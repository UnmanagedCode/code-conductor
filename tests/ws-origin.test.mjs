// Invariant: a browser WebSocket upgrade (one carrying Origin) is admitted only
// when its Origin's host:port equals the Host it addressed; a refusal is a raw
// 403 that reaches neither the wsHub nor the plugin proxy (which would lazy-start
// the child). An upgrade with no Origin is a non-browser client and is admitted.
// Contract: docs/protocol.md → Handshake: Origin check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { bootServer, registerLocalProject } from './helpers.mjs';
import { FAKE_PLUGIN_DIR } from './plugin-helpers.mjs';

async function setup() {
  const boot = await bootServer();
  const dir = path.join(boot.projectsRoot, 'fakeplug');
  await fs.cp(FAKE_PLUGIN_DIR, dir, { recursive: true });
  await registerLocalProject('fakeplug', dir);
  await boot.pluginHost.enable('fake-plugin');
  return boot;
}

// Resolves with how the handshake ended: { open, ws } | { status } | { error }.
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

const pluginWsUrl = (boot) => boot.baseUrl.replace('http://', 'ws://') + '/plugins/fake-plugin/ws-echo';

async function withBoot(fn) {
  const boot = await setup();
  try { await fn(boot); } finally { await boot.close(); }
}

const outcome = (r) => (r.open ? 'open' : JSON.stringify(r));

function assertRefused(r) {
  r.ws?.close();
  assert.equal(r.status, 403, `expected a 403 refusal, got ${outcome(r)}`);
}

function assertOpen(r) {
  r.ws?.close();
  assert.equal(r.open, true, `expected the upgrade to open, got ${outcome(r)}`);
}

test('/ws: a foreign Origin is refused with 403 before the hub sees it', () => withBoot(async (boot) => {
  assertRefused(await attempt(boot.wsUrl, { origin: 'http://evil.example' }));
  assert.equal(boot.wss.clients.size, 0);
}));

test('/ws: an Origin equal to cc\'s own origin opens', () => withBoot(async (boot) => {
  assertOpen(await attempt(boot.wsUrl, { origin: boot.baseUrl }));
}));

test('/ws: no Origin (a non-browser client) opens', () => withBoot(async (boot) => {
  assertOpen(await attempt(boot.wsUrl));
}));

test('/ws: the same host on another port is refused', () => withBoot(async (boot) => {
  const other = Number(new URL(boot.baseUrl).port) + 1;
  assertRefused(await attempt(boot.wsUrl, { origin: `http://127.0.0.1:${other}` }));
}));

test('/ws: a LAN share that forwards Host unchanged opens', () => withBoot(async (boot) => {
  assertOpen(await attempt(boot.wsUrl, { origin: 'http://192.168.1.20:9000', host: '192.168.1.20:9000' }));
}));

test('/ws: an https tunnel with a portless Host opens', () => withBoot(async (boot) => {
  assertOpen(await attempt(boot.wsUrl, { origin: 'https://abc.trycloudflare.com', host: 'abc.trycloudflare.com' }));
}));

test('/plugins: a foreign Origin is refused and never lazy-starts the child', () => withBoot(async (boot) => {
  assertRefused(await attempt(pluginWsUrl(boot), { origin: 'http://evil.example' }));
  assert.equal(boot.pluginHost.runtimeInfo('fake-plugin').status, 'stopped');
}));

test('/plugins: a same-origin upgrade (the plugin iframe) echoes', () => withBoot(async (boot) => {
  const r = await attempt(pluginWsUrl(boot), { origin: boot.baseUrl });
  assert.equal(r.open, true, `expected the upgrade to open, got ${outcome(r)}`);
  const echoed = await new Promise((resolve, reject) => {
    r.ws.on('message', (d) => resolve(d.toString()));
    r.ws.on('error', reject);
    r.ws.send('same-origin echo');
  });
  r.ws.close();
  assert.equal(echoed, 'same-origin echo');
}));
