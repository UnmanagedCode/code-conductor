// The Conductors lens's × reuses sessionActions' deleteSession with
// projectName '.conduct'. These drive the real deleteSession against a
// scripted fetch: which requests a conductor archive sends, and that closing
// the open conductor drops the selection while closing another one does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const load = (name) => import(pathToFileURL(path.join(PUB, name)).href + `?t=${Math.random()}`);

const CONDUCTOR = { id: 'inst-C', sessionId: 'C', project: '.conduct' };

async function setup({ activeId, statuses = [200], confirmAnswer = true } = {}) {
  const { installSessionActions } = await load('sessionActions.js');
  const fetches = [];
  const alerts = [];
  const confirms = [];
  const activeSets = [];
  const unread = [];
  const refreshes = { projects: 0, instances: 0 };
  const queue = [...statuses];
  globalThis.alert = (m) => alerts.push(String(m));
  globalThis.confirm = (m) => { confirms.push(String(m)); return confirmAnswer; };
  globalThis.fetch = async (url, opts) => {
    fetches.push({ url: String(url), method: opts?.method });
    const status = queue.length > 0 ? queue.shift() : 200;
    return { ok: status >= 200 && status < 300, status, json: async () => ({ ok: status === 200 }) };
  };
  const handles = installSessionActions({
    getActiveId: () => activeId,
    setActiveId: (id) => activeSets.push(id),
    getInstances: () => [CONDUCTOR],
    refreshProjects: async () => { refreshes.projects++; },
    refreshInstances: async () => { refreshes.instances++; },
    selectInstance: () => {},
    sidebar: { sessionsCache: new Map() },
    clearUnread: (sid) => unread.push(sid),
    headerUpdate: () => {},
  });
  return { ...handles, fetches, alerts, confirms, activeSets, unread, refreshes };
}

const args = (o = {}) => ({ projectName: '.conduct', worktreeName: null, sessionId: 'C', preview: 'Alpha', synthetic: false, ...o });

test('archiving the open conductor on disk: archive POST, force retry on 409, selection dropped', async () => {
  const t = await setup({ activeId: 'inst-C', statuses: [409, 200] });
  await t.deleteSession(args());
  assert.deepEqual(t.fetches, [
    { url: '/api/projects/.conduct/sessions/C/archive', method: 'POST' },
    { url: '/api/projects/.conduct/sessions/C/archive?force=1', method: 'POST' },
  ]);
  assert.deepEqual(t.activeSets, [null], 'the open conductor is deselected once');
  assert.deepEqual(t.unread, ['C']);
  assert.deepEqual(t.refreshes, { projects: 1, instances: 1 });
  assert.deepEqual(t.alerts, []);
});

test('archiving a conductor that is not open leaves the selection alone', async () => {
  const t = await setup({ activeId: 'inst-other', statuses: [200] });
  await t.deleteSession(args());
  assert.deepEqual(t.fetches, [{ url: '/api/projects/.conduct/sessions/C/archive', method: 'POST' }]);
  assert.deepEqual(t.activeSets, [], 'setActiveId is never called');
  assert.deepEqual(t.refreshes, { projects: 1, instances: 1 });
});

test('a synthetic open conductor is killed by instance id, never archived by session', async () => {
  const t = await setup({ activeId: 'inst-C' });
  await t.deleteSession(args({ synthetic: true }));
  assert.deepEqual(t.fetches, [{ url: '/api/instances/inst-C', method: 'DELETE' }]);
  assert.deepEqual(t.activeSets, [null]);
  assert.deepEqual(t.unread, ['C']);
  assert.deepEqual(t.refreshes, { projects: 1, instances: 1 });
});

test('declining the confirm sends nothing', async () => {
  const d = await setup({ activeId: 'inst-C', confirmAnswer: false });
  await d.deleteSession(args());
  assert.equal(d.confirms.length, 1, 'the user was asked');
  assert.match(d.confirms[0], /^Archive session "Alpha"\?/);
  assert.deepEqual(d.fetches, []);
  assert.deepEqual(d.activeSets, []);
});
