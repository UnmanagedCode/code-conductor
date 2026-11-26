// The UI mode's two client chokepoints: shared/http.ts apiResponse (REST) and
// shared/ws.ts send() (frames) refuse a mutating call while shared/viewOnly.ts's
// mode is not `full`, before anything reaches fetch / the socket; under
// `interact` they admit the interactive session's own calls only. Drives the
// REAL modules.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFakeSocket } from './fakeSocket.mjs';

const SHARED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'shared');
const load = (f) => import(pathToFileURL(path.join(SHARED, f)).href);
globalThis.location = { protocol: 'http:', host: 'localhost:0' };
const { apiFetch } = await load('http.ts');
const ws = await load('ws.ts');
const vo = await load('viewOnly.ts');
const focus = await load('focus.ts');
const caps = await load('capabilities.ts');

const REFUSED_FRAMES = ['prompt', 'mode', 'model', 'effort', 'interrupt', 'kill', 'auto_approve_plan', 'playbook_enforcement', 'pristine_draft'];
const READ_FRAMES = ['subscribe', 'unsubscribe', 'pristine_view', 'pristine_leave'];

function stubFetch(json = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => json };
  };
  return calls;
}

afterEach(() => { vo.setUiMode('full'); focus.setFocus(null); focus.setPageFocus(null); vo.setInstanceSessionLookup(null); });

// Invariant: under `full` the chokepoints refuse nothing.
test('full: every method and frame passes', async () => {
  vo.setUiMode('full');
  const calls = stubFetch();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) await apiFetch('/api/instances', { method });
  assert.equal(calls.length, 4);
  const sent = [];
  installFakeSocket(sent);
  ws.connect();
  for (const t of [...REFUSED_FRAMES, ...READ_FRAMES]) ws.send(t, {});
  assert.deepEqual(sent.map((m) => m.t), [...REFUSED_FRAMES, ...READ_FRAMES]);
});

// Invariant: under `view` a mutating REST call outside VIEW_ONLY_REST_ALLOW never
// reaches fetch and rejects with ViewOnlyError.
test('refused REST never reaches fetch and throws ViewOnlyError', async () => {
  vo.setUiMode('view');
  const calls = stubFetch();
  const refused = [
    ['POST', '/api/instances'], ['PUT', '/api/sessions/s/title'], ['DELETE', '/api/projects/x'],
    ['POST', '/api/admin/restart'], ['POST', '/api/sessions/s/summary'], ['POST', '/api/sessions/s/ask'],
    ['POST', '/api/plugins/x/stop'], ['post', '/api/instances'], ['POST', '/api/plugins/library/x/start'],
    ['POST', '/api/sessions/s/viewed/extra'], ['POST', '/api/tts-other'],
  ];
  for (const [method, url] of refused) {
    await assert.rejects(() => apiFetch(url, { method }), (e) => e instanceof vo.ViewOnlyError && e.code === 'VIEW_ONLY', `${method} ${url}`);
  }
  assert.equal(calls.length, 0);
});

// Invariant: under `view` reads and VIEW_ONLY_REST_ALLOW calls (query stripped) pass.
test('allowlisted REST passes', async () => {
  vo.setUiMode('view');
  const calls = stubFetch();
  await apiFetch('/api/instances');
  await apiFetch('/api/anything?x=1', { method: 'GET' });
  await apiFetch('/api/x', { method: 'HEAD' });
  await apiFetch('/api/sessions/s/viewed', { method: 'POST' });
  await apiFetch('/api/sessions/s/viewed?a=b', { method: 'POST' });
  await apiFetch('/api/tts', { method: 'POST' });
  await apiFetch('/api/plugins/x/start', { method: 'POST' });
  assert.equal(calls.length, 7);
});

// Invariant: under `view` a refused frame is never written; an ack send rejects
// with ViewOnlyError and a non-ack send returns undefined.
test('refused frames are not written; ack rejects, non-ack returns undefined', async () => {
  vo.setUiMode('view');
  const sent = [];
  installFakeSocket(sent);
  ws.connect();
  for (const t of REFUSED_FRAMES) {
    assert.equal(ws.send(t, {}), undefined, t);
    await assert.rejects(() => ws.send(t, {}, { ack: true }), (e) => e instanceof vo.ViewOnlyError, t);
  }
  assert.deepEqual(sent, []);
});

