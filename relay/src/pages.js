// @ts-check
/**
 * The two HTML pages the relay serves: the consent page and a plain message page.
 * Every interpolated value goes through escapeHtml; no scripts, no external resources.
 */

/** @param {unknown} value */
export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      /** @type {Record<string, string>} */ ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char],
  );
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#1b1f24;--muted:#5b6470;--line:#d9dde3;--accent:#1f6feb;--accent-text:#fff;--warn-bg:#fff4e5;--warn-text:#7a4100}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--text:#e7eaee;--muted:#9aa4b1;--line:#2c313a;--accent:#4c8dff;--accent-text:#0b0d10;--warn-bg:#3a2a12;--warn-text:#ffd8a8}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:30rem;margin:0 auto;padding:24px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}
h1{font-size:1.3rem;line-height:1.3;margin:0 0 12px}
p{margin:0 0 12px}
.muted{color:var(--muted);font-size:.92rem}
dl{margin:0 0 16px;display:grid;grid-template-columns:auto 1fr;gap:6px 12px}
dt{color:var(--muted);font-size:.92rem}
dd{margin:0;overflow-wrap:anywhere}
code{font:.85rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
label{display:block;font-weight:600;margin:16px 0 4px}
input[type=text]{width:100%;font:1.4rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
.notice{background:var(--warn-bg);color:var(--warn-text);border-radius:8px;padding:10px 12px;margin:0 0 12px}
.actions{display:flex;gap:12px;margin-top:16px}
.foot{margin:16px 0 0}
button{flex:1;font:inherit;font-weight:600;padding:12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
`;

/**
 * @param {string} title
 * @param {string} body already-escaped HTML
 */
function documentHtml(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main><div class="card">
${body}
</div></main></body>
</html>`;
}

/**
 * Only a plain http(s) origin may appear in the CSP form-action list.
 * @param {string | undefined} origin
 */
function cspOrigin(origin) {
  return origin && /^https?:\/\/[A-Za-z0-9.\-]+(?::\d{1,5})?$/.test(origin) ? origin : null;
}

/**
 * @param {number} status
 * @param {string} html
 * @param {string | undefined} formActionOrigin the redirect origin the consent form may lead to
 */
export function htmlResponse(status, html, formActionOrigin) {
  const extra = cspOrigin(formActionOrigin);
  const formAction = formActionOrigin === undefined ? "'none'" : `'self'${extra ? ` ${extra}` : ''}`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * A page with a title and a message; used for every error the browser must not be redirected
 * for (unknown client, bad redirect_uri, expired request, ...).
 * @param {number} status
 * @param {string} title
 * @param {string} message
 */
export function messagePage(status, title, message) {
  return htmlResponse(
    status,
    documentHtml(title, `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>`),
    undefined,
  );
}

/**
 * The consent page. Asks for the pairing code shown in DroidBridge.
 * @param {{ status?: number, clientName: string | undefined, clientId: string,
 *   clientKind: 'cimd' | 'dcr', redirectUri: string, requestId: string, notice?: string }} options
 */
export function consentPage({ status = 200, clientName, clientId, clientKind, redirectUri, requestId, notice }) {
  const redirect = new URL(redirectUri);
  const name = clientName && clientName.trim() ? clientName.trim() : 'Unnamed client';
  const identity =
    clientKind === 'cimd'
      ? `Identity document published by ${new URL(clientId).host}`
      : 'Name chosen by the client when it registered with this relay';
  const body = `<h1>Allow ${escapeHtml(name)} to use DroidBridge?</h1>
<p>${escapeHtml(name)} is asking to control this phone through DroidBridge with the permissions you granted on the device.</p>
<dl>
<dt>Client</dt><dd>${escapeHtml(name)}<br><span class="muted">${escapeHtml(identity)}</span></dd>
<dt>Client ID</dt><dd><code>${escapeHtml(clientId)}</code></dd>
<dt>Returns to</dt><dd><code>${escapeHtml(redirect.host)}</code></dd>
</dl>
${notice ? `<p class="notice" role="alert">${escapeHtml(notice)}</p>\n` : ''}<form method="post" action="/authorize">
<input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
<label for="pairing_code">Pairing code</label>
<p class="muted">Open DroidBridge, tap <strong>Pair Claude</strong> and type the code it shows.</p>
<input id="pairing_code" name="pairing_code" type="text" autocomplete="one-time-code" inputmode="text" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="32" placeholder="XXXX-XXXX">
<div class="actions">
<button type="submit" name="action" value="allow" class="primary">Allow</button>
<button type="submit" name="action" value="deny">Deny</button>
</div>
</form>
<p class="muted foot">Only allow this if you started connecting Claude to DroidBridge yourself.</p>`;
  return htmlResponse(status, documentHtml('Connect to DroidBridge', body), redirect.origin);
}
