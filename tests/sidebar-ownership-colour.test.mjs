// Conductor ownership colour in the Projects lens (#project-list). Derived only
// from live `ownerSessionId`: a worktree whose live conducted sessions all
// share one conductor carries its bar on the worktree row; a mixed worktree
// and a project's main checkout carry it per session row instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNull } from './dom-assert.mjs';
import { setupSidebar, tick, project, conductor, worker, hand, rowOf, wtHead } from './sidebar-fixture.mjs';

// Open every Worktrees group and let the lazy session lists land.
async function openAll(root) {
  for (const d of root.querySelectorAll('details.worktree-group')) d.open = true;
  await tick();
  await tick();
}

async function render(sidebar, root, { projects, instances, conductRows = [] }) {
  sidebar.setProjects(projects);
  sidebar.setConductSessions(conductRows);
  sidebar.setInstances(instances);
  await tick();
  await openAll(root);
}

const barOf = (node) => ({
  owned: node.classList.contains('owned'),
  color: node.style.getPropertyValue('--owner-color'),
});

test('single-conductor worktree: the head carries the bar and tooltip, its session rows don\'t', async () => {
  const { root, sidebar, conductorColor } = await setupSidebar();
  await render(sidebar, root, {
    projects: [project('proj', { worktrees: ['solo'] })],
    instances: [conductor('A', { title: 'Alpha' }), worker('w1', 'A', 'proj', 'solo'), worker('w2', 'A', 'proj', 'solo')],
  });
  const head = wtHead(root, 'solo');
  assert.deepEqual(barOf(head), { owned: true, color: conductorColor('A') });
  assert.equal(head.title, 'conductor: Alpha');
  for (const sid of ['w1', 'w2']) {
    const row = rowOf(root, sid);
    assert.ok(row, `${sid} row rendered`);
    assert.deepEqual(barOf(row), { owned: false, color: '' }, `${sid} carries no bar of its own`);
  }
});

test('mixed-conductor worktree: the head is uncoloured and each live conducted session gets its own conductor\'s colour', async () => {
  const { root, sidebar, conductorColor } = await setupSidebar();
  await render(sidebar, root, {
    projects: [project('proj', { worktrees: ['mixed'] })],
    instances: [conductor('A', { title: 'Alpha' }), conductor('B'), worker('wa', 'A', 'proj', 'mixed'), worker('wb', 'B', 'proj', 'mixed')],
  });
  assert.deepEqual(barOf(wtHead(root, 'mixed')), { owned: false, color: '' });
  assert.deepEqual(barOf(rowOf(root, 'wa')), { owned: true, color: conductorColor('A') });
  assert.deepEqual(barOf(rowOf(root, 'wb')), { owned: true, color: conductorColor('B') });
  assert.match(rowOf(root, 'wa').title, /\nconductor: Alpha$/, 'the tooltip names the conductor');
});

test('a non-live conducted session gets no bar', async () => {
  const { root, sidebar } = await setupSidebar({
    onLoadSessions: async (name, wt) => (wt === 'mixed' ? [{ sessionId: 'disk-c', conducted: true, lastActivity: 5 }] : []),
  });
  await render(sidebar, root, {
    projects: [project('proj', { worktrees: ['mixed'] })],
    instances: [
      conductor('A'), conductor('B'), worker('wa', 'A', 'proj', 'mixed'), worker('wb', 'B', 'proj', 'mixed'),
      worker('ex', 'A', 'proj', 'mixed', { status: 'exited', ownerSessionId: null }),
    ],
  });
  assert.ok(rowOf(root, 'disk-c'), 'fixture: the disk-only conducted row renders');
  assert.deepEqual(barOf(rowOf(root, 'disk-c')), { owned: false, color: '' }, 'a disk row with no instance');
  assert.deepEqual(barOf(rowOf(root, 'ex')), { owned: false, color: '' }, 'an exited instance (null owner)');
});

test('a hand-spawned session gets no bar, even inside an owned worktree', async () => {
  const { root, sidebar } = await setupSidebar();
  await render(sidebar, root, {
    projects: [project('proj', { worktrees: ['solo', 'mixed'] })],
    instances: [
      conductor('A'), conductor('B'),
      worker('w1', 'A', 'proj', 'solo'), hand('h1', 'proj', 'solo'),
      worker('wa', 'A', 'proj', 'mixed'), worker('wb', 'B', 'proj', 'mixed'), hand('h2', 'proj', 'mixed'),
    ],
  });
  assert.ok(wtHead(root, 'solo').classList.contains('owned'), 'a hand-spawned session does not break single ownership');
  assert.deepEqual(barOf(rowOf(root, 'h1')), { owned: false, color: '' });
  assert.deepEqual(barOf(rowOf(root, 'h2')), { owned: false, color: '' });
});

