// Render test for the #commits view (public/commits.js).
//
// Drives the exported renderCommitList(listEl, data, opts) directly against a
// mounted list element — no network stub. Covers the ahead/already-merged
// partition, which is driven by each commit's own `ahead` flag (the set is not
// a prefix of the window — see getProjectCommits), and the divider that names
// the band below it. The tests at the foot drive the INSTALLED view instead —
// installCommits + open(project, worktree?) against a fetch stub — so the
// whole chain from open() to the request URL is pinned, not just the renderer.
//
// COVERAGE LIMIT: `public/app.js` is outside this harness's reach — no test
// imports it, so the wiring there from `sidebar.onShowCommits` into
// `commits.open(project, worktree)` is unpinned. Both halves it joins ARE
// pinned: the sidebar button's arguments in tests/sidebar.test.mjs, and open()'s
// handling of them here. Closing it needs an app.js harness, which no suite has.
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

const sha = (c) => c.repeat(40);

function commit(name, parents, ahead) {
  return {
    sha: sha(name[0]), shortSha: name[0].repeat(7), subject: name,
    author: 'x', relativeDate: '1 hour ago', isoDate: '2026-01-01T00:00:00Z',
    parents: parents.map(p => sha(p[0])), ahead,
  };
}

// Two ahead, THREE already merged: with only one merged row the divider's
// index would be indistinguishable from "the last row".
function prefixPayload(over = {}) {
  return {
    project: 'demo', branch: 'feature', truncated: false, limit: 100,
    hasUncommitted: false, aheadCount: 2, aheadOf: 'main',
    commits: [
      commit('a', ['b'], true), commit('b', ['c'], true),
      commit('c', ['d'], false), commit('d', ['e'], false), commit('e', [], false),
    ],
    ...over,
  };
}

// The real non-prefix topology from tests/project-commits.test.mjs: a branch
// that merged its moved-on base back in. Already-merged `m2` sits ABOVE two
// ahead commits.
function nonPrefixPayload() {
  return {
    project: 'demo', branch: 'code-conductor/np', truncated: false, limit: 100,
    hasUncommitted: false, aheadCount: 3, aheadOf: 'main',
    commits: [
      { ...commit('M', ['w2'], true), parents: [sha('w2'[0]), sha('m2'[0])] },
      commit('m2', ['m1'], false),
      commit('w2', ['w1'], true),
      commit('w1', ['m1'], true),
      commit('m1', [], false),
    ],
  };
}

// The whole view, not just the list renderer: the DOM installHashView and
// loadCommits touch, plus a fetch stub that records what was actually asked for.
async function setupView() {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.history = window.history;
  window.document.body.innerHTML = `
    <div id="main"></div>
    <section id="commits-view" hidden>
      <button id="commits-back"></button>
      <div id="commits-title"></div>
      <div id="commits-stats"></div>
      <div id="commits-actions" hidden>
        <button id="commits-sync-btn"></button>
        <button id="commits-merge-btn"></button>
      </div>
      <div id="commits-list"></div>
    </section>
    <section id="review-view" hidden></section>`;

  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return { ok: true, json: async () => ({
      project: 'demo', branch: 'code-conductor/feature', truncated: false, limit: 100,
      hasUncommitted: false, aheadCount: 0, aheadOf: null, commits: [],
    }) };
  };
  return { window, requested };
}

// The same view over the REAL public/index.html, so the new control ids are
// pinned to real markup rather than to a fixture that could drift from it.
async function setupRealView() {
  const html = await fs.readFile(path.join(PUB, 'index.html'), 'utf8');
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.history = window.history;
  window.document.documentElement.innerHTML = html;

  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return { ok: true, json: async () => ({
      project: 'demo', branch: 'code-conductor/feature', truncated: false, limit: 100,
      hasUncommitted: false, aheadCount: 0, aheadOf: null, commits: [],
    }) };
  };
  // Targets each injected action was called with, the result it answers, and
  // `impl` for a test that needs to control the action itself (it is installed once).
  const calls = { sync: [], merge: [] };
  const results = { sync: { ok: true }, merge: { ok: true } };
  const impl = {};
  for (const kind of ['sync', 'merge']) {
    impl[kind] = async (t) => { calls[kind].push(t); return results[kind]; };
  }
  const { installCommits } = await import('../public/commits.js');
  const commits = installCommits({
    syncWorktree: (t) => impl.sync(t),
    mergeWorktree: (t) => impl.merge(t),
  });
  const el = (id) => document.getElementById(id);
  return { window, requested, calls, results, impl, commits, el };
}
const flush = () => new Promise(r => setTimeout(r, 0));

