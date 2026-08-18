// Characterization pin for public/sidebarChrome.js — the sidebar drawer /
// scrim / width clamp / ≡ overflow menu.
//
// Written BEFORE the extraction lands (expand-then-contract): at this commit
// public/sidebarChrome.js is an unreferenced verbatim copy of the four blocks
// still live in public/app.js, so these assertions describe the CURRENT
// shipped behaviour. The follow-up commit deletes app.js's copies and wires
// this module; the reviewer's check is that
// `git diff <pin> <wire> -- public/sidebarChrome.js` is empty.
//
// Tier-A harness (same shape as tests/header-mute.test.mjs): load the real
// public/index.html into happy-dom so `dom` matches app.js's getElementById
// wiring, then drive the real factory.
//
// Invariants pinned here:
//   - clampSidebarWidth clamps at 220 and 560, passes through in-range, and
//     returns null for NaN / Infinity / non-numeric
//   - a stored width inside the range is applied to --sidebar-width at install
//   - an out-of-range stored width is clamped, not applied raw
//   - the drawer toggle flips .open on both sidebar and scrim and tracks
//     aria-expanded; the scrim click closes it
//   - closeSidebarOnMobile is gated on the 720px media query — it must NEVER
//     collapse the desktop column
//   - the ≡ overflow toggles hidden + aria-expanded, dismisses on outside
//     click and on Escape, and closeSidebarOverflow on an unarmed controller
//     is a no-op
//
// NOT pinned: the pointerdown drag gesture. It depends on setPointerCapture
// and a computed custom-property read, neither of which happy-dom models
// faithfully enough to bet on — a fake that stubs both would prove nothing.
// The hand UI pass covers the drag (plan Box 3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const INDEX_HTML = path.join(PUB, 'index.html');

const WIDTH_KEY = 'code-conductor:sidebar-width';

async function setup({ storedWidth = null, mobile = false } = {}) {
  const html = await fs.readFile(INDEX_HTML, 'utf8');
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  window.document.documentElement.innerHTML = html;
  const document = window.document;

  const stored = new Map();
  if (storedWidth != null) stored.set(WIDTH_KEY, String(storedWidth));
  globalThis.localStorage = {
    getItem: (k) => (stored.has(k) ? stored.get(k) : null),
    setItem: (k, v) => { stored.set(k, String(v)); },
    removeItem: (k) => { stored.delete(k); },
  };
  // matchMedia drives the mobile-vs-desktop branch. happy-dom's own
  // implementation has no viewport to consult, so pin it explicitly.
  window.matchMedia = (q) => ({ matches: mobile && q === '(max-width: 720px)', media: q });

  const dom = {
    sidebar: document.getElementById('sidebar'),
    sidebarScrim: document.getElementById('sidebar-scrim'),
    sidebarToggle: document.getElementById('sidebar-toggle'),
    sidebarResizeHandle: document.getElementById('sidebar-resize-handle'),
    sidebarOverflowToggle: document.getElementById('sidebar-overflow-toggle'),
    sidebarOverflowPanel: document.getElementById('sidebar-overflow-panel'),
  };
  for (const [k, v] of Object.entries(dom)) {
    assert.ok(v, `dom.${k} must resolve to a real element from index.html`);
  }

  const mod = await import(
    pathToFileURL(path.join(PUB, 'sidebarChrome.js')).href + `?t=${Math.random()}`
  );
  const handle = mod.installSidebarChrome({ dom });
  return { window, document, dom, handle, stored, mod };
}

const click = (node, win) =>
  node.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));

// ── clampSidebarWidth ──────────────────────────────────────────────────────

test('clampSidebarWidth: clamps at both ends and passes an in-range value through', async () => {
  const { mod } = await setup();
  const { clampSidebarWidth } = mod;
  assert.equal(clampSidebarWidth(100), 220, 'below the floor clamps up to 220');
  assert.equal(clampSidebarWidth(220), 220);
  assert.equal(clampSidebarWidth(300), 300, 'in-range passes through untouched');
  assert.equal(clampSidebarWidth(560), 560);
  assert.equal(clampSidebarWidth(9999), 560, 'above the ceiling clamps down to 560');
});

test('clampSidebarWidth: returns null for NaN, Infinity and non-numeric input', async () => {
  const { mod } = await setup();
  const { clampSidebarWidth } = mod;
  for (const bad of [NaN, Infinity, -Infinity, undefined]) {
    assert.equal(clampSidebarWidth(bad), null, `${String(bad)} must yield null, not a clamped number`);
  }
});

// ── stored width applied at install ────────────────────────────────────────

test('an in-range stored width is applied to --sidebar-width at install', async () => {
  const { document } = await setup({ storedWidth: 340 });
  assert.equal(
    document.documentElement.style.getPropertyValue('--sidebar-width'), '340px');
});

test('an out-of-range stored width is clamped before it is applied', async () => {
  const { document } = await setup({ storedWidth: 9999 });
  assert.equal(
    document.documentElement.style.getPropertyValue('--sidebar-width'), '560px',
    'the raw 9999 must never reach the custom property');
});

test('a garbage stored width leaves --sidebar-width unset (CSS default wins)', async () => {
  const { document } = await setup({ storedWidth: 'not-a-number' });
  assert.equal(
    document.documentElement.style.getPropertyValue('--sidebar-width'), '',
    'no fabricated width is written');
});

test('no stored width leaves --sidebar-width unset', async () => {
  const { document } = await setup();
  assert.equal(document.documentElement.style.getPropertyValue('--sidebar-width'), '');
});

