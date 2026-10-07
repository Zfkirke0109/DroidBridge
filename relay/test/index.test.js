// @ts-check
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import worker, { RelayObject, isRelayRoute } from '../src/index.js';
import { RELAY_ANSWER_HEADER, outcomeResponse } from '../src/mcp.js';
import { constantTimeEqual, normalizePairingCode, normalizeResource } from '../src/util.js';
import { MemoryStorage, deviceFetch, mcp, newDeviceKey, obtainTokens, poll, respond, toolsCall, waitFor } from './helpers.js';

/** A fake Durable Object namespace that records which object each request reached. */
function fakeNamespace() {
  /** @type {string[]} */
  const names = [];
  /** @type {string[]} */
  const paths = [];
  const namespace = {
    /** @param {string} name */
    idFromName(name) {
      names.push(name);
      return { name };
    },
    /** @param {{ name: string }} id */
    get(id) {
      return {
        /** @param {Request} request */
        fetch: async (request) => {
          paths.push(`${id.name} ${request.method} ${new URL(request.url).pathname}`);
          return new Response('from-do', { status: 299 });
        },
      };
    },
  };
  return { namespace, names, paths };
}

test('worker routes relay paths to the single "relay" Durable Object', async () => {
  const { namespace, names, paths } = fakeNamespace();
  const env = { RELAY: namespace };
  const routed = [
    '/mcp',
    '/device/v1/poll',
    '/device/v1/anything',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
    '/authorize',
    '/token',
    '/register',
  ];
  for (const path of routed) {
    const res = await worker.fetch(new Request(`https://relay.example${path}?x=1`, { method: 'POST' }), env);
    assert.equal(res.status, 299, path);
    assert.equal(await res.text(), 'from-do');
  }
  assert.deepEqual(new Set(names), new Set(['relay']));
  assert.equal(paths.length, routed.length);

  const root = await worker.fetch(new Request('https://relay.example/'), env);
  assert.equal(root.status, 200);
  assert.equal(await root.text(), 'DroidBridge relay');
  assert.match(root.headers.get('content-type') ?? '', /^text\/plain/);

  for (const path of ['/favicon.ico', '/mcp/', '/mcpx', '/device', '/devices/v1/poll', '/.well-knownx', '/authorize/x', '/admin']) {
    const res = await worker.fetch(new Request(`https://relay.example${path}`), env);
    assert.equal(res.status, 404, path);
  }
  assert.equal(paths.length, routed.length, 'unrouted paths never reach the Durable Object');
  assert.equal(isRelayRoute('/token'), true);
  assert.equal(isRelayRoute('/tokens'), false);
});

test('RelayObject wraps the relay core with Durable Object storage', async () => {
  const device = newDeviceKey();
  const object = new RelayObject({ storage: new MemoryStorage() }, { DEVICE_KEY_SHA256: device.hash });
  const meta = await object.fetch(new Request('https://relay.example/.well-known/oauth-protected-resource'));
  assert.equal(meta.status, 200);
  assert.equal((await meta.json()).resource, 'https://relay.example/mcp');
  const status = await object.fetch(
    new Request('https://relay.example/device/v1/status', { headers: { authorization: `Bearer ${device.key}` } }),
  );
  assert.equal(status.status, 200);
  assert.equal((await status.json()).protocol, 'droidbridge-relay/1');
  assert.equal((await object.fetch(new Request('https://relay.example/nope'))).status, 404);
});

