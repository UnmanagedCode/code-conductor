// The Settings → Conductor preferred-playbook picker (public/defaultPlaybook.js)
// and the seam that feeds it (conventionsPanel's `onData`), driven under
// happy-dom against a scripted fetch.
//
// Server-side tests cannot see these: renaming the payload key or deleting the
// one-line `onData?.(data)` call leaves every REST test green while the picker
// permanently shows only "None".
//
// The picker's three rows mirror DefaultPlaybookSelection: unset (resolving to
// the payload's `defaultPlaybookFallback`), the explicit None opt-out, and an id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

let counter = 0;
function freshImport(name) {
  return import(pathToFileURL(path.join(PUB, name)).href + '?t=' + (++counter));
}

const BASE = '/api/settings/conventions/conductor';

const PAYLOAD = {
  core: { name: 'Core', description: 'core' },
  conventions: [{ slug: 'playbooks', name: 'Playbooks', description: 'p', body: '## Playbooks', builtin: true }],
  enabled: ['playbooks'],
  playbooks: [
    { id: 'solo', name: 'Solo — one worker', description: 'c', entryStages: ['plan'], spawnableStages: ['plan', 'review'] },
    { id: 'relay', name: 'Relay — plan and implement are distinct', description: 's', entryStages: ['plan'], spawnableStages: ['plan'] },
  ],
  playbookErrors: [],
  defaultPlaybook: { mode: 'playbook', id: 'relay' },
  // DELIBERATELY not the real DEFAULT_PLAYBOOK_ID: the label must come
  // from the payload, so a client-side hardcode of the shipped id fails here.
  defaultPlaybookFallback: 'freeform',
};

// A window with the picker's markup (and the conventions panel's, for the seam
// test), plus a scripted fetch recording every call.
function setup({ payload = PAYLOAD } = {}) {
  const window = new Window({ url: 'http://localhost/', settings: { disableIframePageLoading: true } });
  globalThis.window = window;
  globalThis.document = window.document;
  window.document.body.innerHTML = `
    <div class="st-actions"><label for="dp-select">Preferred playbook</label><select id="dp-select"></select></div>
    <div id="dp-status"></div>
    <div id="cc-status"></div>
    <ul id="cc-convention-list"></ul>
  `;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    if ((opts.method || 'GET') === 'GET') {
      return { ok: true, status: 200, json: async () => structuredClone(payload) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { window, calls };
}

const optionsOf = (sel) => [...sel.options].map(o => [o.value, o.textContent]);

test('renders the unset and None rows plus one per playbook, and preselects the stored default', async () => {
  const { window } = setup();
  const { installDefaultPlaybook } = await freshImport('defaultPlaybook.js');
  installDefaultPlaybook({ base: BASE }).render(PAYLOAD);

  const sel = window.document.getElementById('dp-select');
  assert.deepEqual(optionsOf(sel), [
    ['unset', 'Unset — falls back to freeform'],
    ['none', 'None — no playbook convention injected'],
    ['playbook:solo', 'solo — Solo — one worker'],
    ['playbook:relay', 'relay — Relay — plan and implement are distinct'],
  ]);
  assert.equal(sel.value, 'playbook:relay', 'stored default is preselected');
});

// The two states a two-row picker would collapse. Rendering unset as None (or
// vice versa) misreports what the conductor is actually getting.
test('unset selects the Unset row; None selects the None row', async () => {
  const { window } = setup();
  const { installDefaultPlaybook } = await freshImport('defaultPlaybook.js');
  const picker = installDefaultPlaybook({ base: BASE });
  const sel = window.document.getElementById('dp-select');

  picker.render({ ...PAYLOAD, defaultPlaybook: { mode: 'unset' } });
  assert.equal(sel.value, 'unset');
  picker.render({ ...PAYLOAD, defaultPlaybook: { mode: 'none' } });
  assert.equal(sel.value, 'none');
});

test('a re-render does not accumulate duplicate options', async () => {
  const { window } = setup();
  const { installDefaultPlaybook } = await freshImport('defaultPlaybook.js');
  const picker = installDefaultPlaybook({ base: BASE });
  picker.render(PAYLOAD);
  picker.render(PAYLOAD);
  assert.equal(window.document.getElementById('dp-select').options.length, 4);
});

test('each row PUTs its own tagged selection', async () => {
  const { window, calls } = setup();
  const { installDefaultPlaybook } = await freshImport('defaultPlaybook.js');
  installDefaultPlaybook({ base: BASE }).render(PAYLOAD);
  const sel = window.document.getElementById('dp-select');
  const pick = async (value) => {
    sel.value = value;
    sel.dispatchEvent(new window.Event('change'));
    await window.happyDOM.waitUntilComplete();
    return calls.at(-1);
  };

  assert.deepEqual(await pick('playbook:solo'), {
    url: `${BASE}/default-playbook`, method: 'PUT', body: { defaultPlaybook: { mode: 'playbook', id: 'solo' } },
  });
  // The opt-out and the reset are DIFFERENT bodies — a picker that sent one for
  // both would silently move the user between "nothing" and the built-in default.
  assert.deepEqual((await pick('none')).body, { defaultPlaybook: { mode: 'none' } });
  assert.deepEqual((await pick('unset')).body, { defaultPlaybook: { mode: 'unset' } });
});

test('a failed save is reported rather than silently swallowed', async () => {
  const { window } = setup();
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'unknown playbook id' }) });
  const { installDefaultPlaybook } = await freshImport('defaultPlaybook.js');
  installDefaultPlaybook({ base: BASE }).render(PAYLOAD);
  const sel = window.document.getElementById('dp-select');
  sel.value = 'playbook:solo';
  sel.dispatchEvent(new window.Event('change'));
  await window.happyDOM.waitUntilComplete();
  assert.match(window.document.getElementById('dp-status').textContent, /unknown playbook id/);
});

test('definitions rejected at load are surfaced, not swallowed into an empty list', async () => {
  const { window } = setup();
  const { installDefaultPlaybook } = await freshImport('defaultPlaybook.js');
  installDefaultPlaybook({ base: BASE }).render({
    ...PAYLOAD, playbooks: [], playbookErrors: [{ id: 'mine', message: 'stages must be a non-empty object' }],
  });
  const status = window.document.getElementById('dp-status').textContent;
  assert.match(status, /mine: stages must be a non-empty object/);
  assert.equal(window.document.getElementById('dp-select').options.length, 2, 'only the unset and None rows');
});

test('conventionsPanel.load() feeds its onData consumer the whole payload', async () => {
  // The seam: one GET backs both widgets. Deleting `onData?.(data)` leaves every
  // server test green and the picker permanently empty.
  const { window } = setup();
  const [{ installConventionsPanel }, { installDefaultPlaybook }] = await Promise.all([
    freshImport('conventionsPanel.js'), freshImport('defaultPlaybook.js'),
  ]);
  const picker = installDefaultPlaybook({ base: BASE });
  const panel = installConventionsPanel({
    prefix: 'cc', base: BASE, hasToggle: true, noun: 'conductor convention', onData: picker.render,
  });
  await panel.load();
  const sel = window.document.getElementById('dp-select');
  assert.equal(sel.options.length, 4, 'picker populated from the panel load');
  assert.equal(sel.value, 'playbook:relay');
  assert.equal(window.document.getElementById('cc-convention-list').children.length, 1, 'panel still rendered its own list');
});
