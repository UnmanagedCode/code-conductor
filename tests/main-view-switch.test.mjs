// Switching between the full-page main views (Settings, commits, review,
// costs, plugin): opening one must leave exactly that view shown, with the URL
// naming it — no two sections stacked, and no superseded view rewriting the
// hash back to the session anchor on its way out.
//
// Each view module is loaded fresh per test (cache-busted URL) and installed
// in app.js's order, with leave callbacks that behave like app.js's (they
// write the session anchor via replaceState) and count their calls. The
// app.js call sites themselves (sidebar.onShowCommits, selectInstance) cannot
// be loaded here; the "conversation claim" test drives the same
// replaceState-then-reconcileMainViews() sequence selectInstance runs.
//
// Load-bearing harness shim: happy-dom dispatches `hashchange` for
// history.pushState/replaceState, which browsers never do — and that one
// difference hides the stacking bug (Settings only hides on hashchange, and
// commits/costs open via pushState). installBrowserHashSemantics() swallows
// exactly the hashchange events a history call queued; its positive control is
// the first test below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let counter = 0;
function freshImport(file) {
  const url = pathToFileURL(path.resolve(__dirname, '..', 'public', file)).href;
  return import(`${url}?t=${++counter}`);
}
function sharedImport(file) {
  return import(pathToFileURL(path.resolve(__dirname, '..', 'public', file)).href);
}

function makeWindow(url) {
  const window = new Window({ url, settings: { disableIframePageLoading: true } });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.history = window.history;
  window.fetch = () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
  globalThis.fetch = window.fetch;
  return window;
}

// happy-dom queues one hashchange per hash-changing URL update, delivered in
// order. A history call's event is identified by its (oldURL, newURL) pair and
// stopped in a capture listener registered before any app listener; events
// from `location.hash =` still reach the app.
function installBrowserHashSemantics(window) {
  const pending = [];
  for (const op of ['pushState', 'replaceState']) {
    const orig = window.history[op].bind(window.history);
    window.history[op] = (...args) => {
      const oldURL = window.location.href;
      const oldHash = window.location.hash;
      orig(...args);
      if (window.location.hash !== oldHash) pending.push({ oldURL, newURL: window.location.href });
    };
  }
  window.addEventListener('hashchange', e => {
    const head = pending[0];
    if (head && head.oldURL === e.oldURL && head.newURL === e.newURL) {
      pending.shift();
      e.stopImmediatePropagation();
    }
  }, true);
}

function el(document, tag, id, parent, hidden = false) {
  const node = document.createElement(tag);
  node.id = id;
  node.hidden = hidden;
  parent.appendChild(node);
  return node;
}

// The ids each view module touches; Settings' set mirrors
// tests/settings-toggle.test.mjs.
function buildDOM(document) {
  const main = el(document, 'main', 'main', document.body);

  const settings = el(document, 'section', 'settings-view', main, true);
  const groupSelect = el(document, 'select', 'settings-group-select', settings);
  for (const g of ['voice', 'models']) {
    const opt = document.createElement('option');
    opt.value = g;
    groupSelect.appendChild(opt);
    const panel = el(document, 'div', `settings-${g}`, settings, g !== 'voice');
    panel.className = 'settings-group';
  }
  for (const [id, tag] of [
    ['st-status', 'div'], ['st-model-list', 'ul'], ['st-install-btn', 'button'],
    ['st-action-hint', 'span'], ['st-install-log', 'pre'],
    ['pl-status', 'div'], ['pl-list', 'ul'], ['pl-rescan-btn', 'button'],
    ['pll-status', 'div'], ['pll-list', 'ul'],
  ]) el(document, tag, id, settings);
  const pllTail = el(document, 'details', 'pll-tail', settings, true);
  el(document, 'pre', 'pll-tail-pre', pllTail);

  const commits = el(document, 'section', 'commits-view', main, true);
  for (const id of ['commits-back', 'commits-title', 'commits-stats', 'commits-list']) el(document, 'div', id, commits);

  const review = el(document, 'section', 'review-view', main, true);
  for (const id of ['review-back', 'review-title', 'review-stats', 'review-commit-message', 'review-file-list']) el(document, 'div', id, review);

  const costs = el(document, 'section', 'costs-view', main, true);
  for (const id of ['costs-back', 'costs-body']) el(document, 'div', id, costs);

  el(document, 'section', 'plugin-view', main, true);
  return main;
}

const VIEWS = ['settings', 'commits', 'review', 'costs', 'plugin'];
const HASH = {
  settings: '#settings', commits: '#commits', review: '#review',
  costs: '#costs', plugin: '#plugin/fake/',
};