test('new-device-key script prints a well-formed key and its SHA-256', () => {
  const script = fileURLToPath(new URL('../scripts/new-device-key.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [script], { encoding: 'utf8' });
  const key = /\b(dbrk_[A-Za-z0-9_-]+)\b/.exec(output)?.[1];
  const hash = /\b([0-9a-f]{64})\b/.exec(output)?.[1];
  assert.ok(key && hash);
  assert.match(key, /^dbrk_[A-Za-z0-9_-]{43}$/);
  assert.equal(hash, createHash('sha256').update(key).digest('hex'));
  assert.match(output, /npx wrangler@4 secret put DEVICE_KEY_SHA256/);
  const again = execFileSync(process.execPath, [script], { encoding: 'utf8' });
  assert.ok(!again.includes(key), 'a fresh key every run');
});

test('helpers: pairing normalization, resource normalization, constant-time compare', () => {
  assert.equal(normalizePairingCode('k7qm-2xpa'), 'K7QM2XPA');
  assert.equal(normalizePairingCode(' o1L i-0 '), '01110');
  assert.equal(normalizeResource('HTTPS://Relay.Example:443/mcp/'), 'https://relay.example/mcp');
  assert.equal(normalizeResource('https://relay.example/mcp#x'), null);
  assert.equal(normalizeResource('https://u:p@relay.example/mcp'), null);
  assert.equal(normalizeResource('not a url'), null);
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual('', ''), true);
});

/** A namespace whose object reads the body, then fails or answers. */
function failingNamespace(/** @type {boolean} */ fail) {
  /** @type {string[]} */
  const bodies = [];
  const stub = {
    /** @param {Request} request */
    fetch: async (request) => {
      bodies.push(await request.text());
      if (fail) throw new Error('Durable Object reset because its code was updated.');
      return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { status: 200 });
    },
  };
  return { namespace: { idFromName: () => ({}), get: () => stub }, bodies };
}

/** @param {string} body */
function mcpPost(body) {
  return new Request('https://relay.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
    body,
  });
}

test('a Durable Object failure on POST /mcp is a final HTTP 200 JSON-RPC -32002, never a 5xx', async () => {
  const { namespace, bodies } = failingNamespace(true);
  const env = { RELAY: namespace };
  const expectedData = { droidbridge_relay: { state: 'settlement_unknown', delivered: null, retried: false } };

  const withId = await worker.fetch(mcpPost('{"jsonrpc":"2.0","id":"r-9","method":"tools/call"}'), env);
  assert.equal(withId.status, 200);
  const body = await withId.json();
  assert.equal(body.id, 'r-9');
  assert.equal(body.error.code, -32002);
  assert.deepEqual(body.error.data, expectedData);
  assert.match(body.error.message, /not retried/);
  assert.equal(bodies[0], '{"jsonrpc":"2.0","id":"r-9","method":"tools/call"}', 'the object received the full body');

  const numeric = await (await worker.fetch(mcpPost('{"jsonrpc":"2.0","id":7,"method":"ping"}'), env)).json();
  assert.equal(numeric.id, 7);

  const unparseable = await worker.fetch(mcpPost('{oops'), env);
  assert.equal(unparseable.status, 200);
  const unparsed = await unparseable.json();
  assert.equal(unparsed.id, null);
  assert.deepEqual(unparsed.error.data, expectedData);

  const notification = await worker.fetch(mcpPost('{"jsonrpc":"2.0","method":"notifications/initialized"}'), env);
  assert.equal(notification.status, 200);
  assert.equal(await notification.text(), '');

  // Only POST /mcp is wrapped: other routes still surface the failure to the runtime.
  await assert.rejects(worker.fetch(new Request('https://relay.example/token', { method: 'POST', body: 'x' }), env));
  await assert.rejects(worker.fetch(new Request('https://relay.example/mcp'), env));
});

test('a healthy Durable Object answer on POST /mcp passes through unchanged', async () => {
  const { namespace, bodies } = failingNamespace(false);
  const res = await worker.fetch(mcpPost('{"jsonrpc":"2.0","id":1,"method":"ping"}'), { RELAY: namespace });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"jsonrpc":"2.0","id":1,"result":{}}');
  assert.equal(bodies[0], '{"jsonrpc":"2.0","id":1,"method":"ping"}');
});

/**
 * A namespace whose object answers with the given response.
 * @param {() => Response} answer
 */
function answeringNamespace(answer) {
  const stub = {
    /** @param {Request} request */
    fetch: async (request) => {
      await request.text();
      return answer();
    },
  };
  return { RELAY: { idFromName: () => ({}), get: () => stub } };
}