test('a worktree with no live conducted sessions is uncoloured', async () => {
  const { root, sidebar } = await setupSidebar({
    onLoadSessions: async (name, wt) => (wt === 'old' ? [{ sessionId: 'disk-c', conducted: true, lastActivity: 5 }] : []),
  });
  const p = project('proj', { worktrees: ['old', 'feature', 'child'] });
  p.worktrees.find(w => w.worktreeName === 'child').baseBranch = 'cc/feature'; // an aggregate: another worktree builds on it
  p.worktrees.find(w => w.worktreeName === 'old').sessions = { count: 1, lastActivity: 5 };
  await render(sidebar, root, {
    projects: [p],
    instances: [conductor('A'), worker('w', 'A', 'proj', 'child')],
  });
  assert.ok(rowOf(root, 'disk-c'), 'fixture: disk-only conducted row renders');
  assert.deepEqual(barOf(wtHead(root, 'old')), { owned: false, color: '' }, 'disk-only conducted sessions');
  assert.deepEqual(barOf(wtHead(root, 'feature')), { owned: false, color: '' }, 'aggregate worktree with no live conducted session');
  assert.ok(wtHead(root, 'child').classList.contains('owned'), 'control: the worktree that does hold one is coloured');
});

test('main-checkout conducted sessions keep their own bar, per conductor', async () => {
  const { root, sidebar, conductorColor } = await setupSidebar();
  await render(sidebar, root, {
    projects: [project('proj')],
    instances: [conductor('A'), conductor('B'), worker('ma', 'A', 'proj'), worker('mb', 'B', 'proj'), hand('mh', 'proj')],
  });
  assert.deepEqual(barOf(rowOf(root, 'ma')), { owned: true, color: conductorColor('A') });
  assert.deepEqual(barOf(rowOf(root, 'mb')), { owned: true, color: conductorColor('B') });
  assert.deepEqual(barOf(rowOf(root, 'mh')), { owned: false, color: '' });
  assert.equal(root.querySelector('.project-row').classList.contains('owned'), false, 'the project row is never coloured');
});

test('the bar clears in place when the worker dies', async () => {
  const { root, sidebar, conductorColor } = await setupSidebar();
  const projects = [project('proj')];
  await render(sidebar, root, { projects, instances: [conductor('A'), worker('ma', 'A', 'proj')] });
  const before = rowOf(root, 'ma');
  assert.deepEqual(barOf(before), { owned: true, color: conductorColor('A') });
  sidebar.setInstances([conductor('A'), worker('ma', 'A', 'proj', null, { status: 'exited', ownerSessionId: null })]);
  await tick();
  const after = rowOf(root, 'ma');
  assert.equal(after, before, 'same row node');
  assert.deepEqual(barOf(after), { owned: false, color: '' });
});

test('a single-owner worktree head loses its bar in place when its last owned worker goes', async () => {
  const { root, sidebar, conductorColor } = await setupSidebar();
  const projects = [project('proj', { worktrees: ['solo'] })];
  await render(sidebar, root, { projects, instances: [conductor('A', { title: 'Alpha' }), worker('w1', 'A', 'proj', 'solo')] });
  const head = wtHead(root, 'solo');
  assert.deepEqual(barOf(head), { owned: true, color: conductorColor('A') });
  assert.equal(head.title, 'conductor: Alpha');
  sidebar.setInstances([conductor('A', { title: 'Alpha' })]);
  await tick();
  assert.equal(wtHead(root, 'solo'), head, 'same head node');
  assert.deepEqual(barOf(head), { owned: false, color: '' });
  assert.equal(head.hasAttribute('title'), false, 'the conductor tooltip goes with the bar');
});

test('no .conduct row in the Projects lens, even with a live conductor and conduct disk rows', async () => {
  const { root, sidebar } = await setupSidebar();
  await render(sidebar, root, {
    projects: [project('demo')],
    instances: [conductor('A')],
    conductRows: [{ sessionId: 'D', lastActivity: 1 }],
  });
  const names = [...root.querySelectorAll('.project-name')].map(n => n.textContent);
  assert.deepEqual(names, ['demo']);
  assertNull(root.querySelector('.project-conduct'), 'no .project-conduct item');
});

test('"no projects yet" shows even while a conductor is live', async () => {
  const { root, sidebar } = await setupSidebar();
  await render(sidebar, root, { projects: [], instances: [conductor('A')], conductRows: [{ sessionId: 'D', lastActivity: 1 }] });
  assert.equal(root.children.length, 1);
  assert.equal(root.textContent, 'no projects yet');
});

test('hand-spawn controls remain in the Projects tree', async () => {
  const { root, sidebar } = await setupSidebar();
  await render(sidebar, root, {
    projects: [project('proj', { worktrees: ['solo'] })],
    instances: [conductor('A'), worker('w', 'A', 'proj', 'solo')],
  });
  for (const sel of ['.add-instance', '.delete-project', '.wt-spawn', '.wt-remove']) {
    assert.ok(root.querySelector(sel), `${sel} is present`);
  }
});