async function setup() {
  const window = makeWindow('http://localhost/#session=start');
  installBrowserHashSemantics(window);
  const main = buildDOM(window.document);

  const [{ installPluginView }, { installSettings }, { installReview }, { installCommits }, { installCosts }] =
    await Promise.all(['pluginView.js', 'settings.js', 'review.js', 'commits.js', 'costs.js'].map(freshImport));

  const calls = { settings: 0, commits: 0, review: 0, costs: 0, pluginClosed: 0 };
  const writeAnchor = () => window.history.replaceState(null, '', '#session=start');
  const leave = name => () => { calls[name]++; writeAnchor(); };

  // app.js's install order.
  installPluginView({ onClosed: () => { calls.pluginClosed++; } });
  const settings = installSettings({ requestClose: leave('settings') });
  const review = installReview();
  const commits = installCommits({ onClose: leave('commits') });
  const costs = installCosts({ onClose: leave('costs') });

  const open = {
    settings: () => settings.open(),
    commits: () => commits.open('p'),
    review: () => review.open({ title: 'p / wt', url: '/api/projects/p/worktrees/wt/diff', onBack: leave('review') }),
    costs: () => costs.open(),
    plugin: () => { window.location.hash = HASH.plugin; },
  };
  const settle = () => window.happyDOM.waitUntilComplete();
  const shown = () => VIEWS.filter(v => !window.document.getElementById(`${v}-view`).hidden);
  const openClasses = () => VIEWS.filter(v => main.classList.contains(`${v}-open`));
  return { window, calls, open, settle, shown, openClasses, views: { settings, review, commits, costs } };
}

// INVARIANT: the harness has browser hashchange semantics — history calls
// deliver no hashchange, `location.hash =` does, even when interleaved.
test('harness: pushState/replaceState fire no hashchange, location.hash does', async () => {
  const window = makeWindow('http://localhost/#');
  installBrowserHashSemantics(window);
  const seen = [];
  window.addEventListener('hashchange', e => seen.push(new URL(e.newURL).hash));

  window.history.pushState(null, '', '#pushed');
  await window.happyDOM.waitUntilComplete();
  window.history.replaceState(null, '', '#replaced');
  await window.happyDOM.waitUntilComplete();
  assert.deepEqual(seen, [], 'history calls must not reach app listeners');

  window.location.hash = '#assigned';
  await window.happyDOM.waitUntilComplete();
  assert.deepEqual(seen, ['#assigned']);

  // An assignment queued before a history call is still delivered.
  window.location.hash = '#assigned-2';
  window.history.pushState(null, '', '#pushed-2');
  await window.happyDOM.waitUntilComplete();
  assert.deepEqual(seen, ['#assigned', '#assigned-2']);
  window.happyDOM.abort();
});

// INVARIANT: opening any main view leaves exactly that view shown, `#main`
// carrying only its -open class, the URL naming it, and the superseded view's
// leave callback (which navigates) never run.
test('opening a main view supersedes whichever other one is showing', async t => {
  for (const from of VIEWS) {
    for (const to of VIEWS) {
      // Layering review over commits is not a supersede (next test); costs is
      // only reachable from Settings' own button, which leaves Settings.
      if (from === to || to === 'costs' || (from === 'commits' && to === 'review')) continue;
      await t.test(`${from} → ${to}`, async () => {
        const h = await setup();
        h.open[from](); await h.settle();
        assert.deepEqual(h.shown(), [from], 'precondition: the first view is open');

        h.open[to](); await h.settle();
        assert.deepEqual(h.shown(), [to], 'sections shown');
        assert.deepEqual(h.openClasses(), [to], '#main -open classes');
        assert.equal(h.window.location.hash, HASH[to], 'location.hash');
        if (from !== 'plugin') assert.equal(h.calls[from], 0, `${from}'s leave callback must not run on supersede`);
        h.window.happyDOM.abort();
      });
    }
  }
});

// INVARIANT: review opened from the commit list layers over it (both shown,
// hash #review), and backing out of the diff returns to the list alone.
test('a commit-row review (no onBack) layers over commits, and backing out returns to the list', async () => {
  const h = await setup();
  h.open.commits(); await h.settle();
  h.views.review.open({ title: 'abc123 subject', url: '/api/projects/p/commits/abc123/diff' });
  await h.settle();
  assert.deepEqual(h.shown(), ['commits', 'review']);
  assert.deepEqual(h.openClasses(), ['commits', 'review']);
  assert.equal(h.window.location.hash, '#review');

  h.window.location.hash = '#commits'; await h.settle();
  assert.deepEqual(h.shown(), ['commits']);
  assert.deepEqual(h.openClasses(), ['commits']);
  assert.equal(h.calls.commits, 0, 'commits did not leave');
  h.window.happyDOM.abort();
});

