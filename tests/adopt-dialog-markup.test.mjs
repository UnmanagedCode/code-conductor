// THE AFFORDANCE ITSELF — that the Adopt dialog is REACHABLE from the browser,
// not merely that its module works when handed elements.
//
// tests/adopt-project-dialog.test.mjs builds its own fragment, so it pins the
// module's behaviour and nothing about `public/index.html` or `public/app.js`.
// Deleting the <dialog> block, renaming one id, or dropping the install call
// would leave every test in that file green while the feature vanished from the
// page. This card exists to ship a UI affordance, so that chain is the claim.
//
// Three links, one test each:
//   1. the real index.html holds every element app.js looks up,
//   2. app.js binds those ids to those keys AND passes them to the install,
//   3. the real markup drives the real module end to end.
//
// Same harness as tests/header-change-effort.test.mjs: the real index.html into
// happy-dom so `dom` matches app.js's wiring. Scripts are stripped as
// tests/hidden-attribute-layout.test.mjs does — they are irrelevant here and
// only give happy-dom fetches to fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

// THE CONTRACT, spelled once: the `dom` key the module reads ← the element id
// in index.html. Both sides are asserted against this map, so a rename that
// touches only one of them fails here rather than at runtime in a browser.
const WIRING = {
  adoptProjectBtn: 'adopt-project-btn',
  adoptProjectDialog: 'adopt-project-dialog',
  apdForm: 'apd-form',
  apdStale: 'apd-stale',
  apdName: 'apd-name',
  apdPath: 'apd-path',
  apdSuggestions: 'apd-suggestions',
  apdScanNote: 'apd-scan-note',
  apdError: 'apd-error',
  apdStaleSummary: 'apd-stale-summary',
  apdStaleDiscards: 'apd-stale-discards',
  apdStaleError: 'apd-stale-error',
};

// The `returnValue`s installAdoptProjectDialog's close handler switches on.
// They live in the markup alone, so nothing else pins them.
const SUBMIT_VALUES = ['adopt', 'relocate', 'replace'];

async function renderIndex() {
  const html = (await fs.readFile(path.join(PUB, 'index.html'), 'utf8'))
    .replace(/<script[\s\S]*?<\/script>/g, '');
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  window.document.documentElement.innerHTML = html;
  return window;
}

const domFrom = document =>
  Object.fromEntries(Object.entries(WIRING).map(([k, id]) => [k, document.getElementById(id)]));

// PINS: every element app.js looks up for this dialog EXISTS in the shipped
// markup — and that the dialog is reachable, sitting in the sidebar overflow
// panel rather than orphaned somewhere with no way to open it.
test('index.html holds every element the adopt dialog is wired to', async () => {
  const window = await renderIndex();
  const document = window.document;
  const dom = domFrom(document);
  for (const [k, id] of Object.entries(WIRING)) {
    assert.ok(dom[k], `dom.${k} must resolve to #${id} in index.html`);
  }

  // The button is in the ≡ panel — the route the user actually takes.
  assert.equal(dom.adoptProjectBtn.closest('#sidebar-overflow-panel')?.id, 'sidebar-overflow-panel',
    'the Adopt button sits in the sidebar overflow panel');
  assert.equal(dom.adoptProjectBtn.getAttribute('role'), 'menuitem');
  assert.equal(dom.adoptProjectBtn.getAttribute('type'), 'button',
    'a menu button must not submit anything');

  // Two panes, both inside the one dialog, both `method="dialog"` — which is
  // what turns a menu button's `value` into the `returnValue` the module reads.
  for (const key of ['apdForm', 'apdStale']) {
    assert.equal(dom[key].tagName, 'FORM');
    assert.equal(dom[key].getAttribute('method'), 'dialog', `#${WIRING[key]} closes the dialog`);
    assert.equal(dom[key].closest('dialog')?.id, 'adopt-project-dialog');
  }
  assert.equal(dom.apdForm.hidden, false, 'the form pane is the one that opens');
  assert.equal(dom.apdStale.hidden, true, 'the stale pane starts hidden');

  // The three submit values the close handler branches on.
  const values = [...dom.adoptProjectDialog.querySelectorAll('button[value]')]
    .map(b => b.getAttribute('value'));
  for (const v of SUBMIT_VALUES) {
    assert.ok(values.includes(v), `the dialog must offer a button with value="${v}"`);
  }
  assert.ok(values.includes('cancel'), 'and a way out that submits nothing');

  // The name field enforces the server's charset where the user is still
  // looking at it.
  assert.equal(dom.apdName.getAttribute('pattern'), '[a-zA-Z0-9._-]+');
});

