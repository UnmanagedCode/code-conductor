// WHAT THE DELETE DIALOG PROMISES — and why it must differ by placement.
//
// Deleting an IN-ROOT project removes its directory. Deleting an ADOPTED one
// only unlinks the `.external` symlink, and deleting a REMOTE one only clears
// the record: in both, the tree is the user's own checkout and is never
// touched. The dialog said "rm -rf the project directory itself" for all three,
// which is the same defect the server side spent this phase closing — a
// statement that is false about the machine it names.
//
// The confirmation is the one moment the user can act on the difference, so it
// is stated BEFORE the click and repeated by the response afterwards
// (`unregisteredOnly` on DELETE /api/projects/:name).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

// Drives sessionActions.deleteProject with a captured window.prompt, and
// answers it with the project name so the DELETE actually fires.
async function promptFor(project) {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  let shown = null;
  const requests = [];
  window.prompt = (text) => { shown = text; return project.name; };
  window.alert = () => {};
  globalThis.alert = () => {};
  globalThis.fetch = async (url, opts) => {
    requests.push({ url, method: opts?.method });
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' };
  };
  const { installSessionActions } = await import(
    pathToFileURL(path.join(PUB, 'sessionActions.js')).href + `?t=${Math.random()}`);
  const actions = installSessionActions({
    getActiveId: () => null, setActiveId: () => {}, getInstances: () => [],
    refreshProjects: async () => {}, refreshInstances: async () => {},
    selectInstance: () => {}, sidebar: {}, clearUnread: () => {}, headerUpdate: () => {},
  });
  await actions.deleteProject(project);
  return { shown, requests };
}

const base = (over = {}) => ({
  name: 'demo', path: '/p/demo', worktrees: [], external: false, system: 'local', ...over,
});

// PINS: an in-root project's dialog still promises the removal that really
// happens — the baseline the two other placements differ from.
test('an in-root project is told its directory is removed', async () => {
  const { shown, requests } = await promptFor(base());
  assert.match(shown, /rm -rf/);
  assert.ok(!/unregister/i.test(shown));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'DELETE');
});

// PINS: an adopted project's dialog says UNREGISTER and promises the repo is
// untouched. The existing wording was false here before this phase.
test('an adopted project is told it is only unregistered', async () => {
  const { shown } = await promptFor(base({ external: true, path: '/home/me/myrepo' }));
  assert.match(shown, /unregister/i);
  assert.ok(!/rm -rf/.test(shown), 'no removal is promised for a repo cc does not own');
  assert.match(shown, /\/home\/me\/myrepo/, 'and the dialog names what is being left behind');
});

// PINS: a remote project's dialog says the same thing AND names the system, so
// the user knows which machine keeps the tree.
test('a remote project is told the tree stays on its system, named', async () => {
  const { shown } = await promptFor(base({ system: 'prod-box', systemPath: '/app', path: '/app' }));
  assert.match(shown, /unregister/i);
  assert.ok(!/rm -rf/.test(shown));
  assert.match(shown, /prod-box/, 'the machine the tree stays on is named');
  assert.match(shown, /\/app/);
});

// PINS: worktrees follow the same rule — a remote project's worktree
// DIRECTORIES are left on the system, which the cascade also does, so the
// dialog must not promise to remove them.
test('a remote project does not promise to remove its worktree directories', async () => {
  const { shown } = await promptFor(base({
    system: 'prod-box', systemPath: '/app', path: '/app',
    worktrees: [{ worktreeName: 'demo_worktree_a' }],
  }));
  assert.ok(!/\(dir \+ branch\)/.test(shown),
    'the cascade unregisters them on a system; the dialog must not claim otherwise');
  assert.match(shown, /unregister 1 worktree/i);
});

// PINS: the dialog counts exactly the registrations it is handed. The undercount
// the reviewer saw came from the LISTING (a degraded row carried `worktrees: []`
// for a project that had one, pinned in systems-mid-operation-death), and the
// last thing a user read before a destructive action was "unregister 0
// worktrees". This is the dialog's half of that pair: no invented zero.
test('the confirmation counts every registered worktree it is given', async () => {
  const { shown } = await promptFor(base({
    system: 'prod-box', systemPath: '/app', path: '/app',
    worktrees: [{ worktreeName: 'demo_worktree_a' }, { worktreeName: 'demo_worktree_b' }],
  }));
  assert.match(shown, /unregister 2 worktrees/i);
});

// PINS: zero is only said when zero is true — the assertion the one above pairs
// with, so neither can pass by printing a constant.
test('a project with no worktrees says zero', async () => {
  const { shown } = await promptFor(base({ system: 'prod-box', systemPath: '/app', path: '/app' }));
  assert.match(shown, /unregister 0 worktrees/i);
});
