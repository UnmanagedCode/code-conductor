// Invariant: with a base path set, every surface answers both under the prefix
// and at root (prefix stripped before routing); a bare base redirects to its
// slash form; cc's security headers ride prefixed responses; WebSocket upgrades
// are admitted under the prefix with the Origin==Host rule intact; with no base,
// a prefixed path is not a route; loopback callers keep root URLs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { WebSocket } from 'ws';
import { bootServer, api } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { createServer } from '../server.ts';

const BASE = '/p/q';
const get = (url, init) => fetch(url, { redirect: 'manual', ...init });

async function distFixture() {
  const dist = await mkdtemp('cc-basepath-dist-');
  await fs.writeFile(path.join(dist, 'index.html'), '<!doctype html><title>x</title>');
  await fs.writeFile(path.join(dist, 'manifest.webmanifest'), '{}');
  return dist;
}

function attempt(url, { origin, host } = {}) {
  const opts = {};
  if (origin !== undefined) opts.origin = origin;
  if (host !== undefined) opts.headers = { host };
  const ws = new WebSocket(url, opts);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { ws.terminate(); resolve({ error: 'timeout' }); }, 15000);
    const done = (r) => { clearTimeout(timer); resolve(r); };
    ws.on('open', () => done({ open: true, ws }));
    ws.on('unexpected-response', (_req, res) => { res.resume(); done({ status: res.statusCode }); });
    ws.on('error', (e) => done({ error: e.message }));
  });
}

test('with a base, each surface answers prefixed and at root', async (t) => {
  const { baseUrl, close } = await bootServer({ basePath: BASE, webDistDir: await distFixture() });
  try {
    for (const p of ['/api/health', '/pluginBridge.js', '/pluginTheme.css', '/', '/manifest.webmanifest', '/mcp/tools']) {
      await t.test(p, async () => {
        const root = await get(baseUrl + p);
        const prefixed = await get(baseUrl + BASE + p);
        assert.equal(root.status, 200, 'root');
        assert.equal(prefixed.status, 200, 'prefixed');
        assert.equal(prefixed.headers.get('content-type'), root.headers.get('content-type'));
      });
    }
  } finally { await close(); }
});

test('a bare base redirects to its slash form, query kept', async () => {
  const { baseUrl, close } = await bootServer({ basePath: BASE, webDistDir: await distFixture() });
  try {
    const r = await get(baseUrl + BASE + '?a=1');
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), `${BASE}/?a=1`);
    assert.equal((await get(baseUrl + BASE)).headers.get('location'), `${BASE}/`);
  } finally { await close(); }
});

test('security headers are the same on prefixed responses and on the redirect', async () => {
  const { baseUrl, close } = await bootServer({ basePath: BASE, webDistDir: await distFixture() });
  try {
    for (const p of [BASE + '/', BASE + '/api/health', BASE]) {
      const r = await get(baseUrl + p);
      assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN', p);
      assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'self'", p);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
    }
  } finally { await close(); }
});

test('WebSocket opens under the prefix and at root, and a mismatched Origin is still refused', async () => {
  const { baseUrl, wsUrl, close } = await bootServer({ basePath: BASE });
  try {
    const prefixed = wsUrl.replace('/ws', `${BASE}/ws`);
    for (const url of [wsUrl, prefixed]) {
      const ok = await attempt(url, { origin: baseUrl });
      ok.ws?.close();
      assert.equal(ok.open, true, url);
    }
    const bad = await attempt(prefixed, { origin: 'http://evil.example' });
    assert.equal(bad.status, 403);
  } finally { await close(); }
});

test('with no base, a prefixed path is not a route and a prefixed upgrade is dropped', async () => {
  const { baseUrl, wsUrl, close } = await bootServer();
  try {
    assert.equal((await get(`${baseUrl}${BASE}/api/health`)).status === 200, false);
    const r = await attempt(wsUrl.replace('/ws', `${BASE}/ws`));
    assert.equal(r.open, undefined);
  } finally { await close(); }
});

test('loopback URLs handed to children stay root-based with a base set', async () => {
  const { baseUrl, instances, close } = await bootServer({ basePath: BASE });
  try {
    assert.equal(instances.conductorUrl(), baseUrl);
    assert.ok(!instances.mcpServerUrl().includes(BASE), instances.mcpServerUrl());
  } finally { await close(); }
});

test('an invalid base fails createServer loudly', () => {
  assert.throws(() => createServer({ basePath: 'no-slash' }), /CC_BASE_PATH/);
});
