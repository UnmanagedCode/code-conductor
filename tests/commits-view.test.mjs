// Render test for the #commits list (public/commits.js).
//
// Drives the exported renderCommitList(listEl, data, opts) directly against a
// mounted list element — no network stub. Covers the ahead/already-merged
// divider: where it sits, what it says, and that it is driven by aheadCount.
//
// Same happy-dom harness style as tests/costs-view.test.mjs.
//
// NOTE: tests/dom-assert-scan.mjs bans equal-family assertions against
// DOM-valued expressions (they stall node's serializer). Assert on .length /
// .className / .textContent, or use assertNull from tests/dom-assert.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

async function setup() {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  const listEl = window.document.createElement('div');
  listEl.id = 'commits-list';
  window.document.body.appendChild(listEl);
  return listEl;
}

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);

// a → b → c, c a root. Two ahead of main, one already merged.
function payload(over = {}) {
  return {
    project: 'demo', branch: 'feature', truncated: false, limit: 100,
    hasUncommitted: false, aheadCount: 2, aheadOf: 'main',
    commits: [
      { sha: A, shortSha: 'aaaaaaa', subject: 'third', author: 'x', relativeDate: '1 hour ago', isoDate: '2026-01-03T00:00:00Z', parents: [B] },
      { sha: B, shortSha: 'bbbbbbb', subject: 'second', author: 'x', relativeDate: '2 hours ago', isoDate: '2026-01-02T00:00:00Z', parents: [C] },
      { sha: C, shortSha: 'ccccccc', subject: 'first', author: 'x', relativeDate: '3 hours ago', isoDate: '2026-01-01T00:00:00Z', parents: [] },
    ],
    ...over,
  };
}

test('ahead divider is inserted above the first already-merged row', async () => {
  const listEl = await setup();
  const { renderCommitList } = await import('../public/commits.js');

  renderCommitList(listEl, payload(), { project: 'demo', onOpenCommit: () => {} });

  const kids = [...listEl.children];
  assert.equal(listEl.querySelectorAll('.ahead-divider').length, 1);
  assert.equal(kids[0].className, 'commit-row ahead');
  assert.equal(kids[1].className, 'commit-row ahead');
  assert.equal(kids[2].className, 'ahead-divider');
  assert.equal(kids[2].textContent, '↓ already in main',
    'the label must name the direction it binds in, not just the base');
  assert.equal(kids[3].className, 'commit-row', 'first already-merged row');
  assert.equal(kids[3].querySelector('.commit-sha').textContent, 'ccccccc');
  // One lane over this linear history, so the label clears a 14px rail plus the
  // row's padding-left + flex gap — landing on the rows' text column.
  assert.equal(kids[2].style.paddingLeft, '34px', 'label is inset onto the text column');
});

test('no divider and no ahead classing when nothing is ahead', async () => {
  const listEl = await setup();
  const { renderCommitList } = await import('../public/commits.js');

  renderCommitList(listEl, payload({ aheadCount: 0, aheadOf: null }),
    { project: 'demo', onOpenCommit: () => {} });

  assert.equal(listEl.querySelectorAll('.ahead-divider').length, 0);
  assert.equal(listEl.querySelectorAll('.commit-row.ahead').length, 0);
  assert.equal(listEl.querySelectorAll('.commit-row').length, 3);
});

test('.ahead-divider binds to the section below it', async () => {
  // AC-5's CSS half, which no DOM assertion can reach — the divider labels the
  // section that FOLLOWS it, so it needs a top border and no bottom one.
  // Precedent for asserting on styles.css text: tests/rendering.test.mjs.
  const css = await fs.readFile(path.join(PUB, 'styles.css'), 'utf8');
  const rule = css.match(/\.ahead-divider\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  assert.ok(rule.length > 0, 'sanity: styles.css defines .ahead-divider');
  assert.match(rule, /border-top:/);
  assert.doesNotMatch(rule, /border-bottom/);
  assert.doesNotMatch(rule, /text-align:\s*center/);
});
