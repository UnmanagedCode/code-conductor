// CHANGING WHICH TARGET A PROJECT IS ON, from the sidebar's system pill.
//
// The server owns the whole contract — one helper, one guard, one 409 that
// NAMES the live sessions and registered worktrees to clear. What the dialog
// owes is that the naming survives: a refusal collapsed into a sentence is a
// refusal the user has to parse before they can act on it, and the list is the
// only part of it they can act on.
//
// It also owes the other half of "one operation": the system and the path are
// shown but not editable. Moving a project to another machine or another path
// is registration, not a target change, and offering it here would let a
// mis-edit look like the operation the dialog is named for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

const PROJECT = {
  name: 'shipping', system: 'prod-box', remoteId: 'ctr-7', path: '/app',
};

let counter = 0;
async function setup({ response } = {}) {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;

  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined });
    const r = response ?? { status: 200, body: { ok: true, name: 'shipping', system: 'prod-box', remoteId: 'ctr-9' } };
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  window.fetch = impl;
  globalThis.fetch = impl;

  document.body.innerHTML = `
    <dialog id="pr-dialog">
      <form id="pr-form">
        <code id="pr-project"></code>
        <input id="pr-system" readonly />
        <input id="pr-path" readonly />
        <input id="pr-remote" />
        <p id="pr-error"></p>
        <ul id="pr-blockers" hidden></ul>
      </form>
    </dialog>`;
  const dlg = document.getElementById('pr-dialog');
  dlg.showModal = function () { this.open = true; };
  dlg.close = function (v) { this.open = false; this.returnValue = v ?? this.returnValue; };

  const { installProjectRemoteDialog } = await import(
    pathToFileURL(path.join(PUB, 'projectRemoteDialog.js')).href + `?t=${++counter}`);
  let refreshed = 0;
  const handles = installProjectRemoteDialog({
    dom: {
      projectRemoteDialog: dlg,
      prProject: document.getElementById('pr-project'),
      prSystem: document.getElementById('pr-system'),
      prPath: document.getElementById('pr-path'),
      prRemote: document.getElementById('pr-remote'),
      prError: document.getElementById('pr-error'),
      prBlockers: document.getElementById('pr-blockers'),
    },
    refreshProjects: async () => { refreshed++; },
  });
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
  const save = async () => { dlg.returnValue = 'save'; dlg.dispatchEvent(new window.Event('close')); await tick(); };
  return { window, document, dlg, calls, handles, save, tick, refreshedCount: () => refreshed };
}

const $ = (id) => document.getElementById(id);

// PINS: the dialog states the placement it is about to change, and only the
// TARGET is editable — the system and the path are registration, not this
// operation, and an editable copy of them here would let a mis-edit pass for it.
test('the dialog opens on the project, with only the target editable', async () => {
  const { handles, dlg } = await setup();
  handles.open(PROJECT);
  assert.equal(dlg.open, true);
  assert.equal($('pr-project').textContent, 'shipping');
  assert.equal($('pr-system').value, 'prod-box');
  assert.equal($('pr-path').value, '/app');
  assert.equal($('pr-remote').value, 'ctr-7');
  assert.equal($('pr-system').readOnly, true);
  assert.equal($('pr-path').readOnly, true);
  assert.equal($('pr-remote').readOnly, false);
});

// PINS: saving reaches the one endpoint that owns the guard, trimmed, and the
// project list is refreshed so the sidebar pill stops naming the old target.
test('saving PUTs the new target and refreshes the list', async () => {
  const { handles, save, calls, refreshedCount } = await setup();
  handles.open(PROJECT);
  $('pr-remote').value = '  ctr-9  ';
  await save();
  assert.deepEqual(calls.at(-1), {
    url: '/api/projects/shipping/remote', method: 'PUT', body: { remoteId: 'ctr-9' },
  });
  assert.equal(refreshedCount(), 1);
});

// PINS: falling back to the provider's own default is expressible. Without it a
// project put on a named target could never be taken off one.
test('clearing the field sends null, not an empty target', async () => {
  const { handles, save, calls } = await setup();
  handles.open(PROJECT);
  $('pr-remote').value = '   ';
  await save();
  assert.deepEqual(calls.at(-1).body, { remoteId: null });
});

// PINS: the 409's LIST is what the user acts on, so it is rendered as a list
// rather than collapsed into prose. Naming what to clear is the whole reason
// the server refuses instead of killing sessions on the user's behalf.
test('a 409 renders the sessions and worktrees to clear, and reopens', async () => {
  const { handles, save, dlg } = await setup({
    response: {
      status: 409,
      body: {
        error: "project 'shipping' cannot change target while it has 2 live session(s)…",
        code: 'PROJECT_PLACEMENT_IN_USE',
        instances: ['a1b2c3d4', 'e5f6a7b8'],
        worktrees: ['shipping_worktree_feature'],
      },
    },
  });
  handles.open(PROJECT);
  $('pr-remote').value = 'ctr-9';
  await save();

  const blockers = $('pr-blockers');
  assert.equal(blockers.hidden, false, 'the list is shown, not left empty and hidden');
  const items = [...blockers.querySelectorAll('li')].map(li => li.textContent);
  assert.equal(items.length, 3, 'one entry per thing to clear');
  assert.ok(items.some(t => t.includes('a1b2c3d4')));
  assert.ok(items.some(t => t.includes('e5f6a7b8')));
  assert.ok(items.some(t => t.includes('shipping_worktree_feature')));
  assert.match($('pr-error').textContent, /cannot change target/);
  assert.equal(dlg.open, true, 'the dialog reopens so the user can act on the list');
});

// PINS: a refusal the dialog has no special rendering for is still surfaced
// VERBATIM. The two new placement codes arrive this way, and a swallowed one
// leaves the user with a dialog that did nothing and said nothing.
test('any other refusal shows the server message and leaves the list empty', async () => {
  const { handles, save, dlg } = await setup({
    response: {
      status: 502,
      body: { error: "…remote 'typo' of system 'prod-box', which does not serve it" },
    },
  });
  handles.open(PROJECT);
  $('pr-remote').value = 'typo';
  await save();
  assert.match($('pr-error').textContent, /does not serve it/);
  assert.equal($('pr-blockers').hidden, true, 'no blockers to show, so nothing is shown');
  assert.equal(dlg.open, true);
});

// PINS: a cancelled dialog is not a change. The close event fires either way,
// so the returnValue is the only thing separating them.
test('cancelling sends nothing', async () => {
  const { window, handles, dlg, calls, tick } = await setup();
  handles.open(PROJECT);
  dlg.returnValue = 'cancel';
  dlg.dispatchEvent(new window.Event('close'));
  await tick();
  assert.deepEqual(calls, []);
});

// PINS: reopening after a refusal starts clean. A stale blocker list would
// describe sessions the user has since killed.
test('reopening clears the previous refusal', async () => {
  const { handles, save } = await setup({
    response: {
      status: 409,
      body: { error: 'blocked', code: 'PROJECT_PLACEMENT_IN_USE', instances: ['a1b2c3d4'], worktrees: [] },
    },
  });
  handles.open(PROJECT);
  $('pr-remote').value = 'ctr-9';
  await save();
  assert.equal($('pr-blockers').hidden, false);

  handles.open(PROJECT);
  assert.equal($('pr-blockers').hidden, true);
  assert.equal($('pr-error').textContent, '');
});
