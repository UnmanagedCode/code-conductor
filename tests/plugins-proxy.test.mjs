import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { WebSocket } from 'ws';
import { bootServer, waitFor, registerLocalProject } from './helpers.mjs';
import { FAKE_PLUGIN_DIR } from './plugin-helpers.mjs';
import { pidAlive } from '../src/plugins/ports.ts';
import { REWRITE_BODY_CAP_BYTES } from '../src/plugins/proxy.ts';

// Boot the full server (helpers tmp root) with the fake plugin installed as
// a project and enabled — every test drives the real /plugins proxy.
async function setup(opts) {
  const boot = await bootServer(opts);
  const dir = path.join(boot.projectsRoot, 'fakeplug');
  await fs.cp(FAKE_PLUGIN_DIR, dir, { recursive: true });
  await registerLocalProject('fakeplug', dir);
  await boot.pluginHost.enable('fake-plugin');
  return boot;
}

test('proxy: lazy start, prefix strip, query + X-Forwarded passthrough', async () => {
  const boot = await setup();
  try {
    // Enabled-but-stopped: the first request itself must lazy-start the child.
    const r = await fetch(`${boot.baseUrl}/plugins/fake-plugin/env?x=1`);
    assert.equal(r.status, 200);
    const env = await r.json();
    assert.equal(env.query, '?x=1');
    assert.equal(env.pluginId, 'fake-plugin');
    assert.equal(env.conductorUrl, boot.baseUrl);
    assert.equal(env.mcpUrl, boot.baseUrl + '/mcp', 'the plugin is handed the MCP URL');
  } finally {
    await boot.close();
  }
});

test('proxy: bare /plugins/<id> 301s to the trailing-slash form (query kept)', async () => {
  const boot = await setup();
  try {
    const r = await fetch(`${boot.baseUrl}/plugins/fake-plugin?a=1`, { redirect: 'manual' });
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), '/plugins/fake-plugin/?a=1');
  } finally {
    await boot.close();
  }
});