test('ahead divider is inserted above the first already-merged row', async () => {
  const listEl = await setup();
  const { renderCommitList } = await import('../public/commits.js');

  renderCommitList(listEl, prefixPayload(), { project: 'demo', onOpenCommit: () => {} });

  const kids = [...listEl.children];
  assert.equal(listEl.querySelectorAll('.ahead-divider').length, 1,
    'exactly one divider, however many already-merged rows follow');
  assert.equal(kids[0].className, 'commit-row ahead');
  assert.equal(kids[1].className, 'commit-row ahead');
  assert.equal(kids[2].className, 'ahead-divider');
  assert.equal(kids[2].textContent, '↓ already in main',
    'the label must name the direction it binds in, not just the base');
  assert.equal(kids[3].className, 'commit-row', 'first already-merged row');
  assert.equal(kids[3].querySelector('.commit-sha').textContent, 'ccccccc');
  assert.equal(kids[4].className, 'commit-row');
  assert.equal(kids[5].className, 'commit-row', 'and the rows after it get no second divider');
  assert.equal(kids.length, 6);
  // One lane over this linear history, so the label clears a 14px rail plus the
  // row's padding-left + flex gap — landing on the rows' text column.
  assert.equal(kids[2].style.paddingLeft, '34px', 'label is inset onto the text column');
});

test('ahead rows are classed by their own flag, not by their position', async () => {
  const listEl = await setup();
  const { renderCommitList } = await import('../public/commits.js');

  renderCommitList(listEl, nonPrefixPayload(), { project: 'demo', onOpenCommit: () => {} });

  const rows = [...listEl.querySelectorAll('.commit-row')];
  assert.deepEqual(rows.map(r => r.className), [
    'commit-row ahead',  // M
    'commit-row',        // m2 — already in main, ABOVE two ahead commits
    'commit-row ahead',  // w2
    'commit-row ahead',  // w1
    'commit-row',        // m1
  ]);
  // Any index-based partition would badge the first THREE rows here.
  assert.equal(listEl.querySelectorAll('.commit-row.ahead').length, 3);
});

test('no divider is drawn when the ahead rows are not a contiguous prefix', async () => {
  const listEl = await setup();
  const { renderCommitList } = await import('../public/commits.js');

  renderCommitList(listEl, nonPrefixPayload(), { project: 'demo', onOpenCommit: () => {} });

  // The label claims everything BELOW it is already in the base. Here that is
  // false of two rows, so the badges carry the answer alone.
  assert.equal(listEl.querySelectorAll('.ahead-divider').length, 0);
});

test('a single ahead commit still gets a divider', async () => {
  // Boundary on the "is there anything above the divider" test: one ahead row
  // is the commonest case of all.
  const listEl = await setup();
  const { renderCommitList } = await import('../public/commits.js');

  const data = prefixPayload({ aheadCount: 1 });
  data.commits = data.commits.map((c, i) => ({ ...c, ahead: i === 0 }));
  renderCommitList(listEl, data, { project: 'demo', onOpenCommit: () => {} });

  const kids = [...listEl.children];
  assert.equal(listEl.querySelectorAll('.ahead-divider').length, 1);
  assert.equal(kids[0].className, 'commit-row ahead');
  assert.equal(kids[1].className, 'ahead-divider');
});

test('no divider when a base is named but no row is ahead', async () => {
  // The other side of that boundary: a fully-merged branch names a base and
  // counts zero ahead. A divider above row 0 would label the whole list.
  const listEl = await setup();
  const { renderCommitList } = await import('../public/commits.js');

  const data = prefixPayload({ aheadCount: 0 });
  data.commits = data.commits.map(c => ({ ...c, ahead: false }));
  renderCommitList(listEl, data, { project: 'demo', onOpenCommit: () => {} });

  assert.equal(listEl.querySelectorAll('.ahead-divider').length, 0);
  assert.equal(listEl.querySelectorAll('.commit-row.ahead').length, 0);
});

