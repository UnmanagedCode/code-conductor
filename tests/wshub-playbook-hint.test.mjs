// wsHub's 'playbook_changed' listener — the manager event the playbook gate
// fires after a `spawn`/`transition` ledger append folds (src/mcp/playbookGate.ts),
// which is what makes a worker's stage label refresh live on the Sub-agents
// strip without the client polling. Pinned in isolation, against a bare
// EventEmitter standing in for InstanceManagerLike: attachWsHub only ever calls
// `.on(...)` on the manager at wiring time (and `.get(id)` from inside a message
// handler this test never drives), so nothing else needs to exist — and a fake
// this thin means the ONLY thing that can produce a frame is the emit under
// test, unlike a full server boot where other traffic could coincidentally
// satisfy the assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { attachWsHub } from '../src/wsHub.ts';
import { waitFor } from './helpers.mjs';

async function bootHub() {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const instances = Object.assign(new EventEmitter(), { get() { return undefined; } });
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
    ws.on('message', raw => {
      try { messages.push(JSON.parse(raw.toString())); } catch { messages.push(raw.toString()); }
    });
    ws.once('open', () => resolve({
      messages,
      close: () => new Promise(r => { ws.once('close', r); ws.close(); }),
    }));
    ws.once('error', reject);
  });
}

test('a playbook_changed emit delivers exactly one {t:"instances"} frame and no {t:"projects"}', async () => {
  const hub = await bootHub();
  const client = await wsClient(hub.url);
  try {
    // The connection's own greeting, so it isn't mistaken for the hint under test.
    await waitFor(() => client.messages.some(m => m.t === 'hello'));
    client.messages.length = 0;

    hub.instances.emit('playbook_changed', { sessionId: 'w1' });

    await waitFor(() => client.messages.some(m => m.t === 'instances'));
    // Give any further frame (a stray `projects`, or a second `instances`)
    // real chances to land before concluding none will.
    await assert.rejects(
      () => waitFor(() => client.messages.length > 1, { timeout: 500, interval: 20 }),
      /timeout/,
      'no second frame of any kind may follow the one instances hint');
    assert.deepEqual(client.messages, [{ t: 'instances' }]);
  } finally { await client.close(); await hub.close(); }
});