// PINS: THE INSTALL ACTUALLY HAPPENS, and binds the ids above. Dropping the
// `installAdoptProjectDialog({...})` call — or renaming one element-map entry —
// makes the feature unreachable while leaving every behavioural test green, so
// the wiring is asserted against app.js's source rather than assumed.
test('app.js binds those ids and installs the dialog', async () => {
  const appJs = await fs.readFile(path.join(PUB, 'app.js'), 'utf8');

  assert.match(appJs, /import \{ installAdoptProjectDialog \} from '\.\/adoptProjectDialog\.js';/,
    'app.js imports the module');

  const call = appJs.match(/installAdoptProjectDialog\(\{[\s\S]*?\n\}\);/);
  assert.ok(call, 'app.js calls installAdoptProjectDialog');
  for (const key of Object.keys(WIRING)) {
    assert.match(appJs, new RegExp(`\\b${key}: document\\.getElementById\\('${WIRING[key]}'\\)`),
      `app.js's element map binds ${key} to #${WIRING[key]}`);
    assert.match(call[0], new RegExp(`\\b${key}: dom\\.${key}\\b`),
      `the install call passes ${key}`);
  }
  for (const dep of ['refreshProjects', 'closeSidebarOverflow']) {
    assert.match(call[0], new RegExp(`\\b${dep},`), `the install call passes ${dep}`);
  }
});

// PINS: the shipped markup and the shipped module fit each other. Every id, the
// two panes' hidden toggling, and the button `value`s are exercised through the
// REAL document — the one thing neither the fragment-driven behavioural tests
// nor the static assertions above can establish on their own.
test('the real markup drives the real module end to end', async () => {
  const window = await renderIndex();
  const document = window.document;
  const dom = domFrom(document);

  const scan = {
    root: '/root', maxDepth: 3, truncated: false, unreadable: 0,
    candidates: [{ path: '/root/work/api', relPath: 'work/api', depth: 2, isGitRepo: true, suggestedName: 'api' }],
  };
  const posts = [
    { status: 200, body: { ok: false, code: 'PROJECT_EXISTS_STALE', reason: 'stale', heldPath: '/old/api', discards: { attachments: 0, debug: 0, worktrees: 0 } } },
    { status: 201, body: { ok: true } },
  ];
  const requests = [];
  let postIdx = 0;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/api/projects/suggestions')) return { ok: true, status: 200, json: async () => scan };
    requests.push({ url: String(url), body: JSON.parse(opts.body) });
    const next = posts[Math.min(postIdx++, posts.length - 1)];
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  };

  let refreshed = 0;
  let overflowClosed = 0;
  const { installAdoptProjectDialog } = await import(
    pathToFileURL(path.join(PUB, 'adoptProjectDialog.js')).href + `?t=${Math.random()}`);
  installAdoptProjectDialog({
    dom,
    refreshProjects: async () => { refreshed++; },
    closeSidebarOverflow: () => { overflowClosed++; },
  });

  const tick = () => new Promise(r => setTimeout(r, 0));
  dom.adoptProjectBtn.click();
  await tick();
  assert.equal(overflowClosed, 1, 'opening the dialog dismisses the ≡ menu');

  const row = dom.apdSuggestions.querySelector('button.apd-suggestion');
  assert.ok(row, 'the scan rendered a clickable row into the real <ul>');
  row.click();
  assert.equal(dom.apdPath.value, '/root/work/api');
  assert.equal(dom.apdName.value, 'api');

  dom.adoptProjectDialog.close('adopt');
  await tick();
  assert.equal(dom.apdStale.hidden, false, 'the real stale pane is revealed');
  assert.equal(dom.apdForm.hidden, true, 'and the real form pane is hidden');

  dom.adoptProjectDialog.close('relocate');
  await tick();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body,
    { name: 'api', path: '/root/work/api', onStaleRecord: 'relocate' });
  assert.equal(refreshed, 1);
});
