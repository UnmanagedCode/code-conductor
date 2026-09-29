// sessionActions' promoteSession backs the ↑ on both a temp worker row and a
// live temp conductor row. These drive the real promoteSession against a
// scripted fetch: which confirm each gets, which request it sends, and which
// refreshes follow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const load = (name) => import(pathToFileURL(path.join(PUB, name)).href + `?t=${Math.random()}`);

async function setup({ statuses = [200], confirmAnswer = true } = {}) {
  const { installSessionActions } = await load('sessionActions.js');
  const fetches = [];
  const alerts = [];
  const confirms = [];
  const refreshes = { projects: 0, instances: 0 };
  const queue = [...statuses];
  globalThis.alert = (m) => alerts.push(String(m));
  globalThis.confirm = (m) => { confirms.push(String(m)); return confirmAnswer; };
  globalThis.fetch = async (url, opts) => {
    fetches.push({ url: String(url), method: opts?.method });
    const status = queue.length > 0 ? queue.shift() : 200;
    return { ok: status >= 200 && status < 300, status, json: async () => ({ ok: status === 200, error: 'boom' }) };
  };
  const handles = installSessionActions({
    getActiveId: () => null,
    setActiveId: () => {},
    getInstances: () => [],
    refreshProjects: async () => { refreshes.projects++; },
    refreshInstances: async () => { refreshes.instances++; },
    selectInstance: () => {},
    sidebar: { sessionsCache: new Map() },
    clearUnread: () => {},
    headerUpdate: () => {},
  });
  return { ...handles, fetches, alerts, confirms, refreshes };
}

const CONDUCTOR = { projectName: '.conduct', instanceId: 'inst-C', preview: 'Alpha' };

test('promoting a conductor asks to make it persistent, POSTs promote, then refreshes instances only, like a worker', async () => {
  const t = await setup();
  await t.promoteSession(CONDUCTOR);
  assert.deepEqual(t.confirms, [
    'Make this conductor persistent?\n\nAlpha\n\nIt will move to Inactive instead of being archived when it stops.',
  ]);
  assert.ok(!t.confirms[0].includes('.conduct'), 'the confirm never names the .conduct project');
  assert.deepEqual(t.fetches, [{ url: '/api/instances/inst-C/promote', method: 'POST' }]);
  assert.deepEqual(t.refreshes, { projects: 0, instances: 1 });
  assert.deepEqual(t.alerts, []);
});

test('promoting a worker keeps the temp-session confirm and refreshes instances only', async () => {
  const t = await setup();
  await t.promoteSession({ projectName: 'proj', instanceId: 'inst-w', preview: 'do the work' });
  assert.deepEqual(t.confirms, [
    "Make this temp session persistent in 'proj'?\n\ndo the work\n\nThe transcript will be preserved when the session stops.",
  ]);
  assert.deepEqual(t.fetches, [{ url: '/api/instances/inst-w/promote', method: 'POST' }]);
  assert.deepEqual(t.refreshes, { projects: 0, instances: 1 });
});

test('declining the conductor confirm sends nothing and refreshes nothing', async () => {
  const t = await setup({ confirmAnswer: false });
  await t.promoteSession(CONDUCTOR);
  assert.equal(t.confirms.length, 1, 'the user was asked');
  assert.deepEqual(t.fetches, []);
  assert.deepEqual(t.refreshes, { projects: 0, instances: 0 });
});

test('a failed conductor promote alerts and refreshes nothing', async () => {
  const t = await setup({ statuses: [500] });
  await t.promoteSession(CONDUCTOR);
  assert.equal(t.fetches.length, 1);
  assert.equal(t.alerts.length, 1);
  assert.match(t.alerts[0], /^Failed to make persistent: /);
  assert.deepEqual(t.refreshes, { projects: 0, instances: 0 });
});
