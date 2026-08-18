// Pins the contract of the one client-side fetch helper — public/http.js's
// apiFetch, the client counterpart of src/httpError.ts.
//
// Invariant: apiFetch returns the PARSED JSON body on success, and on failure
// throws an Error whose message is the server's `error` string when there is
// one and `HTTP <status>` otherwise — never a JSON SyntaxError, which is what
// the ~20 hand-rolled copies leaked into an alert as `Unexpected token '<'…`
// when a proxy answered with HTML.
//
// Same shape as tests/http-error.test.mjs, which pins the server side.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { apiFetch } = await import(
  pathToFileURL(path.resolve(__dirname, '..', 'public', 'http.js')).href);

// Minimal Response stand-in: `json()` either resolves the parsed body or
// rejects the way a real Response does on a non-JSON payload.
function stubFetch({ ok, status, json }) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok, status,
      json: json === 'invalid'
        ? async () => { throw new SyntaxError("Unexpected token '<', \"<html>\"... is not valid JSON"); }
        : async () => json,
    };
  };
  return calls;
}

test('apiFetch: 2xx with a JSON body returns the parsed body', async () => {
  const calls = stubFetch({ ok: true, status: 200, json: { id: 'inst-1', ok: true } });
  const body = await apiFetch('/api/instances', { method: 'POST' });
  assert.deepEqual(body, { id: 'inst-1', ok: true });
  assert.deepEqual(calls, [{ url: '/api/instances', opts: { method: 'POST' } }],
    'url and opts pass through untouched');
});

test('apiFetch: 2xx with a non-JSON body returns null rather than throwing', async () => {
  // A bodyless 200/204. Only callers that ignore the return value hit this.
  stubFetch({ ok: true, status: 204, json: 'invalid' });
  assert.equal(await apiFetch('/api/whatever'), null);
});

test('apiFetch: an error body\'s `error` string becomes the thrown message', async () => {
  stubFetch({ ok: false, status: 400, json: { error: "project 'demo' already exists" } });
  await assert.rejects(apiFetch('/api/projects', { method: 'POST' }), {
    name: 'Error',
    message: "project 'demo' already exists",
  });
});

test('apiFetch: a non-JSON error body throws HTTP <status>, not a SyntaxError', async () => {
  stubFetch({ ok: false, status: 502, json: 'invalid' });
  await assert.rejects(apiFetch('/api/instances'), (e) => {
    assert.equal(e.name, 'Error', 'a SyntaxError must never escape');
    assert.equal(e.message, 'HTTP 502');
    return true;
  });
});

test('apiFetch: a JSON error body with no `error` key throws HTTP <status>', async () => {
  // Previously `new Error(undefined)` → message '' → `alert("sync failed: ")`.
  stubFetch({ ok: false, status: 500, json: { detail: 'nope' } });
  await assert.rejects(apiFetch('/api/instances'), { message: 'HTTP 500' });
});
