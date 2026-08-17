// Guard tests for card 2026-0154. Two guards with deliberately non-overlapping
// ownership (each module's header states which invariant it owns and why the
// other cannot be deleted as redundant):
//
//   tests/dom-assert-scan.mjs      OWNS  "no equal-family assertion in tests/ is
//                                        written against a DOM-valued expression"
//   tests/dom-assert-tripwire.mjs  GUARDS "a DOM node compared against
//                                        null/undefined by a positive
//                                        equal-family assertion never reaches
//                                        assert's serializer" (one shape only;
//                                        its header names what it does not
//                                        cover — card 2026-0163)
//
// Every test below names the invariant it pins in its title.
//
// All fixtures are plain string literals, never template literals: a `${` in a
// template would leave a live expression that `stripNonCode` preserves. String
// bodies are blanked by the scanner, which is also why this file's own fixtures
// do not trip T1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { isDomNode } from './domNode.mjs';
import { assertNull } from './dom-assert.mjs';
import { scanSource, scanFile, scanTestsDir } from './dom-assert-scan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRIPWIRE = pathToFileURL(path.join(__dirname, 'dom-assert-tripwire.mjs')).href;

// ---------------------------------------------------------------------------
// T1 — pins: the post-2026-0150 tree is clean.
// ---------------------------------------------------------------------------
test('T1 pins: no equal-family assertion in tests/ compares a DOM-valued expression against null', () => {
  // The diff IS the file:line list of violations — a failure names every site.
  assert.deepStrictEqual(scanTestsDir(__dirname).map(v => v.file + ':' + v.line), []);
});

// ---------------------------------------------------------------------------
// T2 — pins: the scan catches every recognised DOM shape, proven by inducing
// violations rather than by trusting a clean tree.
// ---------------------------------------------------------------------------
const CATCH_CASES = [
  { name: 'single-line querySelector', line: 1, src: "assert.equal(root.querySelector('.x'), null);" },
  {
    name: 'multi-line-formatted call (a line regex misses this)',
    line: 1,
    src: ['assert.equal(', "  root.querySelector('.x'),", '  null,', ');'].join('\n'),
  },
  { name: 'reversed operand order', line: 1, src: "assert.equal(null, x.querySelector('a'));" },
  { name: 'bare strictEqual with no assert. prefix', line: 1, src: 'strictEqual(el.parentElement, null);' },
  { name: 'document-scoped .body', line: 1, src: 'deepEqual(document.body, null);' },
  {
    name: 'identifier resolved through an in-file declaration',
    line: 2,
    src: ["const btn = wrap.querySelector('b');", 'assert.strictEqual(btn, null);'].join('\n'),
  },
  {
    name: 'pick off a spread NodeList',
    line: 1,
    src: "assert.equal([...root.querySelectorAll('.x')].find(function (n) { return n.id; }), null);",
  },
  // window.document.* is the dominant style in this tree; bare `document.x` was
  // already caught, this shape was not (review FIX 1).
  { name: 'window.document-scoped .activeElement', line: 1, src: 'assert.equal(window.document.activeElement, null);' },
  // Destructuring binds a name with no `=` initializer to inspect, so these
  // need their own arm in collectDomNames (review FIX 2).
  {
    name: 'renamed destructured NODE_PROPS binding',
    line: 2,
    src: ['const { firstElementChild: el } = root;', 'assert.equal(el, null);'].join('\n'),
  },
  {
    name: 'shorthand destructured NODE_PROPS binding',
    line: 2,
    src: ['const { firstElementChild } = root;', 'assert.equal(firstElementChild, null);'].join('\n'),
  },
  // The object-literal arm of collectDomNames. Without this case its only
  // coverage is T5's aggregate count, so "correcting" T5's 46 to 45 would
  // silently delete the arm's coverage — this card's own failure mode, one
  // layer down.
  {
    name: 'identifier bound through an object-literal property',
    line: 2,
    src: ["const parts = { btn: block.body.querySelector('.tts-speak') };", 'assert.equal(btn, null);'].join('\n'),
  },
  // Line numbers survive a preceding multi-line block comment. This pins
  // NEWLINE PRESERVATION in stripNonCode, which is what actually keeps line
  // numbers valid — the other cases all sit near the top of their fixture and
  // would pass even if blanking collapsed lines.
  {
    name: 'violation following a multi-line block comment',
    line: 6,
    src: [
      '/*',
      ' * assert.equal(root.querySelector(x), null) is the shape we forbid.',
      ' * This prose spans several lines on purpose.',
      ' */',
      'const wrap = mk();',
      "assert.equal(wrap.querySelector('.x'), null);",
    ].join('\n'),
  },
];

