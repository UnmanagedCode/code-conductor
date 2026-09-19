// WHAT THE DELETE DIALOG PROMISES.
//
// Deleting a project DEREGISTERS it. The tree stays unless the user ticks the
// opt-in, and a project on another machine has no opt-in at all — cc removes
// its record of a tree it does not own, never the tree. The confirmation is the
// one moment the user can act on that, so the dialog states the literal path
// the tick would remove, and the response repeats what happened afterwards
// (`directoryDeleted` on DELETE /api/projects/:name).
//
// `window.prompt` cannot hold a checkbox, which is why this is a dialog.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

const DIALOG_HTML = `
  <dialog id="delete-project-dialog">
    <form method="dialog">
      <h3 id="dpd-title"></h3>
      <p id="dpd-summary"></p>
      <ul id="dpd-effects"></ul>
      <label id="dpd-dir-row"><input id="dpd-delete-dir" type="checkbox" /><span id="dpd-dir-label"></span></label>
      <label><input id="dpd-confirm" /></label>
      <p id="dpd-error"></p>
      <menu><button value="cancel"></button><button id="dpd-submit" value="delete"></button></menu>
    </form>
  </dialog>`;

// Drives sessionActions.deleteProject against a real happy-dom dialog, types
// the confirmation, optionally ticks the directory box, and closes with
// `delete` — the same sequence the submit button produces.
async function confirmDelete(project, { instances = [], tickDirectory = false, typed } = {}) {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  window.document.body.innerHTML = DIALOG_HTML;
  globalThis.alert = () => {};
  window.alert = () => {};
  const requests = [];
  globalThis.fetch = async (url, opts) => {
    requests.push({ url, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' };
  };
  const el = id => window.document.getElementById(id);
  const { installSessionActions } = await import(
    pathToFileURL(path.join(PUB, 'sessionActions.js')).href + `?t=${Math.random()}`);
  const actions = installSessionActions({
    getActiveId: () => null, setActiveId: () => {}, getInstances: () => instances,
    refreshProjects: async () => {}, refreshInstances: async () => {},
    selectInstance: () => {}, sidebar: {}, clearUnread: () => {}, headerUpdate: () => {},
    deleteProjectDom: {
      dialog: el('delete-project-dialog'), title: el('dpd-title'), summary: el('dpd-summary'),
      effects: el('dpd-effects'), dirRow: el('dpd-dir-row'), deleteDir: el('dpd-delete-dir'),
      dirLabel: el('dpd-dir-label'), confirm: el('dpd-confirm'), error: el('dpd-error'),
    },
  });
  actions.deleteProject(project);
  const shown = el('delete-project-dialog').textContent;
  const dirHidden = el('dpd-dir-row').hidden;
  el('dpd-confirm').value = typed === undefined ? project.name : typed;
  if (tickDirectory) el('dpd-delete-dir').checked = true;
  el('delete-project-dialog').close('delete');
  await new Promise(r => setTimeout(r, 0));
  return { shown, dirHidden, dirLabel: el('dpd-dir-label').textContent, requests, error: el('dpd-error').textContent };
}

const base = (over = {}) => ({
  name: 'demo', path: '/p/demo', worktrees: [], system: 'local', ...over,
});

// PINS: the default is a DEREGISTER — the tick is off, and the request the
// dialog sends says so.
test('the directory opt-in is off by default and the DELETE says deleteDirectory:false', async () => {
  const { requests, dirHidden } = await confirmDelete(base());
  assert.equal(dirHidden, false, 'a local project is offered the opt-in');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'DELETE');
  assert.deepEqual(requests[0].body, { deleteDirectory: false });
});

// PINS: ticking the box is what carries the removal through to the server —
// the tick is not decorative.
test('ticking the box sends deleteDirectory:true', async () => {
  const { requests } = await confirmDelete(base(), { tickDirectory: true });
  assert.deepEqual(requests[0].body, { deleteDirectory: true });
});

// PINS: the dialog names the LITERAL path the tick would remove. Without it the
// user is authorising an `rm -rf` of a directory nobody named.
test('the opt-in label names the directory it would remove', async () => {
  const { dirLabel } = await confirmDelete(base({ path: '/home/me/myrepo' }));
  assert.match(dirLabel, /\/home\/me\/myrepo/);
});

// PINS: a remote project gets NO opt-in at all. cc owns no area on another
// machine, so offering the tick would promise something it will not do — and
// the route refuses it 400.
test('a remote project is offered no directory opt-in, and its DELETE carries none', async () => {
  const { dirHidden, requests } = await confirmDelete(
    base({ system: 'prod-box', remoteId: 'c1', path: '/app' }), { tickDirectory: true });
  assert.equal(dirHidden, true);
  assert.deepEqual(requests[0].body, { deleteDirectory: false },
    'even a ticked box cannot reach the server for a remote project');
});

// PINS: a remote project's dialog names WHICH machine keeps the tree. One
// system can serve many targets, so "on prod-box" alone would not say which.
test('a remote project names its system and target', async () => {
  const { shown } = await confirmDelete(base({ system: 'prod-box', remoteId: 'c1', path: '/app' }));
  assert.match(shown, /prod-box/);
  assert.match(shown, /c1/);
  assert.match(shown, /\/app/);
});

// PINS: the dialog counts exactly the registrations it is handed. The undercount
// the reviewer saw came from the LISTING (a degraded row carried `worktrees: []`
// for a project that had one), and the last thing a user read before a
// destructive action was "0 worktrees". No invented zero.
test('the confirmation counts every registered worktree it is given', async () => {
  const { shown } = await confirmDelete(base({
    worktrees: [{ worktreeName: 'a' }, { worktreeName: 'b' }],
  }));
  assert.match(shown, /remove 2 worktrees/i);
});

// PINS: zero is only said when zero is true — the assertion the one above pairs
// with, so neither can pass by printing a constant.
test('a project with no worktrees says zero', async () => {
  const { shown } = await confirmDelete(base());
  assert.match(shown, /remove 0 worktrees/i);
});

// PINS: a remote project's worktree DIRECTORIES are left on the system, which
// the cascade also does, so the dialog must not promise to remove them.
test('a remote project does not promise to remove its worktree directories', async () => {
  const { shown } = await confirmDelete(base({
    system: 'prod-box', path: '/app', worktrees: [{ worktreeName: 'a' }],
  }));
  assert.match(shown, /unregister 1 worktree/i);
  assert.ok(!/\(dir \+ branch\)/.test(shown));
});

// PINS: the typed-name confirm still gates the action — a mismatch sends
// nothing and says why.
test('a name mismatch sends no request and reports the mismatch', async () => {
  const { requests, error } = await confirmDelete(base(), { typed: 'wrong' });
  assert.equal(requests.length, 0);
  assert.match(error, /mismatch/i);
});

// PINS: the instance count comes from the live list, not from the project row —
// a dialog that said "kill 0" while a worker was attached would understate what
// the click does.
test('the effects list counts the running instances of this project', async () => {
  const { shown } = await confirmDelete(base(), {
    instances: [{ project: 'demo' }, { project: 'demo' }, { project: 'other' }],
  });
  assert.match(shown, /kill 2 running instances/);
});
