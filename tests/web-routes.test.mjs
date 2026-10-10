// The side-by-side UIs: the old UI (public/) at / and /legacy/, the React UI
// (web/) at /next/. No Vite build runs here — the real server never builds
// under createServer, and every dist-state check runs against a fixture dist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import express from 'express';
import { Window } from 'happy-dom';
import { bootServer } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { webHandler, WEB_MOUNT } from '../src/webBuild.ts';

const get = (url) => fetch(url, { redirect: 'manual' });

test('the real server: old UI at / and /legacy/, /next redirects into its scope', async (t) => {
  const { baseUrl, close } = await bootServer();
  try {
    const root = await get(baseUrl + '/');
    assert.equal(root.status, 200);
    const rootHtml = await root.text();

    await t.test('/ serves the old UI with a link to the new one', () => {
      assert.match(rootHtml, /<script type="module" src="\/app\.js">/);
      const window = new Window({ url: 'http://localhost/' });
      window.document.documentElement.innerHTML = rootHtml;
      assert.ok(window.document.getElementById('conversation'), '#conversation');
      const link = window.document.querySelector('#sidebar-footer a#next-ui-link');
      assert.ok(link, 'a#next-ui-link in the sidebar footer');
      assert.equal(link.getAttribute('href'), '/next/');
    });

    await t.test('/legacy redirects to /legacy/, keeping the query', async () => {
      const r = await get(baseUrl + '/legacy');
      assert.equal(r.status, 301);
      assert.equal(r.headers.get('location'), '/legacy/');
      const q = await get(baseUrl + '/legacy?x=1');
      assert.equal(q.status, 301);
      assert.equal(q.headers.get('location'), '/legacy/?x=1');
    });

    await t.test('/legacy/ serves the same bytes as /, and its assets', async () => {
      const r = await get(baseUrl + '/legacy/');
      assert.equal(r.status, 200);
      assert.equal(await r.text(), rootHtml);
      const app = await get(baseUrl + '/legacy/app.js');
      assert.equal(app.status, 200);
    });

    await t.test('/next redirects to /next/, keeping the query', async () => {
      const r = await get(baseUrl + '/next');
      assert.equal(r.status, 301);
      assert.equal(r.headers.get('location'), '/next/');
      const q = await get(baseUrl + '/next?x=1');
      assert.equal(q.status, 301);
      assert.equal(q.headers.get('location'), '/next/?x=1');
    });

    await t.test('/api is not shadowed by the UI mounts', async () => {
      const r = await get(baseUrl + '/api/health');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') ?? '', /application\/json/);
      assert.equal((await r.json()).app, 'code-conductor');
    });

    await t.test('/pluginBridge.js is served at the root for plugin pages', async () => {
      const r = await get(baseUrl + '/pluginBridge.js');
      assert.equal(r.status, 200);
    });
  } finally { await close(); }
});

async function fixtureApp({ distDir, getState }) {
  const app = express();
  app.use(WEB_MOUNT, webHandler({ distDir, getState }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('webHandler: the built UI, or the building / failed page while there is none', async (t) => {
  await t.test('ready: /next/ serves the dist index and its assets', async () => {
    const distDir = await mkdtemp('cc-web-routes-ready-');
    await fs.mkdir(path.join(distDir, 'assets'));
    await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><p>fixture-index</p>');
    await fs.writeFile(path.join(distDir, 'assets', 'a.js'), 'export const a = 1;');
    const { baseUrl, close } = await fixtureApp({ distDir, getState: () => ({ phase: 'ready', error: null }) });
    try {
      const r = await get(baseUrl + '/next/');
      assert.equal(r.status, 200);
      assert.match(await r.text(), /fixture-index/);
      const a = await get(baseUrl + '/next/assets/a.js');
      assert.equal(a.status, 200);
      assert.match(a.headers.get('content-type') ?? '', /javascript/);
    } finally { await close(); }
  });

  await t.test('building: /next/ is a 503 self-refreshing page', async () => {
    const distDir = await mkdtemp('cc-web-routes-building-');
    const { baseUrl, close } = await fixtureApp({ distDir, getState: () => ({ phase: 'building', error: null }) });
    try {
      const r = await get(baseUrl + '/next/');
      assert.equal(r.status, 503);
      assert.match(r.headers.get('content-type') ?? '', /text\/html/);
      assert.match(await r.text(), /http-equiv="refresh"/);
    } finally { await close(); }
  });

  await t.test('failed: /next/ is a 503 naming the error', async () => {
    const distDir = await mkdtemp('cc-web-routes-failed-');
    const { baseUrl, close } = await fixtureApp({ distDir, getState: () => ({ phase: 'failed', error: 'boom' }) });
    try {
      const r = await get(baseUrl + '/next/');
      assert.equal(r.status, 503);
      assert.match(r.headers.get('content-type') ?? '', /text\/plain/);
      assert.match(await r.text(), /boom/);
    } finally { await close(); }
  });
});
