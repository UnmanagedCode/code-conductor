// GET /api/instances' playbook-binding degrade path (src/routes.ts), isolated
// from the real playbook gate/ledger: a fake gate whose readBindings() rejects
// stands in for a torn ledger file. Pins two things review round 1 flagged —
// (a) a read failure degrades every row to null/null rather than 500ing the
// whole instance list, and (b) it costs exactly ONE warning per request, not
// one per row, which is what moving the read from per-row to a single batch
// call was for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { buildRoutes } from '../src/routes.ts';

function fakeInstances(rows) {
  return { list() { return rows; } };
}

function fakeFailingGate() {
  return {
    calls: 0,
    readBindings() {
      this.calls++;
      return Promise.reject(new Error('ledger read failed'));
    },
  };
}

async function bootRoutes({ instances, playbookGate }) {
  const app = express();
  app.use('/api', buildRoutes({ instances, playbookGate }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise(r => server.close(r)),
  };
}

test('a rejecting playbook gate still returns 200 with playbook:null/stage:null on every row, and warns exactly once', async () => {
  const rows = [
    { id: 'a', sessionId: 'sa', project: 'p' },
    { id: 'b', sessionId: 'sb', project: 'p' },
    { id: 'c', sessionId: 'sc', project: 'p' },
  ];
  const playbookGate = fakeFailingGate();
  const ctx = await bootRoutes({ instances: fakeInstances(rows), playbookGate });
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const res = await fetch(`${ctx.baseUrl}/api/instances`);
    assert.equal(res.status, 200, 'a failing gate must not fail the instance list');
    const body = await res.json();
    assert.equal(body.length, rows.length);
    for (const row of body) {
      assert.deepEqual({ playbook: row.playbook, stage: row.stage }, { playbook: null, stage: null });
    }
    assert.equal(playbookGate.calls, 1, 'the projection is read ONCE for the whole request, not once per row');
    assert.equal(warnings.length, 1, 'exactly one warning for the whole request, not one per row');
  } finally { console.warn = origWarn; await ctx.close(); }
});
