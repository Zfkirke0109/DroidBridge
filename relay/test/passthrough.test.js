// @ts-check
// The relay moves JSON-RPC messages as the text it received, in both directions: numbers keep
// every digit, and an id above 2^53 is matched and echoed exactly.
import assert from 'node:assert/strict';
import test from 'node:test';
import { memberSource, numberKey, valueEnd } from '../src/json.js';
import { PHONE_NUMBER_MAX, phoneUnreadableReason, relayFailureAnswer, requestIdText } from '../src/mcp.js';
import { deviceFetch, makeRelay, mcp, obtainTokens, poll, promptly, waitFor } from './helpers.js';

/**
 * Delivers one message (as text) to a parked poll and returns the poll body text, the command
 * and Claude's pending answer.
 * @param {ReturnType<typeof makeRelay>} t
 * @param {string} token
 * @param {string} body
 */
async function deliver(t, token, body) {
  const parked = poll(t);
  await waitFor(() => t.relay.hub.inspect().parked);
  const answer = mcp(t, token, body);
  // A refused request is answered while the poll stays parked: fail here instead of waiting.
  const first = await Promise.race([parked.then(() => 'poll'), answer.then((res) => `answer ${res.status}`)]);
  assert.equal(first, 'poll', 'the request was handed to the phone');
  const res = await parked;
  assert.equal(res.status, 200);
  const text = await res.text();
  const [command] = JSON.parse(text).commands;
  return { text, command, answer };
}

/**
 * Posts the phone's reply as raw text, with resp_json given as raw JSON text.
 * @param {ReturnType<typeof makeRelay>} t
 * @param {Record<string, any>} command
 * @param {string} respJson
 * @param {number} [status]
 */
function replyRaw(t, command, respJson, status = 200) {
  const body =
    `{"request_id":${JSON.stringify(command.request_id)},"channel":"main","resp_json":${respJson},` +
    `"resp_headers":{"Content-Type":["application/json"]},"resp_code":${status},"resp_type":"jsonrpc_response"}`;
  return deviceFetch(t, '/device/v1/response', {
    method: 'POST',
    body,
    headers: { 'x-tunnel-shard-token': command.shard_token },
  });
}

test('Claude to phone: the request reaches the phone as the text Claude sent, every number intact', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const body =
    '{"jsonrpc":"2.0", "id":7,"method":"tools/call","params":{"name":"command","arguments":' +
    '{"big":9007199254740993,"huge_int":18446744073709551615,"ns":1700000000123456789,' +
    '"negzero":-0,"tiny":1e-400,"exact":0.1000000000000000055511151231257827,"e":1E+2,' +
    '"near_max":1.79e308,"neg_near_max":-1.79e308,"zero_exp":0e999,"text":"caf\\u00e9 \\/ \\ud83d\\ude00",' +
    '"dup":1,"dup":2}}}';
  const { text, command, answer } = await deliver(t, token, body);
  assert.ok(text.includes(`"jsonrpc":${body}}`), 'forwarded byte for byte');
  assert.equal(command.jsonrpc.id, 7);
  assert.equal((await replyRaw(t, command, '{"jsonrpc":"2.0","id":7,"result":{}}')).status, 200);
  assert.equal((await answer).status, 200);
});

test('phone to Claude: resp_json reaches Claude exactly as the phone wrote it', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const replies = [
    '{"id":7,"jsonrpc":"2.0","result":{"structuredContent":{"inode":18446744073709551615,' +
      '"ns":1700000000123456789,"negzero":-0.0,"big":9007199254740993,"inf":1e999,"f":2.5e-324}}}',
    '{ "jsonrpc" : "2.0" ,\n "result" : { "text" : "caf\\u00e9 \\/" } , "id" : 7 }',
    // Repeated members, as JSON.parse reads them: the last wins.
    '{"jsonrpc":"2.0","id":8,"id":7,"result":{"a":1,"a":2}}',
    // Nested far deeper than JSON.stringify could encode again.
    `{"jsonrpc":"2.0","id":7,"result":${'['.repeat(100_000)}${']'.repeat(100_000)}}`,
    // An id of the same value written another way.
    '{"jsonrpc":"2.0","id":7.0,"result":null}',
    '{"jsonrpc":"2.0","id":70e-1,"error":{"code":-32603,"message":"MCP request failed"}}',
  ];
  for (const reply of replies) {
    const { command, answer } = await deliver(t, token, '{"jsonrpc":"2.0","id":7,"method":"tools/call"}');
    assert.equal((await replyRaw(t, command, reply)).status, 200);
    const res = await answer;
    assert.equal(res.status, 200, reply.slice(0, 60));
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(await res.text(), reply, 'unchanged');
  }
  assert.equal(t.relay.hub.inspect().inFlight, 0);
});