for (const c of CATCH_CASES) {
  test('T2 pins: the scan flags a DOM-vs-null assertion — ' + c.name, () => {
    const found = scanSource(c.src, 'fixture.mjs');
    assert.equal(found.length, 1, 'expected exactly one violation, got ' + JSON.stringify(found));
    assert.equal(found[0].line, c.line);
  });
}

// ---------------------------------------------------------------------------
// T3 — pins: comments and strings are immune (a line regex over-matches prose).
// ---------------------------------------------------------------------------
const IMMUNE_CASES = [
  { name: 'line comment', src: "// assert.equal(root.querySelector('.x'), null);" },
  { name: 'block comment', src: ['/*', " assert.equal(root.querySelector('.x'), null);", '*/'].join('\n') },
  { name: 'string literal', src: "const s = 'assert.equal(root.querySelector(x), null)';" },
];

for (const c of IMMUNE_CASES) {
  test('T3 pins: non-code is blanked before matching — ' + c.name, () => {
    assert.deepStrictEqual(scanSource(c.src, 'fixture.mjs'), []);
  });
}

test('T3 pins: the real prose comment naming assert.equal(node, null) is not flagged', () => {
  // tests/header-playbook-enforcement.test.mjs explains the rule in English
  // across several comment lines. A line regex would flag it.
  assert.deepStrictEqual(scanFile(path.join(__dirname, 'header-playbook-enforcement.test.mjs')), []);
});

// ---------------------------------------------------------------------------
// T4 — pins: the negative family is never flagged. notEqual(node, null) can
// only FAIL when the operand is already nullish, so no node ever reaches the
// serializer; flagging it would be a false positive by construction.
// ---------------------------------------------------------------------------
for (const fn of ['notEqual', 'notStrictEqual', 'notDeepEqual', 'notDeepStrictEqual']) {
  test('T4 pins: ' + fn + '-vs-null is never flagged', () => {
    assert.deepStrictEqual(scanSource('assert.' + fn + "(root.querySelector('.x'), null);", 'fixture.mjs'), []);
  });
}

