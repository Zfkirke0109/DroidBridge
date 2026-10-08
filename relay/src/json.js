// @ts-check
/**
 * Reading JSON source text without re-encoding it. The relay parses every JSON-RPC message with
 * JSON.parse to validate it, but forwards the text it received, never JSON.stringify of the
 * parsed value: that would round every number through an IEEE double (2^53 + 1 becomes 2^53,
 * 1e400 becomes null, -0 becomes 0). These helpers find the pieces of that text the relay needs.
 *
 * Every function expects text that JSON.parse has already accepted. On anything else it throws
 * a SyntaxError; it never loops forever or reads past the end.
 */

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

/** JSON whitespace: space, tab, line feed, carriage return. */
const WHITESPACE = /[ \t\n\r]*/y;
/** A number, true, false or null. */
const SCALAR_RUN = /[^ \t\n\r,:[\]{}"]*/y;
/** A JSON number literal: sign, integer part, fraction, exponent. */
const NUMBER = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * Index after the run `regex` (sticky, may match empty) matches at `i`.
 * @param {RegExp} regex
 * @param {string} text
 * @param {number} i
 */
function skip(regex, text, i) {
  regex.lastIndex = i;
  return regex.test(text) ? regex.lastIndex : i;
}

/**
 * Index of the first character at or after `i` that is not JSON whitespace.
 * @param {string} text
 * @param {number} i
 */
export function skipWhitespace(text, i) {
  return skip(WHITESPACE, text, i);
}

/**
 * Index just past the string that starts with the quote at `start`.
 * @param {string} text
 * @param {number} start
 */
export function stringEnd(text, start) {
  if (text.charCodeAt(start) !== QUOTE) throw new SyntaxError('expected a string');
  let i = start + 1;
  for (;;) {
    const quote = text.indexOf('"', i);
    if (quote === -1) throw new SyntaxError('unterminated string');
    // The quote closes the string unless an odd number of backslashes escapes it. The run of
    // backslashes stops at the opening quote at the latest.
    let before = quote - 1;
    while (text.charCodeAt(before) === BACKSLASH) before -= 1;
    if ((quote - 1 - before) % 2 === 0) return quote + 1;
    i = quote + 1;
  }
}

/**
 * Index just past the number, true, false or null that starts at `start`.
 * @param {string} text
 * @param {number} start
 */
export function scalarEnd(text, start) {
  const end = skip(SCALAR_RUN, text, start);
  if (end === start) throw new SyntaxError('expected a value');
  return end;
}

/**
 * Index just past the value that starts at `start` (no whitespace before it).
 * @param {string} text
 * @param {number} start
 */
export function valueEnd(text, start) {
  const first = text.charCodeAt(start);
  if (first === QUOTE) return stringEnd(text, start);
  if (first !== OPEN_BRACE && first !== OPEN_BRACKET) return scalarEnd(text, start);
  let depth = 0;
  let i = start;
  for (;;) {
    if (i >= text.length) throw new SyntaxError('unterminated object or array');
    const c = text.charCodeAt(i);
    if (c === QUOTE) {
      i = stringEnd(text, i);
      continue;
    }
    if (c === OPEN_BRACE || c === OPEN_BRACKET) {
      depth += 1;
    } else if (c === CLOSE_BRACE || c === CLOSE_BRACKET) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
}

/**
 * The source text of member `name` of the JSON object `text`, without the whitespace around it;
 * undefined when the object has no such member. Like JSON.parse, the last of repeated members
 * wins.
 * @param {string} text
 * @param {string} name
 * @returns {string | undefined}
 */
export function memberSource(text, name) {
  let i = skipWhitespace(text, 0);
  if (text.charCodeAt(i) !== OPEN_BRACE) throw new SyntaxError('expected an object');
  i = skipWhitespace(text, i + 1);
  if (text.charCodeAt(i) === CLOSE_BRACE) return undefined;
  /** @type {string | undefined} */
  let found;
  for (;;) {
    const keyEnd = stringEnd(text, i);
    const rawKey = text.slice(i, keyEnd);
    const key = rawKey.includes('\\') ? JSON.parse(rawKey) : rawKey.slice(1, -1);
    i = skipWhitespace(text, keyEnd);
    if (text.charCodeAt(i) !== COLON) throw new SyntaxError('expected a colon');
    i = skipWhitespace(text, i + 1);
    const end = valueEnd(text, i);
    if (key === name) found = text.slice(i, end);
    i = skipWhitespace(text, end);
    const c = text.charCodeAt(i);
    if (c === CLOSE_BRACE) return found;
    if (c !== COMMA) throw new SyntaxError('expected a comma');
    i = skipWhitespace(text, i + 1);
  }
}

/**
 * A canonical form of a JSON number literal: two literals have the same form exactly when they
 * denote the same number (so `1`, `1.0` and `10e-1` match, and `9007199254740993` does not match
 * `9007199254740992`, which JSON.parse turns into the same double). Null when `literal` is not a
 * JSON number.
 * @param {string} literal
 */
export function numberKey(literal) {
  const match = NUMBER.exec(literal);
  if (!match) return null;
  const [, sign, integer, fraction = '', exponent = '0'] = match;
  const digits = `${integer}${fraction}`.replace(/^0+/, '');
  if (digits === '') return '0';
  const significant = digits.replace(/0+$/, '');
  const scale = BigInt(exponent) - BigInt(fraction.length) + BigInt(digits.length - significant.length);
  return `${sign}${significant}e${scale}`;
}
