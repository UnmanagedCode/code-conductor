// Pins the shape of the one shared statusCode-bearing Error constructor.
//
// Invariant: httpError produces a real Error whose `message` is the caller's
// string and whose `statusCode` is the caller's number, with `extra` fields
// merged on top — the exact contract the express error handler (routes.ts) and
// codeForStatus (mcp/server.ts) read. Every module that used to declare its own
// copy now imports this one, so a change here changes every REST/MCP refusal at
// once; this test is what makes that change visible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpError } from '../src/httpError.ts';

test('httpError carries the message and statusCode the caller passed', () => {
  const e = httpError(404, "project 'x' not found");
  assert.ok(e instanceof Error);
  assert.equal(e.message, "project 'x' not found");
  assert.equal(e.statusCode, 404);
  assert.ok(e.stack, 'a real Error carries a stack');
});

test('extra fields are merged onto the error (the plugin 503 body shape)', () => {
  const e = httpError(503, 'plugin crashed', { status: 'crashed', tail: 'boom', retryAfter: 7 });
  assert.equal(e.statusCode, 503);
  assert.equal(e.message, 'plugin crashed');
  assert.equal(e.status, 'crashed');
  assert.equal(e.tail, 'boom');
  assert.equal(e.retryAfter, 7);
});

test('omitting extra leaves exactly one own enumerable field', () => {
  // Guards against a future default that quietly attaches something else —
  // e.g. a `code` that would collide with the Node error-code convention
  // summarize.ts still uses for ENOENT.
  const e = httpError(400, 'bad');
  assert.deepEqual(Object.keys(e), ['statusCode']);
});
