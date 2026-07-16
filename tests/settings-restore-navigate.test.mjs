// Test for the "restore → navigate to restored session" behavior: clicking
// Restore on the Archived-sessions page should hand the restored session's
// identity to `onSessionRestored` so app.js can resume/select it and close
// Settings. Uses the same happy-dom harness as settings-toggle.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function buildDOM(document) {
  const main = document.createElement('div');
  main.id = 'main';

  const view = document.createElement('section');
  view.id = 'settings-view';
  view.hidden = true;

  const groupSelect = document.createElement('select');
  groupSelect.id = 'settings-group-select';
  for (const val of ['transcribe', 'archived']) {
    const opt = document.createElement('option');
    opt.value = val;
    groupSelect.appendChild(opt);
  }
  view.appendChild(groupSelect);

  for (const g of ['transcribe', 'archived']) {
    const panel = document.createElement('div');
    panel.id = `settings-${g}`;
    panel.className = 'settings-group';
    panel.hidden = g !== 'transcribe';
    view.appendChild(panel);
  }

  for (const [id, tag] of [
    ['st-status', 'div'], ['st-model-list', 'ul'],
    ['st-install-btn', 'button'], ['st-action-hint', 'span'], ['st-install-log', 'pre'],
  ]) {
    const el = document.createElement(tag);
    el.id = id;
    if (id === 'st-install-btn' || id === 'st-install-log') el.hidden = true;
    view.appendChild(el);
  }

  // Plugins group DOM — `pl-list` must exist or installPluginManager() no-ops
  // entirely (see public/pluginManager.js).
  for (const [id, tag] of [
    ['pl-status', 'div'], ['pl-list', 'ul'], ['pl-rescan-btn', 'button'],
    ['pll-status', 'div'], ['pll-list', 'ul'],
  ]) {
    const el = document.createElement(tag);
    el.id = id;
    view.appendChild(el);
  }
  const pllTail = document.createElement('details');
  pllTail.id = 'pll-tail';
  pllTail.hidden = true;
  const pllTailPre = document.createElement('pre');
  pllTailPre.id = 'pll-tail-pre';
  pllTail.appendChild(pllTailPre);
  view.appendChild(pllTail);

  // Archived group elements — ar-status/ar-list render the restorable rows.
  const arStatus = document.createElement('div');
  arStatus.id = 'ar-status';
  view.appendChild(arStatus);
  const arList = document.createElement('div');
  arList.id = 'ar-list';
  view.appendChild(arList);

  main.appendChild(view);
  document.body.appendChild(main);
  return { main, view, arList };
}

let counter = 0;
async function setup(fetchImpl) {
  const window = new Window({ url: 'http://localhost/#' });
  window.fetch = fetchImpl || (() => Promise.resolve({
    ok: false, status: 503,
    json: () => Promise.resolve({}),
  }));

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.history = window.history;
  globalThis.fetch = window.fetch;

  const dom = buildDOM(window.document);

  const url = pathToFileURL(
    path.resolve(__dirname, '..', 'public', 'settings.js'),
  ).href + '?t=' + (++counter);
  const mod = await import(url);
  return { window, mod, ...dom };
}

function click(node, win) {
  node.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
}

const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

function stubRestoreFetch() {
  const ok = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  const notFound = () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
  const archivedGroups = {
    groups: [{
      project: 'demoproj',
      sessions: [{ sessionId: 'sid-1', title: 'Fix the thing', worktreeName: null, mtime: 0 }],
    }],
  };

  const impl = (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url === '/api/archived') return ok(archivedGroups);
    if (url === '/api/projects/demoproj/sessions/sid-1/restore' && method === 'POST') return ok({ ok: true });
    return notFound();
  };
  return impl;
}

test('settings: clicking Restore on an archived session fires onSessionRestored with its identity', async () => {
  const { window, mod, arList } = await setup(stubRestoreFetch());
  let restored = null;
  const s = mod.installSettings({
    requestClose: () => {},
    onArchivedChanged: () => {},
    onSessionRestored: (identity) => { restored = identity; },
  });

  s.open();
  await window.happyDOM.waitUntilComplete();
  await tick();

  const restoreBtn = [...arList.querySelectorAll('.archived-restore')][0];
  assert.ok(restoreBtn, 'Restore button rendered for the archived session');

  click(restoreBtn, window);
  await tick(20);

  assert.deepEqual(restored, { project: 'demoproj', worktreeName: null, sessionId: 'sid-1' });
  window.happyDOM.abort();
});

test('settings: onSessionRestored does not fire when the restore request fails', async () => {
  const impl = (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url === '/api/archived') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          groups: [{ project: 'demoproj', sessions: [{ sessionId: 'sid-1', title: 'x', worktreeName: null, mtime: 0 }] }],
        }),
      });
    }
    if (url === '/api/projects/demoproj/sessions/sid-1/restore' && method === 'POST') {
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) });
    }
    return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
  };
  const { window, mod, arList } = await setup(impl);
  globalThis.alert = () => {}; // restoreArchived() alerts on failure
  let restored = null;
  const s = mod.installSettings({
    requestClose: () => {},
    onSessionRestored: (identity) => { restored = identity; },
  });

  s.open();
  await window.happyDOM.waitUntilComplete();
  await tick();

  const restoreBtn = [...arList.querySelectorAll('.archived-restore')][0];
  click(restoreBtn, window);
  await tick(20);

  assert.equal(restored, null, 'onSessionRestored must not fire when the restore POST fails');
  window.happyDOM.abort();
});