test('an id above 2^53 is accepted, forwarded, matched on its digits and echoed exactly', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  for (const id of ['9007199254740993', '18446744073709551615', '-9223372036854775808', '12345678901234567890']) {
    const request = `{"jsonrpc":"2.0","id":${id},"method":"tools/call"}`;

    // The phone's reply for that very id passes through.
    let { text, command, answer } = await deliver(t, token, request);
    assert.ok(text.includes(`"jsonrpc":${request}}`));
    const reply = `{"jsonrpc":"2.0","id":${id},"result":{"ok":true}}`;
    assert.equal((await replyRaw(t, command, reply)).status, 200);
    let res = await answer;
    assert.equal(res.status, 200);
    assert.equal(await res.text(), reply);

    // A reply for the neighbouring id, which JSON.parse turns into the same double, is invalid,
    // and the relay's own error echoes the request's id digit for digit.
    ({ command, answer } = await deliver(t, token, request));
    const neighbour = (BigInt(id) + (id.startsWith('-') ? 1n : -1n)).toString();
    assert.equal(Number(neighbour), Number(id), 'the same double');
    assert.equal((await replyRaw(t, command, `{"jsonrpc":"2.0","id":${neighbour},"result":{}}`)).status, 200);
    res = await answer;
    assert.equal(res.status, 200);
    const invalid = await res.text();
    assert.ok(invalid.startsWith(`{"jsonrpc":"2.0","id":${id},"error":{"code":-32603,`), invalid);
    assert.equal(JSON.parse(invalid).error.data.droidbridge_relay.state, 'invalid_device_reply');
  }

  // A reply id that is the same double but not the same number is invalid too.
  const { command, answer } = await deliver(t, token, '{"jsonrpc":"2.0","id":5,"method":"x"}');
  assert.equal((await replyRaw(t, command, '{"jsonrpc":"2.0","id":5.0000000000000000001,"result":{}}')).status, 200);
  assert.equal(JSON.parse(await (await answer).text()).error.code, -32603);

  // Offline: the relay's answer echoes the id exactly.
  const offline = makeRelay();
  const { access_token: offlineToken } = await obtainTokens(offline);
  const res = await mcp(offline, offlineToken, '{"jsonrpc":"2.0","id":9007199254740993,"method":"x"}');
  assert.equal(res.status, 503);
  assert.match(await res.text(), /^\{"jsonrpc":"2\.0","id":9007199254740993,"error":/);
});

test('a string id is matched on its value and type: a reply for another id is an invalid device reply', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  /** @type {[string, string, boolean][]} request id, phone reply id (JSON text), passes through */
  const cases = [
    ['"a"', '"b"', false],
    ['"3"', '3', false],
    ['"a"', '["a"]', false],
    ['"a"', 'null', false],
    ['""', '0', false],
    ['"a"', '"a"', true],
    // The same string written with other escapes is the same id.
    ['"A\\/b"', '"A/b"', true],
    ['"a\\u0062"', '"ab"', true],
  ];
  for (const [id, replyId, passes] of cases) {
    const label = `request id ${id}, reply id ${replyId}`;
    const { command, answer } = await deliver(t, token, `{"jsonrpc":"2.0","id":${id},"method":"tools/call"}`);
    const reply = `{"jsonrpc":"2.0","id":${replyId},"result":{"ok":true}}`;
    assert.equal((await replyRaw(t, command, reply)).status, 200, label);
    const res = await answer;
    assert.equal(res.status, 200, label);
    const text = await res.text();
    if (passes) {
      assert.equal(text, reply, label);
      continue;
    }
    // The relay's own error echoes the request's id as Claude wrote it.
    assert.ok(text.startsWith(`{"jsonrpc":"2.0","id":${id},"error":{"code":-32603,`), `${label}: ${text}`);
    assert.deepEqual(JSON.parse(text).error.data.droidbridge_relay, {
      state: 'invalid_device_reply',
      delivered: true,
      retried: false,
    });
  }
  assert.equal(t.relay.hub.inspect().inFlight, 0);
});

