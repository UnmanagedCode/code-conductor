// The one-row phone header's CSS contract, read from public/styles.css (happy-dom
// computes no layout; the real layout is in the gated
// tests/header-compact-browser.test.mjs). The declarations of one rule, by exact
// selector, as tests/sticky-prompt.test.mjs's pinRule does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { MOBILE_LAYOUT_QUERY } from '../public/layout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const css = await fs.readFile(path.resolve(__dirname, '..', 'public', 'styles.css'), 'utf8');

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The body of the `@media <query> { … }` block (brace-matched), or null.
function mediaBlock(query) {
  const head = `@media ${query} {`;
  const at = css.indexOf(head);
  if (at < 0) return null;
  let depth = 1;
  let i = at + head.length;
  for (; i < css.length && depth > 0; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
  }
  return css.slice(at + head.length, i - 1);
}

// The declarations of the rule with this exact selector inside `scope`.
function rule(scope, selector) {
  const m = scope.match(new RegExp(`(?:^|\\n)\\s*${esc(selector)}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `${selector} rule not found`);
  return m[1];
}

// Everything outside the phone block, where the desktop rules live.
const desktop = () => css.replace(mediaBlock(MOBILE_LAYOUT_QUERY), '');

// Invariant: the JS breakpoint and the CSS breakpoint are one value — the
// narrow header rules sit in the @media block whose query is MOBILE_LAYOUT_QUERY.
test('the narrow header rules sit in the @media block whose query is MOBILE_LAYOUT_QUERY', () => {
  const block = mediaBlock(MOBILE_LAYOUT_QUERY);
  assert.ok(block, `styles.css has an @media ${MOBILE_LAYOUT_QUERY} block`);
  rule(block, '#instance-header');
  rule(block, '#instance-title');
  rule(block, '.ih-line');
  assert.equal(css.split(`@media ${MOBILE_LAYOUT_QUERY} {`).length - 1, 1, 'exactly one such block');
});

// Invariant: one row can only hold if nothing wraps and the title truncates.
test('narrow header: no wrap on the bar or controls; ellipsis on the title lead and subline', () => {
  const block = mediaBlock(MOBILE_LAYOUT_QUERY);
  assert.match(rule(block, '#instance-header'), /flex-wrap:\s*nowrap/);
  assert.match(rule(block, '#instance-controls'), /flex-wrap:\s*nowrap/);
  assert.match(rule(block, '#instance-title'), /flex-wrap:\s*nowrap/);
  const lead = rule(block, '.ih-line-main > .ih-title, .ih-line-main > .ih-project');
  assert.match(lead, /text-overflow:\s*ellipsis/);
  assert.match(lead, /min-width:\s*0/, 'the lead can shrink below its text');
  const sub = rule(block, '.ih-line-sub');
  assert.match(sub, /white-space:\s*nowrap/);
  assert.match(sub, /text-overflow:\s*ellipsis/);
});

// Invariant: the header's clip never makes a scroll container (which can end the
// touch-action intersection the swipe zone relies on), and no narrow rule
// re-declares touch-action.
test('header clipping uses overflow: clip, never hidden/auto/scroll, and nothing re-declares touch-action inside the header', () => {
  const block = mediaBlock(MOBILE_LAYOUT_QUERY);
  const headerRules = [...block.matchAll(/(?:^|\n)\s*([^{}\n]*\.ih-[^{}\n]*|#instance-[^{}\n]*)\{([^}]*)\}/g)];
  assert.ok(headerRules.length >= 6, 'found the narrow header rules');
  for (const [, selector, body] of headerRules) {
    for (const m of body.matchAll(/(?:^|[\s;])overflow(?:-[xy])?:\s*([\w-]+)/g)) {
      assert.equal(m[1], 'clip', `${selector.trim()} must clip, not ${m[1]}`);
    }
    assert.doesNotMatch(body, /touch-action/, `${selector.trim()} must not re-declare touch-action`);
  }
  assert.match(rule(css, '#instance-header'), /touch-action:\s*pan-x pinch-zoom/, 'the base swipe-zone declaration stays');
});

// Invariant: the desktop rendering contract — the two lines are transparent to
// the flex row, status chips order last, the "· " separator hangs off the
// secondary project chip, and the TEMP / DEBUG pills have no styling left.
test('desktop: .ih-line is display: contents, status chips are order 1, the separator is on .ih-secondary; no .ih-temp/.ih-debug rules', () => {
  const d = desktop();
  assert.match(rule(d, '.ih-line'), /display:\s*contents/);
  assert.match(rule(d, '#instance-title .ih-status'), /order:\s*1/);
  assert.match(rule(d, '.ih-chip.ih-project.ih-secondary::before'), /content:\s*'· '/);
  assert.doesNotMatch(css, /\.ih-temp|\.ih-debug/);
  assert.doesNotMatch(css, /\.ih-title \+ /, 'no adjacent-sibling separator selector across the line wrappers');
});