test('proxy: HTML page + relative asset resolve under the prefix', async () => {
  const boot = await setup();
  try {
    const page = await fetch(`${boot.baseUrl}/plugins/fake-plugin/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /img src="asset\.svg"/);
    const asset = await fetch(`${boot.baseUrl}/plugins/fake-plugin/asset.svg`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /svg/);
  } finally {
    await boot.close();
  }
});

test('proxy: root-relative Location is re-prefixed; absolute passes through', async () => {
  const boot = await setup();
  try {
    const rel = await fetch(`${boot.baseUrl}/plugins/fake-plugin/redirect`, { redirect: 'manual' });
    assert.equal(rel.status, 302);
    assert.equal(rel.headers.get('location'), '/plugins/fake-plugin/somewhere');
    const abs = await fetch(`${boot.baseUrl}/plugins/fake-plugin/redirect-absolute`, { redirect: 'manual' });
    assert.equal(abs.headers.get('location'), 'https://example.com/elsewhere');
  } finally {
    await boot.close();
  }
});

test('proxy: request/response bodies stream incrementally (no buffering)', async () => {
  const boot = await setup();
  try {
    const port = Number(new URL(boot.baseUrl).port);
    const received = [];
    let onChunk = null;
    const done = new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/plugins/fake-plugin/echo' }, (res) => {
        res.on('data', (d) => { received.push(d.toString()); onChunk?.(); });
        res.on('end', resolve);
      });
      req.on('error', reject);
      // First chunk must come back BEFORE the request body is finished —
      // proving both directions stream through the proxy unbuffered.
      req.write('chunk-one');
      onChunk = () => {
        onChunk = null;
        req.end('chunk-two');
      };
    });
    await done;
    assert.equal(received.join(''), 'chunk-onechunk-two');
    assert.ok(received.length >= 2, 'expected at least two separate chunks');
  } finally {
    await boot.close();
  }
});

test('proxy: WebSocket upgrade pipes through to the child (echo)', async () => {
  const boot = await setup();
  try {
    const wsUrl = boot.baseUrl.replace('http://', 'ws://') + '/plugins/fake-plugin/ws-echo';
    const ws = new WebSocket(wsUrl);
    const echoed = await new Promise((resolve, reject) => {
      ws.on('open', () => ws.send('hello through the proxy'));
      ws.on('message', (d) => resolve(d.toString()));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('ws echo timeout')), 15000).unref();
    });
    assert.equal(echoed, 'hello through the proxy');
    ws.close();
  } finally {
    await boot.close();
  }
});

test('regression: /ws still upgrades; unknown upgrade paths are destroyed', async () => {
  const boot = await setup();
  try {
    const ws = new WebSocket(boot.wsUrl);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.close();

    const bogus = new WebSocket(boot.baseUrl.replace('http://', 'ws://') + '/nope');
    await new Promise((resolve) => {
      bogus.on('error', resolve);
      bogus.on('close', resolve);
    });
    assert.notEqual(bogus.readyState, WebSocket.OPEN);
  } finally {
    await boot.close();
  }
});

test('proxy: unknown or disabled plugin → 404 JSON', async () => {
  const boot = await setup();
  try {
    const r1 = await fetch(`${boot.baseUrl}/plugins/ghost/x`);
    assert.equal(r1.status, 404);
    assert.ok((await r1.json()).error);

    await boot.pluginHost.disable('fake-plugin');
    const r2 = await fetch(`${boot.baseUrl}/plugins/fake-plugin/env`);
    assert.equal(r2.status, 404);
  } finally {
    await boot.close();
  }
});

test('proxy: killed child → 503 with crash status, then lazy restart serves again', async () => {
  const boot = await setup();
  try {
    const first = await fetch(`${boot.baseUrl}/plugins/fake-plugin/env`);
    assert.equal(first.status, 200);
    const { pid } = await boot.pluginHost.status('fake-plugin');
    process.kill(-pid, 'SIGKILL');
    await waitFor(() => !pidAlive(pid));
    await waitFor(async () => (await boot.pluginHost.status('fake-plugin')).state === 'crashed');

    // Inside the crash backoff window: 503 with structured body.
    const down = await fetch(`${boot.baseUrl}/plugins/fake-plugin/env`);
    assert.equal(down.status, 503);
    const body = await down.json();
    assert.equal(body.status, 'crashed');
    assert.ok(body.retryAfter >= 1);

    // Past the backoff: next demand lazy-restarts.
    await new Promise(r => setTimeout(r, 2200));
    const back = await fetch(`${boot.baseUrl}/plugins/fake-plugin/env`);
    assert.equal(back.status, 200);
  } finally {
    await boot.close();
  }
});

// Invariant: the proxy owns no plugin policy. A page that declares no framing
// policy is made same-origin-framable only, and cc's own CSP/nosniff never
// land on a plugin response.
test('proxy: a plugin page that declares no framing policy gets X-Frame-Options SAMEORIGIN and none of cc\'s CSP or nosniff', async () => {
  const boot = await setup();
  try {
    const r = await fetch(`${boot.baseUrl}/plugins/fake-plugin/`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(r.headers.get('content-security-policy'), null);
    assert.equal(r.headers.get('x-content-type-options'), null);
  } finally {
    await boot.close();
  }
});

// Invariant: a plugin's own CSP / X-Frame-Options / nosniff pass through
// byte-identical; X-Frame-Options is added only when no framing policy exists.
test("proxy: a plugin's own framing policy passes through unchanged", async (t) => {
  const boot = await setup();
  try {
    const hit = (query) => fetch(`${boot.baseUrl}/plugins/fake-plugin/headers?${new URLSearchParams(query)}`);
    await t.test('frame-ancestors in the CSP: CSP unchanged, no X-Frame-Options added', async () => {
      const csp = "default-src 'none'; frame-ancestors 'self'";
      const r = await hit({ 'content-security-policy': csp });
      assert.equal(r.headers.get('content-security-policy'), csp);
      assert.equal(r.headers.get('x-frame-options'), null);
    });
    await t.test("the plugin's own X-Frame-Options wins", async () => {
      const r = await hit({ 'x-frame-options': 'DENY' });
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
    });
    // Invariant: a framing policy counts only when a browser enforces it, so an unusable
    // X-Frame-Options is replaced by the SAMEORIGIN default rather than trusted.
    await t.test('a blank X-Frame-Options is replaced by SAMEORIGIN', async () => {
      const r = await hit({ 'x-frame-options': '' });
      assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
    });
    await t.test('a legacy ALLOW-FROM X-Frame-Options is replaced by SAMEORIGIN', async () => {
      const r = await hit({ 'x-frame-options': 'ALLOW-FROM http://evil.test' });
      assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
    });
    // Invariant: recognition of an enforcing value is case-insensitive and passes through byte-identical.
    await t.test('a lowercase deny passes through unchanged', async () => {
      const r = await hit({ 'x-frame-options': 'deny' });
      assert.equal(r.headers.get('x-frame-options'), 'deny');
    });
    // Invariant: an X-Frame-Options counts only when it is exactly DENY or SAMEORIGIN, so a value
    // that merely contains one of those words is replaced by SAMEORIGIN, never passed through.
    await t.test('an X-Frame-Options that only contains deny is replaced by SAMEORIGIN', async () => {
      const r = await hit({ 'x-frame-options': 'ALLOW-FROM https://x.test/deny' });
      assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
    });
    await t.test('a list X-Frame-Options (DENY,SAMEORIGIN) is replaced by SAMEORIGIN', async () => {
      const r = await hit({ 'x-frame-options': 'DENY,SAMEORIGIN' });
      assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
    });
    // Invariant: only an actual frame-ancestors directive in the CSP counts, not the word anywhere in it.
    await t.test('a CSP that only mentions frame-ancestors in a host name still gets the framing default', async () => {
      const csp = 'default-src https://frame-ancestors.example';
      const r = await hit({ 'content-security-policy': csp });
      assert.equal(r.headers.get('content-security-policy'), csp);
      assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
    });
    // Invariant: the CSP directive name matches case-insensitively, so FRAME-ANCESTORS counts as declared.
    await t.test('an upper-case FRAME-ANCESTORS directive counts as a declared policy', async () => {
      const csp = "FRAME-ANCESTORS 'self'";
      const r = await hit({ 'content-security-policy': csp });
      assert.equal(r.headers.get('content-security-policy'), csp);
      assert.equal(r.headers.get('x-frame-options'), null);
    });
    await t.test('a CSP without frame-ancestors still gets the framing default', async () => {
      const csp = "default-src 'none'";
      const r = await hit({ 'content-security-policy': csp });
      assert.equal(r.headers.get('content-security-policy'), csp);
      assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
    });
    await t.test("the plugin's own nosniff passes through", async () => {
      const r = await hit({ 'x-content-type-options': 'nosniff' });
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    });
  } finally {
    await boot.close();
  }
});

// Invariant: responses cc itself makes inside the /plugins mount carry cc's full policy.
test("proxy: cc-made proxy responses carry cc's policy", async (t) => {
  const boot = await setup();
  try {
    for (const [name, url, status] of [
      ['unknown plugin 404', '/plugins/nope/', 404],
      ['bare-id 301', '/plugins/fake-plugin', 301],
    ]) {
      await t.test(name, async () => {
        const r = await fetch(boot.baseUrl + url, { redirect: 'manual' });
        assert.equal(r.status, status);
        assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
        assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'self'");
        assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      });
    }
  } finally {
    await boot.close();
  }
});

// ── hosted under a base path (CC_BASE_PATH) ──

const BASE = '/p/q';
const rawGet = (port, p, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  http.request({ host: '127.0.0.1', port, path: p, headers, method }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject).end();
});

test('base path: X-Forwarded-Prefix, Location and the bare-id redirect carry the base; upstream gets identity encoding', async () => {
  // Invariant: a plugin that builds URLs from X-Forwarded-Prefix, or redirects, lands under the hosting prefix.
  const boot = await setup({ basePath: BASE });
  try {
    for (const prefix of ['', BASE]) {
      const h = await (await fetch(`${boot.baseUrl}${prefix}/plugins/fake-plugin/request-headers`, { headers: { 'accept-encoding': 'gzip' } })).json();
      assert.equal(h['x-forwarded-prefix'], `${BASE}/plugins/fake-plugin`, `via '${prefix}'`);
      assert.equal(h['accept-encoding'], 'identity');
    }
    const rel = await fetch(`${boot.baseUrl}${BASE}/plugins/fake-plugin/redirect`, { redirect: 'manual' });
    assert.equal(rel.headers.get('location'), `${BASE}/plugins/fake-plugin/somewhere`);
    const bare = await fetch(`${boot.baseUrl}${BASE}/plugins/fake-plugin?a=1`, { redirect: 'manual' });
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.get('location'), `${BASE}/plugins/fake-plugin/?a=1`);
  } finally { await boot.close(); }
});

test('base path: only the bridge and theme host URLs in HTML are re-rooted, with a correct content-length', async () => {
  // Invariant: a legacy root-absolute plugin page loads its bridge and theme under the base; nothing else is touched.
  const boot = await setup({ basePath: BASE });
  try {
    const port = Number(new URL(boot.baseUrl).port);
    const r = await rawGet(port, `${BASE}/plugins/fake-plugin/legacy`);
    const body = r.body.toString('utf8');
    assert.match(body, /href="\/p\/q\/pluginTheme\.css"/);
    assert.match(body, /src="\/p\/q\/pluginBridge\.js"/);
    assert.match(body, /<p>\/pluginBridge\.js stays text<\/p>/);
    assert.equal(Number(r.headers['content-length']), r.body.length);
    const safe = (await rawGet(port, `${BASE}/plugins/fake-plugin/`)).body.toString('utf8');
    assert.match(safe, /src="\.\.\/\.\.\/pluginBridge\.js"/);
    const json = await rawGet(port, `${BASE}/plugins/fake-plugin/env`);
    assert.equal(JSON.parse(json.body.toString('utf8')).pluginId, 'fake-plugin');
  } finally { await boot.close(); }
});

test('base path: compressed HTML from a non-compliant child is piped untouched and warned once', async () => {
  // Invariant: a degradation is visible (a warning), never silent corruption.
  const boot = await setup({ basePath: BASE });
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  try {
    const port = Number(new URL(boot.baseUrl).port);
    for (let i = 0; i < 2; i++) {
      const r = await rawGet(port, `${BASE}/plugins/fake-plugin/gzip-html`);
      assert.equal(r.headers['content-encoding'], 'gzip');
      assert.match(zlib.gunzipSync(r.body).toString(), /src="\/pluginBridge\.js"/);
    }
    assert.equal(warns.filter((w) => w.includes("plugin 'fake-plugin'")).length, 1);
  } finally { console.warn = orig; await boot.close(); }
});

test('base path: a plugin WebSocket upgrades under the prefix', async () => {
  const boot = await setup({ basePath: BASE });
  try {
    const ws = new WebSocket(boot.baseUrl.replace('http://', 'ws://') + `${BASE}/plugins/fake-plugin/ws-echo`);
    const echoed = await new Promise((resolve, reject) => {
      ws.on('open', () => ws.send('prefixed'));
      ws.on('message', (d) => resolve(d.toString()));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('ws echo timeout')), 15000).unref();
    });
    assert.equal(echoed, 'prefixed');
    ws.close();
  } finally { await boot.close(); }
});

test('no base: the proxy forwards exactly as before (prefix, encoding, body)', async () => {
  // Invariant: with no CC_BASE_PATH nothing about a plugin request or response changes.
  const boot = await setup();
  try {
    const port = Number(new URL(boot.baseUrl).port);
    const h = JSON.parse((await rawGet(port, '/plugins/fake-plugin/request-headers', { 'accept-encoding': 'gzip' })).body.toString('utf8'));
    assert.equal(h['x-forwarded-prefix'], '/plugins/fake-plugin');
    assert.equal(h['accept-encoding'], 'gzip');
    const legacy = (await rawGet(port, '/plugins/fake-plugin/legacy')).body.toString('utf8');
    assert.match(legacy, /href="\/pluginTheme\.css"/);
    assert.match(legacy, /src="\/pluginBridge\.js"/);
  } finally { await boot.close(); }
});

// The fake plugin's own port, to read what the child sent before the proxy touched it.
const childPort = async (ccPort) => (await (await fetch(`http://127.0.0.1:${ccPort}/plugins/fake-plugin/env`)).json()).port;

test('base path: a non-UTF-8 page comes through byte-identical except the two rewritten values', async () => {
  // Invariant: the rewrite never decodes the body, so bytes >= 0x80 that are not UTF-8 survive.
  const boot = await setup({ basePath: BASE });
  try {
    const port = Number(new URL(boot.baseUrl).port);
    const plain = (await rawGet(await childPort(port), '/latin1')).body;
    const viaBase = await rawGet(port, `${BASE}/plugins/fake-plugin/latin1`);
    const expected = Buffer.from(plain.toString('latin1')
      .replace('src="/pluginBridge.js"', `src="${BASE}/pluginBridge.js"`)
      .replace('href="/pluginTheme.css"', `href="${BASE}/pluginTheme.css"`), 'latin1');
    assert.notDeepEqual(viaBase.body, plain, 'fixture check: the page was rewritten');
    assert.deepEqual(viaBase.body, expected);
    assert.equal(Number(viaBase.headers['content-length']), expected.length);
    assert.match(viaBase.headers['content-type'], /windows-1252/);
  } finally { await boot.close(); }
});

test('base path: HEAD and body-less answers keep the upstream headers and are not rewritten', async () => {
  // Invariant: a response with no body is neither buffered nor given a recomputed content-length.
  const boot = await setup({ basePath: BASE });
  try {
    const port = Number(new URL(boot.baseUrl).port);
    const direct = await rawGet(await childPort(port), '/sized-html', {}, 'HEAD');
    const head = await rawGet(port, `${BASE}/plugins/fake-plugin/sized-html`, {}, 'HEAD');
    assert.equal(head.status, 200);
    assert.ok(Number(direct.headers['content-length']) > 0, 'fixture check: upstream names a length');
    assert.equal(head.headers['content-length'], direct.headers['content-length']);
    assert.equal(head.body.length, 0);
    for (const status of [204, 304]) {
      const r = await rawGet(port, `${BASE}/plugins/fake-plugin/empty-html?status=${status}`);
      assert.equal(r.status, status);
      assert.equal(r.headers.etag, '"x"');
      assert.equal(r.headers['content-length'], undefined, `${status} carries no recomputed length`);
      assert.equal(r.body.length, 0);
    }
  } finally { await boot.close(); }
});

test('base path: HTML over the buffering cap streams untouched with one warning, declared length or chunked', async () => {
  // Invariant: the proxy never buffers more than the cap; the over-cap page is intact and the degradation is logged once.
  const boot = await setup({ basePath: BASE });
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  try {
    const port = Number(new URL(boot.baseUrl).port);
    const bytes = REWRITE_BODY_CAP_BYTES + 1024;
    for (const chunked of ['0', '1']) {
      const r = await rawGet(port, `${BASE}/plugins/fake-plugin/big-html?bytes=${bytes}&chunked=${chunked}`);
      const text = r.body.toString('latin1');
      assert.equal(r.body.length, bytes, `chunked=${chunked}: whole body arrives`);
      assert.ok(text.startsWith('<script src="/pluginBridge.js">') && text.endsWith('<script src="/pluginBridge.js"></script>'), `chunked=${chunked}: untouched`);
      if (chunked === '0') assert.equal(Number(r.headers['content-length']), bytes);
    }
    const small = await rawGet(port, `${BASE}/plugins/fake-plugin/big-html?bytes=2048&chunked=1`);
    assert.match(small.body.toString('latin1'), /^<script src="\/p\/q\/pluginBridge\.js">/, 'under the cap is rewritten');
    assert.equal(warns.filter((w) => w.includes("plugin 'fake-plugin'") && w.includes('cap')).length, 1);
  } finally { console.warn = orig; await boot.close(); }
});

test('base path: a 206 slice (or any Content-Range answer) is streamed untouched', async () => {
  // Invariant: the rewrite never changes a partial body's length behind a Content-Range that describes the original.
  const boot = await setup({ basePath: BASE });
  try {
    const port = Number(new URL(boot.baseUrl).port);
    const direct = await rawGet(await childPort(port), '/partial-html');
    const via = await rawGet(port, `${BASE}/plugins/fake-plugin/partial-html`);
    assert.equal(via.status, 206);
    assert.deepEqual(via.body, direct.body);
    assert.equal(via.headers['content-length'], direct.headers['content-length']);
    assert.equal(via.headers['content-range'], direct.headers['content-range']);
  } finally { await boot.close(); }
});

test('upstream abort mid-body ends the client response (reset), over the cap and with no base alike', async () => {
  // Invariant: an upstream that dies mid-body never leaves the client hanging with neither end nor error.
  const outcome = (port, p) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve('hang'), 8000);
    const done = (v) => { clearTimeout(timer); resolve(v); };
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      res.on('data', () => {});
      res.on('end', () => done(res.complete ? 'complete' : 'truncated'));
      res.on('error', () => done('reset'));
      res.on('close', () => done(res.complete ? 'complete' : 'reset'));
    }).on('error', () => done('reset'));
  });
  const over = REWRITE_BODY_CAP_BYTES + 4096;
  const withBase = await setup({ basePath: BASE });
  try {
    const port = Number(new URL(withBase.baseUrl).port);
    assert.equal(await outcome(port, `${BASE}/plugins/fake-plugin/abort-html?declared=${over}&sent=65536`), 'reset', 'over-cap declared length');
  } finally { await withBase.close(); }
  const noBase = await setup();
  try {
    const port = Number(new URL(noBase.baseUrl).port);
    assert.equal(await outcome(port, '/plugins/fake-plugin/abort-html?declared=100000&sent=65536'), 'reset', 'no base');
  } finally { await noBase.close(); }
});

