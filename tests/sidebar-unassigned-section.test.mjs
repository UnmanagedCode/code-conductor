// The unassigned projects listed after the last workspace must read as their
// own section, not as members of that workspace. Sidebar.render() already puts
// them at the top level of the project list; the boundary is purely CSS — the
// dashed rule every workspace section opens with (.project-workspace) must
// also open the unassigned run. happy-dom computes no layout, but it does run
// the author cascade in getComputedStyle, so these tests load the real
// public/styles.css and assert on the computed styles of the real rendered DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNull } from './dom-assert.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

async function setupSidebar() {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.localStorage = window.localStorage;
  try { window.localStorage.clear(); } catch { /* ignore */ }

  const { Sidebar } = await import(pathToFileURL(path.join(PUB, 'sidebar.js')).href);
  document.body.innerHTML = '<ul id="mission-list" class="mission-list"></ul><ul id="project-list" class="project-list"></ul>';
  const style = document.createElement('style');
  style.textContent = await fs.readFile(path.join(PUB, 'styles.css'), 'utf8');
  document.head.appendChild(style);
  const list = document.getElementById('project-list');
  const missionList = document.getElementById('mission-list');

  const calls = { showCommits: [] };
  const sidebar = new Sidebar({
    rootList: list,
    missionList,
    onSelectInstance: () => {},
    onCreateInstanceClick: () => {},
    onResumeSession: () => {},
    onRemoveWorktree: () => {},
    onDeleteProject: () => {},
    onLoadSessions: async () => [],
    onEditWorkspace: () => {},
    onQuickSpawn: () => {},
  });
  sidebar.onShowCommits = (name) => calls.showCommits.push(name);
  return { window, list, missionList, sidebar, calls };
}

function project(name, workspace, isGitRepo) {
  return {
    name, path: `/p/${name}`, workspace, isGitRepo,
    sessionIds: [], worktrees: [], sessions: { count: 0, lastActivity: 0 },
  };
}

const FIXTURE = [
  project('recon', 'TTD', true),
  project('TTD-Linux', 'TTD', true),
  project('alpha-member', 'AI', true),
  project('binary-ninja', null, false),
  project('zeta', null, false),
];

// FIXTURE plus a git unassigned project, so top-level rows come in both kinds
// (visible ≡ button and invisible spacer).
const MIXED = [...FIXTURE, project('gitty', null, true)];

const CONDUCT_INSTANCE = {
  id: 'inst-c', project: '.conduct', sessionId: 'sid-c', status: 'idle',
  mode: 'bypassPermissions', worktree: null, temp: true,
};
// A live worker of CONDUCT_INSTANCE in the git top-level project `gitty`, so
// an expanded mission renders a project row inside .mission-tree.
const GITTY_WORKER = {
  id: 'inst-w', project: 'gitty', sessionId: 'sid-w', status: 'idle',
  mode: 'default', worktree: null, conducted: true, ownerSessionId: 'sid-c',
};

async function render(sidebar, projects, instances = []) {
  sidebar.setProjects(projects);
  sidebar.setInstances(instances);
  await new Promise(r => setTimeout(r, 0));
}

function topLi(list, name) {
  const nameEl = [...list.querySelectorAll('.project-name')].find(n => n.textContent === name);
  assert.ok(nameEl, `project row "${name}" is rendered`);
  return nameEl.closest('li');
}

function ruleOf(window, el) {
  const cs = window.getComputedStyle(el);
  return {
    style: cs.getPropertyValue('border-top-style'),
    top: cs.getPropertyValue('border-top'),
    pad: cs.getPropertyValue('padding-top'),
  };
}

function workspaceDetails(list, name) {
  const d = [...list.querySelectorAll('.project-workspace')]
    .find(el => el.querySelector('.project-workspace-name')?.textContent === name);
  assert.ok(d, `workspace "${name}" is rendered`);
  return d;
}

test('unassigned project after the last workspace sits at top level, directly after it (DOM precondition)', async () => {
  const { list, sidebar } = await setupSidebar();
  await render(sidebar, FIXTURE);
  const li = topLi(list, 'binary-ninja');
  assert.ok(li.parentElement === list, 'unassigned row is a direct child of the project list');
  const prev = li.previousElementSibling;
  assert.ok(prev?.classList.contains('project-workspace-item'), 'preceded by a workspace item');
  assert.equal(prev.querySelector('.project-workspace-name').textContent, 'TTD');
  assertNull(li.closest('.project-workspace-list'), 'not nested in any workspace member list');
});

