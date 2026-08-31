// CHOOSING WHERE A NEW PROJECT LIVES, from the New Project dialog.
//
// The REST route takes `{system, systemPath}`, but a route nothing can reach is
// not a feature: the dialog is the only way a user creates a project, so it is
// where the placement is chosen. What the dialog owes is exactly what the server
// enforces — a system needs a path, and the path is absolute — stated where the
// user can act on it rather than as a 400 after the fact.
//
// The system list comes from the registry, so a system with no provider command
// is not offered: putting a project on one produces a project nothing can reach.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

const SYSTEMS = [
  { id: 'local', label: 'This machine', managed: true },
  { id: 'prod-box', label: 'Prod box', managed: false, launch: ['ssh', 'prod', 'p'] },
  { id: 'namedonly', label: 'Named only', managed: false },
];

let counter = 0;
async function setup({ systems = SYSTEMS, createResponse } = {}) {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  const posts = [];
  const impl = async (url, opts = {}) => {
    if (String(url).includes('/api/settings/systems')) {
      return { ok: true, status: 200, json: async () => ({ systems }) };
    }
    if (String(url).includes('/api/settings/conventions/project')) {
      return { ok: true, status: 200, json: async () => ({ conventions: [] }) };
    }
    if (String(url) === '/api/projects' && opts.method === 'POST') {
      posts.push(JSON.parse(opts.body));
      const r = createResponse ?? { ok: true, body: { name: 'demo', path: '/x', system: 'local' } };
      return {
        ok: r.ok, status: r.ok ? 201 : 400,
        json: async () => (r.ok ? r.body : { error: r.error }),
        text: async () => JSON.stringify(r.ok ? r.body : { error: r.error }),
      };
    }
    return { ok: false, status: 503, json: async () => ({}), text: async () => '{}' };
  };
  window.fetch = impl;
  globalThis.fetch = impl;

  document.body.innerHTML = `
    <button id="np-btn"></button>
    <dialog id="np-dialog">
      <form id="np-form">
        <input id="np-name" />
        <select id="np-system"></select>
        <label id="np-system-path-row"><input id="np-system-path" /></label>
        <label id="np-remote-row"><input id="np-remote" /></label>
        <code id="np-preview"></code>
        <div id="np-contributions"></div>
        <p id="np-error"></p>
      </form>
      <form id="np-confirm" hidden><textarea id="np-scaffold-text"></textarea></form>
    </dialog>`;
  // happy-dom's <dialog> needs these for showModal/close to be drivable.
  const dlg = document.getElementById('np-dialog');
  dlg.showModal = function () { this.open = true; };
  dlg.close = function (v) { this.open = false; this.returnValue = v ?? this.returnValue; };

  const { installNewProjectDialog } = await import(
    pathToFileURL(path.join(PUB, 'newProjectDialog.js')).href + `?t=${++counter}`);
  installNewProjectDialog({
    dom: {
      newProjectBtn: document.getElementById('np-btn'),
      newProjectDialog: dlg,
      npName: document.getElementById('np-name'),
      npError: document.getElementById('np-error'),
      npPreview: document.getElementById('np-preview'),
      npContributions: document.getElementById('np-contributions'),
      npForm: document.getElementById('np-form'),
      npConfirm: document.getElementById('np-confirm'),
      npScaffoldText: document.getElementById('np-scaffold-text'),
      npSystem: document.getElementById('np-system'),
      npSystemPath: document.getElementById('np-system-path'),
      npSystemPathRow: document.getElementById('np-system-path-row'),
      npRemote: document.getElementById('np-remote'),
      npRemoteRow: document.getElementById('np-remote-row'),
    },
    refreshProjects: async () => {},
    closeSidebarOverflow: () => {},
  });
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
  const open = async () => { document.getElementById('np-btn').click(); await tick(); };
  const submit = async () => { dlg.returnValue = 'create'; dlg.dispatchEvent(new window.Event('close')); await tick(); };
  return { window, document, dlg, posts, open, submit, tick };
}

const $ = (id) => document.getElementById(id);

// PINS: only systems cc can actually reach are offered. A registry row with no
// provider command would produce a project every operation refuses.
test('the system picker offers local plus reachable systems only', async () => {
  const { open } = await setup();
  await open();
  assert.deepEqual([...$('np-system').options].map(o => o.value), ['local', 'prod-box']);
  assert.equal($('np-system').value, 'local', 'local is the default — it is where every project lives');
});

