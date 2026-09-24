// The Projects lens's conductor filter (#conductor-filter <select>): All /
// Hand-spawned only / one entry per live owner. A selected conductor narrows
// the tree to where it has live sessions; the ownership classification still
// reads every instance.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNull } from './dom-assert.mjs';
import { setupSidebar, tick, project, conductor, worker, hand, rowOf, wtHead } from './sidebar-fixture.mjs';

const PROJECTS = [
  project('alpha', { worktrees: ['solo-a', 'mixed', 'other-b'] }),
  project('beta'),
  project('gamma', { workspace: 'WS' }),
  project('delta', { workspace: 'WS' }),
  project('empty-ws-member', { workspace: 'WS2' }),
];
const INSTANCES = [
  conductor('A', { title: 'Alpha mission', createdAt: 3000 }),
  conductor('B', { createdAt: 2000, firstPrompt: 'bravo prompt' }),
  hand('H', 'beta', null, { firstPrompt: 'hand owner' }),
  worker('a1', 'A', 'alpha', 'solo-a'),
  worker('a2', 'A', 'alpha', 'mixed'),
  worker('b1', 'B', 'alpha', 'mixed'),
  worker('b2', 'B', 'alpha', 'other-b'),
  worker('a3', 'A', 'gamma'),
  worker('b3', 'B', 'delta'),
  worker('h1', 'H', 'beta'),
  hand('h2', 'alpha', 'mixed'),
];

async function render(sidebar) {
  sidebar.setProjects(PROJECTS);
  sidebar.setWorkspaces(['WS', 'WS2']);
  sidebar.setConductSessions([]);
  sidebar.setInstances(INSTANCES);
  await tick();
}

async function choose(select, value) {
  select.value = value;
  select.dispatchEvent(new select.ownerDocument.defaultView.Event('change'));
  await tick();
  await tick();
}

const projectNames = (root) => [...root.querySelectorAll('.project-name')].map(n => n.textContent);

test('options are All / Hand-spawned only / one per live owner, labelled by mission title', async () => {
  const { select, sidebar } = await setupSidebar();
  await render(sidebar);
  const opts = [...select.options].map(o => [o.value, o.textContent]);
  assert.deepEqual(opts, [
    ['', 'All sessions'],
    ['hand', 'Hand-spawned only'],
    ['A', 'Alpha mission'],
    ['B', 'bravo prompt'],
    ['H', 'hand owner'],
  ], 'live missions (newest first), then owners that are not missions');
});

test('selecting a conductor hides projects and workspaces without its live sessions, force-opens its worktrees and lists only its sessions', async () => {
  const { root, select, sidebar } = await setupSidebar();
  await render(sidebar);
  await choose(select, 'A');
  assert.deepEqual(projectNames(root), ['gamma', 'alpha'], 'beta, delta and the WS2 workspace are hidden');
  assert.deepEqual([...root.querySelectorAll('.project-workspace-name')].map(n => n.textContent), ['WS']);
  const group = root.querySelector('details.worktree-group');
  assert.equal(group.open, true, 'the Worktrees group is forced open');
  await tick();
  const names = [...group.querySelectorAll('.worktree-name')].map(n => n.textContent);
  assert.deepEqual(names, ['solo-a', 'mixed'], 'only the worktrees holding an A session');
  assert.ok(rowOf(root, 'a2'));
  assertNull(rowOf(root, 'b1'), 'another conductor\'s row is dropped');
  assertNull(rowOf(root, 'h2'), 'a hand-spawned row is dropped');
});

test('a mixed worktree stays visible under the filter, with the head uncoloured and only the selected conductor\'s session bars', async () => {
  const { root, select, sidebar, conductorColor } = await setupSidebar();
  await render(sidebar);
  await choose(select, 'A');
  const head = wtHead(root, 'mixed');
  assert.ok(head, 'mixed is listed');
  assert.equal(head.classList.contains('owned'), false, 'classification uses all instances: still mixed');
  const a2 = rowOf(root, 'a2');
  assert.ok(a2.classList.contains('owned'));
  assert.equal(a2.style.getPropertyValue('--owner-color'), conductorColor('A'));
  assert.equal(wtHead(root, 'solo-a').style.getPropertyValue('--owner-color'), conductorColor('A'));
});

test('the filter root carries the selected conductor\'s colour, and none for All or Hand-spawned', async () => {
  const { filterRoot, select, sidebar, conductorColor } = await setupSidebar();
  await render(sidebar);
  assert.equal(filterRoot.classList.contains('owned'), false);
  await choose(select, 'B');
  assert.ok(filterRoot.classList.contains('owned'));
  assert.equal(filterRoot.style.getPropertyValue('--owner-color'), conductorColor('B'));
  await choose(select, 'hand');
  assert.equal(filterRoot.classList.contains('owned'), false);
  assert.equal(filterRoot.style.getPropertyValue('--owner-color'), '');
  await choose(select, '');
  assert.equal(filterRoot.classList.contains('owned'), false);
});

test('Hand-spawned only drops conducted rows and the — conducted — separator', async () => {
  const { root, select, sidebar } = await setupSidebar();
  await render(sidebar);
  for (const d of root.querySelectorAll('details')) d.open = true;
  await tick();
  assert.ok([...root.querySelectorAll('.sessions-separator')].some(s => s.textContent === '— conducted —'), 'fixture: separator shows under All');
  await choose(select, 'hand');
  assert.ok(rowOf(root, 'h2'), 'the hand-spawned row stays');
  for (const sid of ['a1', 'a2', 'b1', 'h1']) assertNull(rowOf(root, sid), `${sid} (conducted) is dropped`);
  assert.equal([...root.querySelectorAll('.sessions-separator')].some(s => s.textContent === '— conducted —'), false);
  assert.ok(projectNames(root).includes('delta'), 'projects are not hidden by Hand-spawned only');
});

test('clearing the filter restores the user\'s own worktree expansion', async () => {
  const { root, select, sidebar } = await setupSidebar();
  await render(sidebar);
  const group = root.querySelector('details.worktree-group');
  assert.equal(group.open, false, 'fixture: the user left Worktrees collapsed');
  await choose(select, 'A');
  assert.equal(group.open, true, 'forced open under the filter');
  assert.equal(sidebar.expandedWorktrees.has('alpha'), false, 'the forced open is never recorded');
  await choose(select, '');
  assert.equal(root.querySelector('details.worktree-group'), group, 'same group node');
  assert.equal(group.open, false, 'back to the user\'s collapsed state');
  assert.equal(sidebar.expandedWorktrees.has('alpha'), false);
});

test('the filter falls back to All when the selected owner no longer has a live session', async () => {
  const { root, select, sidebar } = await setupSidebar();
  await render(sidebar);
  await choose(select, 'B');
  sidebar.setInstances(INSTANCES.map(i => (i.ownerSessionId === 'B' ? { ...i, status: 'exited', ownerSessionId: null } : i)));
  await tick();
  assert.equal(sidebar.filter, '');
  assert.equal(select.value, '');
  assert.ok(projectNames(root).includes('beta'), 'the full tree is back');
  assert.equal([...select.options].some(o => o.value === 'B'), false, 'B is no longer offered');
});
