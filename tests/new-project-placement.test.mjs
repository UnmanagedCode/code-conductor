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
// `remotes(system)` answers `GET /api/systems/<system>/remotes` — a body, or a
// promise of one so a test can hold an answer back. Omitted (or answering
// undefined), the request falls through to the 503 catch-all below.
async function setup({ systems = SYSTEMS, createResponse, listing = () => ({ ok: true, entries: [], links: [], truncated: false, max: 1000 }), remotes = () => undefined } = {}) {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  const posts = [];
  const listings = [];
  const remoteAsks = [];
  const timers = fakeTimers();
  const impl = async (url, opts = {}) => {
    if (String(url).includes('/api/settings/systems')) {
      return { ok: true, status: 200, json: async () => ({ systems }) };
    }
    const asked = String(url).match(/^\/api\/systems\/([^/]+)\/remotes$/);
    if (asked) {
      const system = decodeURIComponent(asked[1]);
      remoteAsks.push(system);
      const body = await remotes(system);
      if (body !== undefined) return { ok: true, status: 200, json: async () => body };
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
        <label id="np-remote-row"><select id="np-remote-select" hidden></select><input id="np-remote" /></label>
        <p id="np-remote-note"></p>
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
      npRemoteSelect: document.getElementById('np-remote-select'),
      npRemoteNote: document.getElementById('np-remote-note'),
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
  // Choosing from the Remote dropdown the way a user does: by `change`.
  const pickRemote = async (value) => {
    $('np-remote-select').value = value;
    $('np-remote-select').dispatchEvent(new window.Event('change'));
    await tick();
  };
  // "Other…" by its label, so no test restates the option's sentinel value.
  const pickOther = async () => {
    const other = [...$('np-remote-select').options].find(o => o.textContent === 'Other…');
    assert.ok(other, 'the dropdown offers Other…');
    await pickRemote(other.value);
  };
  return { window, document, dlg, posts, listings, remoteAsks, timers, typePath, choose, open, submit, tick, pickRemote, pickOther };
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

// PINS: changing the remote RESETS the picker — a list open for the old target
// closes and its note clears — not merely refetches (a changed remote already
// changes the cache key, so a refetch alone proves nothing about the reset).
test('changing the remote closes the picker and the same directory is listed afresh', async () => {
  const { window, open, choose, typePath, listings } = await setup({
    listing: () => ({ ok: true, entries: ['d1'], links: [], truncated: true, max: 9 }),
  });
  await open();
  await choose('prod-box');
  await typePath('/srv/d');
  assert.equal($('np-system-path-completions').hidden, false, 'a list is open before the change');
  assert.equal($('np-system-path').getAttribute('aria-expanded'), 'true');
  assert.match($('np-system-path-note').textContent, /more than 9/);

  $('np-remote').value = 'r2';
  $('np-remote').dispatchEvent(new window.Event('input'));
  assert.equal($('np-system-path-completions').hidden, true);
  assert.equal($('np-system-path-completions').children.length, 0);
  assert.equal($('np-system-path').getAttribute('aria-expanded'), 'false');
  assert.equal($('np-system-path-note').textContent, '');

  await typePath('/srv/d');
  assert.equal(listings.length, 2);
  assert.equal(listings[1].params.get('remoteId'), 'r2');
});

// PINS: changing the system closes the picker too, for the same reason.
test('changing the system closes the picker', async () => {
  const { open, choose, typePath } = await setup({
    listing: () => ({ ok: true, entries: ['d1'], links: [], truncated: true, max: 9 }),
  });
  await open();
  await choose('prod-box');
  await typePath('/srv/d');
  assert.equal($('np-system-path-completions').hidden, false);
  await choose('local');
  assert.equal($('np-system-path-completions').hidden, true);
  assert.equal($('np-system-path').getAttribute('aria-expanded'), 'false');
  assert.equal($('np-system-path-note').textContent, '');
});

// ── THE REMOTE DROPDOWN ─────────────────────────────────────────────────────
//
// A System whose provider enumerates its configured remotes offers them as a
// dropdown, with Other… as the way to type one it did not list. A System that
// does not enumerate, or whose enumeration failed, keeps the free-text field —
// and a failure says why, so it is never read as "no remotes".

const LISTED = (...remoteIds) => ({ system: 'prod-box', label: 'Prod box', state: 'listed', remoteIds });
const optionTexts = () => [...$('np-remote-select').options].map(o => o.textContent);

// PINS the dropdown half of the switch: listed ids become options between an
// unsubmittable placeholder and Other…, the free-text field hides, and the id
// picked is the one posted.
test('an enumerable system offers its remotes as a dropdown', async () => {
  const { window, open, choose, pickRemote, submit, posts } = await setup({ remotes: () => LISTED('ctr-a', 'ctr-b') });
  await open();
  $('np-name').value = 'demo';
  await choose('prod-box');
  assert.equal($('np-remote-select').hidden, false);
  assert.deepEqual(optionTexts(), ['— choose a remote —', 'ctr-a', 'ctr-b', 'Other…']);
  assert.equal($('np-remote-select').value, '', 'the placeholder is what starts selected');
  assert.equal($('np-remote').hidden, true, 'the free-text field hides behind Other…');
  assert.equal($('np-remote-note').textContent, '');

  await pickRemote('ctr-b');
  assert.match($('np-preview').textContent, /remote 'ctr-b' of system 'prod-box'/);
  $('np-system-path').value = '/srv/demo';
  $('np-system-path').dispatchEvent(new window.Event('input'));
  await submit();
  assert.deepEqual(posts.at(-1), { name: 'demo', system: 'prod-box', systemPath: '/srv/demo', remoteId: 'ctr-b' });
});

// PINS the free-text half: a System that is not enumerable keeps exactly the
// field it always had, with nothing said.
test('a non-enumerable system keeps the free-text Remote field', async () => {
  const { open, choose } = await setup({
    remotes: () => ({ system: 'prod-box', label: 'Prod box', state: 'not-enumerable', reason: 'does not advertise' }),
  });
  await open();
  await choose('prod-box');
  assert.equal($('np-remote-select').hidden, true);
  assert.equal($('np-remote').hidden, false);
  assert.equal($('np-remote-note').textContent, '');
});

// PINS failure ≠ empty in the dialog: a failed enumeration — reported by the
// server, or a request that never got a state back — keeps free text and says
// why, rather than offering an empty dropdown.
test('a failed enumeration keeps free text and says why', async (t) => {
  await t.test('a failed state names its reason', async () => {
    const { open, choose } = await setup({
      remotes: () => ({ system: 'prod-box', label: 'Prod box', state: 'failed', reason: 'the provider is down', code: 'SYSTEM_UNREACHABLE' }),
    });
    await open();
    await choose('prod-box');
    assert.equal($('np-remote-select').hidden, true);
    assert.equal($('np-remote').hidden, false);
    assert.match($('np-remote-note').textContent, /Could not list the remotes of system 'prod-box' \(the provider is down\)/);
  });
  await t.test('a non-OK response names its status', async () => {
    const { open, choose } = await setup(); // the 503 catch-all
    await open();
    await choose('prod-box');
    assert.equal($('np-remote-select').hidden, true);
    assert.equal($('np-remote').hidden, false);
    assert.match($('np-remote-note').textContent, /\(HTTP 503\)/);
  });
});

// PINS empty ≠ not-enumerable: a provider configured for nothing still gets
// the dropdown — placeholder and Other… only — and the note says so.
test('an empty list offers only Other… and says so', async () => {
  const { open, choose } = await setup({ remotes: () => LISTED() });
  await open();
  await choose('prod-box');
  assert.equal($('np-remote-select').hidden, false);
  assert.deepEqual(optionTexts(), ['— choose a remote —', 'Other…']);
  assert.match($('np-remote-note').textContent, /lists no configured remotes right now/);
});

// PINS Other…: it reveals the free-text field, and what is typed there is what
// is posted.
test('Other… reveals the free-text field and posts what is typed', async () => {
  const { window, open, choose, pickOther, submit, posts } = await setup({ remotes: () => LISTED('ctr-a') });
  await open();
  $('np-name').value = 'demo';
  await choose('prod-box');
  await pickOther();
  assert.equal($('np-remote').hidden, false);
  $('np-remote').value = ' ctr-z ';
  $('np-remote').dispatchEvent(new window.Event('input'));
  $('np-system-path').value = '/srv/demo';
  await submit();
  assert.deepEqual(posts.at(-1), { name: 'demo', system: 'prod-box', systemPath: '/srv/demo', remoteId: 'ctr-z' });
});

// PINS the refusal: with a dropdown up, a remote has to be chosen — the
// placeholder, or Other… left blank, keeps the dialog open with nothing sent.
test('the placeholder, or Other… left blank, is refused in the dialog', async (t) => {
  for (const [title, act, message] of [
    ['the placeholder', async () => {}, /choose a remote on 'prod-box'/],
    ['Other… left blank', async (d) => d.pickOther(), /type a remote for 'prod-box', or pick a listed one/],
  ]) {
    await t.test(title, async () => {
      const d = await setup({ remotes: () => LISTED('ctr-a') });
      await d.open();
      $('np-name').value = 'demo';
      await d.choose('prod-box');
      $('np-system-path').value = '/srv/demo';
      await act(d);
      await d.submit();
      assert.equal(d.posts.length, 0, 'nothing was posted');
      assert.match($('np-error').textContent, message);
      assert.equal(d.dlg.open, true, 'the dialog reopens on the field to fix');
    });
  }
});

// PINS THE STALE-ANSWER DROP, one conjunct per subtest. An answer is applied
// only while it is the latest ask AND its system is still the one chosen.
test('a late answer for a previously chosen system is dropped', async (t) => {
  const TWO = [...SYSTEMS, { id: 'lab', label: 'Lab', managed: false, launch: ['ssh', 'lab'] }];

  // The SEQUENCE conjunct: the late answer is for the very system chosen now,
  // but an older ask of it — only the ask counter tells them apart.
  await t.test('an older ask of the system chosen again', async () => {
    let release;
    let asks = 0;
    const { open, choose } = await setup({
      systems: TWO,
      remotes: (system) => {
        if (system !== 'prod-box') return { system, label: 'Lab', state: 'listed', remoteIds: ['lab-1'] };
        return ++asks === 1 ? new Promise(r => { release = () => r(LISTED('stale-1')); }) : LISTED('fresh-1');
      },
    });
    await open();
    await choose('prod-box');
    await choose('lab');
    await choose('prod-box');
    assert.deepEqual(optionTexts(), ['— choose a remote —', 'fresh-1', 'Other…']);
    release();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(optionTexts(), ['— choose a remote —', 'fresh-1', 'Other…'], 'the older answer was dropped');
  });

  // The SYSTEM conjunct: the choice moved by a value write — no `change`, so no
  // new ask — and only the chosen-system check stops the answer landing.
  await t.test('an answer for a system no longer chosen', async () => {
    let release;
    const { open, choose, tick } = await setup({
      systems: TWO,
      remotes: () => new Promise(r => { release = () => r(LISTED('stale-1')); }),
    });
    await open();
    await choose('prod-box');
    $('np-system').value = 'lab';
    release();
    await tick();
    assert.equal($('np-remote-select').hidden, true, 'no dropdown for a system that is not chosen');
    assert.equal($('np-remote-select').options.length, 0);
  });
});

// PINS that a remote picked from the dropdown resets the path picker, as typing
// one does: a list open for the old target closes and its note clears.
test('choosing a listed remote resets the path picker', async () => {
  const { open, choose, typePath, pickRemote } = await setup({
    remotes: () => LISTED('ctr-a', 'ctr-b'),
    listing: () => ({ ok: true, entries: ['d1'], links: [], truncated: true, max: 9 }),
  });
  await open();
  await choose('prod-box');
  await pickRemote('ctr-a');
  await typePath('/srv/d');
  assert.equal($('np-system-path-completions').hidden, false, 'a list is open before the pick');
  await pickRemote('ctr-b');
  assert.equal($('np-system-path-completions').hidden, true);
  assert.equal($('np-system-path-completions').children.length, 0);
  assert.equal($('np-system-path-note').textContent, '');
});

// PINS the local short-circuit on the client: this machine has no named
// remotes, so choosing it asks the server nothing.
test('local asks nothing', async () => {
  const { open, choose, remoteAsks } = await setup({ remotes: () => LISTED('ctr-a') });
  await open();
  await choose('prod-box');
  await choose('local');
  assert.deepEqual(remoteAsks, ['prod-box']);
});

// PINS RESET ON REOPEN, for the whole family the dropdown added: an abandoned
// Other… with text in it must not come back as the next open's state — nor
// ride out on its POST.
test('reopening resets the dropdown, Other… and the note', async () => {
  const { window, dlg, open, choose, pickOther, submit, posts } = await setup({ remotes: () => LISTED('ctr-a') });
  await open();
  await choose('prod-box');
  await pickOther();
  $('np-remote').value = 'ctr-z';
  $('np-remote').dispatchEvent(new window.Event('input'));
  $('np-system-path').value = '/srv/demo';
  $('np-name').value = 'abandoned';
  dlg.close('cancel');

  await open();
  assert.equal($('np-remote-select').hidden, true);
  assert.equal($('np-remote-select').options.length, 0);
  assert.equal($('np-remote').hidden, false);
  assert.equal($('np-remote').value, '');
  assert.equal($('np-remote-note').textContent, '');
  assert.equal($('np-remote-row').hidden, true);
  assert.equal($('np-system').value, 'local');
  assert.equal($('np-system-path').value, '');
  assert.equal($('np-name').value, '');

  // The reset is what the POST is made of. A value write (no `change`, so no
  // ask) puts the project on the system: had the dropdown mode survived, this
  // would be refused for want of a chosen remote rather than posted bare.
  $('np-name').value = 'demo';
  $('np-system').value = 'prod-box';
  $('np-system-path').value = '/srv/demo';
  await submit();
  assert.deepEqual(posts.at(-1), { name: 'demo', system: 'prod-box', systemPath: '/srv/demo' });

  await open();
  $('np-name').value = 'demo';
  await submit();
  assert.deepEqual(posts.at(-1), { name: 'demo' });
});