test('the Worker turns an unmarked 5xx from the object on POST /mcp into -32002 and passes marked answers', async () => {
  const unknown = { droidbridge_relay: { state: 'settlement_unknown', delivered: null, retried: false } };
  for (const status of [500, 502, 503, 504, 599]) {
    const env = answeringNamespace(() => new Response('internal', { status }));
    const res = await worker.fetch(mcpPost('{"jsonrpc":"2.0","id":"u","method":"tools/call"}'), env);
    assert.equal(res.status, 200, String(status));
    const body = await res.json();
    assert.equal(body.id, 'u');
    assert.equal(body.error.code, -32002);
    assert.deepEqual(body.error.data, unknown);
    const note = await worker.fetch(mcpPost('{"jsonrpc":"2.0","method":"notifications/initialized"}'), env);
    assert.equal(note.status, 200);
    assert.equal(await note.text(), '');
  }

  // The object's own answers keep their status and lose the internal marker.
  const offline = '{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"offline","data":{"droidbridge_relay":{"state":"offline","delivered":false}}}}';
  for (const [status, body] of /** @type {[number, string][]} */ ([
    [503, offline],
    [502, ''],
    [500, '{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"from the phone"}}'],
    [429, ''],
    [200, '{"jsonrpc":"2.0","id":1,"result":{}}'],
  ])) {
    const env = answeringNamespace(
      () =>
        new Response(body || null, {
          status,
          headers: { 'content-type': 'application/json', 'retry-after': '1', [RELAY_ANSWER_HEADER]: '1' },
        }),
    );
    const res = await worker.fetch(mcpPost('{"jsonrpc":"2.0","id":1,"method":"ping"}'), env);
    assert.equal(res.status, status);
    assert.equal(await res.text(), body);
    assert.equal(res.headers.get(RELAY_ANSWER_HEADER), null, 'the marker never reaches Claude');
    assert.equal(res.headers.get('retry-after'), '1', 'other headers are kept');
  }

  // An object that cannot even be addressed never received the request: delivered false.
  for (const broken of [{}, { RELAY: { idFromName: () => ({}), get: () => { throw new Error('no such object'); } } }]) {
    const res = await worker.fetch(mcpPost('{"jsonrpc":"2.0","id":2,"method":"ping"}'), /** @type {any} */ (broken));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, 2);
    assert.equal(body.error.code, -32002);
    assert.match(body.error.message, /not delivered/);
    assert.deepEqual(body.error.data.droidbridge_relay, { state: 'settlement_unknown', delivered: false, retried: false });
    await assert.rejects(worker.fetch(new Request('https://relay.example/token', { method: 'POST', body: 'x' }), /** @type {any} */ (broken)));
  }

  // Only POST /mcp is converted; other routes pass the object's answer through.
  const env = answeringNamespace(() => new Response('internal', { status: 500 }));
  assert.equal((await worker.fetch(new Request('https://relay.example/token', { method: 'POST', body: 'x' }), env)).status, 500);
});

/** Memory storage whose every operation throws while `failing` is set. */
class FlakyStorage extends MemoryStorage {
  failing = false;
  #check() {
    if (this.failing) throw new Error('storage unavailable');
  }
  /** @param {string} key */
  async get(key) {
    this.#check();
    return super.get(key);
  }
  /** @param {string} key @param {unknown} value */
  async put(key, value) {
    this.#check();
    return super.put(key, value);
  }
  /** @param {string} key */
  async delete(key) {
    this.#check();
    return super.delete(key);
  }
  /** @param {{ prefix?: string }} [options] */
  async list(options) {
    this.#check();
    return super.list(options);
  }
}

/**
 * A real RelayObject behind the real Worker. Returns a harness the shared helpers accept: every
 * request goes Worker -> namespace -> RelayObject, with real timers and the real clock.
 */
function realDeployment() {
  const storage = new FlakyStorage();
  const device = newDeviceKey();
  const object = new RelayObject({ storage }, { DEVICE_KEY_SHA256: device.hash, RESPONSE_TIMEOUT_SECONDS: '10' });
  /** @type {unknown[]} */
  const errors = [];
  object.relay.onError = (error) => errors.push(error);
  const stub = { fetch: (/** @type {Request} */ request) => object.fetch(request) };
  const env = { RELAY: { idFromName: () => ({}), get: () => stub } };
  const t = /** @type {any} */ ({
    relay: { fetch: (/** @type {Request} */ request) => worker.fetch(request, env), hub: object.relay.hub },
    storage,
    device,
  });
  return { t, storage, errors };
}

/** @param {Response} res */
async function relayData(res) {
  assert.equal(res.headers.get(RELAY_ANSWER_HEADER), null, 'the marker never reaches Claude');
  return res.json();
}