// ---------------------------------------------------------------------------
// T5 — pins: recall against the historical (pre-2026-0150) set does not
// regress. These are the real expressions the sweep converted, recovered from
// tests/ at 6de56a3^1. The four occurrences the scan cannot reach —
// conv.emptyNode, main.leadingAssistantWrap (x2), batch.leadingWrap — are
// DELIBERATELY absent rather than asserted as unflagged: pinning them would
// lock in the blind spot and fail a future improvement. They are covered by the
// tripwire (T7); see the false-negative note in tests/dom-assert-scan.mjs.
// ---------------------------------------------------------------------------
const HISTORICAL = [
  "return { block, btn: block.body.querySelector('.tts-speak') };",
  "const promoteBtn = root.querySelector('.session-promote');",
  "const tempSep = [...root.querySelectorAll('.sessions-separator')].find(n => n.textContent === '— temp —');",
  "assert.equal(block.node.querySelector('a'), null);",
  "assert.equal(block.node.querySelector('pre'), null);",
  "assert.equal(block.node.querySelector('img'), null);",
  "assert.equal(btn, null, 'button should not exist when TTS is unavailable');",
  "assert.equal(batch.holder.querySelector('.empty'), null, 'no placeholder transplanted');",
  "assert.equal(bubble.querySelector('.user-msg-actions'), null, 'no unanchored rewind buttons');",
  "assert.equal(document.querySelector('.lightbox-backdrop'), null);",
  "assert.equal(pre.querySelector('.md-code-copy'), null);",
  "assert.equal(root.querySelector('a'), null, 'no anchor for javascript: url');",
  "assert.equal(root.querySelector('script'), null);",
  "assert.equal(root.querySelector('a'), null);",
  "assert.equal(root.querySelector('table'), null);",
  "assert.equal(root.querySelector('img'), null);",
  "assert.equal(root.querySelector('img'), null);",
  "assert.equal(root.querySelector('script'), null);",
  "assert.equal(dom.npContributions.querySelector('.np-group-master'), null, 'no master toggle checkbox');",
  "assert.equal(dom.npContributions.querySelector('.np-group-head'), null, 'no master toggle heading');",
  "assert.equal(dom.npContributions.querySelector('input[data-kind=\"scaffold\"]'), null, 'no separate scaffold checkboxes');",
  "assert.equal(dom.npContributions.querySelector('.np-rule-tag'), null, 'no \"sets up\" tag rendered');",
  "assert.equal(tool.querySelector('.block.tool-input'), null, 'specialty diff renderer must NOT be wrapped in tool_input');",
  "assert.equal(card.querySelector('.pr-approve'), null, 'no Approve button');",
  "assert.equal(card.querySelector('.pr-reject'), null, 'no Reject button');",
  "assert.equal(card.querySelector('.pr-feedback'), null, 'no feedback textarea');",
  "assert.equal(node.querySelector('summary'), null, 'redacted thinking must have no <summary>');",
  "assert.equal(node.querySelector('summary'), null, 'must have no <summary>');",
  "assert.equal(textBlock.querySelector('a'), null, 'no anchor before text_end');",
  "assert.equal(textBlock.querySelector('strong'), null, 'no <strong> before text_end');",
  "assert.equal(userMsg.querySelector('.transcribed-badge'), null, 'no badge on plain message');",
  "assert.equal(details.querySelector('.review-file-error'), null, 'error cleared after successful retry');",
  "assert.equal(ollamaRow.querySelector('.sb-row-env'), null);",
  "assert.equal(userRow.querySelector('.sb-managed-badge'), null);",
  "assert.equal(li.querySelector('.sm-field--backend').closest('.sm-field-pair'), null, `${tier}: backend is not in the pair`);",
  "assert.equal(tierBound.querySelector('.sm-field-pair'), null, 'a tier-bound role has no model field, so effort takes the line alone — an empty half would be a dead column');",
  "assert.equal(enable.querySelector('.sm-field-cap'), null, 'the enable checkbox is named by the tier label beside it — no caption node');",
  "assert.equal(conductLi.querySelector('.delete-project'), null, 'no delete button');",
  "assert.equal(conductLi.querySelector('.quick-spawn'), null, 'no quick-spawn button');",
  "assert.equal(conductLi.querySelector('.add-instance'), null, 'no add-instance button');",
  "assert.equal(root.querySelector('details.temp-sessions-group'), null, 'separate Temp Sessions subnode has been removed');",
  "assert.equal(root.querySelector('.sessions-separator'), null, 'no separator when there are no temp instances');",
  "assert.equal(promoteBtn, null, 'no promote button on non-temp rows');",
  "assert.equal(tempSep, undefined, 'no — temp — separator: the live temp:false overrides the stale on-disk temp:true');",
  "assert.equal(root.querySelector('details.block.skill'), null, 'no skill bubble rendered');",
  "assert.equal(root.querySelector('details.block.skill'), null, 'a normal prompt is not tagged as a skill load');",
  "assert.equal(wrap.querySelector('details.block.wake'), null, 'no <details> for a body-less stub');",
  "assert.equal(root.querySelector('.msg.user.wake-callback'), null, 'a normal prompt is not tagged as a wake callback');",
  "assert.equal(root.querySelector('details.block.wake'), null, 'no wake details block');",
].join('\n');