// Invariant: under `view` the read-only subscription and presence frames pass.
test('read frames pass', () => {
  vo.setUiMode('view');
  const sent = [];
  installFakeSocket(sent);
  ws.connect();
  for (const t of READ_FRAMES) ws.send(t, {});
  assert.deepEqual(sent.map((m) => m.t), READ_FRAMES);
});

// Invariant: every refused call notifies each refusal listener exactly once;
// allowed calls notify none.
test('a refusal notifies listeners once per refused call', async () => {
  vo.setUiMode('view');
  stubFetch();
  const sent = [];
  installFakeSocket(sent);
  ws.connect();
  let n = 0;
  const off = vo.onViewOnlyRefusal(() => { n++; });
  await apiFetch('/api/instances').catch(() => {});          // GET: allowed
  ws.send('subscribe', {});                                   // allowed frame
  assert.equal(n, 0);
  await apiFetch('/api/instances', { method: 'POST' }).catch(() => {});
  assert.equal(n, 1);
  ws.send('prompt', {});
  assert.equal(n, 2);
  await ws.send('kill', {}, { ack: true }).catch(() => {});
  assert.equal(n, 3);
  off();
  ws.send('prompt', {});
  assert.equal(n, 3, 'unsubscribed');
});

// Invariant: loadCapabilities sets the mode from health's top-level `uiMode`; a
// missing or unknown `uiMode` fails closed to `view`; a failed read leaves the
// mode unchanged; the focus is set from the same read.
test('capabilities sets the UI mode only from a successful health read', async () => {
  // loadCapabilities memoises a success, so each arm gets a fresh module instance.
  const fresh = async (health) => {
    const url = `${pathToFileURL(path.join(SHARED, 'capabilities.ts')).href}?arm=${Math.random()}`;
    globalThis.fetch = async () => health === 'fail' ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => health };
    const m = await import(url);
    await m.loadCapabilities();
  };
  const origWarn = console.warn; console.warn = () => {};
  try {
    vo.setUiMode('full');
    await fresh('fail');
    assert.equal(vo.uiMode(), 'full', 'a failed load leaves it full');
    for (const m of ['view', 'interact', 'full']) {
      await fresh({ capabilities: { voice: true }, uiMode: m, focus: { sessionId: 'root' } });
      assert.equal(vo.uiMode(), m);
    }
    assert.deepEqual(focus.focusState(), { sessionId: 'root' }, 'the focus comes from the same read');
    await fresh({ capabilities: { voice: true } });
    assert.equal(vo.uiMode(), 'view', 'a health without uiMode fails closed to view');
    vo.setUiMode('full');
    await fresh({ capabilities: { voice: true }, uiMode: 'spectate' });
    assert.equal(vo.uiMode(), 'view', 'an unknown uiMode fails closed to view');
    vo.setUiMode('interact');
    await fresh('fail');
    assert.equal(vo.uiMode(), 'interact', 'a failed load leaves the mode unchanged');
  } finally { console.warn = origWarn; }
  void caps;
});

// ── interact ────────────────────────────────────────────────────────────

const ROOT_SID = 'root-sid';
const ROOT_INST = 'root-inst';
const WORKER_INST = 'worker-inst';
const SESSIONS = { [ROOT_INST]: ROOT_SID, [WORKER_INST]: 'worker-sid' };
function interact({ focused = ROOT_SID } = {}) {
  vo.setUiMode('interact');
  focus.setFocus({ sessionId: focused });
  vo.setInstanceSessionLookup((id) => SESSIONS[id] ?? null);
}
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Invariant: under `interact` prompt / interrupt / mode frames pass for the
// focused root's instance and are refused for a worker, an unknown instance,
// a missing id, and for every instance while the focus is null.
test('interact: the root frames pass for the focused root only', async () => {
  interact();
  const sent = [];
  installFakeSocket(sent);
  ws.connect();
  for (const t of ['prompt', 'interrupt', 'mode']) ws.send(t, { id: ROOT_INST });
  assert.deepEqual(sent.map((m) => m.t), ['prompt', 'interrupt', 'mode']);
  sent.length = 0;
  for (const t of ['prompt', 'interrupt', 'mode']) {
    for (const payload of [{ id: WORKER_INST }, { id: 'nobody' }, {}]) {
      await assert.rejects(() => ws.send(t, payload, { ack: true }), (e) => e instanceof vo.ViewOnlyError, `${t} ${JSON.stringify(payload)}`);
    }
  }
  focus.setFocus({ sessionId: null });
  for (const t of ['prompt', 'interrupt', 'mode']) ws.send(t, { id: ROOT_INST });
  assert.deepEqual(sent, []);
});