test('the relay\'s own answers echo a string id exactly as Claude wrote it, escapes included', async () => {
  const id = '"A\\/b"';
  const request = `{"jsonrpc":"2.0","id":${id},"method":"tools/list"}`;
  const prefix = `{"jsonrpc":"2.0","id":${id},"error":`;

  // Offline (no poll waiting): 503, not delivered.
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  let res = await mcp(t, token, request);
  assert.equal(res.status, 503);
  let text = await res.text();
  assert.ok(text.startsWith(prefix), text);
  assert.equal(JSON.parse(text).error.data.droidbridge_relay.state, 'offline');

  // Online but no poll within 5 s: 503 unavailable.
  assert.equal((await poll(t, 0)).status, 204);
  const pending = mcp(t, token, request);
  await waitFor(() => t.relay.hub.inspect().handoff === 1);
  await t.clock.advance(5000);
  res = await pending;
  assert.equal(res.status, 503);
  text = await res.text();
  assert.ok(text.startsWith(prefix), text);
  assert.equal(JSON.parse(text).error.data.droidbridge_relay.state, 'unavailable');

  // Delivered, no reply before the deadline: HTTP 200 -32002.
  const { answer } = await deliver(t, token, request);
  await t.clock.advance(245_000);
  res = await answer;
  assert.equal(res.status, 200);
  text = await res.text();
  assert.ok(text.startsWith(`${prefix}{"code":-32002,`), text);
  assert.equal(JSON.parse(text).error.data.droidbridge_relay.state, 'settlement_unknown');

  // A relay failure: HTTP 200 -32002.
  t.relay.grants.lookupAccess = async () => {
    throw new Error('storage');
  };
  res = await mcp(t, token, request);
  assert.equal(res.status, 200);
  text = await res.text();
  assert.ok(text.startsWith(`${prefix}{"code":-32002,`), text);

  // A message the phone could not read: 400 before delivery.
  const u = makeRelay();
  const { access_token: uToken } = await obtainTokens(u);
  res = await mcp(u, uToken, `{"jsonrpc":"2.0","id":${id},"method":"x","params":{"n":1e400}}`);
  assert.equal(res.status, 400);
  text = await res.text();
  assert.ok(text.startsWith(`${prefix}{"code":-32600,`), text);
});

