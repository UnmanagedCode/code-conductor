// wsHub's 'list_changed' listener — the manager event an instance spawn or
// exit fires. It hints clients to re-read both lists, and leaves the cached git
// facts alone: those facts hold nothing derived from the instance list (session
// ids and counts are computed per request), and a worktree record write
// invalidates them through projectsChanged.
//
// Same bare-EventEmitter hub as tests/wshub-playbook-hint.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { attachWsHub } from '../src/wsHub.ts';
import { getOrCompute, _resetForTest } from '../src/projectsCache.ts';
import { markProjectsChanged } from '../src/projectsChanged.ts';
import { waitFor } from './helpers.mjs';

async function bootHub() {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const instances = Object.assign(new EventEmitter(), { get() { return undefined; }, pristine: { drop() {} } });
  attachWsHub({ wss, instances });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    instances,
    url: `ws://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise(r => server.close(r));
    },
  };
}

function wsClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.on('message', raw => { messages.push(JSON.parse(raw.toString())); });
    ws.once('open', () => resolve({
      messages,
      close: () => new Promise(r => { ws.once('close', r); ws.close(); }),
    }));
    ws.once('error', reject);
  });
}

test('list_changed broadcasts both hints and keeps cached git facts', async () => {
  _resetForTest(60_000);
  const hub = await bootHub();
  const client = await wsClient(hub.url);
  try {
    await waitFor(() => client.messages.some(m => m.t === 'hello'));
    client.messages.length = 0;
    let computed = 0;
    const compute = async () => ++computed;
    await getOrCompute('local:p', compute);
    hub.instances.emit('list_changed');
    await waitFor(() => client.messages.some(m => m.t === 'instances') && client.messages.some(m => m.t === 'projects'));
    await getOrCompute('local:p', compute);
    assert.equal(computed, 1, 'the cached facts survived the spawn/exit hint');
  } finally { await client.close(); await hub.close(); _resetForTest(); }
});

test('a projectsChanged signal still invalidates cached git facts', async () => {
  _resetForTest(60_000);
  const hub = await bootHub();
  const client = await wsClient(hub.url);
  try {
    await waitFor(() => client.messages.some(m => m.t === 'hello'));
    client.messages.length = 0;
    let computed = 0;
    const compute = async () => ++computed;
    await getOrCompute('local:p', compute);
    markProjectsChanged();
    await waitFor(() => client.messages.some(m => m.t === 'projects'));
    await getOrCompute('local:p', compute);
    assert.equal(computed, 2, 'a committed project/worktree record change recomputes');
  } finally { await client.close(); await hub.close(); _resetForTest(); }
});