// Invariant: under `interact` every other mutating frame stays refused, even for
// the focused root.
test('interact: frames outside the exception stay refused for the root', async () => {
  interact();
  const sent = [];
  installFakeSocket(sent);
  ws.connect();
  for (const t of ['kill', 'model', 'effort', 'auto_approve_plan', 'playbook_enforcement', 'pristine_draft']) {
    await assert.rejects(() => ws.send(t, { id: ROOT_INST }, { ack: true }), (e) => e instanceof vo.ViewOnlyError, t);
  }
  assert.deepEqual(sent, []);
});

// Invariant: under `interact` the REST exception admits only calls addressing
// the interactive session — its restore (both URL shapes), its resume
// (POST /api/instances with resume = that session) and its instance's respawn;
// a fresh spawn, another session's resume or restore, a non-JSON body, a
// worker's respawn and a root DELETE are refused before fetch.
test('interact: the REST exception addresses the interactive session only', async () => {
  interact();
  const calls = stubFetch();
  const allowed = [
    [`/api/projects/.conduct/sessions/${ROOT_SID}/restore`, { method: 'POST' }],
    [`/api/projects/.conduct/worktrees/w1/sessions/${ROOT_SID}/restore`, { method: 'POST' }],
    ['/api/instances', json({ project: '.conduct', resume: ROOT_SID })],
    [`/api/instances/${ROOT_INST}/respawn`, { method: 'POST' }],
    ['/api/transcribe', { method: 'POST', body: new Uint8Array([1]) }],
  ];
  for (const [url, opts] of allowed) await apiFetch(url, opts);
  assert.equal(calls.length, allowed.length);
  const refused = [
    ['/api/projects/.conduct/sessions/other/restore', { method: 'POST' }],
    ['/api/projects/.conduct/worktrees/w1/sessions/other/restore', { method: 'POST' }],
    ['/api/instances', json({ project: '.conduct' })],
    ['/api/instances', json({ project: '.conduct', resume: 'other' })],
    ['/api/instances', { method: 'POST', body: `resume=${ROOT_SID}` }],
    ['/api/instances', { method: 'POST' }],
    [`/api/instances/${WORKER_INST}/respawn`, { method: 'POST' }],
    [`/api/instances/${ROOT_INST}`, { method: 'DELETE' }],
    [`/api/sessions/${ROOT_SID}/title`, { method: 'PUT' }],
  ];
  for (const [url, opts] of refused) {
    await assert.rejects(() => apiFetch(url, opts), (e) => e instanceof vo.ViewOnlyError, `${opts.method} ${url}`);
  }
  assert.equal(calls.length, allowed.length, 'no refused call reached fetch');
});

// Invariant: the session-addressing REST exception is gone while the focus is
// null (nothing is interactive), and /api/transcribe is admitted under
// `interact` only, never under `view`.
test('interact: null focus admits no session call; transcribe is interact-only', async () => {
  interact({ focused: null });
  focus.setFocus({ sessionId: null });
  const calls = stubFetch();
  await assert.rejects(() => apiFetch('/api/instances', json({ resume: ROOT_SID })), (e) => e instanceof vo.ViewOnlyError);
  await apiFetch('/api/transcribe', { method: 'POST' });
  assert.equal(calls.length, 1);
  vo.setUiMode('view');
  await assert.rejects(() => apiFetch('/api/transcribe', { method: 'POST' }), (e) => e instanceof vo.ViewOnlyError);
  assert.equal(calls.length, 1);
});