// PINS: the path field is only shown when a system is chosen, and the preview
// tracks the placement, so what the dialog says it will create is what it posts.
test('choosing a system reveals the path field and retargets the preview', async () => {
  const { window, open, tick } = await setup();
  await open();
  assert.equal($('np-system-path-row').hidden, true, 'a local project has no path to choose');
  $('np-name').value = 'demo';
  $('np-name').dispatchEvent(new window.Event('input'));
  assert.equal($('np-preview').textContent, '~/project/demo');

  $('np-system').value = 'prod-box';
  $('np-system').dispatchEvent(new window.Event('change'));
  await tick();
  assert.equal($('np-system-path-row').hidden, false);
  $('np-system-path').value = '/srv/demo';
  $('np-system-path').dispatchEvent(new window.Event('input'));
  assert.match($('np-preview').textContent, /prod-box/);
  assert.match($('np-preview').textContent, /\/srv\/demo/);
});

// PINS: a local create still posts exactly what it always did — no placement
// keys leak onto the request when none was chosen.
test('a local create posts no placement', async () => {
  const { open, submit, posts } = await setup();
  await open();
  $('np-name').value = 'demo';
  await submit();
  assert.deepEqual(posts.at(-1), { name: 'demo' },
    'no placement keys leak onto a request that chose none');
});

// PINS: the placement reaches the server as the two fields the route reads.
test('a remote create posts system + systemPath', async () => {
  const { window, open, submit, posts, tick } = await setup();
  await open();
  $('np-name').value = 'demo';
  $('np-system').value = 'prod-box';
  $('np-system').dispatchEvent(new window.Event('change'));
  await tick();
  $('np-system-path').value = ' /srv/demo ';
  await submit();
  assert.deepEqual(posts.at(-1), { name: 'demo', system: 'prod-box', systemPath: '/srv/demo' });
});

// PINS: the target is chosen where the project is created, appears with the
// path (a target is only meaningful on a system), and travels as the field the
// route reads. Always offered for a non-local system: cc cannot know whether a
// provider serves named targets without connecting, and the server's named
// refusal at create time is what answers that.
test('choosing a system reveals the remote field, and it reaches the POST', async () => {
  const { window, open, submit, posts, tick } = await setup();
  await open();
  assert.equal($('np-remote-row').hidden, true, 'a local project has no target to name');

  $('np-name').value = 'demo';
  $('np-system').value = 'prod-box';
  $('np-system').dispatchEvent(new window.Event('change'));
  await tick();
  assert.equal($('np-remote-row').hidden, false);

  $('np-system-path').value = '/srv/demo';
  $('np-remote').value = ' ctr_7.a ';
  $('np-remote').dispatchEvent(new window.Event('input'));
  // The preview names the target too — a preview that showed only the system
  // would promise the wrong machine on a system serving many.
  assert.match($('np-preview').textContent, /ctr_7\.a/);

  await submit();
  assert.deepEqual(posts.at(-1),
    { name: 'demo', system: 'prod-box', systemPath: '/srv/demo', remoteId: 'ctr_7.a' });
});

// PINS: absence stays absence. An empty field is the provider's OWN default
// target, and posting `remoteId: ""` would record a target named nothing.
test('a remote create with no target posts no remoteId', async () => {
  const { window, open, submit, posts, tick } = await setup();
  await open();
  $('np-name').value = 'demo';
  $('np-system').value = 'prod-box';
  $('np-system').dispatchEvent(new window.Event('change'));
  await tick();
  $('np-system-path').value = '/srv/demo';
  $('np-remote').value = '   ';
  await submit();
  assert.deepEqual(posts.at(-1), { name: 'demo', system: 'prod-box', systemPath: '/srv/demo' });
});

// PINS: the dialog refuses a system with no path ITSELF, without a round trip —
// the server's 400 says the same thing, but only after the dialog has closed.
test('a system with no path is refused in the dialog, before any request', async () => {
  const { window, open, submit, posts, dlg, tick } = await setup();
  await open();
  $('np-name').value = 'demo';
  $('np-system').value = 'prod-box';
  $('np-system').dispatchEvent(new window.Event('change'));
  await tick();
  $('np-system-path').value = '';
  await submit();
  assert.equal(posts.length, 0, 'nothing was posted');
  assert.match($('np-error').textContent, /path/i);
  assert.equal(dlg.open, true, 'the dialog reopens so the user can fix it');
});

// PINS: the same for a relative path, which the server also refuses — a relative
// path resolves against whatever cwd the provider happens to have.
test('a relative path is refused in the dialog', async () => {
  const { window, open, submit, posts, tick } = await setup();
  await open();
  $('np-name').value = 'demo';
  $('np-system').value = 'prod-box';
  $('np-system').dispatchEvent(new window.Event('change'));
  await tick();
  $('np-system-path').value = 'srv/demo';
  await submit();
  assert.equal(posts.length, 0);
  assert.match($('np-error').textContent, /absolute/i);
});
