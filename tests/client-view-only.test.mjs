// View-only mode's two client chokepoints: shared/http.ts apiResponse (REST) and
// shared/ws.ts send() (frames) refuse a mutating call while shared/viewOnly.ts's
// flag is on, before anything reaches fetch / the socket. Drives the REAL modules.
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

afterEach(() => { vo.setViewOnly(false); });

test('flag off: every method and frame passes', async () => {
  vo.setViewOnly(false);
  const calls = stubFetch();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) await apiFetch('/api/instances', { method });
  assert.equal(calls.length, 4);
  const sent = [];
  installFakeSocket(sent);
  ws.connect();
  for (const t of [...REFUSED_FRAMES, ...READ_FRAMES]) ws.send(t, {});
  assert.deepEqual(sent.map((m) => m.t), [...REFUSED_FRAMES, ...READ_FRAMES]);
});

test('refused REST never reaches fetch and throws ViewOnlyError', async () => {
  vo.setViewOnly(true);
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

test('allowlisted REST passes', async () => {
  vo.setViewOnly(true);
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

test('refused frames are not written; ack rejects, non-ack returns undefined', async () => {
  vo.setViewOnly(true);
  const sent = [];
  installFakeSocket(sent);
  ws.connect();
  for (const t of REFUSED_FRAMES) {
    assert.equal(ws.send(t, {}), undefined, t);
    await assert.rejects(() => ws.send(t, {}, { ack: true }), (e) => e instanceof vo.ViewOnlyError, t);
  }
  assert.deepEqual(sent, []);
});

test('read frames pass', () => {
  vo.setViewOnly(true);
  const sent = [];
  installFakeSocket(sent);
  ws.connect();
  for (const t of READ_FRAMES) ws.send(t, {});
  assert.deepEqual(sent.map((m) => m.t), READ_FRAMES);
});

test('a refusal notifies listeners once per refused call', async () => {
  vo.setViewOnly(true);
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

test('capabilities sets view-only only from a successful health read', async () => {
  // loadCapabilities memoises a success, so each arm gets a fresh module instance.
  const fresh = async (health) => {
    const url = `${pathToFileURL(path.join(SHARED, 'capabilities.ts')).href}?arm=${Math.random()}`;
    globalThis.fetch = async () => health === 'fail' ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => health };
    const m = await import(url);
    await m.loadCapabilities();
  };
  const origWarn = console.warn; console.warn = () => {};
  try {
    vo.setViewOnly(false);
    await fresh('fail');
    assert.equal(vo.isViewOnly(), false, 'a failed load leaves it off');
    await fresh({ capabilities: { viewOnly: true, voice: true } });
    assert.equal(vo.isViewOnly(), true);
    await fresh({ capabilities: { voice: true } });
    assert.equal(vo.isViewOnly(), false, 'a health without the key turns it off');
    vo.setViewOnly(true);
    await fresh('fail');
    assert.equal(vo.isViewOnly(), true, 'a failed load leaves the flag unchanged');
  } finally { console.warn = origWarn; }
  void caps;
});
