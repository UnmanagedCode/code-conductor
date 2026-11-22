import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocket } from 'ws';
import { bootServer, waitFor, registerLocalProject } from './helpers.mjs';
import { FAKE_PLUGIN_DIR } from './plugin-helpers.mjs';
import { pidAlive } from '../src/plugins/ports.ts';

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

test('base path: X-Forwarded-Prefix, Location and the bare-id redirect carry the base', async () => {
  // Invariant: a plugin that builds URLs from X-Forwarded-Prefix, or redirects, lands under the hosting prefix.
  const boot = await setup({ basePath: BASE });
  try {
    for (const prefix of ['', BASE]) {
      const h = await (await fetch(`${boot.baseUrl}${prefix}/plugins/fake-plugin/request-headers`, { headers: { 'accept-encoding': 'gzip' } })).json();
      assert.equal(h['x-forwarded-prefix'], `${BASE}/plugins/fake-plugin`, `via '${prefix}'`);
    }
    const rel = await fetch(`${boot.baseUrl}${BASE}/plugins/fake-plugin/redirect`, { redirect: 'manual' });
    assert.equal(rel.headers.get('location'), `${BASE}/plugins/fake-plugin/somewhere`);
    const bare = await fetch(`${boot.baseUrl}${BASE}/plugins/fake-plugin?a=1`, { redirect: 'manual' });
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.get('location'), `${BASE}/plugins/fake-plugin/?a=1`);
  } finally { await boot.close(); }
});

test('base path: request headers and bodies are byte-identical to the no-base path', async () => {
  // Invariant: a base changes nothing the proxy sends or returns beyond X-Forwarded-Prefix, Location and the bare-id redirect; no body is parsed.
  const boot = await setup({ basePath: BASE });
  try {
    const port = Number(new URL(boot.baseUrl).port);
    const hdrs = { 'accept-encoding': 'gzip, br' };
    const parse = async (p) => JSON.parse((await rawGet(port, p, hdrs)).body.toString('utf8'));
    const root = await parse('/plugins/fake-plugin/request-headers');
    const based = await parse(`${BASE}/plugins/fake-plugin/request-headers`);
    assert.deepEqual(based, root);
    assert.equal(based['accept-encoding'], 'gzip, br');
    const direct = await rawGet(await childPort(port), '/legacy');
    const via = await rawGet(port, `${BASE}/plugins/fake-plugin/legacy`);
    assert.ok(direct.body.includes('src="/pluginBridge.js"') && !direct.body.includes(BASE), 'fixture check: root-absolute and base-free');
    assert.deepEqual(via.body, direct.body);
    assert.equal(via.headers['content-length'], direct.headers['content-length']);
    assert.equal(via.headers['transfer-encoding'], direct.headers['transfer-encoding']);
    const safe = (await rawGet(port, `${BASE}/plugins/fake-plugin/`)).body.toString('utf8');
    assert.match(safe, /src="\.\.\/\.\.\/pluginBridge\.js"/);
  } finally { await boot.close(); }
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
    const direct = await rawGet(await childPort(port), '/legacy');
    const legacy = await rawGet(port, '/plugins/fake-plugin/legacy');
    assert.deepEqual(legacy.body, direct.body);
    assert.match(legacy.body.toString('utf8'), /src="\/pluginBridge\.js"/);
  } finally { await boot.close(); }
});

// The fake plugin's own port, to read what the child sent before the proxy touched it.
const childPort = async (ccPort) => (await (await fetch(`http://127.0.0.1:${ccPort}/plugins/fake-plugin/env`)).json()).port;

test('upstream abort mid-body ends the client response (reset), with a base and without', async () => {
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
  const withBase = await setup({ basePath: BASE });
  try {
    const port = Number(new URL(withBase.baseUrl).port);
    assert.equal(await outcome(port, `${BASE}/plugins/fake-plugin/abort-html?declared=100000&sent=65536`), 'reset', 'with a base');
  } finally { await withBase.close(); }
  const noBase = await setup();
  try {
    const port = Number(new URL(noBase.baseUrl).port);
    assert.equal(await outcome(port, '/plugins/fake-plugin/abort-html?declared=100000&sent=65536'), 'reset', 'no base');
  } finally { await noBase.close(); }
});

test('an upstream that over-sends past its Content-Length cannot crash cc, with a base and without', async () => {
  // Invariant: an upstream error once the body is streaming cuts the pair instead of ending the response while the pipe still writes; cc keeps answering.
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  try {
    for (const [name, opts, prefix] of [['with a base', { basePath: BASE }, BASE], ['no base', undefined, '']]) {
      const boot = await setup(opts);
      try {
        const port = Number(new URL(boot.baseUrl).port);
        for (let i = 0; i < 4; i++) {
          const outcome = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ hang: true }), 8000);
            http.get({ host: '127.0.0.1', port, path: `${prefix}/plugins/fake-plugin/oversend-html` }, (res) => {
              res.on('data', () => {});
              res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode }); });
              res.on('error', () => { clearTimeout(timer); resolve({ reset: true }); });
              res.on('close', () => { clearTimeout(timer); resolve({ reset: true }); });
            }).on('error', () => { clearTimeout(timer); resolve({ reset: true }); });
          });
          assert.ok(!outcome.hang, `${name}: never a hang`);
        }
        assert.deepEqual(uncaught, [], `${name}: no uncaught exception`);
        assert.equal((await fetch(`${boot.baseUrl}${prefix}/api/health`)).status, 200, `${name}: cc still answers`);
      } finally { await boot.close(); }
    }
  } finally { process.off('uncaughtException', onUncaught); }
});
