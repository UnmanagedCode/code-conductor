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
import { withHealth } from './capabilitiesStub.mjs';
import { fakeTimers } from './composerDraftsHarness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

const SYSTEMS = [
  { id: 'local', label: 'This machine', managed: true },
  { id: 'prod-box', label: 'Prod box', managed: false, launch: ['ssh', 'prod', 'p'] },
  { id: 'namedonly', label: 'Named only', managed: false },
];

let counter = 0;
async function setup({ systems = SYSTEMS, createResponse, listing = () => ({ ok: true, entries: [], links: [], truncated: false, max: 1000 }) } = {}) {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  const posts = [];
  const listings = [];
  const timers = fakeTimers();
  const impl = async (url, opts = {}) => {
    if (String(url).includes('/api/settings/systems')) {
      return { ok: true, status: 200, json: async () => ({ systems }) };
    }
    if (String(url).includes('/api/fs/dirs')) {
      const params = new URL(String(url), 'http://localhost').searchParams;
      listings.push({ params });
      return { ok: true, status: 200, json: async () => listing(params) };
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
  window.fetch = withHealth(impl);
  globalThis.fetch = window.fetch;

  document.body.innerHTML = `
    <button id="np-btn"></button>
    <dialog id="np-dialog">
      <form id="np-form">
        <input id="np-name" />
        <select id="np-system"></select>
        <label id="np-system-path-row"><input id="np-system-path" /></label>
        <ul id="np-system-path-completions" hidden></ul>
        <p id="np-system-path-note"></p>
        <label id="np-remote-row"><input id="np-remote" /></label>
        <code id="np-preview"></code>
        <div id="np-contributions"></div>
        <p id="np-error"></p>
      </form>
      <form id="np-confirm" hidden>
        <p id="np-git-skipped" hidden></p>
        <div id="np-scaffold-block" hidden><textarea id="np-scaffold-text"></textarea></div>
      </form>
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
      npScaffoldBlock: document.getElementById('np-scaffold-block'),
      npGitSkipped: document.getElementById('np-git-skipped'),
      npSystem: document.getElementById('np-system'),
      npSystemPath: document.getElementById('np-system-path'),
      npSystemPathRow: document.getElementById('np-system-path-row'),
      npSystemPathCompletions: document.getElementById('np-system-path-completions'),
      npSystemPathNote: document.getElementById('np-system-path-note'),
      npRemote: document.getElementById('np-remote'),
      npRemoteRow: document.getElementById('np-remote-row'),
    },
    refreshProjects: async () => {},
    closeSidebarOverflow: () => {},
    timers,
  });
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
  const open = async () => { document.getElementById('np-btn').click(); await tick(); };
  const submit = async () => { dlg.returnValue = 'create'; dlg.dispatchEvent(new window.Event('close')); await tick(); };
  const typePath = async (v) => {
    $('np-system-path').value = v;
    $('np-system-path').dispatchEvent(new window.Event('input', { bubbles: true }));
    timers.fireAll();
    await tick();
  };
  const choose = async (id) => {
    $('np-system').value = id;
    $('np-system').dispatchEvent(new window.Event('change'));
    await tick();
  };
  return { window, document, dlg, posts, listings, timers, typePath, choose, open, submit, tick };
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

// A create answered 201 with `body` — the dialog's only input from the server
// besides the scaffold directive.
const created = (extra) => ({ ok: true, body: { name: 'demo', path: '/x', system: 'local', ...extra } });

// PINS: a create that skipped git is reported where the user is looking. The
// pane opens on `gitSkipped` ALONE (no scaffold), shows the server's reason,
// and keeps the scaffold block out of it.
test('a create that skipped git shows its reason on the confirm pane', async () => {
  const { open, submit, dlg } = await setup({
    createResponse: created({ gitSkipped: 'git init failed in /x: spawn git ENOENT' }),
  });
  await open();
  $('np-name').value = 'demo';
  await submit();
  assert.equal($('np-confirm').hidden, false, 'the confirm pane opens for a git skip alone');
  assert.equal($('np-form').hidden, true);
  assert.equal(dlg.open, true);
  assert.equal($('np-git-skipped').hidden, false);
  assert.match($('np-git-skipped').textContent, /spawn git ENOENT/);
  assert.equal($('np-scaffold-block').hidden, true, 'there is no scaffold to show');
});

// PINS: the notice is conditional on the field — a scaffold-only create shows
// its scaffold and no git notice.
test('a scaffold-only create shows no git notice', async () => {
  const { open, submit } = await setup({ createResponse: created({ scaffold: 'do the thing' }) });
  await open();
  $('np-name').value = 'demo';
  await submit();
  assert.equal($('np-confirm').hidden, false);
  assert.equal($('np-git-skipped').hidden, true);
  assert.equal($('np-scaffold-block').hidden, false);
  assert.equal($('np-scaffold-text').value, 'do the thing');
});

// PINS: the pane is rewritten from each response, so a git notice from one
// create does not survive into the next create's pane.
test('a git notice from one create is cleared by the next', async () => {
  let n = 0;
  const { open, submit, window } = await setup({
    createResponse: created({ gitSkipped: 'no git' }),
  });
  await open();
  $('np-name').value = 'one';
  await submit();
  assert.equal($('np-git-skipped').hidden, false);
  // The next create answers with a scaffold and no skip. The stub reads
  // createResponse once at setup, so swap what the same fetch returns.
  const prior = window.fetch;
  const next = async (url, opts = {}) => {
    if (String(url) === '/api/projects' && opts.method === 'POST') {
      n++;
      const body = created({ scaffold: 'steps' }).body;
      return { ok: true, status: 201, json: async () => body, text: async () => JSON.stringify(body) };
    }
    return prior(url, opts);
  };
  window.fetch = next; globalThis.fetch = next;
  await open();
  $('np-name').value = 'two';
  await submit();
  assert.equal(n, 1);
  assert.equal($('np-git-skipped').hidden, true);
  assert.equal($('np-scaffold-block').hidden, false);
});

// ── PATH COMPLETION ─────────────────────────────────────────────────────────

// PINS: the system path field completes against the chosen placement, and a
// completion goes through the same `input` event the preview listens to, so what
// the dialog says it will create follows what the user picked.
test('completing a directory asks the chosen system and updates the preview', async () => {
  const { window, open, choose, typePath, listings } = await setup({
    listing: () => ({ ok: true, entries: ['demo', 'other'], links: [], truncated: false, max: 1000 }),
  });
  await open();
  await choose('prod-box');
  $('np-remote').value = 'r1';
  $('np-remote').dispatchEvent(new window.Event('input'));
  await typePath('/srv/d');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].params.get('system'), 'prod-box');
  assert.equal(listings[0].params.get('remoteId'), 'r1');
  assert.equal(listings[0].params.get('path'), '/srv');
  assert.deepEqual([...$('np-system-path-completions').children].map(li => li.textContent), ['demo']);

  $('np-system-path').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
  assert.equal($('np-system-path').value, '/srv/demo/');
  assert.match($('np-preview').textContent, /\/srv\/demo\//, 'the dispatched input kept the preview in step');
});

// PINS: the OPEN handler resets the picker (list, note, cache). After the
// reopen the system is selected by writing the select's value, NOT by a `change`
// event: that event resets the picker through its own listener and would clear
// the cache whether or not the open handler did.
test('reopening clears the picker, and the create body is the unchanged placement shape', async () => {
  const { window, dlg, open, choose, typePath, listings, submit, posts } = await setup({
    listing: () => ({ ok: true, entries: ['demo'], links: [], truncated: true, max: 5 }),
  });
  await open();
  await choose('prod-box');
  await typePath('/srv/d');
  assert.equal($('np-system-path-completions').hidden, false, 'the first open left a list showing');
  assert.match($('np-system-path-note').textContent, /more than 5/);
  assert.equal(listings.length, 1);
  dlg.close('cancel');

  await open();
  assert.equal($('np-system-path-completions').hidden, true);
  assert.equal($('np-system-path-completions').children.length, 0);
  assert.equal($('np-system-path-note').textContent, '');
  $('np-system').value = 'prod-box';
  await typePath('/srv/d');
  assert.equal(listings.length, 2, 'the cache did not survive the reopen');

  $('np-name').value = 'demo';
  $('np-system-path').value = '/srv/demo';
  $('np-remote').value = 'r1';
  $('np-remote').dispatchEvent(new window.Event('input'));
  await submit();
  assert.deepEqual(posts, [{ name: 'demo', system: 'prod-box', systemPath: '/srv/demo', remoteId: 'r1' }]);
});

// PINS: the remote field invalidates the cache — a listing is about one target.
test('changing the remote refetches the same directory', async () => {
  const { window, open, choose, typePath, listings } = await setup();
  await open();
  await choose('prod-box');
  await typePath('/srv/d');
  await typePath('/srv/e');
  assert.equal(listings.length, 1, 'same placement, same directory: cached');
  $('np-remote').value = 'r2';
  $('np-remote').dispatchEvent(new window.Event('input'));
  await typePath('/srv/d');
  assert.equal(listings.length, 2);
  assert.equal(listings[1].params.get('remoteId'), 'r2');
});
