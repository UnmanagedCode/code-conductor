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
  document.body.innerHTML = '<ul id="project-list" class="project-list"></ul>';
  const style = document.createElement('style');
  style.textContent = await fs.readFile(path.join(PUB, 'styles.css'), 'utf8');
  document.head.appendChild(style);
  const list = document.getElementById('project-list');

  const sidebar = new Sidebar({
    rootList: list,
    onSelectInstance: () => {},
    onCreateInstanceClick: () => {},
    onResumeSession: () => {},
    onRemoveWorktree: () => {},
    onDeleteProject: () => {},
    onLoadSessions: async () => [],
    onEditWorkspace: () => {},
    onQuickSpawn: () => {},
  });
  return { window, list, sidebar };
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

const CONDUCT_INSTANCE = {
  id: 'inst-c', project: '.conduct', sessionId: 'sid-c', status: 'idle',
  mode: 'bypassPermissions', worktree: null, temp: true,
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
  assert.equal(li.parentElement, list, 'unassigned row is a direct child of the project list');
  const prev = li.previousElementSibling;
  assert.ok(prev?.classList.contains('project-workspace-item'), 'preceded by a workspace item');
  assert.equal(prev.querySelector('.project-workspace-name').textContent, 'TTD');
  assertNull(li.closest('.project-workspace-list'), 'not nested in any workspace member list');
});

test('the first unassigned project opens its own section with the workspace section rule — collapsed, expanded, and under a Conduct row', async () => {
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
  await render(sidebar, FIXTURE, [CONDUCT_INSTANCE]);
  check('with a Conduct row above');
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

test('no section rule when nothing precedes it — no workspaces, or the Conduct row', async (t) => {
  await t.test('only unassigned projects', async () => {
    const { window, list, sidebar } = await setupSidebar();
    await render(sidebar, [project('binary-ninja', null, false), project('zeta', null, false)]);
    for (const li of list.querySelectorAll(':scope > li')) {
      assert.notEqual(ruleOf(window, li).style, 'dashed', 'no rule without a preceding workspace');
    }
  });
  await t.test('Conduct row precedes the workspaces', async () => {
    const { window, list, sidebar } = await setupSidebar();
    await render(sidebar, FIXTURE, [CONDUCT_INSTANCE]);
    const conduct = list.querySelector('.project-conduct');
    assert.ok(conduct, 'conduct row is rendered');
    assert.notEqual(ruleOf(window, conduct).style, 'dashed', 'Conduct row draws no rule');
  });
});
