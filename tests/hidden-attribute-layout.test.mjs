// An element that ships `hidden` must actually be laid out as hidden.
//
// An AUTHOR `display` outranks the UA stylesheet's `[hidden] { display: none }`
// — origin decides this, not specificity, so even a weak selector wins — and
// public/styles.css has several. Each one needs a paired `[hidden]` reset, the
// idiom already used for .overflow-panel, .lightbox-backdrop and .turn-indicator
// (whose comment documents the trap).
//
// Two elements had none. `dialog label { display: block }` caught d3007496's
// `<label id="np-system-path-row" hidden>` under the New Project dialog's System
// dropdown: "Path on that system" stood there permanently, offsetting every row
// below the dropdown, and newProjectDialog.js's syncSystemPathRow() toggling
// `.hidden` changed nothing on screen. `.composer-attachments { display: flex }`
// caught #composer-attachments, which was symptom-free only because composer.js
// hides it exactly when it is empty and an empty flex box has no footprint.
//
// tests/new-project-placement.test.mjs pins the `.hidden` PROPERTY for local vs
// remote; it builds a bare DOM with no stylesheet, so it cannot see whether
// `hidden` hides. This file is the other half: the real public/index.html under
// the real public/styles.css.
//
// SCOPE: the static index.html, with scripts stripped. A dialog label built in
// JS is not swept — an accepted gap, since the three that exist
// (workspaceDialog.js, settings.js, newProjectDialog.js) are never hidden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

// Scripts are stripped rather than merely blocked: index.html's module scripts
// are irrelevant to the cascade and only give happy-dom fetches to fail.
async function renderIndex() {
  const [html, css] = await Promise.all([
    fs.readFile(path.join(PUB, 'index.html'), 'utf8'),
    fs.readFile(path.join(PUB, 'styles.css'), 'utf8'),
  ]);
  const window = new Window({
    url: 'http://localhost/',
    settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  const document = window.document;
  document.write(html.replace(/<script\b[\s\S]*?<\/script>/g, ''));
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  return { window, document, style };
}

const displayOf = (window, el) => window.getComputedStyle(el).display;

test('the New Project dialog\'s "Path on that system" row is laid out per its hidden attribute', async () => {
  const { window, document } = await renderIndex();
  const row = document.getElementById('np-system-path-row');
  assert.ok(row, 'index.html must still carry #np-system-path-row');
  assert.equal(row.hasAttribute('hidden'), true, 'it ships hidden — a local project has no path to choose');

  assert.equal(
    displayOf(window, row), 'none',
    'the row must not render while hidden; `dialog label { display: block }` outranks the UA [hidden] rule',
  );

  // The other direction: the reset must be scoped to [hidden], not blanket the
  // row out of existence for the remote case the dialog exists to offer.
  row.hidden = false;
  assert.notEqual(
    displayOf(window, row), 'none',
    'choosing a remote system must reveal the row',
  );
});

// Elements that must lay out while carrying `hidden`. An entry belongs here only
// with a reason — the point of the sweep is that nothing opts out of `hidden`
// silently. Empty is the intended state, and it is empty.
const RENDERS_WHILE_HIDDEN = new Set();

// Every author selector that declares `display`, including inside @media — a
// rule that only applies at some widths still opts its element out of `hidden`
// at those widths. Selectors happy-dom cannot match (pseudo-elements) are
// skipped rather than crashing the sweep.
function authorDisplaySelectors(document) {
  const out = [];
  const walk = (rules) => {
    for (const rule of rules) {
      if (rule.selectorText && rule.style?.getPropertyValue('display')) out.push(rule.selectorText);
      if (rule.cssRules) walk(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) walk(sheet.cssRules);
  return out;
}

// Origin, not specificity, is what decides this in a browser: the UA's
// `[hidden] { display: none }` loses to ANY matching author `display`, however
// weak its selector — which is why `dialog label` (0,0,2) beat it. happy-dom
// ships no UA stylesheet at all, so `getComputedStyle` here reports the author
// cascade alone and every element without an author rule reads as its tag
// default. Asking "does an author `display` match, and does it resolve to
// something other than none?" is therefore both the faithful question and the
// invariant itself.
function sweep(window, document) {
  const selectors = authorDisplaySelectors(document);
  const hidden = [...document.querySelectorAll('[hidden]')];
  const offenders = hidden
    .filter(el => !RENDERS_WHILE_HIDDEN.has(el.id))
    // An author display resolving to `none` is the paired reset doing its job.
    .filter(el => displayOf(window, el) !== 'none')
    .filter(el => selectors.some(sel => { try { return el.matches(sel); } catch { return false; } }))
    .map(el => `${el.tagName.toLowerCase()}#${el.id || '(no id)'}.${el.className || '(no class)'}`
      + ` → author display:${displayOf(window, el)}`);
  return { selectors, hidden, offenders };
}

test('nothing in index.html lays out while carrying the hidden attribute', async () => {
  const { window, document, style } = await renderIndex();
  const { selectors, hidden, offenders } = sweep(window, document);
  assert.ok(selectors.length > 0, 'sanity: styles.css declares display somewhere');
  assert.ok(hidden.length > 0, 'sanity: index.html ships elements with a hidden attribute');

  assert.deepEqual(
    offenders, [],
    'these ship `hidden` but an author `display` outranks the UA [hidden] rule, so they lay out anyway. '
    + 'Add a `[hidden] { display: none }` reset beside the rule that sets each one\'s display, '
    + `or name it in RENDERS_WHILE_HIDDEN with a reason:\n  ${offenders.join('\n  ')}`,
  );

  // POSITIVE CONTROL. An empty offender list is the passing answer, so this
  // assertion is worthless unless a real collision would have shown up in it —
  // and the two sanity checks above only pin that the collector and the document
  // are non-empty. Break the MATCHER while collection stays healthy (a happy-dom
  // upgrade changing `matches` semantics, or a selector form that makes the
  // `catch` above swallow every attempt) and the sweep goes quietly blind.
  //
  // So: introduce a collision in the in-memory sheet and demand the same
  // pipeline reports it. `dialog .hint` is chosen because #gd-empty-hint is
  // reachable ONLY by descendant match — no id or class selector would find it —
  // so nothing but real selector matching can produce this hit.
  style.textContent += '\ndialog .hint { display: block; }';
  const control = sweep(window, document);
  assert.ok(
    control.offenders.some(o => o.includes('#gd-empty-hint')),
    'positive control failed: a deliberate `dialog .hint { display: block }` collision against '
    + '<p class="hint" id="gd-empty-hint" hidden> went unreported, so the sweep above cannot be '
    + `trusted to report a real one. Selector matching is broken, not the sheet.\n  saw: ${JSON.stringify(control.offenders)}`,
  );
});