test('T5 pins: every recoverable pre-sweep DOM-vs-null expression is still caught', () => {
  assert.equal(scanSource(HISTORICAL, 'historical.mjs').length, 46);
});

// ---------------------------------------------------------------------------
// T6 — pins: the tripwire is behaviour-identical for every non-DOM assertion.
// Demonstrated, not reasoned: two child processes, one with the preload and one
// without, over a case table. Child processes rather than in-process because
// the tripwire is globally installed in this suite's own children, so pristine
// originals are otherwise unobtainable — and this exercises the real preload
// path.
// ---------------------------------------------------------------------------
const PARITY_CASES = [
  'assert.equal(1, 2)',
  'assert.equal(1, 1)',
  "assert.equal('a', 'b', 'custom msg')",
  "assert.equal(0, '0')",
  'assert.equal(null, undefined)',
  'assert.strictEqual(NaN, NaN)',
  "assert.deepEqual({ a: 1 }, { a: '1' })",
  "assert.deepStrictEqual({ a: 1 }, { a: '1' })",
  // node-ISH but not a node (no nodeName): must stay a plain ERR_ASSERTION.
  'assert.deepStrictEqual({ nodeType: 1 }, null)',
  'assert.deepStrictEqual([1, 2], [1, 2, 3])',
  // Requires orig.apply(this, arguments): named parameters would pass an
  // explicit `undefined` and lose ERR_MISSING_ARGS.
  'assert.equal(1)',
  "assert.deepStrictEqual(Symbol('s'), null)",
];

const PARITY_PROBE = [
  "const assert = require('node:assert');",
  'const cases = [' + PARITY_CASES.map(c => '() => ' + c).join(', ') + '];',
  'const out = cases.map(function (f, i) {',
  '  try { f(); return { i: i, ok: true }; }',
  '  catch (e) {',
  '    return { i: i, ok: false, name: e.name, code: e.code, message: e.message,',
  '      actual: String(e.actual), expected: String(e.expected),',
  '      operator: String(e.operator), generatedMessage: e.generatedMessage };',
  '  }',
  '});',
  'console.log(JSON.stringify(out));',
].join('\n');

function runProbe(probe, extraArgs) {
  const r = spawnSync(process.execPath, extraArgs.concat(['-e', probe]), { encoding: 'utf8' });
  assert.equal(r.status, 0, 'probe exited ' + r.status + ': ' + r.stderr);
  return JSON.parse(r.stdout);
}

test('T6 pins: the tripwire changes nothing for assertions that involve no DOM node', () => {
  const withPreload = runProbe(PARITY_PROBE, ['--import', TRIPWIRE]);
  const withoutPreload = runProbe(PARITY_PROBE, []);
  assert.equal(withoutPreload.length, PARITY_CASES.length);
  assert.deepStrictEqual(withPreload, withoutPreload);
});

// ---------------------------------------------------------------------------
// T7 — pins: the tripwire is actually installed and fires, which is what covers
// the shapes the scan is structurally blind to.
// ---------------------------------------------------------------------------
test('T7 pins: the tripwire is installed in this child and converts a node-vs-null compare into a named error', () => {
  // Assert installation FIRST so this test cannot pass vacuously if the
  // execArgv preload in tests/run.mjs is ever removed.
  assert.equal(assert.equal.__domTripwire, true,
    'tripwire not installed — the public/-valued gap in the scan is unguarded');
  // A node-ISH plain object, never a live node: if the tripwire were ever
  // absent this fails instantly instead of stalling the suite for 33-120s.
  assert.throws(
    () => assert.equal({ nodeType: 1, nodeName: 'DIV', tagName: 'DIV' }, null),
    /expected null, found <div>/,
  );
});

