// src/ndjsonAction.ts — the streamed error arm of the NDJSON contract the
// plugin library, self-update and Claude update routes share.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { streamNdjsonAction } from '../src/ndjsonAction.ts';

const THROWN = {
  'an Error': Object.assign(new Error('pull failed'), { tail: 'fatal: x' }),
  'a string': 'boom',
  'a plain object with a tail': { tail: 'partial output' },
  'null': null,
};

test('a rejection after onValidated is one result line: the message via errMessage (\'internal error\' for a non-Error), and the tail when it has one', async (t) => {
  const app = express();
  app.post('/t/:kind', (req, res, next) => streamNdjsonAction(res, next, async (onChunk, onValidated) => {
    onValidated();
    onChunk('step', 'working\n');
    throw THROWN[req.params.kind];
  }));
  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const expected = {
      'an Error': { type: 'result', ok: false, error: 'pull failed', tail: 'fatal: x' },
      'a string': { type: 'result', ok: false, error: 'internal error' },
      'a plain object with a tail': { type: 'result', ok: false, error: 'internal error', tail: 'partial output' },
      'null': { type: 'result', ok: false, error: 'internal error' },
    };
    for (const kind of Object.keys(THROWN)) {
      await t.test(`thrown ${kind}`, async () => {
        const res = await fetch(`${base}/t/${encodeURIComponent(kind)}`, { method: 'POST' });
        assert.equal(res.status, 200);
        const lines = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
        assert.deepEqual(lines, [{ type: 'chunk', phase: 'step', text: 'working\n' }, expected[kind]]);
      });
    }
  } finally {
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
  }
});
