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
  assertNull(projectNames(root).find(n => n === 'delta') ?? null, 'delta, whose only session is conducted, is hidden');
});

// Pins the project/workspace half of the rule: under Hand-spawned only a
// project shows iff its main checkout or a worktree holds a hand-spawned
// session — a non-conducted one on disk (`handCount`) or a live one — and a
// workspace shows iff a member does.
test('Hand-spawned only hides projects and workspaces with no hand-spawned session — zero-session and all-conducted alike', async (t) => {
  const projects = [
    project('empty'),
    project('all-conducted', { workspace: 'WS3', sessions: { count: 2, handCount: 0, lastActivity: 1 } }),
    project('disk-hand', { sessions: { count: 1, handCount: 1, lastActivity: 1 } }),
    project('live-hand'),
    project('wt-disk-hand', {
      sessions: { count: 1, handCount: 0, lastActivity: 1 },
      worktrees: [{ name: 'w', sessions: { count: 1, handCount: 1, lastActivity: 1 } }],
    }),
    project('ws2-member', { workspace: 'WS2' }),
  ];
  const instances = [
    conductor('C'),
    worker('c1', 'C', 'all-conducted'),
    hand('lh', 'live-hand'),
  ];
  const { root, select, sidebar } = await setupSidebar();
  sidebar.setProjects(projects);
  sidebar.setWorkspaces(['WS2', 'WS3']);
  sidebar.setConductSessions([]);
  sidebar.setInstances(instances);
  await tick();
  const mainSessions = (name) => [...root.querySelectorAll('.project-name')].find(n => n.textContent === name)
    ?.closest('li').querySelector(':scope > details.sessions-group') ?? null;
  const workspaceNames = () => [...root.querySelectorAll('.project-workspace-name')].map(n => n.textContent);
  assert.deepEqual(projectNames(root).sort(), projects.map(p => p.name).sort(), 'fixture: All lists every project');
  assert.ok(mainSessions('wt-disk-hand'), 'fixture: its conducted-only main checkout has a Sessions subnode under All');
  await choose(select, 'hand');
  const shown = projectNames(root);
  await t.test('a project with no sessions at all is hidden', () => {
    assert.equal(shown.includes('empty'), false);
  });
  await t.test('a project whose sessions are all conducted is hidden', () => {
    assert.equal(shown.includes('all-conducted'), false);
  });
  await t.test('an on-disk hand-spawned session (handCount) shows the project', () => {
    assert.ok(shown.includes('disk-hand'));
  });
  await t.test('a live hand-spawned instance shows the project', () => {
    assert.ok(shown.includes('live-hand'));
  });
  await t.test('an on-disk hand-spawned session in a worktree shows the project', () => {
    assert.ok(shown.includes('wt-disk-hand'));
  });
  await t.test('a main checkout holding only conducted sessions loses its Sessions subnode', () => {
    assertNull(mainSessions('wt-disk-hand'));
  });
  await t.test('a workspace with no visible member is hidden', () => {
    assert.deepEqual(workspaceNames(), []);
  });
  await t.test('switching back to All restores every project and workspace', async () => {
    await choose(select, '');
    assert.deepEqual(projectNames(root).sort(), projects.map(p => p.name).sort());
    assert.deepEqual(workspaceNames(), ['WS2', 'WS3']);
  });
});

// Pins the inner half: inside a shown project only the places holding a
// hand-spawned session are listed, the counts stay whole, and nothing is
// force-opened (that is the selected-conductor filter's alone).
test('Hand-spawned only lists only the worktrees and Sessions subnodes holding a hand-spawned session', async () => {
  const { root, select, sidebar } = await setupSidebar();
  await render(sidebar);
  await choose(select, 'hand');
  const alphaLi = [...root.querySelectorAll('.project-name')].find(n => n.textContent === 'alpha').closest('li');
  const group = alphaLi.querySelector('details.worktree-group');
  assert.equal(group.open, false, 'the Worktrees group is not force-opened');
  assert.equal(sidebar.expandedWorktrees.has('alpha'), false);
  group.open = true;
  await tick();
  assert.ok(wtHead(root, 'mixed'), 'mixed holds h2');
  assertNull(wtHead(root, 'solo-a'), 'solo-a holds only a conducted session');
  assertNull(wtHead(root, 'other-b'), 'other-b holds only a conducted session');
  assert.equal(group.querySelector('.worktree-summary').textContent, 'Worktrees (3)', 'the count stays unfiltered');
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