test('real RelayObject: storage failing before delivery answers POST /mcp with HTTP 200 -32002 delivered:false', async () => {
  const { t, storage, errors } = realDeployment();
  const { access_token: token } = await obtainTokens(t);
  // The deliberate answers keep their codes through the Worker.
  const offline = await mcp(t, token, toolsCall('o'));
  assert.equal(offline.status, 503);
  assert.deepEqual((await relayData(offline)).error.data.droidbridge_relay, { state: 'offline', delivered: false });

  storage.failing = true;
  const res = await mcp(t, token, toolsCall('s'));
  assert.equal(res.status, 200);
  const body = await relayData(res);
  assert.equal(body.id, 's');
  assert.equal(body.error.code, -32002);
  assert.match(body.error.message, /not delivered/);
  assert.deepEqual(body.error.data.droidbridge_relay, { state: 'settlement_unknown', delivered: false, retried: false });
  assert.equal(errors.length, 1, 'the failure is reported');

  // A notification gets an empty 200; a request without a token never touches storage: 401.
  const note = await mcp(t, token, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 200);
  assert.equal(await note.text(), '');
  assert.equal((await mcp(t, null, toolsCall())).status, 401);
  // The phone polls afterwards: nothing was handed off.
  assert.equal((await poll(t, 0)).status, 204);
  assert.equal(t.relay.hub.inspect().inFlight, 0);

  // Storage back: the same token works again.
  storage.failing = false;
  const pollPromise = poll(t);
  await waitFor(() => t.relay.hub.inspect().parked);
  const answer = mcp(t, token, toolsCall('back'));
  const [command] = (await (await pollPromise).json()).commands;
  assert.equal((await respond(t, command)).status, 200);
  const ok = await answer;
  assert.equal(ok.status, 200);
  assert.deepEqual(await relayData(ok), { jsonrpc: '2.0', id: 'back', result: { ok: true } });
});

test('real RelayObject: failures after delivery answer POST /mcp with HTTP 200 -32002 delivered:true, never a 5xx', async () => {
  const { t, storage, errors } = realDeployment();
  const { access_token: token } = await obtainTokens(t);

  // Storage failing after delivery: answering needs no storage, so the phone's reply arrives.
  let pollPromise = poll(t);
  await waitFor(() => t.relay.hub.inspect().parked);
  let answer = mcp(t, token, toolsCall('kept'));
  let [command] = (await (await pollPromise).json()).commands;
  storage.failing = true;
  assert.equal((await respond(t, command)).status, 200);
  const kept = await answer;
  assert.equal(kept.status, 200);
  assert.deepEqual(await relayData(kept), { jsonrpc: '2.0', id: 'kept', result: { ok: true } });
  storage.failing = false;

  // The relay failing after delivery: the handler throws once the phone's reply settled it.
  const submit = t.relay.hub.submit.bind(t.relay.hub);
  t.relay.hub.submit = (...args) =>
    submit(...args).then(() => {
      throw new RangeError('answer failure');
    });
  pollPromise = poll(t);
  await waitFor(() => t.relay.hub.inspect().parked);
  answer = mcp(t, token, toolsCall('deep'));
  [command] = (await (await pollPromise).json()).commands;
  const ack = await respond(t, command);
  assert.equal(ack.status, 200);
  const res = await answer;
  assert.equal(res.status, 200);
  const body = await relayData(res);
  assert.equal(body.id, 'deep');
  assert.equal(body.error.code, -32002);
  assert.match(body.error.message, /may or may not have run/);
  assert.deepEqual(body.error.data.droidbridge_relay, { state: 'settlement_unknown', delivered: true, retried: false });
  assert.ok(errors.some((error) => error instanceof RangeError), 'the failure is reported');
  assert.equal((await respond(t, command)).status, 404, 'settled: a later reply is 404');
  assert.equal(t.relay.hub.inspect().inFlight, 0);
});

/**
 * The keys of a TOML document's root table, with their raw values: the key/value lines before
 * the first table header (`[name]` or `[[name]]`). A key below a header belongs to that table,
 * so it is not a root key however it is written. Enough of TOML for wrangler.toml: comments,
 * blank lines and arrays spread over several lines.
 * @param {string} toml
 */