// ---------------------------------------------------------------------------
// T8 — pins: tests/dom-assert.mjs formats through the SHARED predicate.
// Mutating isDomNode to always-false makes describeFound fall to its
// [object Object] branch and this fires, independently of T7 and T9.
// ---------------------------------------------------------------------------
test('T8 pins: assertNull summarizes a node via the shared predicate', () => {
  const nodeIsh = { nodeType: 1, nodeName: 'DIV', tagName: 'DIV', id: 'id', className: 'cls' };
  assert.throws(
    () => assertNull(nodeIsh, 'label'),
    (err) => {
      assert.match(err.message, /<div#id\.cls>/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// T9 — pins: the shared predicate accepts a real happy-dom node and rejects
// merely node-ish objects. A pure predicate call: nothing is handed to assert,
// so there is no stall risk. T7 and T9 together cover the real-node case
// compositionally, without ever executing a real-node-vs-null assertion.
// ---------------------------------------------------------------------------
test('T9 pins: isDomNode accepts a real happy-dom node and nothing else', () => {
  const window = new Window({ url: 'http://localhost/' });
  assert.equal(isDomNode(window.document.createElement('div')), true);
  assert.equal(isDomNode(window.document.createTextNode('t')), true);
  assert.equal(isDomNode({}), false);
  assert.equal(isDomNode(null), false);
  assert.equal(isDomNode(undefined), false);
  assert.equal(isDomNode({ nodeType: 1 }), false);
  assert.equal(isDomNode('div'), false);
});

// ---------------------------------------------------------------------------
// T10 — pins: the preload reaches EVERY import style. An implementer who
// "simplifies" createRequire to a static ESM import fails here rather than
// silently losing named-import coverage.
// ---------------------------------------------------------------------------
const STYLES_PROBE = [
  '(async function () {',
  "  const a = await import('node:assert');",
  "  const s = await import('node:assert/strict');",
  '  console.log(JSON.stringify({',
  '    assertNamedEqual: a.equal.__domTripwire === true,',
  '    assertNamedStrictEqual: a.strictEqual.__domTripwire === true,',
  '    assertDefault: a.default.equal.__domTripwire === true,',
  '    strictNamedEqual: s.equal.__domTripwire === true,',
  '    strictDefault: s.default.equal.__domTripwire === true,',
  '  }));',
  '})();',
].join('\n');

test('T10 pins: the preload patches node:assert named + default and node:assert/strict named + default', () => {
  assert.deepStrictEqual(runProbe(STYLES_PROBE, ['--import', TRIPWIRE]), {
    assertNamedEqual: true,
    assertNamedStrictEqual: true,
    assertDefault: true,
    strictNamedEqual: true,
    strictDefault: true,
  });
  // Negative control: without the preload nothing is patched, so the assertions
  // above are reading a real effect and not a constant.
  assert.deepStrictEqual(runProbe(STYLES_PROBE, []), {
    assertNamedEqual: false,
    assertNamedStrictEqual: false,
    assertDefault: false,
    strictNamedEqual: false,
    strictDefault: false,
  });
});

// ---------------------------------------------------------------------------
// T11 — pins: a throwing preload fails LOUDLY. The tripwire's fail-loud
// property depends on this Node semantic; a silently-dead tripwire is the false
// safety this card exists to prevent.
// ---------------------------------------------------------------------------
test('T11 pins: a preload that throws kills the child before the body runs', () => {
  const r = spawnSync(
    process.execPath,
    ['--import', 'data:text/javascript,throw new Error("boom")', '-e', 'console.log("ran")'],
    { encoding: 'utf8' },
  );
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout.includes('ran'), false, 'the body must never run');
});