// Invariant: while the focus is null nothing is interactive, so an id that maps
// to no session never matches it: a prompt / interrupt / mode frame for an
// unknown instance (the lookup answers null), a POST /api/instances with no
// resume or a non-JSON body, and a respawn of an unknown instance are all
// refused before the socket or fetch.
test('interact, null focus: an id that maps to no session is not admitted', async () => {
  interact();
  focus.setFocus({ sessionId: null });
  const sent = [];
  installFakeSocket(sent);
  ws.connect();
  for (const t of ['prompt', 'interrupt', 'mode']) {
    await assert.rejects(() => ws.send(t, { id: 'nobody' }, { ack: true }), (e) => e instanceof vo.ViewOnlyError, t);
  }
  assert.deepEqual(sent, []);
  const calls = stubFetch();
  for (const [url, opts] of [
    ['/api/instances', json({ project: '.conduct' })],
    ['/api/instances', { method: 'POST', body: 'not json' }],
    ['/api/instances', { method: 'POST' }],
    ['/api/instances/nobody/respawn', { method: 'POST' }],
  ]) {
    await assert.rejects(() => apiFetch(url, opts), (e) => e instanceof vo.ViewOnlyError, `${opts.body ?? 'no body'} ${url}`);
  }
  assert.equal(calls.length, 0);
});

// Invariant: sessionViewOnly is false only for the focused session under
// `interact`, true for every session under `view`, false for all under `full`;
// subscribeSessionViewOnly fires on a mode change and on a focus change.
test('sessionViewOnly and its subscription follow the mode and the focus', () => {
  let fired = 0;
  const off = vo.subscribeSessionViewOnly(() => { fired++; });
  try {
    vo.setUiMode('full');
    assert.equal(vo.sessionViewOnly(ROOT_SID), false);
    vo.setUiMode('view');
    assert.equal(fired, 1);
    focus.setFocus({ sessionId: ROOT_SID });
    assert.equal(fired, 2);
    assert.equal(vo.sessionViewOnly(ROOT_SID), true);
    vo.setUiMode('interact');
    assert.equal(vo.sessionViewOnly(ROOT_SID), false);
    assert.equal(vo.sessionViewOnly('worker-sid'), true);
    assert.equal(vo.sessionViewOnly(null), true);
    assert.equal(vo.isViewOnly(), true, 'the global gate stays on under interact');
  } finally { off(); }
  focus.setFocus(null);
  assert.equal(fired, 3, 'unsubscribed from both');
});

// ── the URL focus marker ────────────────────────────────────────────────

// Invariant: the marker never grants control — under `interact`, with only a page
// focus, the marked session is not interactive: its frames and REST calls are refused.
// With both, the server's session is interactive and the marked one is not.
test('interact: a page focus makes no session interactive', async () => {
  vo.setUiMode('interact');
  vo.setInstanceSessionLookup((id) => SESSIONS[id] ?? null);
  focus.setPageFocus({ sessionId: ROOT_SID });
  assert.equal(vo.isInteractiveSession(ROOT_SID), false);
  assert.equal(vo.sessionViewOnly(ROOT_SID), true);
  const sent = [];
  installFakeSocket(sent);
  ws.connect();
  await assert.rejects(() => ws.send('prompt', { id: ROOT_INST }, { ack: true }), (e) => e instanceof vo.ViewOnlyError);
  assert.deepEqual(sent, []);
  const calls = stubFetch();
  await assert.rejects(() => apiFetch(`/api/sessions/${ROOT_SID}/resume`, json({})), (e) => e instanceof vo.ViewOnlyError);
  assert.equal(calls.length, 0);
  focus.setFocus({ sessionId: 'other-sid' });
  assert.equal(vo.isInteractiveSession('other-sid'), true);
  assert.equal(vo.isInteractiveSession(ROOT_SID), false);
});

// Invariant: the marker does not move the access mode — `view` stays view-only for
// the marked session, `full` stays editable.
test('a page focus leaves the access mode alone', async () => {
  focus.setPageFocus({ sessionId: ROOT_SID });
  vo.setUiMode('view');
  assert.equal(vo.sessionViewOnly(ROOT_SID), true);
  const calls = stubFetch();
  await assert.rejects(() => apiFetch('/api/instances', { method: 'POST' }), (e) => e instanceof vo.ViewOnlyError);
  assert.equal(calls.length, 0);
  vo.setUiMode('full');
  assert.equal(vo.isViewOnly(), false);
  assert.equal(vo.sessionViewOnly(ROOT_SID), false);
});