test('JSON whitespace of every kind (space, tab, CR, LF) between tokens is read and forwarded as is', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  // Pretty-printed requests, with newlines, tabs and CRLF on both sides of the id member, and a
  // number id that is the last member, ended by LF, CRLF or CR alone.
  const requests = [
    '{\n  "jsonrpc": "2.0",\n  "id": 7,\n  "method": "tools/call",\n  "params": {\n    "name": "command",\n    "arguments": [1, 2]\n  }\n}\n',
    '{\r\n\t"jsonrpc":\t"2.0",\r\n\t"id"\t:\t"seven",\r\n\t"method":\t"tools/call",\r\n\t"params":\t{\r\n\t\t"n":\t[\r\n\t\t\t9007199254740993\r\n\t\t]\r\n\t}\r\n}\r\n',
    '\r\n\t {"method"\r:\r"tools/call"\t,\n"id"\r\n:\r\n18446744073709551615\t\r\n,\n"jsonrpc"\t:"2.0"}\t\r\n',
    '{\n  "jsonrpc": "2.0",\n  "method": "tools/list",\n  "id": 8\n}',
    '{\r\n  "jsonrpc": "2.0",\r\n  "method": "tools/list",\r\n  "id": -9223372036854775808\r\n}\r\n',
    '{"jsonrpc":"2.0","method":"tools/list","id":10\r}',
    '{\n\t"jsonrpc" :\r\n "2.0",\r\n "method":"notifications/initialized"\r\n}',
  ];
  // The phone's replies: tabs and CRLF between tokens, and the id as the last member, ended by
  // LF, CRLF or CR alone.
  const replies = [
    (/** @type {string} */ id) =>
      `{\r\n\t"jsonrpc":\t"2.0",\r\n\t"id":\t${id},\r\n\t"result":\t{\r\n\t\t"ok":\ttrue\r\n\t}\r\n}`,
    (/** @type {string} */ id) => `{"jsonrpc":"2.0","result":{"ok":true},"id":${id}\n}`,
    (/** @type {string} */ id) => `{\r\n  "jsonrpc": "2.0",\r\n  "result": {},\r\n  "id": ${id}\r\n}`,
    (/** @type {string} */ id) => `{"jsonrpc":"2.0","error":{"code":-32000,"message":"x"},"id":${id}\r}`,
  ];
  let round = 0;
  for (const request of requests) {
    const label = JSON.stringify(request).slice(0, 50);
    const { text, command, answer } = await deliver(t, token, request);
    assert.ok(text.includes(`"jsonrpc":${request}}`), `${label}: forwarded byte for byte`);
    if (command.jsonrpc.id === undefined) {
      assert.equal((await deviceFetch(t, '/device/v1/response', {
        method: 'POST',
        body: `{\r\n\t"request_id":\t${JSON.stringify(command.request_id)},\r\n\t"resp_code":\t202\r\n}`,
        headers: { 'x-tunnel-shard-token': command.shard_token },
      })).status, 200);
      const res = await answer;
      assert.equal(res.status, 202, label);
      assert.equal(await res.text(), '');
      continue;
    }
    const id = /** @type {string} */ (memberSource(request, 'id'));
    const reply = replies[round++ % replies.length](id);
    // The phone's envelope uses tabs and CRLF too.
    const envelope =
      `{\r\n\t"request_id":\t${JSON.stringify(command.request_id)},\r\n\t"channel"\t:\r\n"main",\r\n` +
      `\t"resp_json":\r\n\t${reply}\t,\r\n\t"resp_code":\t200,\r\n\t"resp_type":\t"jsonrpc_response"\r\n}\r\n`;
    const ack = await deviceFetch(t, '/device/v1/response', {
      method: 'POST',
      body: envelope,
      headers: { 'x-tunnel-shard-token': command.shard_token },
    });
    assert.equal(ack.status, 200, label);
    const res = await answer;
    assert.equal(res.status, 200, label);
    assert.equal(await res.text(), reply, `${label}: the phone's reply, unchanged`);
  }
  assert.equal(t.relay.hub.inspect().inFlight, 0);
  assert.equal(t.errors.length, 0);
});

test('a leading UTF-8 BOM on Claude\'s body is removed; the rest reaches the phone byte for byte', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  const message = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"s":"caf\\u00e9 é"}}';
  const encoded = new TextEncoder().encode(message);
  const body = new Uint8Array(3 + encoded.byteLength);
  body.set([0xef, 0xbb, 0xbf]);
  body.set(encoded, 3);
  const parked = poll(t);
  await waitFor(() => t.relay.hub.inspect().parked);
  const answer = t.relay.fetch(
    new Request('https://relay.example/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    }),
  );
  // A refused body is answered while the poll stays parked: fail here instead of waiting.
  const first = await Promise.race([parked.then(() => 'poll'), answer.then((res) => `answer ${res.status}`)]);
  assert.equal(first, 'poll', 'the request was handed to the phone');
  const text = await (await parked).text();
  assert.ok(text.includes(`"jsonrpc":${message}}`), text);
  assert.ok(!text.includes('\ufeff'));
  await t.clock.advance(245_000);
  assert.equal((await answer).status, 200);
});

test('an id the phone would not answer is refused before delivery with id null', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  assert.equal((await poll(t, 0)).status, 204); // online: an accepted request would wait
  // serde_json reads these as floats (or not at all as an integer) and the phone ignores the
  // request, so it could only ever end as "outcome unknown".
  for (const id of ['18446744073709551616', '-9223372036854775809', '1.0', '1e0', '-0', '1.5', '100000000000000000000000']) {
    const res = await promptly(mcp(t, token, `{"jsonrpc":"2.0","id":${id},"method":"x"}`), id);
    assert.equal(res.status, 400, id);
    const body = await res.json();
    assert.equal(body.id, null, id);
    assert.equal(body.error.code, -32600, id);
  }
  assert.equal(t.relay.hub.inspect().inFlight, 0);
  // Strings and integers in range are fine.
  for (const id of ['"x"', '0', '-1', '9223372036854775807']) {
    assert.equal((await poll(t, 0)).status, 204);
    const pending = mcp(t, token, `{"jsonrpc":"2.0","id":${id},"method":"x"}`);
    await waitFor(() => t.relay.hub.inspect().handoff === 1);
    await t.clock.advance(5000);
    assert.equal((await pending).status, 503, id);
  }
});