test('a window lying entirely inside the ahead range gets no divider', async () => {
  // firstMerged === -1: a truncated window where every row is still ahead of
  // the base. There is no already-merged section for a divider to label.
  const listEl = await setup();
  const { renderCommitList } = await import('../public/commits.js');

  const data = prefixPayload({ aheadCount: 40, truncated: true });
  data.commits = data.commits.map(c => ({ ...c, ahead: true }));
  renderCommitList(listEl, data, { project: 'demo', onOpenCommit: () => {} });

  assert.equal(listEl.querySelectorAll('.ahead-divider').length, 0);
  assert.equal(listEl.querySelectorAll('.commit-row.ahead').length, 5, 'every row is badged');
});

test('no divider and no ahead classing when nothing is ahead', async () => {
  const listEl = await setup();
  const { renderCommitList } = await import('../public/commits.js');

  const data = prefixPayload({ aheadCount: 0, aheadOf: null });
  data.commits = data.commits.map(c => ({ ...c, ahead: false }));
  renderCommitList(listEl, data, { project: 'demo', onOpenCommit: () => {} });

  assert.equal(listEl.querySelectorAll('.ahead-divider').length, 0);
  assert.equal(listEl.querySelectorAll('.commit-row.ahead').length, 0);
  assert.equal(listEl.querySelectorAll('.commit-row').length, 5);
});

test('an empty history renders one working-tree row and the empty notice', async () => {
  const listEl = await setup();
  const { renderCommitList } = await import('../public/commits.js');

  renderCommitList(listEl, prefixPayload({ commits: [], hasUncommitted: true }),
    { project: 'demo', onOpenCommit: () => {} });

  assert.equal(listEl.querySelectorAll('.commit-row.uncommitted').length, 1,
    'the working-tree row is rendered exactly once');
  assert.equal(listEl.querySelectorAll('.review-empty').length, 1);
  assert.equal(listEl.children.length, 2);
});

test('tapping a row calls the injected onOpenCommit, not a module global', async () => {
  const listEl = await setup();
  const { renderCommitList } = await import('../public/commits.js');

  const calls = [];
  renderCommitList(listEl, prefixPayload(), {
    project: 'demo', onOpenCommit: (project, c) => calls.push([project, c.subject]),
  });
  listEl.querySelector('.commit-row').click();

  assert.deepEqual(calls, [['demo', 'a']]);
});