test('base path: status 206 alone, or a Content-Range alone, excludes the rewrite', async () => {
  // Invariant: either signal on its own streams the body untouched, with its original length and headers.
  const boot = await setup({ basePath: BASE });
  try {
    const port = Number(new URL(boot.baseUrl).port);
    const child = await childPort(port);
    for (const [route, status] of [['partial-no-range', 206], ['ranged-ok', 200]]) {
      const direct = await rawGet(child, `/${route}`);
      const via = await rawGet(port, `${BASE}/plugins/fake-plugin/${route}`);
      assert.equal(via.status, status, route);
      assert.deepEqual(via.body, direct.body, `${route}: byte-identical`);
      assert.ok(!via.body.toString().includes(BASE), `${route}: no rewrite`);
      assert.equal(via.headers['content-length'], direct.headers['content-length'], route);
    }
  } finally { await boot.close(); }
});

test('base path: an upstream that over-sends past its Content-Length cannot crash cc', async () => {
  // Invariant: the buffered branch owns the response, so the upstream-error 502 and the deferred writeHead never both write; cc keeps answering.
  const boot = await setup({ basePath: BASE });
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  try {
    const port = Number(new URL(boot.baseUrl).port);
    for (let i = 0; i < 4; i++) {
      const outcome = await new Promise((resolve) => {
        const chunks = [];
        const timer = setTimeout(() => resolve({ hang: true }), 8000);
        http.get({ host: '127.0.0.1', port, path: `${BASE}/plugins/fake-plugin/oversend-html` }, (res) => {
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }); });
          res.on('error', () => { clearTimeout(timer); resolve({ reset: true }); });
        }).on('error', () => { clearTimeout(timer); resolve({ reset: true }); });
      });
      assert.ok(!outcome.hang, 'never a hang');
      if (outcome.status === 200) assert.ok(outcome.body.includes(`src="${BASE}/pluginBridge.js"`), 'a full page is the rewritten one');
      else if (outcome.status !== undefined) assert.equal(outcome.status, 502, 'else a clean 502');
    }
    assert.deepEqual(uncaught, [], 'no uncaught exception');
    const after = await fetch(`${boot.baseUrl}${BASE}/api/health`);
    assert.equal(after.status, 200, 'cc still answers');
  } finally { process.off('uncaughtException', onUncaught); await boot.close(); }
});