// ── drawer: toggle + scrim ─────────────────────────────────────────────────

test('the toggle opens and closes the drawer, flipping .open on sidebar AND scrim', async () => {
  const { window, dom } = await setup({ mobile: true });
  assert.equal(dom.sidebar.classList.contains('open'), false, 'starts closed');

  click(dom.sidebarToggle, window);
  assert.equal(dom.sidebar.classList.contains('open'), true);
  assert.equal(dom.sidebarScrim.classList.contains('open'), true, 'scrim tracks the drawer');
  assert.equal(dom.sidebarToggle.getAttribute('aria-expanded'), 'true');

  click(dom.sidebarToggle, window);
  assert.equal(dom.sidebar.classList.contains('open'), false);
  assert.equal(dom.sidebarScrim.classList.contains('open'), false);
  assert.equal(dom.sidebarToggle.getAttribute('aria-expanded'), 'false');
});

test('a scrim click closes the drawer', async () => {
  const { window, dom } = await setup({ mobile: true });
  click(dom.sidebarToggle, window);
  assert.equal(dom.sidebar.classList.contains('open'), true, 'sanity: open');
  click(dom.sidebarScrim, window);
  assert.equal(dom.sidebar.classList.contains('open'), false);
  assert.equal(dom.sidebarToggle.getAttribute('aria-expanded'), 'false');
});

// ── closeSidebarOnMobile: the 720px guard ──────────────────────────────────

test('closeSidebarOnMobile collapses the drawer below 720px', async () => {
  const { window, dom, handle } = await setup({ mobile: true });
  click(dom.sidebarToggle, window);
  assert.equal(dom.sidebar.classList.contains('open'), true, 'sanity: open');
  handle.closeSidebarOnMobile();
  assert.equal(dom.sidebar.classList.contains('open'), false);
});

test('closeSidebarOnMobile is INERT on desktop — it must never collapse the column', async () => {
  const { window, dom, handle } = await setup({ mobile: false });
  click(dom.sidebarToggle, window);
  assert.equal(dom.sidebar.classList.contains('open'), true, 'sanity: .open was set');
  handle.closeSidebarOnMobile();
  assert.equal(dom.sidebar.classList.contains('open'), true,
    'above the breakpoint the guard must short-circuit — every navigation call site relies on this');
});

// ── ≡ overflow menu ────────────────────────────────────────────────────────

test('the ≡ toggle un-hides the panel and sets aria-expanded, and a second click re-hides it', async () => {
  const { window, dom } = await setup();
  assert.equal(dom.sidebarOverflowPanel.hidden, true, 'starts hidden');

  click(dom.sidebarOverflowToggle, window);
  assert.equal(dom.sidebarOverflowPanel.hidden, false);
  assert.equal(dom.sidebarOverflowToggle.getAttribute('aria-expanded'), 'true');

  click(dom.sidebarOverflowToggle, window);
  assert.equal(dom.sidebarOverflowPanel.hidden, true);
  assert.equal(dom.sidebarOverflowToggle.getAttribute('aria-expanded'), 'false');
});

test('an outside pointerdown dismisses the ≡ overflow', async () => {
  const { window, document, dom } = await setup();
  click(dom.sidebarOverflowToggle, window);
  assert.equal(dom.sidebarOverflowPanel.hidden, false, 'sanity: open');

  document.getElementById('conversation').dispatchEvent(
    new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
  assert.equal(dom.sidebarOverflowPanel.hidden, true);
  assert.equal(dom.sidebarOverflowToggle.getAttribute('aria-expanded'), 'false');
});

test('a pointerdown INSIDE the panel does not dismiss it', async () => {
  const { window, dom } = await setup();
  click(dom.sidebarOverflowToggle, window);
  dom.sidebarOverflowPanel.dispatchEvent(
    new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
  assert.equal(dom.sidebarOverflowPanel.hidden, false,
    'clicking an item inside the menu must not close it out from under the click');
});

test('Escape dismisses the ≡ overflow', async () => {
  const { window, document, dom } = await setup();
  click(dom.sidebarOverflowToggle, window);
  assert.equal(dom.sidebarOverflowPanel.hidden, false, 'sanity: open');

  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(dom.sidebarOverflowPanel.hidden, true);
});

test('closeSidebarOverflow on an unarmed controller is a no-op', async () => {
  const { dom, handle } = await setup();
  dom.sidebarOverflowToggle.setAttribute('aria-expanded', 'sentinel');
  handle.closeSidebarOverflow();
  assert.equal(dom.sidebarOverflowToggle.getAttribute('aria-expanded'), 'sentinel',
    'the armed guard must short-circuit before touching the DOM');
});

test('closeSidebarOverflow closes an open menu and disarms it', async () => {
  const { window, document, dom, handle } = await setup();
  click(dom.sidebarOverflowToggle, window);
  handle.closeSidebarOverflow();
  assert.equal(dom.sidebarOverflowPanel.hidden, true);

  // Disarmed: a later outside pointerdown must not re-run onDismiss against a
  // stale listener. Re-open, and confirm one toggle is enough to show it.
  click(dom.sidebarOverflowToggle, window);
  assert.equal(dom.sidebarOverflowPanel.hidden, false,
    'a single toggle re-opens — the controller state and the DOM stayed in sync');
  document.getElementById('conversation').dispatchEvent(
    new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
  assert.equal(dom.sidebarOverflowPanel.hidden, true);
});
