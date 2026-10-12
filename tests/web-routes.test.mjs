// The web UI's routes: the React UI (web/) at /, /next[/…] redirected into it,
// /pluginBridge.js for plugin pages, and nothing of the old UI. No Vite build
// runs here — the real server never builds under createServer, it is booted on
// an empty dist dir, and every dist-state check runs against a fixture dist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { bootServer } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { webHandler } from '../src/webBuild.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const get = (url) => fetch(url, { redirect: 'manual' });

/** One GET sent as a raw request line, so no client normalises the path. */
function rawGet(baseUrl, target) {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(port), hostname);
    let data = '';
    sock.setEncoding('utf8');
    sock.on('data', (c) => { data += c; });
    sock.on('error', reject);
    sock.on('end', () => {
      const head = data.split('\r\n\r\n')[0].split('\r\n');
      const status = Number(head[0].split(' ')[1]);
      const loc = head.find((l) => /^location:/i.test(l));
      resolve({ status, location: loc ? loc.slice(loc.indexOf(':') + 1).trim() : null });
    });
    sock.write(`GET ${target} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
  });
}

test('the real server, booted with no build', async (t) => {
  const distDir = await mkdtemp('cc-web-routes-nodist-');
  const { baseUrl, close } = await bootServer({ webDistDir: distDir });
  try {
    await t.test("/ is the web UI's mount: with no build it answers the building page", async () => {
      const r = await get(baseUrl + '/');
      assert.equal(r.status, 503);
      assert.match(r.headers.get('content-type') ?? '', /text\/html/);
      const html = await r.text();
      assert.match(html, /http-equiv="refresh"/);
      assert.doesNotMatch(html, /\/app\.js/);
    });

    await t.test('/next, /next/ and /next/<path> redirect 301 to the same path under /, keeping the query', async () => {
      for (const [from, to] of [
        ['/next', '/'],
        ['/next/', '/'],
        ['/next?x=1', '/?x=1'],
        ['/next/manifest.webmanifest', '/manifest.webmanifest'],
        ['/next/assets/a.js?v=2', '/assets/a.js?v=2'],
      ]) {
        const r = await get(baseUrl + from);
        assert.equal(r.status, 301, from);
        assert.equal(r.headers.get('location'), to, from);
      }
    });

    await t.test('/next/ followed by slashes or backslashes and a <host> redirects to a path on this origin, never off it', async () => {
      for (const [from, to] of [
        ['/next///evil.example/x', '/evil.example/x'],
        ['/next//evil.example/x', '/evil.example/x'],
        ['/next////evil.example', '/evil.example'],
        ['/next/\\evil.example', '/evil.example'],
        ['/next/\\/evil.example', '/evil.example'],
      ]) {
        const r = await rawGet(baseUrl, from);
        assert.deepEqual(r, { status: 301, location: to }, from);
        assert.equal(new URL(r.location, baseUrl).origin, new URL(baseUrl).origin, `${from}: Location stays on this origin`);
      }
    });

    await t.test('/next is matched by path segment: /nextfoo is not redirected', async () => {
      const r = await rawGet(baseUrl, '/nextfoo');
      assert.ok(r.status < 300 || r.status >= 400, `status ${r.status}`);
      assert.equal(r.location, null);
    });

    await t.test('the old UI is gone: /legacy, /legacy/, /app.js, /styles.css and /planApproval.ts answer 404', async () => {
      for (const p of ['/legacy', '/legacy/', '/app.js', '/styles.css', '/planApproval.ts']) {
        const r = await get(baseUrl + p);
        assert.equal(r.status, 404, p);
      }
    });

    await t.test('/api is not shadowed by the UI mount', async () => {
      const r = await get(baseUrl + '/api/health');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') ?? '', /application\/json/);
      assert.equal((await r.json()).app, 'code-conductor');
    });

    await t.test('/pluginBridge.js is served at the root as JavaScript for plugin pages, with no build', async () => {
      const r = await get(baseUrl + '/pluginBridge.js');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') ?? '', /javascript/);
      assert.equal(await r.text(), await fs.readFile(path.join(__dirname, '..', 'public', 'pluginBridge.js'), 'utf8'));
    });
  } finally { await close(); }
});

async function fixtureApp({ distDir, getState }) {
  const app = express();
  app.use(webHandler({ distDir, getState }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('webHandler: the built UI, or the building / failed page while there is none', async (t) => {
  await t.test('ready: / serves the dist index and its assets', async () => {
    const distDir = await mkdtemp('cc-web-routes-ready-');
    await fs.mkdir(path.join(distDir, 'assets'));
    await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><p>fixture-index</p>');
    await fs.writeFile(path.join(distDir, 'assets', 'a.js'), 'export const a = 1;');
    const { baseUrl, close } = await fixtureApp({ distDir, getState: () => ({ phase: 'ready', error: null }) });
    try {
      const r = await get(baseUrl + '/');
      assert.equal(r.status, 200);
      assert.match(await r.text(), /fixture-index/);
      const a = await get(baseUrl + '/assets/a.js');
      assert.equal(a.status, 200);
      assert.match(a.headers.get('content-type') ?? '', /javascript/);
    } finally { await close(); }
  });

  await t.test('building: / is a 503 self-refreshing page', async () => {
    const distDir = await mkdtemp('cc-web-routes-building-');
    const { baseUrl, close } = await fixtureApp({ distDir, getState: () => ({ phase: 'building', error: null }) });
    try {
      const r = await get(baseUrl + '/');
      assert.equal(r.status, 503);
      assert.match(r.headers.get('content-type') ?? '', /text\/html/);
      assert.match(await r.text(), /http-equiv="refresh"/);
    } finally { await close(); }
  });

  await t.test('failed: / is a 503 naming the error', async () => {
    const distDir = await mkdtemp('cc-web-routes-failed-');
    const { baseUrl, close } = await fixtureApp({ distDir, getState: () => ({ phase: 'failed', error: 'boom' }) });
    try {
      const r = await get(baseUrl + '/');
      assert.equal(r.status, 503);
      assert.match(r.headers.get('content-type') ?? '', /text\/plain/);
      assert.match(await r.text(), /boom/);
    } finally { await close(); }
  });
});
