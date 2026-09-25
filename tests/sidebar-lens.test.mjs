// The Conductors / Projects lens toggle (public/sidebarLens.js) and the
// #sidebar-body markup it switches (public/index.html).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { PUB } from './sidebar-fixture.mjs';

const { installSidebarLens } = await import(pathToFileURL(path.join(PUB, 'sidebarLens.js')).href);
const KEY = 'code-conductor:sidebar-lens';

// A fresh page from the real index.html, with a localStorage the caller may
// seed before the install runs.
async function page({ stored } = {}) {
  const html = await fs.readFile(path.join(PUB, 'index.html'), 'utf8');
  const window = new Window({
    url: 'http://localhost/',
    settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  window.document.write(html.replace(/<script\b[\s\S]*?<\/script>/g, ''));
  globalThis.localStorage = window.localStorage;
  if (stored !== undefined) window.localStorage.setItem(KEY, stored);
  return window;
}

function install(window) {
  const document = window.document;
  const dom = {
    sidebar: document.getElementById('sidebar'),
    sidebarLensButtons: document.querySelectorAll('.sidebar-lens button'),
  };
  const closes = [];
  installSidebarLens({ dom, closeSidebarOverflow: () => closes.push(1) });
  const btn = (lens) => document.querySelector(`.sidebar-lens button[data-lens="${lens}"]`);
  return { dom, closes, btn };
}

test('a fresh profile defaults to Conductors', async () => {
  const window = await page();
  const { dom, btn } = install(window);
  assert.equal(dom.sidebar.dataset.lens, 'conductors');
  assert.equal(btn('conductors').getAttribute('aria-pressed'), 'true');
  assert.equal(btn('projects').getAttribute('aria-pressed'), 'false');
});

test('clicking Projects persists the choice; a re-install reads it back', async () => {
  const window = await page();
  const { dom, btn } = install(window);
  btn('projects').click();
  assert.equal(dom.sidebar.dataset.lens, 'projects');
  assert.equal(btn('projects').getAttribute('aria-pressed'), 'true');
  assert.equal(btn('conductors').getAttribute('aria-pressed'), 'false');
  assert.equal(window.localStorage.getItem(KEY), 'projects');

  const again = await page({ stored: window.localStorage.getItem(KEY) });
  const second = install(again);
  assert.equal(second.dom.sidebar.dataset.lens, 'projects');
  assert.equal(second.btn('projects').getAttribute('aria-pressed'), 'true');
});

test('a garbage stored value falls back to Conductors', async () => {
  const window = await page({ stored: 'bogus' });
  const { dom, btn } = install(window);
  assert.equal(dom.sidebar.dataset.lens, 'conductors');
  assert.equal(btn('conductors').getAttribute('aria-pressed'), 'true');
});

test('switching to Conductors closes the ≡ overflow', async () => {
  const window = await page({ stored: 'projects' });
  const { closes, btn } = install(window);
  btn('projects').click();
  assert.equal(closes.length, 0, 'staying on / moving to Projects leaves the menu alone');
  btn('conductors').click();
  assert.equal(closes.length, 1);
});

test('#sidebar-body order: Conduct alone, strip slot, lens toggle, Projects row (filter + ≡ menu), then the lists', async () => {
  const window = await page();
  const doc = window.document;
  assert.equal(doc.getElementById('sidebar').getAttribute('data-lens'), 'conductors', 'the first paint is already Conductors');
  const body = doc.getElementById('sidebar-body');
  const kids = [...body.children].map(c => c.id || c.className);
  assert.deepEqual(kids, [
    'sidebar-actions',
    'sidebar-strip-slot',
    'sidebar-lens',
    'projects-lens-row projects-lens-only',
    'conductor-list',
    'project-list',
  ]);
  const actions = body.querySelector('.sidebar-actions');
  assert.deepEqual([...actions.children].map(c => c.id), ['conduct-btn']);
  const row = body.querySelector('.projects-lens-row');
  assert.deepEqual([...row.children].map(c => c.id), ['conductor-filter', 'sidebar-overflow-menu']);
  assert.ok(doc.querySelector('#conductor-filter select#conductor-filter-select'));
  assert.ok(doc.getElementById('conductor-list').classList.contains('conductors-lens-only'));
  assert.ok(doc.getElementById('project-list').classList.contains('projects-lens-only'));
});
