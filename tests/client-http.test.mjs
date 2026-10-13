// Pins the contract of the one client-side fetch helper — shared/http.ts's
// apiFetch, the client counterpart of src/httpError.ts.
//
// Invariant: apiFetch returns the PARSED JSON body on success, and on failure
// throws an Error whose message is the server's `error` string when there is
// one and `HTTP <status>` otherwise — never a JSON SyntaxError, which is what
// the ~20 hand-rolled copies leaked into an alert as `Unexpected token '<'…`
// when a proxy answered with HTML.
//
// It also pins the error classes: a server answer is an ApiError (status,
// body, tail), a fetch() rejection is a NetworkError carrying the one
// SERVER_UNREACHABLE_MESSAGE, and an AbortError passes through untouched.
//
// Same shape as tests/http-error.test.mjs, which pins the server side.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { apiFetch, apiResponse, readApiBody, ApiError, NetworkError, SERVER_UNREACHABLE_MESSAGE } = await import(
  pathToFileURL(path.resolve(__dirname, '..', 'shared', 'http.ts')).href);

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

// fetch() itself rejecting, as it does when the server is down or restarting.
function rejectFetch(err) {
  globalThis.fetch = async () => { throw err; };
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

test('apiFetch: an error body becomes an ApiError carrying status, body and tail', async () => {
  const body = { error: 'worktree is dirty', code: 'WORKTREE_DIRTY', tail: 'M a.txt' };
  stubFetch({ ok: false, status: 409, json: body });
  await assert.rejects(apiFetch('/api/projects/p/worktrees/w', { method: 'DELETE' }), (e) => {
    assert.ok(e instanceof ApiError, 'a server answer is an ApiError');
    assert.equal(e.status, 409);
    assert.deepEqual(e.body, body);
    assert.equal(e.tail, 'M a.txt');
    assert.equal(e.message, 'worktree is dirty');
    return true;
  });
});

test('apiFetch: a non-string tail is not a tail', async () => {
  stubFetch({ ok: false, status: 500, json: { error: 'install crashed', tail: 7 } });
  await assert.rejects(apiFetch('/api/plugins/x/start'), (e) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.tail, undefined);
    return true;
  });
});

test('apiFetch: a non-JSON error body is an ApiError with a null body', async () => {
  // A 401 from a proxy in front of cc: cc itself sends none.
  stubFetch({ ok: false, status: 401, json: 'invalid' });
  await assert.rejects(apiFetch('/api/projects'), (e) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 401);
    assert.equal(e.body, null);
    assert.equal(e.message, 'HTTP 401');
    return true;
  });
});

test('apiFetch: a fetch rejection becomes a NetworkError with the one message and the original as cause', async () => {
  const orig = new TypeError('Failed to fetch');
  rejectFetch(orig);
  await assert.rejects(apiFetch('/api/instances'), (e) => {
    assert.ok(e instanceof NetworkError, 'a fetch rejection is a NetworkError');
    assert.ok(!(e instanceof ApiError), 'a network failure is no server answer');
    assert.equal(e.message, SERVER_UNREACHABLE_MESSAGE);
    assert.ok(e.cause === orig, 'the original rejection is the cause');
    return true;
  });
});

test('apiFetch: an AbortError DOMException passes through untouched', async () => {
  const abort = new DOMException('The operation was aborted.', 'AbortError');
  rejectFetch(abort);
  await assert.rejects(apiFetch('/api/fs/dirs?path=%2F'), (e) => {
    assert.ok(e === abort, 'the identical abort, not a NetworkError');
    return true;
  });
});

test('apiFetch: any error named AbortError passes through untouched', async () => {
  const abort = Object.assign(new Error('aborted by the caller'), { name: 'AbortError' });
  rejectFetch(abort);
  await assert.rejects(apiFetch('/api/fs/dirs?path=%2F'), (e) => {
    assert.ok(e === abort, 'the identical abort, not a NetworkError');
    return true;
  });
});

test('apiFetch: a body-read failure is not a network failure', async () => {
  // Headers arrived; the body stream then broke. Only fetch() rejections are wrapped.
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new TypeError('terminated'); } });
  assert.equal(await apiFetch('/api/projects'), null);
});

test('apiResponse: returns the raw Response for a non-2xx without throwing, through the injected fetchImpl', async () => {
  const calls = [];
  const res = { ok: false, status: 418 };
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return res; };
  const opts = { cache: 'no-store' };
  const got = await apiResponse('/api/health', opts, fetchImpl);
  assert.ok(got === res, 'the Response itself, unchecked');
  assert.deepEqual(calls, [{ url: '/api/health', opts }]);
});

test('apiResponse: an injected fetchImpl rejection is a NetworkError', async () => {
  const orig = new TypeError('NetworkError when attempting to fetch resource.');
  const fetchImpl = async () => { throw orig; };
  await assert.rejects(apiResponse('/api/health', undefined, fetchImpl), (e) => {
    assert.ok(e instanceof NetworkError);
    assert.equal(e.message, SERVER_UNREACHABLE_MESSAGE);
    assert.ok(e.cause === orig, 'the original rejection is the cause');
    return true;
  });
});

test('readApiBody: a 2xx body is returned and a non-2xx throws ApiError', async () => {
  assert.deepEqual(await readApiBody({ ok: true, status: 200, json: async () => ({ a: 1 }) }), { a: 1 });
  await assert.rejects(readApiBody({ ok: false, status: 422, json: async () => ({ error: 'bad tier' }) }), (e) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 422);
    assert.equal(e.message, 'bad tier');
    return true;
  });
});
