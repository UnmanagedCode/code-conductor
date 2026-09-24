// resumeSession({archived}) — the Missions → Inactive resume of an archived
// conductor. It must un-archive through the same helper Settings → Archived's
// Restore uses (public/archivedSessions.js) BEFORE resuming, or the resumed
// session stays archived and a later Restore 409s. A non-archived resume must
// not touch the restore route.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const load = (name) => import(pathToFileURL(path.join(PUB, name)).href + `?t=${Math.random()}`);

async function install(fetchImpl) {
  const { installSessionActions } = await load('sessionActions.js');
  const calls = [];
  let alerted = null, selected = null;
  globalThis.alert = (m) => { alerted = m; };
  globalThis.fetch = async (url, opts = {}) => {
    calls.push(`${opts.method ?? 'GET'} ${url}`);
    return fetchImpl(url, opts);
  };
  const { resumeSession } = installSessionActions({
    getActiveId: () => null, setActiveId: () => {}, getInstances: () => [],
    refreshProjects: async () => {}, refreshInstances: async () => {},
    selectInstance: (id) => { selected = id; }, sidebar: {}, clearUnread: () => {},
  });
  return { resumeSession, calls, alerted: () => alerted, selected: () => selected };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

test('an archived resume restores the session first, then resumes it', async () => {
  const h = await install(async (url) => (url === '/api/instances' ? ok({ id: 'inst-T' }) : ok({ ok: true })));
  await h.resumeSession({ projectName: '.conduct', worktreeName: null, sessionId: 'T', archived: true });
  assert.deepEqual(h.calls, [
    'POST /api/projects/.conduct/sessions/T/restore',
    'POST /api/instances',
  ]);
  assert.equal(h.selected(), 'inst-T');
  assert.equal(h.alerted(), null);
});

test('a non-archived resume never calls the restore route', async () => {
  const h = await install(async () => ok({ id: 'inst-D' }));
  await h.resumeSession({ projectName: '.conduct', worktreeName: null, sessionId: 'D' });
  assert.deepEqual(h.calls, ['POST /api/instances']);
});

test('a refused restore alerts and does not resume', async () => {
  const h = await install(async (url) => (url.endsWith('/restore')
    ? { ok: false, status: 409, json: async () => ({ error: 'not archived' }) }
    : ok({ id: 'x' })));
  await h.resumeSession({ projectName: '.conduct', worktreeName: null, sessionId: 'T', archived: true });
  assert.deepEqual(h.calls, ['POST /api/projects/.conduct/sessions/T/restore']);
  assert.match(String(h.alerted()), /not archived/);
});
