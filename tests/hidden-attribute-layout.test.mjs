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

// Elements index.html ships `hidden` that ALSO carry an author `display`, and
// that some flow has to reveal. Both halves matter: the paired `[hidden]` reset
// must exist, and it must be scoped to `[hidden]` rather than blanketing the
// element out of existence for the flow that shows it.
//
// AN ELEMENT WITH NO AUTHOR `display` DOES NOT BELONG HERE. happy-dom ships no
// UA stylesheet, so `display` for such an element is its tag default and never
// `none` — the first assertion below would fail against perfectly correct
// markup, and passing it would prove nothing anyway. Those are covered by the
// sweep at the bottom, which asks the only question that is answerable here:
// does any author `display` match them at all?
const REVEALED_BY_A_FLOW = [
  ['np-system-path-row', 'choosing a remote system must reveal the path field'],
  ['np-remote-row', 'choosing a remote system must reveal the target field'],
  ['apd-suggestions', 'the local placement must reveal the scanned directory list'],
  ['apd-remote-row', 'choosing a system must reveal the target field'],
];

for (const [id, why] of REVEALED_BY_A_FLOW) {
  test(`#${id} is laid out per its hidden attribute, both ways`, async () => {
    const { window, document } = await renderIndex();
    const row = document.getElementById(id);
    assert.ok(row, `index.html must still carry #${id}`);
    assert.equal(row.hasAttribute('hidden'), true, 'it ships hidden');

    assert.equal(
      displayOf(window, row), 'none',
      'it must not render while hidden; an author `display` outranks the UA [hidden] rule',
    );

    // The other direction: a reset must be scoped to [hidden], not blanket the
    // element out of existence for the flow that exists to show it.
    row.hidden = false;
    assert.notEqual(displayOf(window, row), 'none', why);
  });
}

// The mirror image of REVEALED_BY_A_FLOW: elements that ship VISIBLE in markup
// and get `.hidden` set true by a flow. An author `display` on these must still
// yield to `[hidden]` once the flow hides them, or the row renders when it
// shouldn't. #dpd-dir-row starts unhidden — a remote project has no directory
// to delete, so deleteProjectDialog.js's `open()` sets
// `dom.dirRow.hidden = !!remoteSystem` to hide the opt-in row; an `!important`
// on `.dpd-dir-row`'s `display` would beat `dialog label[hidden]` and leave the
// row (and its "Also delete the directory …" checkbox) showing for a remote
// project — the tick that project has no server-side effect for.
const HIDDEN_BY_A_FLOW = [
  ['dpd-dir-row', 'a remote project must hide the directory opt-in row'],
];

for (const [id, why] of HIDDEN_BY_A_FLOW) {
  test(`#${id} starts visible and is laid out per its hidden attribute once a flow sets it`, async () => {
    const { window, document } = await renderIndex();
    const row = document.getElementById(id);
    assert.ok(row, `index.html must still carry #${id}`);
    assert.equal(row.hasAttribute('hidden'), false, 'it ships visible, hidden only by a later flow');
    assert.notEqual(displayOf(window, row), 'none', 'it renders before any flow hides it');

    row.hidden = true;
    assert.equal(
      displayOf(window, row), 'none',
      `${why}; an author \`display\` must not outrank the UA [hidden] rule`,
    );
  });
}

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
  // COLLECTION, checked by name. `length > 0` says the collector works at all;
  // it does not say a given element is IN scope, and an element the sweep never
  // saw is indistinguishable from one it cleared. These two rely on the UA rule
  // alone (no author `display` matches them, which is the point), so nothing
  // else in this file would notice them dropping out of the query.
  //
  // DELIBERATELY NOT ALL ~57. A `querySelectorAll('[hidden]')` that returned
  // some elements and not others is a happy-dom defect, and pinning it
  // element-by-element buys brittleness rather than coverage: the list would
  // have to be edited by every future markup change and would still only restate
  // the query. The MATCHER — the half a break can shape around — is controlled
  // per selector shape below instead.
  const sweptIds = new Set(hidden.map(el => el.id));
  for (const id of ['pr-blockers', 'composer-attachments']) {
    assert.ok(sweptIds.has(id), `#${id} must be within the sweep's reach`);
  }

  assert.deepEqual(
    offenders, [],
    'these ship `hidden` but an author `display` outranks the UA [hidden] rule, so they lay out anyway. '
    + 'Add a `[hidden] { display: none }` reset beside the rule that sets each one\'s display, '
    + `or name it in RENDERS_WHILE_HIDDEN with a reason:\n  ${offenders.join('\n  ')}`,
  );

});

// POSITIVE CONTROLS. An empty offender list is the PASSING answer above, so that
// assertion is worthless unless a real collision would have shown up in it — and
// its sanity checks only pin that the collector and the document are non-empty.
// Break the MATCHER while collection stays healthy (a happy-dom upgrade changing
// `matches` semantics, or a selector form that makes the sweep's `catch` swallow
// every attempt) and it goes quietly blind.
//
// So: inject a collision into the in-memory sheet and demand the SAME pipeline
// reports it. One control per SELECTOR SHAPE the sweep relies on, because a
// break can be shaped to spare one shape and not another — a matcher that only
// handled `.hint` would leave a single descendant-and-class control green while
// every id- and attribute-selector collision in styles.css sailed past.
//
// Each runs against its own fresh render, so exactly one injected selector is in
// play and nothing else can produce the hit. #gd-empty-hint is the target
// throughout: it carries `hidden`, has no author `display` of its own, and is
// reachable by all three shapes.
const MATCHER_CONTROLS = [
  ['a descendant + class selector', 'dialog .hint { display: block; }'],
  ['an id selector', '#gd-empty-hint { display: block; }'],
  ['an attribute selector', '[id="gd-empty-hint"] { display: block; }'],
];

for (const [shape, css] of MATCHER_CONTROLS) {
  test(`the sweep reports a collision declared through ${shape}`, async () => {
    const { window, document, style } = await renderIndex();
    assert.deepEqual(sweep(window, document).offenders, [],
      'the control must start from a clean sweep, or it proves nothing');

    style.textContent += `\n${css}`;
    const control = sweep(window, document);
    assert.ok(
      control.offenders.some(o => o.includes('#gd-empty-hint')),
      `positive control failed: a deliberate \`${css.trim()}\` collision against `
      + '<p class="hint" id="gd-empty-hint" hidden> went unreported, so the sweep cannot be trusted '
      + `to report a real one of this shape. Selector matching is broken, not the sheet.\n  saw: ${JSON.stringify(control.offenders)}`,
    );
  });
}