test('a number the phone cannot read is refused before delivery, also inside a repeated member', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  assert.equal((await poll(t, 0)).status, 204);
  const numbers = [
    '1e400',
    '-1e400',
    '1e999',
    '1.8e308',
    '-1.8e308',
    '1.7976931348623157e308',
    `1${'0'.repeat(400)}`,
    '1e99999999999',
    // Below the largest double, so JSON.parse reads it, but serde_json 1.0.151 overflows on it.
    '1797693134862315668.0835e290',
    // The double just above 1.79e308, and a literal between it and the largest double.
    '1.7900000000000002e308',
    '1.795e308',
  ];
  assert.ok(Number.isFinite(Number(numbers.at(-1))));
  for (const number of numbers) {
    for (const params of [`{"n":${number}}`, `{"n":${number},"n":1}`, `{"list":[1,${number}]}`]) {
      const res = await promptly(mcp(t, token, `{"jsonrpc":"2.0","id":"n","method":"tools/call","params":${params}}`), params);
      assert.equal(res.status, 400, params);
      const body = await res.json();
      assert.equal(body.id, 'n');
      assert.equal(body.error.code, -32600);
      assert.match(body.error.message, /beyond the range the phone can read/);
      const note = await promptly(mcp(t, token, `{"jsonrpc":"2.0","method":"notifications/x","params":${params}}`), params);
      assert.equal(note.status, 400);
      assert.equal(await note.text(), '');
    }
  }
  assert.equal(t.relay.hub.inspect().inFlight, 0);
  assert.equal((await poll(t, 0)).status, 204, 'nothing was handed off');
});

test('phoneUnreadableReason reads the text itself', () => {
  assert.equal(phoneUnreadableReason('{"a":[1,-0,1e-999,0e999,true,false,null,"x"],"b":{"c":"\\ud83d\\ude00"}}'), null);
  assert.equal(phoneUnreadableReason(`{"n":${PHONE_NUMBER_MAX}}`), null);
  assert.equal(phoneUnreadableReason(`{"n":-${PHONE_NUMBER_MAX}}`), null);
  assert.match(String(phoneUnreadableReason('{"n":1.791e308}')), /beyond the range/);
  // The bound applies to the number as JavaScript reads it, rounded to the nearest double: the
  // double just above 1.79e308 is refused, a longer literal that rounds to 1.79e308 is not, and
  // anything read as infinity is refused.
  assert.equal(Number('1.7900000000000002e308') > PHONE_NUMBER_MAX, true);
  assert.match(String(phoneUnreadableReason('{"n":1.7900000000000002e308}')), /beyond the range/);
  assert.match(String(phoneUnreadableReason('{"n":-1.7900000000000002e308}')), /beyond the range/);
  assert.match(String(phoneUnreadableReason('{"n":1e309}')), /beyond the range/);
  assert.equal(Number('1.79000000000000001e308'), PHONE_NUMBER_MAX);
  assert.equal(phoneUnreadableReason('{"n":1.79000000000000001e308}'), null);
  assert.equal(phoneUnreadableReason(`{"n":179${'0'.repeat(306)}}`), null);
  assert.equal(phoneUnreadableReason('{"n":1.7899999999999998e308}'), null);
  assert.match(String(phoneUnreadableReason('{"a":"\\ud83d","a":"ok"}')), /a string contains/);
  assert.match(String(phoneUnreadableReason('{"\\udc00" : 1}')), /a member name contains/);
  assert.match(String(phoneUnreadableReason(`{"a":${'{"b":'.repeat(64)}0${'}'.repeat(64)}}`)), /nested more than 64/);
  assert.equal(phoneUnreadableReason(`{"a":${'{"b":'.repeat(63)}0${'}'.repeat(63)}}`), null);
  // An escaped backslash before "u" is not a \u escape.
  assert.equal(phoneUnreadableReason('{"a":"\\\\ud83d"}'), null);
});

