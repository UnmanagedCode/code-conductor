// Settings when the host's capabilities cannot be read (public/capabilities.js
// resolves null): every group loads as marked up, and the next open retries.
// Its own file because public/capabilities.js memoises the first successful
// answer per process. Happy-dom, per docs/frontend-testing.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const imp = (file) => import(pathToFileURL(path.join(PUB, file)).href);
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

test('an unknown capabilities answer loads every group, and the next open retries and applies it', async () => {
  const window = new Window({ url: 'http://localhost/#' });
  let healthCalls = 0;
  const urls = [];
  const fetchImpl = (url) => {
    if (String(url).includes('/api/health')) {
      healthCalls++;
      return healthCalls === 1
        ? Promise.reject(new Error('transient'))
        : Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, capabilities: { remoteSystems: true, fuseUnion: true, voice: false } }) });
    }
    urls.push(String(url));
    return Promise.resolve({ ok: false, status: 503, json: async () => ({}), text: async () => '{}' });
  };
  window.fetch = fetchImpl;
  Object.assign(globalThis, { window, document: window.document, location: window.location, history: window.history, fetch: fetchImpl });
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  const document = window.document;
  const warn = console.warn; console.warn = () => {};
  try {
    const main = document.createElement('div'); main.id = 'main';
    const view = document.createElement('section'); view.id = 'settings-view'; view.hidden = true;
    view.innerHTML = `
      <select id="settings-group-select">
        <option value="models">Models</option><option value="systems">Systems</option><option value="voice">Voice</option>
      </select>
      <div id="settings-models" class="settings-group"></div>
      <div id="settings-systems" class="settings-group" hidden><div id="sy-status"></div><ul id="sy-list"></ul></div>
      <div id="settings-voice" class="settings-group" hidden>
        <div id="st-status"></div><ul id="st-model-list"></ul><div id="tt-status"></div><ul id="tt-voice-list"></ul>
      </div>`;
    main.appendChild(view); document.body.appendChild(main);
    const { installSettings } = await imp('settings.js');
    installSettings({ requestClose: () => {} });
    const options = () => [...document.getElementById('settings-group-select').options].map(o => o.value);

    window.location.hash = '#settings';
    await tick();
    assert.equal(healthCalls, 1);
    for (const u of ['/api/settings/systems', '/api/settings/transcribe', '/api/settings/tts']) {
      assert.ok(urls.some(x => x.startsWith(u)), `${u} was fetched: ${urls}`);
    }
    assert.deepEqual(options(), ['models', 'systems', 'voice']);

    window.location.hash = '#';
    await tick();
    window.location.hash = '#settings';
    await tick();
    assert.equal(healthCalls, 2, 'the reopen retried');
    assert.deepEqual(options(), ['models', 'systems']);
    const caps = await imp('capabilities.js');
    assert.equal(caps.capabilities().remoteSystems, true);
  } finally { console.warn = warn; }
  window.happyDOM.abort();
});