function rootTomlKeys(toml) {
  /** @type {Map<string, string>} */
  const keys = new Map();
  const lines = toml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/^\s+/, '');
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) break;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    assert.ok(match, `a key/value line: ${line}`);
    let value = match[2].replace(/\s+#[^"]*$/, '').trim();
    while (value.startsWith('[') && !value.endsWith(']') && i + 1 < lines.length) {
      i += 1;
      value += lines[i].replace(/\s+#[^"]*$/, '').trim();
    }
    keys.set(match[1], value);
  }
  return keys;
}

test('wrangler.toml enables request.signal, which Cloudflare aborts on a client disconnect only with that flag', () => {
  const toml = readFileSync(fileURLToPath(new URL('../wrangler.toml', import.meta.url)), 'utf8');
  // Only a root key is a compatibility flag. Below [vars] the same line would be a Worker
  // variable, and below [[durable_objects.bindings]] a field of the binding: Cloudflare would
  // leave request.signal unaborted on a disconnect.
  const value = rootTomlKeys(toml).get('compatibility_flags');
  assert.ok(value, 'compatibility_flags is a root key of wrangler.toml');
  const flags = JSON.parse(value.replace(/,\s*]$/, ']'));
  assert.ok(Array.isArray(flags) && flags.includes('enable_request_signal'), value);
  const elsewhere = toml.split(/\r?\n/).filter((line) => /^\s*compatibility_flags\s*=/.test(line));
  assert.equal(elsewhere.length, 1, 'set once, nowhere else');
});

test('rootTomlKeys reads only the root table', () => {
  const toml = [
    '# comment',
    'name = "x" # trailing comment',
    'compatibility_flags = [',
    '  "a",',
    '  "enable_request_signal",',
    ']',
    '',
    '[[durable_objects.bindings]]',
    'name = "RELAY"',
    'compatibility_flags = ["nope"]',
    '[vars]',
    'compatibility_flags = ["nope"]',
  ].join('\n');
  const keys = rootTomlKeys(toml);
  assert.deepEqual([...keys.keys()], ['name', 'compatibility_flags']);
  assert.equal(keys.get('name'), '"x"');
  assert.deepEqual(JSON.parse(String(keys.get('compatibility_flags')).replace(/,\s*]$/, ']')), ['a', 'enable_request_signal']);
  assert.equal(rootTomlKeys('[vars]\ncompatibility_flags = ["enable_request_signal"]\n').get('compatibility_flags'), undefined);
});

test('README asks for the Node.js version that Wrangler 4 needs, as package.json does', () => {
  // wrangler@4 declares engines.node ">=22.0.0" and exits below it (bin/wrangler.js,
  // MIN_NODE_VERSION = "22.0.0"), and every deploy step runs `npx wrangler@4`.
  const WRANGLER_4_MIN_NODE = 22;
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  const required = /Node\.js (\d+) or newer/.exec(readme);
  assert.ok(required, 'README names a minimum Node.js version');
  assert.ok(Number(required[1]) >= WRANGLER_4_MIN_NODE, `README asks for Node.js ${required[1]}`);
  assert.equal(pkg.engines?.node, `>=${required[1]}`, 'package.json engines agree with the README');
  const majors = new Set([...`${readme}\n${JSON.stringify(pkg.scripts)}`.matchAll(/wrangler@(\d+)/g)].map((m) => m[1]));
  assert.deepEqual([...majors], ['4'], 'every command runs Wrangler 4');
});

test('the Worker hands the object the request itself, so its abort signal reaches the object', async () => {
  /** @type {Request[]} */
  const received = [];
  const stub = {
    /** @param {Request} request */
    fetch: async (request) => {
      received.push(request);
      return new Response(null, { status: 204, headers: { [RELAY_ANSWER_HEADER]: '1' } });
    },
  };
  const env = { RELAY: { idFromName: () => ({}), get: () => stub } };
  const controllers = [new AbortController(), new AbortController()];
  const mcpRequest = new Request('https://relay.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    signal: controllers[0].signal,
  });
  const pollRequest = new Request('https://relay.example/device/v1/poll', { signal: controllers[1].signal });
  const passed = await worker.fetch(mcpRequest, env);
  assert.equal(passed.status, 204, 'a marked 204 passes through');
  assert.equal(await passed.text(), '');
  await worker.fetch(pollRequest, env);
  assert.equal(received.length, 2);
  for (const request of received) assert.equal(request.signal.aborted, false);
  for (const controller of controllers) controller.abort();
  for (const request of received) assert.equal(request.signal.aborted, true);
});