test('requestIdText gives the id as Claude wrote it, or null when the phone would not answer it', () => {
  /** @param {string} text */
  const idOf = (text) => requestIdText(text, JSON.parse(text));
  // A string id keeps its escapes: the relay's own answers echo it as Claude wrote it.
  assert.equal(idOf('{"id":"a\\u0062"}'), '"a\\u0062"');
  assert.equal(idOf('{"id"\t:\r\n"A\\/b" }'), '"A\\/b"');
  assert.equal(idOf('{"id":"x","id":"y"}'), '"y"', 'the last of repeated members, as JSON.parse reads it');
  assert.equal(idOf('{"id": 9007199254740993 }'), '9007199254740993');
  assert.equal(idOf('{"id":1,"id":18446744073709551615}'), '18446744073709551615');
  assert.equal(idOf('{"id":-9223372036854775808}'), '-9223372036854775808');
  for (const id of ['null', 'true', '{}', '[]', '1.0', '1e2', '-0', '18446744073709551616', '-9223372036854775809']) {
    assert.equal(idOf(`{"id":${id}}`), null, id);
  }
});

test('relayFailureAnswer echoes an id above 2^53 exactly', async () => {
  const text = '{"jsonrpc":"2.0","id":9007199254740993,"method":"x"}';
  const res = relayFailureAnswer({ text, message: JSON.parse(text) }, null);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /^\{"jsonrpc":"2\.0","id":9007199254740993,"error":\{"code":-32002,/);
  const bad = '{"jsonrpc":"2.0","id":1.5,"method":"x"}';
  assert.equal(JSON.parse(await relayFailureAnswer({ text: bad, message: JSON.parse(bad) }, false).text()).id, null);
  const note = '{"jsonrpc":"2.0","method":"x"}';
  assert.equal(await relayFailureAnswer({ text: note, message: JSON.parse(note) }, true).text(), '');
  assert.equal(JSON.parse(await relayFailureAnswer(undefined, null).text()).id, null);
});

test('a relay failure on a request with an id above 2^53 echoes that id exactly', async () => {
  const t = makeRelay();
  const { access_token: token } = await obtainTokens(t);
  t.relay.grants.lookupAccess = async () => {
    throw new Error('storage');
  };
  const res = await mcp(t, token, '{"jsonrpc":"2.0","id":18446744073709551615,"method":"x"}');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /^\{"jsonrpc":"2\.0","id":18446744073709551615,"error":\{"code":-32002,/);
});

test('memberSource and valueEnd find values in JSON text as JSON.parse reads it', () => {
  const text = ' {"a" : 1 , "b\\u0022":[1,{"x":"}\\"]"}], "a" :{"y":["\\\\"]} ,"s":"\\\\\\""} ';
  assert.equal(memberSource(text, 'a'), '{"y":["\\\\"]}', 'the last of repeated members');
  assert.equal(memberSource(text, 'b"'), '[1,{"x":"}\\"]"}]');
  assert.equal(memberSource(text, 's'), '"\\\\\\""');
  assert.equal(memberSource(text, 'z'), undefined);
  assert.equal(memberSource('{}', 'a'), undefined);
  assert.equal(valueEnd('[[],{}] ', 0), 7);
  assert.equal(valueEnd('-1.5e3,', 0), 6);
  for (const bad of ['{"a":', '{"a":"x', '{"a":[1,2', '[1]', '{"a" 1}', '{"a":1 "b":2}', '']) {
    assert.throws(() => memberSource(bad, 'a'), SyntaxError, bad);
  }
});

test('numberKey compares JSON numbers on their exact value', () => {
  assert.equal(numberKey('1'), numberKey('1.0'));
  assert.equal(numberKey('1'), numberKey('10e-1'));
  assert.equal(numberKey('-1500'), numberKey('-1.50e+3'));
  assert.equal(numberKey('0'), numberKey('-0.000e5'));
  assert.notEqual(numberKey('9007199254740993'), numberKey('9007199254740992'));
  assert.notEqual(numberKey('1'), numberKey('-1'));
  assert.equal(numberKey('01'), null);
  assert.equal(numberKey('x'), null);
});
