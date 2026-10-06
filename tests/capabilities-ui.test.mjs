// The UI hides what the host platform cannot run (public/capabilities.js reads
// GET /api/health): Settings → Systems / Voice, the composer mic, and the
// New-project / Adopt system pickers. Happy-dom, per docs/frontend-testing.md.
//
// The module memoises the first successful answer per process (each test file is
// its own process), so every test here boots OFF. A scenario that needs an
// unloaded module or another answer goes in its own file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { withHealth } from './capabilitiesStub.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const OFF = { remoteSystems: false, fuseUnion: false, voice: false };
const imp = (file) => import(pathToFileURL(path.join(PUB, file)).href);
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

// Installs the window + a recording fetch.
async function boot(capabilities) {
  const window = new Window({ url: 'http://localhost/#' });
  const urls = [];
  const fetchImpl = withHealth(async (url) => {
    urls.push(String(url));
    return { ok: false, status: 503, json: async () => ({}), text: async () => '{}' };
  }, capabilities);
  window.fetch = fetchImpl;
  Object.assign(globalThis, { window, document: window.document, location: window.location, history: window.history, fetch: fetchImpl });
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  return { window, urls };
}

test('Settings drops the Systems and Voice groups and never fetches them', async () => {
  const { window, urls } = await boot(OFF);
  const document = window.document;
  const main = document.createElement('div'); main.id = 'main';
  const view = document.createElement('section'); view.id = 'settings-view'; view.hidden = true;
  view.innerHTML = `
    <select id="settings-group-select">
      <option value="models">Models</option><option value="systems">Systems</option><option value="voice">Voice</option>
    </select>
    <div id="settings-models" class="settings-group"></div>
    <div id="settings-systems" class="settings-group" hidden></div>
    <div id="settings-voice" class="settings-group" hidden></div>`;
  main.appendChild(view); document.body.appendChild(main);

  const { installSettings } = await imp('settings.js');
  installSettings({ requestClose: () => {} });
  window.location.hash = '#settings';
  await tick();

  const options = [...document.getElementById('settings-group-select').options].map(o => o.value);
  assert.deepEqual(options, ['models']);
  for (const u of ['/api/settings/systems', '/api/settings/transcribe', '/api/settings/tts']) {
    assert.ok(!urls.some(x => x.startsWith(u)), `${u} was not fetched`);
  }
  assert.ok(urls.length > 0, 'positive control: other groups still load: ' + urls);
  window.happyDOM.abort();
});

async function composerWith(voiceSupported) {
  const { window } = await boot(OFF);
  const document = window.document;
  document.body.innerHTML = `
    <form id="composer">
      <div id="composer-attachments" hidden></div>
      <textarea id="composer-input"></textarea>
      <input id="composer-file" type="file" hidden />
      <button id="composer-attach" type="button"></button>
      <button id="composer-send" type="button" disabled><span class="cs-label">Send</span><svg class="cs-mic"></svg></button>
    </form>`;
  const { attachComposer } = await imp('composer.js');
  const sendBtn = document.getElementById('composer-send');
  const composer = attachComposer({
    form: document.getElementById('composer'),
    textarea: document.getElementById('composer-input'),
    sendBtn,
    attachBtn: document.getElementById('composer-attach'),
    fileInput: document.getElementById('composer-file'),
    chipsContainer: document.getElementById('composer-attachments'),
    onSubmit: () => {},
    voiceSupported,
  });
  composer.set({ canType: true, canSend: true });
  composer.setMicAvailable(true);
  return { sendBtn };
}

test('an empty composer stays in Send mode when voice is unsupported', async () => {
  const { sendBtn } = await composerWith(() => false);
  assert.ok(sendBtn.classList.contains('mode-send'));
  assert.ok(!sendBtn.classList.contains('mode-mic'));
  assert.ok(!/Whisper|dictate/i.test(sendBtn.title), sendBtn.title);
});

test('an empty composer shows the mic when voice is supported', async () => {
  const { sendBtn } = await composerWith(() => true);
  assert.ok(sendBtn.classList.contains('mode-mic'));
});

