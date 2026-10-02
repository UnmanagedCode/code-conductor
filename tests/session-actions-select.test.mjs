// Which selectInstance options public/sessionActions.js passes: a resume the
// user asked for and a fork are user gestures (the prompt bar takes focus); a
// silent resume (the anchor auto-resume) is not, in either its success or its
// 409 branch. Same setup as tests/anchor-autoresume.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const load = (name) => import(pathToFileURL(path.join(PUB, name)).href + `?t=${Math.random()}`);

async function setup({ fetchImpl, instances = [] }) {
  const { installSessionActions } = await load('sessionActions.js');
  const selected = [];
  globalThis.alert = () => {};
  globalThis.confirm = () => true;
  globalThis.fetch = fetchImpl;
  const actions = installSessionActions({
    getActiveId: () => 'inst-active', setActiveId: () => {}, getInstances: () => instances,
    refreshProjects: async () => {}, refreshInstances: async () => {},
    selectInstance: (id, opts) => selected.push({ id, opts }), sidebar: {}, clearUnread: () => {},
  });
  return { actions, selected };
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

test('a user resume selects with a user gesture', async () => {
  const { actions, selected } = await setup({ fetchImpl: async () => okJson({ id: 'inst-new' }) });
  await actions.resumeSession({ projectName: 'p', worktreeName: null, sessionId: 'sid', silent: false });

  assert.deepEqual(selected, [{ id: 'inst-new', opts: { userGesture: true } }]);
});

test('a silent resume selects without a user gesture', async () => {
  const { actions, selected } = await setup({ fetchImpl: async () => okJson({ id: 'inst-new' }) });
  await actions.resumeSession({ projectName: 'p', worktreeName: null, sessionId: 'sid', silent: true });

  assert.equal(selected.length, 1);
  assert.ok(!selected[0].opts.userGesture, 'a silent resume is passive');
});

test('a silent resume that 409s selects the owning instance without a user gesture', async () => {
  const { actions, selected } = await setup({
    fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: 'already attached' }) }),
    instances: [{ id: 'inst-owner', sessionId: 'sid' }],
  });
  await actions.resumeSession({ projectName: 'p', worktreeName: null, sessionId: 'sid', silent: true });

  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, 'inst-owner');
  assert.ok(!selected[0].opts.userGesture, 'the 409 branch of a silent resume is passive');
});

test('a fork selects the new instance with a user gesture', async () => {
  const { actions, selected } = await setup({
    fetchImpl: async () => okJson({ instance: { id: 'inst-fork' } }),
  });
  await actions.forkActiveSession(1, 'prompt text');

  assert.deepEqual(selected, [{ id: 'inst-fork', opts: { userGesture: true } }]);
});
