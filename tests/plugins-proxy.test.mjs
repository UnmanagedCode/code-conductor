import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocket } from 'ws';
import { bootServer, waitFor } from './helpers.mjs';
import { FAKE_PLUGIN_DIR } from './plugin-helpers.mjs';
import { pidAlive } from '../src/plugins/ports.js';

// Boot the full server (helpers tmp root) with the fake plugin installed as
// a project and enabled — every test drives the real /plugins proxy.
async function setup() {
  const boot = await bootServer();
  await fs.cp(FAKE_PLUGIN_DIR, path.join(boot.projectsRoot, 'fakeplug'), { recursive: true });
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