// INVARIANT: a view's leave callback runs when the view is left for the
// conversation — explicit close(), and (for the hash-routed views) the hash
// navigating to a non-view anchor.
test('leaving a main view runs its leave callback', async t => {
  for (const name of ['settings', 'commits', 'review', 'costs']) {
    await t.test(`${name}: close()`, async () => {
      const h = await setup();
      h.open[name](); await h.settle();
      h.views[name].close(); await h.settle();
      assert.equal(h.calls[name], 1);
      assert.deepEqual(h.shown(), []);
      h.window.happyDOM.abort();
    });
  }
  for (const name of ['commits', 'review', 'costs']) {
    await t.test(`${name}: hash leaves to #session=`, async () => {
      const h = await setup();
      h.open[name](); await h.settle();
      h.window.location.hash = '#session=other'; await h.settle();
      assert.equal(h.calls[name], 1);
      assert.deepEqual(h.shown(), []);
      h.window.happyDOM.abort();
    });
  }
});

// INVARIANT: once the URL names the session (selectInstance's replaceState),
// reconcileMainViews() clears every main view — whatever the hash was, layered
// or not — and the plugin view's onClosed notification still fires.
test('selecting a session clears every main view', async t => {
  const cases = [...VIEWS.map(v => [v]), ['commits', 'review']];
  for (const stack of cases) {
    await t.test(stack.join(' + '), async () => {
      const h = await setup();
      const { reconcileMainViews } = await sharedImport('mainViews.js');
      if (stack.length === 2) {
        h.open.commits(); await h.settle();
        h.views.review.open({ title: 'c', url: '/api/projects/p/commits/c/diff' }); await h.settle();
      } else {
        h.open[stack[0]](); await h.settle();
      }
      assert.deepEqual(h.shown(), stack, 'precondition');
      const closedBefore = h.calls.pluginClosed;

      h.window.history.replaceState(null, '', '#session=picked'); await h.settle();
      reconcileMainViews(); await h.settle();
      assert.deepEqual(h.shown(), []);
      assert.deepEqual(h.openClasses(), []);
      assert.equal(h.window.location.hash, '#session=picked', 'reconcile never navigates');
      if (stack[0] === 'plugin') assert.equal(h.calls.pluginClosed, closedBefore + 1, 'plugin onClosed fired');
      h.window.happyDOM.abort();
    });
  }
});

// INVARIANT: the registry is per window — a view registered on one window is
// never reconciled from another.
test('mainViews registry is scoped to its window', async () => {
  const { registerMainView, reconcileMainViews } = await sharedImport('mainViews.js');
  const a = makeWindow('http://localhost/#elsewhere');
  let superseded = 0;
  registerMainView({ matches: h => h === '#mine', isOpen: () => true, supersede: () => { superseded++; } });

  const b = makeWindow('http://localhost/#elsewhere');
  reconcileMainViews();
  assert.equal(superseded, 0, 'reconciling another window must not reach it');

  globalThis.window = a;
  globalThis.location = a.location;
  reconcileMainViews();
  assert.equal(superseded, 1, 'reconciling its own window does');
  a.happyDOM.abort();
  b.happyDOM.abort();
});

// INVARIANT: reconcileMainViews() tears down only views that are showing — a
// main view that is installed but closed (never opened, or already left) is
// not torn down again by later switches, so its teardown notification (the
// plugin view's onClosed) fires once per close, never per switch.
test('switching views never re-tears-down a closed view', async t => {
  const switchAround = async h => {
    const { reconcileMainViews } = await sharedImport('mainViews.js');
    h.open.settings(); await h.settle();
    h.open.commits(); await h.settle();
    h.window.history.replaceState(null, '', '#session=picked'); await h.settle();
    reconcileMainViews(); await h.settle();
    h.open.review(); await h.settle();
    h.open.settings(); await h.settle();
  };

  await t.test('plugin view never opened', async () => {
    const h = await setup();
    await switchAround(h);
    assert.equal(h.calls.pluginClosed, 0, 'onClosed must not fire for a view that was never shown');
    h.window.happyDOM.abort();
  });

  await t.test('plugin view already left', async () => {
    const h = await setup();
    h.open.plugin(); await h.settle();
    h.open.commits(); await h.settle();
    assert.equal(h.calls.pluginClosed, 1, 'precondition: leaving the plugin view fired onClosed once');
    await switchAround(h);
    assert.equal(h.calls.pluginClosed, 1, 'onClosed must not fire again after the view is closed');
    h.window.happyDOM.abort();
  });

  await t.test('registry: a registered view reporting closed is not superseded', async () => {
    makeWindow('http://localhost/#elsewhere');
    const { registerMainView, reconcileMainViews } = await sharedImport('mainViews.js');
    let superseded = 0;
    registerMainView({ matches: () => false, isOpen: () => false, supersede: () => { superseded++; } });
    reconcileMainViews();
    assert.equal(superseded, 0);
    window.happyDOM.abort();
  });
});