test('the first unassigned project opens its own section with the workspace section rule — collapsed and expanded', async () => {
  const { window, list, sidebar } = await setupSidebar();
  await render(sidebar, FIXTURE);
  const ttd = workspaceDetails(list, 'TTD');
  const check = (state) => {
    const li = topLi(list, 'binary-ninja');
    const got = ruleOf(window, li);
    const want = ruleOf(window, ttd);
    assert.equal(got.style, 'dashed', `${state}: first unassigned row opens with a dashed rule`);
    assert.equal(got.top, want.top, `${state}: same border-top as .project-workspace`);
    assert.equal(got.pad, want.pad, `${state}: same padding-top as .project-workspace`);
  };
  check('initial');
  ttd.open = true;
  check('expanded');
  ttd.open = false;
  check('collapsed');
});

test('the section rule is drawn once, not between unassigned rows', async () => {
  const { window, list, sidebar } = await setupSidebar();
  await render(sidebar, FIXTURE);
  assert.notEqual(ruleOf(window, topLi(list, 'zeta')).style, 'dashed',
    'a second unassigned row gets no rule of its own');
  const items = [...list.querySelectorAll(':scope > li.project-workspace-item')];
  assert.ok(items.length >= 2, 'fixture renders more than one workspace');
  for (const item of items) {
    assert.notEqual(ruleOf(window, item).style, 'dashed',
      'a workspace <li> draws no rule — its <details> owns it');
  }
});

test('no section rule when nothing precedes it — only unassigned projects', async () => {
  const { window, list, sidebar } = await setupSidebar();
  await render(sidebar, [project('binary-ninja', null, false), project('zeta', null, false)]);
  for (const li of list.querySelectorAll(':scope > li')) {
    assert.notEqual(ruleOf(window, li).style, 'dashed', 'no rule without a preceding workspace');
  }
});

// ── Name alignment ──────────────────────────────────────────────────────────
// happy-dom computes no layout, so x positions are summed from the computed box
// model of the real rules. getComputedStyle ignores pseudo-elements in
// happy-dom, so the header caret's width is read from its real CSSOM rule.

const px = (v) => {
  if (v === '' || v === '0') return 0;
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v);
  assert.ok(m, `expected a px length, got ${JSON.stringify(v)}`);
  return Number(m[1]);
};

function cssRule(window, selectorText) {
  const rule = [...window.document.styleSheets].flatMap(sh => [...sh.cssRules])
    .find(r => r.selectorText === selectorText);
  assert.ok(rule, `styles.css has a rule for ${selectorText}`);
  return rule;
}

// Left inset of an element's content edge inside its own margin box.
function leadIn(cs) {
  return px(cs.getPropertyValue('margin-left')) + px(cs.getPropertyValue('border-left-width'))
    + px(cs.getPropertyValue('padding-left'));
}

// x of .project-workspace-name, relative to the workspace <li>'s border edge.
function headerLabelX(window, list) {
  const details = workspaceDetails(list, 'TTD');
  const summary = details.querySelector(':scope > .project-workspace-summary');
  const scs = window.getComputedStyle(summary);
  const caret = cssRule(window, '.project-workspace > .project-workspace-summary::before').style;
  const caretW = px(caret.getPropertyValue('width'))
    + px(caret.getPropertyValue('padding-left')) + px(caret.getPropertyValue('padding-right'))
    + px(caret.getPropertyValue('margin-left')) + px(caret.getPropertyValue('margin-right'));
  return leadIn(window.getComputedStyle(details.closest('li')))
    + leadIn(window.getComputedStyle(details))
    + leadIn(scs) + caretW + px(scs.getPropertyValue('column-gap'));
}

// Outer width of the commit-log column, or a failure when CSS does not fix it —
// an auto width is the ≡ glyph's advance, which depends on the font.
function logColumnWidth(window, el) {
  const cs = window.getComputedStyle(el);
  const w = cs.getPropertyValue('width');
  assert.match(w, /px$/, `${el.className} has a fixed CSS width (got ${JSON.stringify(w)}) — an auto width is the glyph's, font-dependent`);
  assert.equal(cs.getPropertyValue('flex-shrink'), '0', `${el.className} must not shrink below its width`);
  const inner = cs.getPropertyValue('box-sizing') === 'border-box' ? 0
    : px(cs.getPropertyValue('padding-left')) + px(cs.getPropertyValue('padding-right'))
      + px(cs.getPropertyValue('border-left-width')) + px(cs.getPropertyValue('border-right-width'));
  return px(w) + inner + px(cs.getPropertyValue('margin-left')) + px(cs.getPropertyValue('margin-right'));
}

// x of .project-name in a row, relative to its <li>'s border edge.
function rowNameX(window, li) {
  const row = li.querySelector(':scope > .project-row');
  const rcs = window.getComputedStyle(row);
  const first = row.firstElementChild;
  assert.ok(first.matches('.commit-log, .commit-log-spacer'), 'the commit-log column leads the row');
  assert.ok(first.nextElementSibling.matches('.project-name'), 'the name follows the commit-log column');
  return leadIn(window.getComputedStyle(li)) + leadIn(rcs)
    + logColumnWidth(window, first) + px(rcs.getPropertyValue('column-gap'));
}

