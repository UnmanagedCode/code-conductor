// The × of a session row / strip entry is ONE step down from where the session
// is: a live persistent session is stopped (transcript kept), a live temp or
// not-live one is archived. These drive the real closeSession / stopSession /
// deleteSession against a scripted fetch: which request each state sends, when
// the user is asked first, and what the sidebar bookkeeping does afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const load = (name) => import(pathToFileURL(path.join(PUB, name)).href + `?t=${Math.random()}`);

const { closeActionOf, CLOSE_TITLES, stopNeedsConfirm } = await load('closeAction.js');

async function setup({ activeId = null, statuses = [200], confirmAnswer = true, instances = [{ id: 'inst-X', sessionId: 'X', project: 'proj' }] } = {}) {
  const { installSessionActions } = await load('sessionActions.js');
  const fetches = [];
  const alerts = [];
  const confirms = [];
  const activeSets = [];
  const unread = [];
  const refreshes = { projects: 0, instances: 0 };
  const queue = [...statuses];
  const cache = new Map([['proj', 1], ['proj:wt', 1]]);
  globalThis.alert = (m) => alerts.push(String(m));
  globalThis.confirm = (m) => { confirms.push(String(m)); return confirmAnswer; };
  globalThis.fetch = async (url, opts) => {
    fetches.push({ url: String(url), method: opts?.method });
    const status = queue.length > 0 ? queue.shift() : 200;
    return { ok: status >= 200 && status < 300, status, json: async () => (status === 200 ? { ok: true } : { error: 'boom' }) };
  };
  const handles = installSessionActions({
    getActiveId: () => activeId,
    setActiveId: (id) => activeSets.push(id),
    getInstances: () => instances,
    refreshProjects: async () => { refreshes.projects++; },
    refreshInstances: async () => { refreshes.instances++; },
    selectInstance: () => {},
    sidebar: { sessionsCache: cache },
    clearUnread: (sid) => unread.push(sid),
    headerUpdate: () => {},
  });
  return { ...handles, fetches, alerts, confirms, activeSets, unread, refreshes, cache };
}

const args = (o = {}) => ({
  projectName: 'proj', worktreeName: null, sessionId: 'X', instanceId: 'inst-X',
  preview: 'Alpha', status: 'idle', temp: false, synthetic: false, ...o,
});

const STOP_REQ = [{ url: '/api/instances/inst-X', method: 'DELETE' }];
const ARCHIVE_REQ = { url: '/api/projects/proj/sessions/X/archive', method: 'POST' };

// Invariant: the state → action mapping is live && !temp → stop, else archive; a missing instanceId or status is never live.
test('closeActionOf: one step down — stop only a live persistent session', async (t) => {
  const cases = [
    ['live idle persistent', { instanceId: 'i', status: 'idle', temp: false }, 'stop'],
    ['live busy persistent', { instanceId: 'i', status: 'turn', temp: false }, 'stop'],
    ['live temp', { instanceId: 'i', status: 'idle', temp: true }, 'archive'],
    ['exited persistent', { instanceId: 'i', status: 'exited', temp: false }, 'archive'],
    ['crashed persistent', { instanceId: 'i', status: 'crashed', temp: false }, 'archive'],
    ['disk row, no instance', { instanceId: null, status: null, temp: false }, 'archive'],
    ['instance id but no status', { instanceId: 'i', status: null, temp: false }, 'archive'],
    ['status but no instance id (the row renders offline)', { instanceId: null, status: 'offline', temp: false }, 'archive'],
  ];
  for (const [name, input, want] of cases) {
    await t.test(name, () => assert.equal(closeActionOf(input), want));
  }
});

// Invariant: the two tooltip / aria-label strings are exactly these, keyed by action.
test('CLOSE_TITLES names each action', () => {
  assert.deepEqual(CLOSE_TITLES, { stop: 'Stop session', archive: 'Archive session (keeps history)' });
});

// Invariant: only plain idle stops without a prompt; every other status (turn, running, spawning) is busy.
test('stopNeedsConfirm: idle is the only status that stops silently', async (t) => {
  assert.equal(stopNeedsConfirm('idle'), false);
  for (const s of ['turn', 'running', 'spawning']) {
    await t.test(s, () => assert.equal(stopNeedsConfirm(s), true));
  }
});

// Invariant: a live persistent idle session is stopped with exactly one DELETE on its instance id, no archive request, no prompt.
test('closeSession on a live persistent idle session: one DELETE, no archive, no confirm', async () => {
  const t = await setup();
  await t.closeSession(args());
  assert.deepEqual(t.fetches, STOP_REQ);
  assert.deepEqual(t.confirms, []);
  assert.deepEqual(t.alerts, []);
});