test('.commit-row.ahead carries a tint as well as a border', async () => {
  // The interleaved case draws no divider, so the row's own styling carries the
  // whole partition — one 3px strip in a hue the UI reuses is a single channel.
  const css = await fs.readFile(path.join(PUB, 'styles.css'), 'utf8');
  const rule = css.match(/\.commit-row\.ahead\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  assert.ok(rule.length > 0, 'sanity: styles.css defines .commit-row.ahead');
  assert.match(rule, /border-left:\s*3px solid var\(--tool\)/);
  assert.match(rule, /background:/, 'the tint is the second channel');
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

test('.commit-row keeps the box model ROW_TEXT_INSET is derived from', async () => {
  // ROW_TEXT_INSET (public/commits.js) is padding-left + gap, read off this
  // rule. Retuning either here silently breaks the divider's alignment, which
  // no DOM assertion can measure — so pin the two properties it depends on.
  const css = await fs.readFile(path.join(PUB, 'styles.css'), 'utf8');
  const rule = css.match(/\n\.commit-row\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  assert.ok(rule.length > 0, 'sanity: styles.css defines .commit-row');
  assert.match(rule, /gap:\s*8px/);
  assert.match(rule, /padding:\s*8px 12px/);
});

// ── Worktree-scoped addressing ──────────────────────────────────────────────

// PINS: every row's diff URL is built on the SAME base the list was fetched
// from, so opening a commit (or the working tree) of a worktree stays on the
// worktree-scoped spelling — the parent-scoped one cannot reach a worktree
// whose tree is on a system.
test('rows hand out diff URLs on the base the list was fetched from', async () => {
  const listEl = await setup();
  const { renderCommitList, commitsApiBase } = await import('../public/commits.js');

  const apiBase = commitsApiBase('demo', 'demo_worktree_feature');
  assert.equal(apiBase, '/api/projects/demo/worktrees/demo_worktree_feature');

  const opened = [];
  renderCommitList(listEl, prefixPayload({ hasUncommitted: true }), {
    project: 'demo', apiBase, onOpenCommit: (project, c) => opened.push([project, c.diffUrl]),
  });

  listEl.querySelector('.commit-row.uncommitted').click();
  listEl.querySelectorAll('.commit-row:not(.uncommitted)')[0].click();

  assert.deepEqual(opened, [
    ['demo', `${apiBase}/commits/uncommitted/diff`],
    ['demo', `${apiBase}/commits/${sha('a')}/diff`],
  ]);
});

// PINS: the default is the project-scoped spelling — a caller that names no
// worktree gets the same URLs it always did.
test('without an apiBase the rows fall back to the project-scoped spelling', async () => {
  const listEl = await setup();
  const { renderCommitList } = await import('../public/commits.js');

  const opened = [];
  renderCommitList(listEl, prefixPayload({ hasUncommitted: true }), {
    project: 'de mo', onOpenCommit: (project, c) => opened.push(c.diffUrl),
  });

  listEl.querySelector('.commit-row.uncommitted').click();
  listEl.querySelectorAll('.commit-row:not(.uncommitted)')[0].click();

  assert.deepEqual(opened, [
    '/api/projects/de%20mo/commits/uncommitted/diff',
    `/api/projects/de%20mo/commits/${sha('a')}/diff`,
  ]);
});

// PINS: the seam between `commits.open(project, worktree)` and the request —
// the pair must survive installHashView's dispatch into `onShow` AND
// loadCommits' base construction. Asserting BOTH arms is what gives it teeth:
// a chain that drops the worktree anywhere along it collapses the two arms onto
// the same project-scoped URL, which is the parent's history shown under a
// worktree's name.
test('open(project, worktree) fetches the worktree-scoped list, open(project) the project one', async () => {
  const { requested } = await setupView();
  const { installCommits } = await import('../public/commits.js');
  const commits = installCommits({});

  commits.open('demo', 'demo_worktree_feature');
  await new Promise(r => setTimeout(r, 0));
  commits.close();

  commits.open('demo');
  await new Promise(r => setTimeout(r, 0));
  commits.close();

  assert.deepEqual(requested, [
    '/api/projects/demo/worktrees/demo_worktree_feature/commits',
    '/api/projects/demo/commits',
  ]);
});

// PINS: the rows of a worktree-opened view build their diff URLs on the base the
// view was opened with — the request URL alone would not catch a view that
// fetched the worktree list and then handed out parent-scoped row URLs.
test('a worktree-opened view hands its rows worktree-scoped diff URLs', async () => {
  const { requested } = await setupView();
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return { ok: true, json: async () => prefixPayload({ hasUncommitted: true }) };
  };
  const { installCommits } = await import('../public/commits.js');
  const commits = installCommits({});
  const opened = [];
  commits.onOpenCommit = (project, c) => opened.push([project, c.diffUrl]);

  commits.open('demo', 'demo_worktree_feature');
  await new Promise(r => setTimeout(r, 0));

  const listEl = document.getElementById('commits-list');
  listEl.querySelector('.commit-row.uncommitted').click();
  listEl.querySelectorAll('.commit-row:not(.uncommitted)')[0].click();
  commits.close();

  const base = '/api/projects/demo/worktrees/demo_worktree_feature';
  assert.deepEqual(opened, [
    ['demo', `${base}/commits/uncommitted/diff`],
    ['demo', `${base}/commits/${sha('a')}/diff`],
  ]);
});

// PINS: the controls exist only for a worktree's history — a project's own tree
// has nothing to land back, so showing them there would offer a no-op.
test('Sync and Merge show for a worktree\'s history and are hidden for the project\'s own tree', async (t) => {
  const { commits, el } = await setupRealView();
  await t.test('a worktree\'s history shows them', async () => {
    commits.open('demo', 'wt');
    await flush();
    assert.equal(el('commits-actions').hidden, false);
    assert.equal(el('commits-sync-btn').textContent.trim(), 'Sync');
    assert.equal(el('commits-merge-btn').textContent.trim(), 'Merge');
  });
  await t.test('reopening on the project\'s own tree hides them again', async () => {
    commits.open('demo');
    await flush();
    assert.equal(el('commits-actions').hidden, true);
  });
  await t.test('closing a worktree view hides them', async () => {
    commits.open('demo', 'wt');
    await flush();
    commits.close();
    assert.equal(el('commits-actions').hidden, true);
  });
});

// PINS: the action's target is the (project, worktree) on screen at click time,
// not whatever was captured at install or at the first open.
test('Sync and Merge pass the viewed (project, worktree) to the injected actions, following a reopen', async () => {
  const { commits, calls, el } = await setupRealView();
  commits.open('demo', 'wt1');
  await flush();
  el('commits-sync-btn').click();
  await flush();
  el('commits-merge-btn').click();
  await flush();
  commits.open('other', 'wt2');
  await flush();
  el('commits-sync-btn').click();
  await flush();
  el('commits-merge-btn').click();
  await flush();
  assert.deepEqual(calls.sync, [{ project: 'demo', worktree: 'wt1' }, { project: 'other', worktree: 'wt2' }]);
  assert.deepEqual(calls.merge, [{ project: 'demo', worktree: 'wt1' }, { project: 'other', worktree: 'wt2' }]);
});

// PINS: refresh-on-success, and only on success — a refused or cancelled action
// changed nothing, so re-fetching would only blank the list for no reason.
test('an ok result re-fetches the list; ok:false or a cancelled (null) result does not', async (t) => {
  for (const [name, result, reloads] of [
    ['ok result', { ok: true }, true],
    ['ok:false refusal', { ok: false, reason: 'no' }, false],
    ['cancelled (null)', null, false],
  ]) {
    for (const kind of ['sync', 'merge']) {
      await t.test(`${kind}: ${name}`, async () => {
        const { commits, results, requested, el } = await setupRealView();
        commits.open('demo', 'wt');
        await flush();
        const before = requested.length;
        results[kind] = result;
        el(`commits-${kind}-btn`).click();
        await flush();
        assert.equal(requested.length - before, reloads ? 1 : 0);
        if (reloads) assert.equal(requested.at(-1), '/api/projects/demo/worktrees/wt/commits');
      });
    }
  }
});

// PINS: the stale-target guard — an action that resolves after the user moved to
// another worktree must not reload (and so retitle) the view they moved to.
test('a result landing after the view moved to another target does not reload it', async () => {
  const { commits, requested, impl, el } = await setupRealView();
  let finish;
  impl.sync = () => new Promise(r => { finish = r; });
  commits.open('demo', 'wt1');
  await flush();
  el('commits-sync-btn').click();
  commits.open('demo', 'wt2');
  await flush();
  const before = requested.length;
  finish({ ok: true });
  await flush();
  assert.equal(requested.length, before, 'no reload for the stale target');
});

// PINS: single dispatch — a second tap while a confirm/alert chain is in flight
// must not start a second action.
test('both buttons are disabled while an action is in flight and re-enabled after', async () => {
  const { commits, impl, el } = await setupRealView();
  let finish; let started = 0;
  impl.sync = () => { started++; return new Promise(r => { finish = r; }); };
  commits.open('demo', 'wt');
  await flush();
  el('commits-sync-btn').click();
  await flush();
  assert.equal(el('commits-sync-btn').disabled, true);
  assert.equal(el('commits-merge-btn').disabled, true);
  el('commits-sync-btn').click();
  assert.equal(started, 1, 'a disabled button does not start a second action');
  finish({ ok: false });
  await flush();
  assert.equal(el('commits-sync-btn').disabled, false);
  assert.equal(el('commits-merge-btn').disabled, false);
});
