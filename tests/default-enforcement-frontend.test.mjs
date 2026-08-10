// The Settings → Conductor playbook-enforcement picker (public/defaultEnforcement.js)
// and its share of the seam that feeds it (conventionsPanel's `onData`), driven
// under happy-dom against a scripted fetch.
//
// Server-side tests cannot see these: renaming a payload key or dropping this
// widget out of settings.js's composed `onData` leaves every REST test green
// while the picker permanently shows the wrong level — which reads as "my
// conductors start enforcing" when they don't.
//
// The payload's mode list is DELIBERATELY not the shipped ['warn','enforce']:
// a picker with a client-side allow-list would render the shipped rows instead
// and fail to preselect the stored level, so the substitution is visible rather
// than coincidental.

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

// Modes no build of src/playbooks.ts has ever shipped: if any of them renders
// as a row and preselects, the list came off the wire.
const PAYLOAD = {
  core: { name: 'Core', description: 'core' },
  conventions: [{ slug: 'playbooks', name: 'Playbooks', description: 'p', body: '## Playbooks', builtin: true }],
  enabled: ['playbooks'],
  playbooks: [],
  playbookErrors: [],
  defaultPlaybook: { mode: 'unset' },
  defaultPlaybookFallback: 'relay',
  playbookEnforcementModes: ['lenient', 'strict', 'paranoid'],
  defaultPlaybookEnforcement: 'strict',
};

function setup({ payload = PAYLOAD } = {}) {
  const window = new Window({ url: 'http://localhost/', settings: { disableIframePageLoading: true } });
  globalThis.window = window;
  globalThis.document = window.document;
  window.document.body.innerHTML = `
    <div class="st-actions"><label for="dp-select">Preferred playbook</label><select id="dp-select"></select></div>
    <div id="dp-status"></div>
    <div class="st-actions"><label for="dpe-select">Playbook enforcement</label><select id="dpe-select"></select></div>
    <div id="dpe-status"></div>
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

const valuesOf = (sel) => [...sel.options].map(o => o.value);

test('rows come from the payload allow-list, not a client-side copy', async () => {
  const { window } = setup();
  const { installDefaultEnforcement } = await freshImport('defaultEnforcement.js');
  installDefaultEnforcement({ base: BASE }).render(PAYLOAD);

  const sel = window.document.getElementById('dpe-select');
  assert.deepEqual(valuesOf(sel), ['lenient', 'strict', 'paranoid'],
    'a hardcoded warn/enforce list would show those instead');
  assert.equal(sel.value, 'strict', 'the persisted level is preselected');
  // A mode with no label entry still gets a row, so the server list stays the
  // authority on which levels exist.
  assert.equal([...sel.options].find(o => o.value === 'paranoid').textContent, 'paranoid');
});

test('the shipped levels render with their explanatory labels', async () => {
  const { window } = setup();
  const { installDefaultEnforcement } = await freshImport('defaultEnforcement.js');
  installDefaultEnforcement({ base: BASE }).render({
    ...PAYLOAD, playbookEnforcementModes: ['warn', 'enforce'], defaultPlaybookEnforcement: 'warn',
  });
  const sel = window.document.getElementById('dpe-select');
  assert.deepEqual([...sel.options].map(o => [o.value, o.textContent]), [
    ['warn', 'Warn — off-graph calls are ledgered and proceed'],
    ['enforce', 'Enforce — off-graph calls are refused'],
  ]);
  assert.equal(sel.value, 'warn');
});

test('a re-render does not accumulate duplicate options', async () => {
  const { window } = setup();
  const { installDefaultEnforcement } = await freshImport('defaultEnforcement.js');
  const picker = installDefaultEnforcement({ base: BASE });
  picker.render(PAYLOAD);
  picker.render(PAYLOAD);
  assert.equal(window.document.getElementById('dpe-select').options.length, 3);
});

test('picking a level PUTs it to the enforcement endpoint', async () => {
  const { window, calls } = setup();
  const { installDefaultEnforcement } = await freshImport('defaultEnforcement.js');
  installDefaultEnforcement({ base: BASE }).render(PAYLOAD);
  const sel = window.document.getElementById('dpe-select');
  sel.value = 'lenient';
  sel.dispatchEvent(new window.Event('change'));
  await window.happyDOM.waitUntilComplete();

  // Its OWN endpoint and body shape — posting to /default-playbook would be
  // rejected server-side but silently, and the level would never persist.
  assert.deepEqual(calls.at(-1), {
    url: `${BASE}/default-playbook-enforcement`, method: 'PUT', body: { mode: 'lenient' },
  });
});

test('a failed save is reported rather than silently swallowed', async () => {
  const { window } = setup();
  const { installDefaultEnforcement } = await freshImport('defaultEnforcement.js');
  installDefaultEnforcement({ base: BASE }).render(PAYLOAD);
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'mode must be one of warn | enforce' }) });
  const sel = window.document.getElementById('dpe-select');
  sel.value = 'lenient';
  sel.dispatchEvent(new window.Event('change'));
  await window.happyDOM.waitUntilComplete();
  assert.match(window.document.getElementById('dpe-status').textContent, /mode must be one of/);
});

test('one panel load feeds BOTH conductor pickers', async () => {
  // The seam, as settings.js composes it: a single onData fans out to the
  // preferred-playbook picker and this one. Dropping either call leaves every
  // server test green and that widget permanently empty.
  const { window } = setup();
  const [{ installConventionsPanel }, { installDefaultPlaybook }, { installDefaultEnforcement }] = await Promise.all([
    freshImport('conventionsPanel.js'), freshImport('defaultPlaybook.js'), freshImport('defaultEnforcement.js'),
  ]);
  const playbook = installDefaultPlaybook({ base: BASE });
  const enforcement = installDefaultEnforcement({ base: BASE });
  const panel = installConventionsPanel({
    prefix: 'cc', base: BASE, hasToggle: true, noun: 'conductor convention',
    onData: (data) => { playbook.render(data); enforcement.render(data); },
  });
  await panel.load();

  assert.equal(window.document.getElementById('dpe-select').value, 'strict', 'enforcement picker populated');
  assert.equal(window.document.getElementById('dp-select').value, 'unset', 'playbook picker still populated');
});