test('the New-project dialog hides the system rows and sends no system', async () => {
  const { window, urls } = await boot(OFF);
  const document = window.document;
  const posts = [];
  const prior = globalThis.fetch;
  globalThis.fetch = window.fetch = (url, opts = {}) => {
    if (String(url) === '/api/projects' && opts.method === 'POST') {
      posts.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ name: 'demo', path: '/x' }), text: async () => '{}' });
    }
    return prior(url, opts);
  };
  document.body.innerHTML = `
    <button id="np-btn"></button>
    <dialog id="np-dialog">
      <form id="np-form">
        <input id="np-name" />
        <label>System <select id="np-system"></select></label>
        <label id="np-system-path-row" hidden><input id="np-system-path" /></label>
        <ul id="np-system-path-completions" hidden></ul><p id="np-system-path-note"></p>
        <label id="np-remote-row" hidden><input id="np-remote" /></label>
        <code id="np-preview"></code><div id="np-contributions"></div><p id="np-error"></p>
      </form>
      <form id="np-confirm" hidden><p id="np-git-skipped" hidden></p>
        <div id="np-scaffold-block" hidden><textarea id="np-scaffold-text"></textarea></div></form>
    </dialog>`;
  const dlg = document.getElementById('np-dialog');
  dlg.showModal = function () { this.open = true; };
  dlg.close = function (v) { this.open = false; this.returnValue = v ?? this.returnValue; };
  const $ = (id) => document.getElementById(id);
  const { installNewProjectDialog } = await imp('newProjectDialog.js');
  installNewProjectDialog({
    dom: {
      newProjectBtn: $('np-btn'), newProjectDialog: dlg, npName: $('np-name'), npError: $('np-error'),
      npPreview: $('np-preview'), npContributions: $('np-contributions'), npSystem: $('np-system'),
      npSystemPath: $('np-system-path'), npSystemPathRow: $('np-system-path-row'),
      npSystemPathCompletions: $('np-system-path-completions'), npSystemPathNote: $('np-system-path-note'),
      npRemote: $('np-remote'), npRemoteRow: $('np-remote-row'), npForm: $('np-form'),
      npConfirm: $('np-confirm'), npScaffoldText: $('np-scaffold-text'),
      npScaffoldBlock: $('np-scaffold-block'), npGitSkipped: $('np-git-skipped'),
    },
    refreshProjects: async () => {},
    closeSidebarOverflow: () => {},
  });
  $('np-btn').click();
  await tick();
  assert.equal($('np-system').closest('label').hidden, true);
  assert.equal($('np-system-path-row').hidden, true);
  assert.equal($('np-remote-row').hidden, true);
  assert.ok(!urls.some(u => u.includes('/api/settings/systems')), 'registry not fetched');

  $('np-name').value = 'demo';
  dlg.returnValue = 'create';
  dlg.dispatchEvent(new window.Event('close'));
  await tick();
  assert.equal(posts.length, 1);
  assert.ok(!('system' in posts[0]) && !('systemPath' in posts[0]), JSON.stringify(posts[0]));
});

test('the Adopt dialog hides the system picker and sends no system', async () => {
  const { window, urls } = await boot(OFF);
  const document = window.document;
  const posts = [];
  const prior = globalThis.fetch;
  globalThis.fetch = window.fetch = (url, opts = {}) => {
    if (String(url) === '/api/projects/external') {
      posts.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ ok: true, name: 'a' }) });
    }
    if (String(url).includes('/api/projects/suggestions')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ root: '/r', dirs: [] }) });
    }
    return prior(url, opts);
  };
  document.body.innerHTML = `
    <button id="adopt-btn"></button>
    <dialog id="adopt-dlg">
      <form id="apd-form">
        <input id="apd-name" />
        <label>System <select id="apd-system"></select></label>
        <p id="apd-system-note"></p>
        <label id="apd-remote-row" hidden><input id="apd-remote" /></label>
        <input id="apd-path" /><ul id="apd-path-completions" hidden></ul><p id="apd-path-note"></p><ul id="apd-suggestions"></ul><p id="apd-scan-note"></p><p id="apd-error"></p>
      </form>
      <p id="apd-stale-summary"></p><ul id="apd-stale-discards"></ul><p id="apd-stale-error"></p>
    </dialog>`;
  const dlg = document.getElementById('adopt-dlg');
  dlg.showModal = function () { this.open = true; };
  dlg.close = function (v) { this.open = false; this.returnValue = v ?? this.returnValue; };
  const $ = (id) => document.getElementById(id);
  const { installAdoptProjectDialog } = await imp('adoptProjectDialog.js');
  installAdoptProjectDialog({
    dom: {
      adoptProjectBtn: $('adopt-btn'), adoptProjectDialog: dlg, apdForm: $('apd-form'), apdStale: $('apd-form'),
      apdName: $('apd-name'), apdSystem: $('apd-system'), apdSystemNote: $('apd-system-note'),
      apdRemote: $('apd-remote'), apdRemoteRow: $('apd-remote-row'), apdPath: $('apd-path'),
      apdPathCompletions: $('apd-path-completions'), apdPathNote: $('apd-path-note'),
      apdSuggestions: $('apd-suggestions'), apdScanNote: $('apd-scan-note'), apdError: $('apd-error'),
      apdStaleSummary: $('apd-stale-summary'), apdStaleDiscards: $('apd-stale-discards'), apdStaleError: $('apd-stale-error'),
    },
    refreshProjects: async () => {},
    closeSidebarOverflow: () => {},
  });
  $('adopt-btn').click();
  await tick();
  assert.equal($('apd-system').closest('label').hidden, true);
  assert.equal($('apd-remote-row').hidden, true);
  assert.ok(!urls.some(u => u.includes('/api/settings/systems')), 'registry not fetched');

  $('apd-name').value = 'a';
  $('apd-path').value = '/abs/a';
  dlg.returnValue = 'adopt';
  dlg.dispatchEvent(new window.Event('close'));
  await tick();
  assert.equal(posts.length, 1);
  assert.ok(!('system' in posts[0]) || posts[0].system == null, JSON.stringify(posts[0]));
});