test('a marked answer whose body breaks off is a final HTTP 200 -32002 delivered:null, never a truncated 200', async () => {
  const brokenAnswer = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":"x","result":{"text":"aaaa'));
          controller.error(new Error('Durable Object reset because its code was updated.'));
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json', [RELAY_ANSWER_HEADER]: '1' } },
    );
  const env = answeringNamespace(brokenAnswer);
  const res = await worker.fetch(mcpPost('{"jsonrpc":"2.0","id":"x","method":"tools/call"}'), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, 'x');
  assert.equal(body.error.code, -32002);
  assert.deepEqual(body.error.data.droidbridge_relay, { state: 'settlement_unknown', delivered: null, retried: false });
  assert.equal(res.headers.get(RELAY_ANSWER_HEADER), null);
  const note = await worker.fetch(mcpPost('{"jsonrpc":"2.0","method":"notifications/initialized"}'), env);
  assert.equal(note.status, 200);
  assert.equal(await note.text(), '');
  // An unmarked answer that breaks off is treated the same way.
  const unmarked = answeringNamespace(() => {
    const response = brokenAnswer();
    const headers = new Headers(response.headers);
    headers.delete(RELAY_ANSWER_HEADER);
    return new Response(response.body, { status: 200, headers });
  });
  const plain = await (await worker.fetch(mcpPost('{"jsonrpc":"2.0","id":"y","method":"tools/call"}'), unmarked)).json();
  assert.equal(plain.id, 'y');
  assert.equal(plain.error.data.droidbridge_relay.delivered, null);
});

test('real RelayObject: the phone\'s own 5xx and a notification\'s 502 pass through the Worker as deliberate answers', async () => {
  const { t } = realDeployment();
  const { access_token: token } = await obtainTokens(t);
  /** @param {unknown} message @param {Record<string, unknown>} overrides */
  const roundTrip = async (message, overrides) => {
    const pollPromise = poll(t);
    await waitFor(() => t.relay.hub.inspect().parked);
    const answer = mcp(t, token, message);
    const [command] = (await (await pollPromise).json()).commands;
    assert.equal((await respond(t, command, overrides)).status, 200);
    return answer;
  };
  for (const [id, code, status] of /** @type {[number, number, number][]} */ ([[5, -32603, 500], [6, -32000, 503], [7, -32001, 504]])) {
    const reply = { jsonrpc: '2.0', id, error: { code, message: 'MCP request failed' } };
    const res = await roundTrip(toolsCall(id), { resp_json: reply, resp_code: status });
    assert.equal(res.status, status);
    assert.deepEqual(await relayData(res), reply, 'the phone\'s answer reaches Claude');
  }
  const invalid = await roundTrip({ jsonrpc: '2.0', method: 'notifications/initialized' }, { resp_code: 0 });
  assert.equal(invalid.status, 502);
  assert.equal(invalid.headers.get(RELAY_ANSWER_HEADER), null);
  assert.equal(await invalid.text(), '');
  const failed = await roundTrip({ jsonrpc: '2.0', method: 'notifications/initialized' }, { resp_code: 503 });
  assert.equal(failed.status, 503, 'the phone\'s own status for a notification');
  assert.equal(await failed.text(), '');
  assert.equal(t.relay.hub.inspect().inFlight, 0);
});

test('real RelayObject: an unexpected hub outcome is HTTP 200 -32002 delivered:false, never a 5xx', async () => {
  assert.throws(() => outcomeResponse(/** @type {any} */ ({ kind: 'bogus' }), true, '1'), /unexpected hub outcome/);
  const { t, errors } = realDeployment();
  const { access_token: token } = await obtainTokens(t);
  t.relay.hub.submit = async () => ({ kind: 'bogus' });
  const res = await mcp(t, token, toolsCall('x'));
  assert.equal(res.status, 200);
  const body = await relayData(res);
  assert.equal(body.id, 'x');
  assert.equal(body.error.code, -32002);
  assert.deepEqual(body.error.data.droidbridge_relay, { state: 'settlement_unknown', delivered: false, retried: false });
  assert.equal(errors.length, 1);
});