// The box-model properties that place a row's name, as a comparable record.
function rowGeometry(window, row) {
  const pick = (el, props) => Object.fromEntries(props.map(p => [p, window.getComputedStyle(el).getPropertyValue(p)]));
  const box = ['padding-left', 'padding-right', 'margin-left', 'border-left-width', 'column-gap'];
  const col = ['width', 'flex-shrink', 'padding-left', 'padding-right', 'margin-left', 'margin-right'];
  return { row: pick(row, box), log: pick(row.firstElementChild, col) };
}

test('a top-level project name starts at the workspace label x — git and non-git rows alike', async () => {
  const { window, list, sidebar } = await setupSidebar();
  await render(sidebar, MIXED);
  const want = headerLabelX(window, list);
  const git = topLi(list, 'gitty');
  const plain = topLi(list, 'binary-ninja');
  assert.ok(git.querySelector(':scope > .project-row > .commit-log'), 'fixture: gitty shows the ≡ button');
  assert.ok(plain.querySelector(':scope > .project-row > .commit-log-spacer'), 'fixture: binary-ninja shows the spacer');
  assert.equal(rowNameX(window, git), want, 'git top-level name x = workspace label x');
  assert.equal(rowNameX(window, plain), want, 'non-git top-level name x = workspace label x');
});

test('the ≡ commit-log button on a git top-level row stays visible and clickable', async () => {
  const { window, list, sidebar, calls } = await setupSidebar();
  await render(sidebar, MIXED);
  const btn = topLi(list, 'gitty').querySelector(':scope > .project-row > .commit-log');
  const cs = window.getComputedStyle(btn);
  assert.notEqual(cs.getPropertyValue('visibility'), 'hidden');
  assert.notEqual(cs.getPropertyValue('display'), 'none');
  assert.notEqual(cs.getPropertyValue('pointer-events'), 'none');
  btn.click();
  assert.deepEqual(calls.showCommits, ['gitty']);
});

test('workspace member rows keep the base .project-row geometry', async () => {
  const { window, list, sidebar } = await setupSidebar();
  await render(sidebar, MIXED);
  // Reference: the same markup outside the project list, where only the base
  // .project-row rules apply.
  const ref = window.document.createElement('div');
  ref.innerHTML = '<div class="project-row"><button class="commit-log">≡</button><span class="project-name">x</span></div>';
  window.document.body.appendChild(ref);
  const refGit = ref.firstElementChild;
  const member = topLi(list, 'recon').querySelector(':scope > .project-row');
  assert.ok(member.closest('.project-workspace-list'), 'fixture: recon is a workspace member');
  assert.deepEqual(rowGeometry(window, member), rowGeometry(window, refGit), 'member row geometry');
  // The reference sits in the same cascade, so an unscoped alignment rule would
  // move it too; the top-level rows are the other side of that comparison.
  const topGit = topLi(list, 'gitty').querySelector(':scope > .project-row');
  assert.notDeepEqual(rowGeometry(window, member), rowGeometry(window, topGit),
    'the top-level alignment does not reach workspace member rows');
});

test('the top-level alignment does not reach .mission-tree project rows', async () => {
  const { window, list, missionList, sidebar } = await setupSidebar();
  await render(sidebar, MIXED, [CONDUCT_INSTANCE, GITTY_WORKER]);
  missionList.querySelector('.mission-caret').click();
  const treeRow = missionList.querySelector('.mission-tree .project-row');
  assert.ok(treeRow, 'fixture: the expanded mission renders a project row');
  assert.ok(treeRow.querySelector(':scope > .commit-log'), 'fixture: gitty is a git project');
  const topGit = topLi(list, 'gitty').querySelector(':scope > .project-row');
  const ref = window.document.createElement('div');
  ref.innerHTML = '<div class="project-row"><button class="commit-log">≡</button><span class="project-name">x</span></div>';
  window.document.body.appendChild(ref);
  assert.notDeepEqual(rowGeometry(window, treeRow), rowGeometry(window, topGit),
    'a mission-tree project row does not take the top-level alignment');
  assert.deepEqual(rowGeometry(window, treeRow).log, rowGeometry(window, ref.firstElementChild).log,
    'its commit-log column keeps the base geometry');
});

test('the workspace header caret does not shrink when the summary overflows', async () => {
  const { window } = await setupSidebar();
  // The top-level commit-log column is a fixed width; a caret that shrinks
  // under a long workspace name or a narrow sidebar pulls the label left of it.
  const caret = cssRule(window, '.project-workspace > .project-workspace-summary::before').style;
  assert.equal(caret.getPropertyValue('flex-shrink'), '0', 'caret rule sets flex-shrink 0');
});