// Invariant: a live temp session goes down the archive path (synthetic → kill by instance id, archived on exit), after a confirm.
test('closeSession on a live temp session takes the archive path', async (t) => {
  await t.test('synthetic: DELETE by instance id, after the archive confirm', async () => {
    const s = await setup();
    await s.closeSession(args({ temp: true, synthetic: true }));
    assert.deepEqual(s.fetches, STOP_REQ);
    assert.equal(s.confirms.length, 1);
    assert.match(s.confirms[0], /^Archive session "Alpha"\?/);
  });
  await t.test('on disk: archive POST', async () => {
    const s = await setup();
    await s.closeSession(args({ temp: true }));
    assert.deepEqual(s.fetches, [ARCHIVE_REQ]);
    assert.equal(s.confirms.length, 1);
  });
  await t.test('attached to a live instance: 409 retries with ?force=1', async () => {
    const s = await setup({ statuses: [409, 200] });
    await s.closeSession(args({ temp: true }));
    assert.deepEqual(s.fetches, [ARCHIVE_REQ, { ...ARCHIVE_REQ, url: `${ARCHIVE_REQ.url}?force=1` }]);
  });
});

// Invariant: a session with no live instance is archived (POST), never stopped.
test('closeSession on a not-live session archives it', async (t) => {
  await t.test('no instance', async () => {
    const s = await setup();
    await s.closeSession(args({ instanceId: null, status: null }));
    assert.deepEqual(s.fetches, [ARCHIVE_REQ]);
    assert.equal(s.confirms.length, 1);
  });
  await t.test('exited instance', async () => {
    const s = await setup();
    await s.closeSession(args({ status: 'exited' }));
    assert.deepEqual(s.fetches, [ARCHIVE_REQ]);
  });
});

// Invariant: stopping a busy session asks first (one confirm naming the stop), per busy status.
test('stopping a busy session asks once; declining sends nothing', async (t) => {
  for (const status of ['turn', 'running', 'spawning']) {
    await t.test(`${status}: confirm, then DELETE`, async () => {
      const s = await setup();
      await s.closeSession(args({ status }));
      assert.equal(s.confirms.length, 1);
      assert.match(s.confirms[0], /^Stop session "Alpha"\?/);
      assert.match(s.confirms[0], /transcript is kept/);
      assert.deepEqual(s.fetches, STOP_REQ);
    });
    await t.test(`${status}: declined → no fetch, no bookkeeping`, async () => {
      const s = await setup({ confirmAnswer: false, activeId: 'inst-X' });
      await s.closeSession(args({ status }));
      assert.equal(s.confirms.length, 1);
      assert.deepEqual(s.fetches, []);
      assert.deepEqual(s.activeSets, []);
      assert.deepEqual(s.refreshes, { projects: 0, instances: 0 });
    });
  }
});

// Invariant: archiving always confirms with the existing text, and a declined archive sends nothing.
test('archiving still confirms with the archive text; declined sends nothing', async () => {
  const s = await setup({ confirmAnswer: false });
  await s.closeSession(args({ temp: true }));
  assert.equal(s.confirms.length, 1);
  assert.match(s.confirms[0], /^Archive session "Alpha"\?\nIt moves to Settings → Archived/);
  assert.deepEqual(s.fetches, []);
});

// Invariant: after a stop the open instance is deselected once; another open instance is left alone.
test('a stop deselects the open instance, and only that one', async (t) => {
  await t.test('open instance is the stopped one', async () => {
    const s = await setup({ activeId: 'inst-X' });
    await s.closeSession(args());
    assert.deepEqual(s.activeSets, [null]);
  });
  await t.test('another instance is open', async () => {
    const s = await setup({ activeId: 'inst-other' });
    await s.closeSession(args());
    assert.deepEqual(s.activeSets, []);
  });
});

// Invariant: after a stop the projects and instances lists refresh, the scope's sessions cache entry is dropped, and the unread badge stays (the session stays in the sidebar).
test('a stop refreshes both lists, drops the scope cache, and keeps the unread badge', async (t) => {
  await t.test('project scope', async () => {
    const s = await setup();
    await s.closeSession(args());
    assert.deepEqual(s.refreshes, { projects: 1, instances: 1 });
    assert.deepEqual([...s.cache.keys()], ['proj:wt'], 'only the project key is dropped');
    assert.deepEqual(s.unread, [], 'clearUnread is never called');
  });
  await t.test('worktree scope', async () => {
    const s = await setup();
    await s.closeSession(args({ worktreeName: 'wt' }));
    assert.deepEqual([...s.cache.keys()], ['proj'], 'only the worktree key is dropped');
  });
});

// Invariant: a failed stop alerts `stop session failed: <server message>` and refreshes nothing.
test('a failed stop alerts and refreshes nothing', async () => {
  const s = await setup({ statuses: [500], activeId: 'inst-X' });
  await s.closeSession(args());
  assert.deepEqual(s.alerts, ['stop session failed: boom']);
  assert.deepEqual(s.refreshes, { projects: 0, instances: 0 });
  assert.deepEqual(s.activeSets, [], 'the selection is untouched');
});
