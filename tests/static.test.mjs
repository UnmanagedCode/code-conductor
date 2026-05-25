import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { Window } from 'happy-dom';
import { bootServer, api } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.resolve(__dirname, '..', 'public', 'index.html');

test('serves index.html with module entry', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const r = await fetch(baseUrl + '/');
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /<script type="module" src="\/app\.js">/);
    assert.match(html, /id="conversation"/);
    assert.match(html, /id="mode-select"/);
  } finally { await close(); }
});

test('serves each public asset', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    for (const asset of ['/app.js', '/ws.js', '/sidebar.js', '/conversation.js', '/blocks.js', '/composer.js', '/styles.css', '/sw.js', '/notifications.js', '/diff.js']) {
      const r = await fetch(baseUrl + asset);
      assert.equal(r.status, 200, `expected 200 for ${asset}`);
      const len = Number(r.headers.get('content-length') ?? 0);
      assert.ok(len > 0, `${asset} should be non-empty`);
    }
  } finally { await close(); }
});

test('instance-controls: auto-approve-plan-btn lives in the controls row (not the overflow menu)', async () => {
  // The toggle is the user-facing control for the "auto-approve plans"
  // feature and needs to be one click away — including mid-turn — rather
  // than buried two clicks deep inside the ⋮ overflow panel.
  const html = await fs.readFile(INDEX_HTML, 'utf8');
  const window = new Window({ url: 'http://localhost/' });
  window.document.documentElement.innerHTML = html;
  const doc = window.document;
  const btn = doc.getElementById('auto-approve-plan-btn');
  assert.ok(btn, 'auto-approve-plan-btn must exist');
  assert.equal(btn.parentElement?.id, 'instance-controls',
    'auto-approve-plan-btn must be a direct child of #instance-controls');
  assert.equal(btn.getAttribute('aria-pressed'), 'false', 'default aria-pressed=false');
  assert.ok(btn.getAttribute('aria-label'), 'icon-only button needs an aria-label');
  assert.ok(btn.getAttribute('title'), 'tooltip text required for hover/long-press');
  assert.ok(btn.hasAttribute('disabled'), 'starts disabled until an instance is selected');
  assert.ok(btn.classList.contains('auto-approve-toggle'),
    'has the .auto-approve-toggle class for inline styling');
});

test('instance-controls: kill-btn moved into the ⋮ overflow menu', async () => {
  // Interrupt/Kill is less frequently needed than the primary controls,
  // so it lives inside the ⋮ panel alongside Debug — freeing the
  // controls row for the always-visible auto-approve toggle.
  const html = await fs.readFile(INDEX_HTML, 'utf8');
  const window = new Window({ url: 'http://localhost/' });
  window.document.documentElement.innerHTML = html;
  const doc = window.document;
  const killBtn = doc.getElementById('kill-btn');
  assert.ok(killBtn, 'kill-btn must exist');
  assert.equal(killBtn.parentElement?.id, 'overflow-panel',
    'kill-btn must live inside #overflow-panel');
  assert.ok(killBtn.hasAttribute('disabled'), 'starts disabled until an instance is selected');
  // Sibling order: kill-btn before debug-btn so it's the primary
  // overflow action.
  const panel = doc.getElementById('overflow-panel');
  const children = Array.from(panel.children);
  const killIdx = children.indexOf(killBtn);
  const debugIdx = children.indexOf(doc.getElementById('debug-btn'));
  assert.ok(killIdx >= 0 && debugIdx >= 0 && killIdx < debugIdx,
    'kill-btn must precede debug-btn in the overflow panel');
});

test('quick-spawn dialog hosts a plan + auto-accept toggle, default off', async () => {
  // The Quick (↯) dialog gates a per-open decision: spawn the temp
  // session in plan mode with auto-approve pre-armed, or fall through to
  // the default code-mode spawn. The toggle must live inside the dialog,
  // start aria-pressed=false (no persistence per design), and sit above
  // the model row so it's read before the user commits to a model.
  const html = await fs.readFile(INDEX_HTML, 'utf8');
  const window = new Window({ url: 'http://localhost/' });
  window.document.documentElement.innerHTML = html;
  const doc = window.document;
  const dialog = doc.getElementById('quick-spawn-dialog');
  assert.ok(dialog, 'quick-spawn-dialog must exist');
  const toggle = doc.getElementById('qs-plan-toggle');
  assert.ok(toggle, 'qs-plan-toggle must exist');
  assert.ok(dialog.contains(toggle), 'toggle must live inside the dialog');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false', 'default aria-pressed=false');
  // Order check: toggle precedes the .quick-spawn-models row.
  const models = dialog.querySelector('.quick-spawn-models');
  assert.ok(models, '.quick-spawn-models row must exist');
  const togglePos = toggle.compareDocumentPosition(models);
  assert.ok(togglePos & window.Node.DOCUMENT_POSITION_FOLLOWING,
    'toggle must come before the model row');
});

test('DOM-free public modules import cleanly in Node', async () => {
  // Use file:// imports — these modules have no top-level browser-globals
  // access, so a successful import proves their syntax + imports resolve.
  // app.js touches document at top level so it's excluded.
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const pub = path.resolve(here, '..', 'public');
  for (const asset of ['blocks.js', 'sidebar.js', 'conversation.js', 'composer.js']) {
    const mod = await import(url.pathToFileURL(path.join(pub, asset)).href);
    assert.ok(mod, `${asset} imported`);
  }
});
