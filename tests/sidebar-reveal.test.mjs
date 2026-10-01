// Reveal on select: Sidebar.setActive opens every collapsed group on the
// selected session's path in both lenses, once per selection, and switches a
// Projects-lens conductor filter that would hide the row. Every fixture holds a
// second conductor / workspace / project that must stay collapsed, so a reveal
// that opens the wrong target or everything is told apart from the right one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNull } from './dom-assert.mjs';
import { setupSidebar, tick, project, conductor, worker, hand, rowOf } from './sidebar-fixture.mjs';

const conductorOf = (list, sid) => list.querySelector(`[data-key="conductor:${sid}"]`);
const caretOf = (list, sid) => conductorOf(list, sid).querySelector('.conductor-caret');
const isOpen = (list, sid) => conductorOf(list, sid).classList.contains('open');
const treeOf = (list, sid) => conductorOf(list, sid).querySelector('.conductor-tree');
const inactiveGroup = (list) => list.querySelector('details.conductor-inactive');
const workspaceDet = (root, name) => [...root.querySelectorAll('details.project-workspace')]
  .find(d => d.querySelector('.project-workspace-name').textContent === name);
const sessionsDetOf = (root, name) => [...root.querySelectorAll('.project-name')]
  .find(n => n.textContent === name).closest('li').querySelector(':scope > details.sessions-group');

async function render(sidebar, { projects = [], instances = [], conductRows = [], workspaces = [] } = {}) {
  sidebar.setProjects(projects);
  sidebar.setWorkspaces(workspaces);
  sidebar.setConductSessions(conductRows);
  sidebar.setInstances(instances);
  await tick();
}

async function choose(select, value) {
  select.value = value;
  select.dispatchEvent(new select.ownerDocument.defaultView.Event('change'));
  await tick();
}

async function select(sidebar, id) {
  sidebar.setActive(id);
  await tick();
  await tick();
}

const CONDUCTOR_PROJECTS = [project('proj', { worktrees: ['wt'] }), project('other')];

test('Conductors lens', async (t) => {
  await t.test('selecting a worker expands its owning bubble only and highlights its row', async () => {
    const { conductorList, sidebar } = await setupSidebar();
    await render(sidebar, {
      projects: CONDUCTOR_PROJECTS,
      instances: [conductor('A'), conductor('B'), worker('wa1', 'A', 'proj'), worker('wb1', 'B', 'other')],
    });
    assert.ok(!isOpen(conductorList, 'A') && !isOpen(conductorList, 'B'), 'fixture: both bubbles start collapsed');
    await select(sidebar, 'inst-wa1');
    assert.ok(isOpen(conductorList, 'A'), 'the owner bubble is open');
    assert.equal(caretOf(conductorList, 'A').getAttribute('aria-expanded'), 'true');
    assert.ok(rowOf(treeOf(conductorList, 'A'), 'wa1').classList.contains('active'), 'the worker row is highlighted');
    assert.ok(!isOpen(conductorList, 'B'), 'the other conductor stays collapsed');
    assertNull(treeOf(conductorList, 'B'), 'and builds no tree');
  });

  await t.test('a worker spawned by a worker opens the root owner bubble and shows in its tree', async () => {
    const { conductorList, sidebar } = await setupSidebar();
    await render(sidebar, {
      projects: CONDUCTOR_PROJECTS,
      instances: [
        conductor('A'), conductor('B'),
        worker('n1', 'A', 'proj'),
        worker('n2', 'A', 'proj', 'wt', { callerInstanceId: 'inst-n1' }),
        worker('wb1', 'B', 'other'),
      ],
    });
    await select(sidebar, 'inst-n2');
    assert.ok(isOpen(conductorList, 'A'), 'the root conductor bubble is open');
    assert.ok(rowOf(treeOf(conductorList, 'A'), 'n2').classList.contains('active'), 'the nested worker row is highlighted');
    assert.ok(!isOpen(conductorList, 'B'), 'the unrelated conductor stays collapsed');
  });

  await t.test('a worker of a conductor that is not live opens the Inactive group and the bubble inside it', async () => {
    const { conductorList, sidebar } = await setupSidebar();
    await render(sidebar, {
      projects: CONDUCTOR_PROJECTS,
      instances: [
        conductor('A', { status: 'exited' }), conductor('B', { status: 'exited' }), conductor('L'),
        worker('n2', 'A', 'proj', 'wt'),
      ],
    });
    assert.equal(inactiveGroup(conductorList).open, false, 'fixture: Inactive starts collapsed');
    await select(sidebar, 'inst-n2');
    assert.equal(inactiveGroup(conductorList).open, true, 'the Inactive group is open');
    assert.ok(isOpen(conductorList, 'A'), 'the dead conductor bubble inside it is open');
    assert.ok(rowOf(treeOf(conductorList, 'A'), 'n2').classList.contains('active'), 'the row is highlighted');
    assert.ok(!isOpen(conductorList, 'B'), 'the other dead conductor stays collapsed');
    assert.ok(!isOpen(conductorList, 'L'), 'the live conductor stays collapsed');
  });

  await t.test('selecting a live conductor opens no bubble, its own included', async () => {
    const { conductorList, sidebar } = await setupSidebar();
    await render(sidebar, {
      projects: CONDUCTOR_PROJECTS,
      instances: [conductor('A'), conductor('B'), worker('wa1', 'A', 'proj')],
    });
    await select(sidebar, 'inst-A');
    assert.equal(sidebar.expandedConductors.size, 0, 'nothing is recorded as expanded');
    assert.ok(!isOpen(conductorList, 'A') && !isOpen(conductorList, 'B'), 'no bubble opens');
    assertNull(treeOf(conductorList, 'A'), 'the selected conductor builds no tree');
    assert.ok(conductorOf(conductorList, 'A').querySelector('.conductor-row').classList.contains('active'), 'its row is highlighted');
  });

  await t.test('selecting a conductor that is not live opens only the Inactive group', async () => {
    const { conductorList, sidebar } = await setupSidebar();
    await render(sidebar, {
      projects: CONDUCTOR_PROJECTS,
      instances: [conductor('A', { status: 'crashed' }), conductor('B', { status: 'exited' })],
    });
    await select(sidebar, 'inst-A');
    assert.equal(inactiveGroup(conductorList).open, true, 'the Inactive group is open');
    assert.equal(sidebar.expandedConductors.size, 0, 'but no bubble is');
    assert.ok(conductorOf(conductorList, 'A').querySelector('.conductor-row').classList.contains('active'), 'the row is highlighted');
  });

  await t.test('the reveal fires once per selection: a manual collapse survives re-renders, a new selection re-opens', async () => {
    const { conductorList, sidebar } = await setupSidebar();
    const instances = [conductor('A'), conductor('B'), worker('wa1', 'A', 'proj'), worker('wb1', 'B', 'other')];
    await render(sidebar, { projects: CONDUCTOR_PROJECTS, instances });
    await select(sidebar, 'inst-wa1');
    assert.ok(isOpen(conductorList, 'A'), 'fixture: revealed');
    caretOf(conductorList, 'A').click();
    assert.ok(!isOpen(conductorList, 'A'), 'the user collapses it');
    sidebar.setInstances(instances.map(i => ({ ...i })));
    await tick();
    assert.ok(!isOpen(conductorList, 'A'), 'a re-render does not re-open it');
    await select(sidebar, 'inst-wa1');
    assert.ok(isOpen(conductorList, 'A'), 'selecting the session again does');
  });

  await t.test('a hand-spawned session and a null selection open nothing', async () => {
    const { conductorList, sidebar } = await setupSidebar();
    await render(sidebar, {
      projects: CONDUCTOR_PROJECTS,
      instances: [conductor('A'), conductor('B'), worker('wa1', 'A', 'proj'), hand('h1', 'other')],
    });
    await select(sidebar, 'inst-h1');
    assert.equal(sidebar.expandedConductors.size, 0, 'a hand-spawned session has no bubble');
    assert.ok(!isOpen(conductorList, 'A') && !isOpen(conductorList, 'B'));
    await select(sidebar, null);
    assert.equal(sidebar.expandedConductors.size, 0, 'a null selection reveals nothing');
    assert.ok(!isOpen(conductorList, 'A') && !isOpen(conductorList, 'B'));
  });
});

const WS_PROJECTS = () => [
  project('p', { workspace: 'W', worktrees: ['wt', 'wt2'] }),
  project('q', { workspace: 'X', worktrees: ['wtx'] }),
  project('loose'),
];

test('Projects lens', async (t) => {
  await t.test('every collapsed group on the path opens, and only that path', async () => {
    const { root, sidebar } = await setupSidebar({
      onLoadSessions: async (name, wt) => (name === 'p' && wt === 'wt'
        ? [{ sessionId: 'disk1', firstPrompt: 'on disk', lastActivity: 5, size: 1 }] : []),
    });
    // The user's own collapse of the worktree Sessions subnodes, in the store
    // before the nodes exist: they are built closed and load nothing.
    sidebar.collapsedSessions.add('p:wt');
    sidebar.collapsedSessions.add('p:wt2');
    await render(sidebar, {
      projects: WS_PROJECTS(), workspaces: ['W', 'X'],
      instances: [
        conductor('A'),
        worker('w1', 'A', 'p', 'wt'), worker('w2', 'A', 'p', 'wt2'), worker('wx', 'A', 'q', 'wtx'),
      ],
    });
    const sessionsOf = (key) => [...root.querySelectorAll('details.sessions-group')].find(d => d._key === key);
    const groupOf = (name) => [...root.querySelectorAll('.project-name')].find(n => n.textContent === name)
      .closest('li').querySelector('details.worktree-group');
    assert.equal(workspaceDet(root, 'W').open, false, 'fixture: workspace W starts collapsed');
    assert.equal(sessionsOf('p:wt').open, false, 'fixture: the worktree Sessions subnode starts collapsed');
    assertNull(rowOf(root, 'disk1'), 'fixture: nothing is loaded yet');
    await select(sidebar, 'inst-w1');
    assert.equal(workspaceDet(root, 'W').open, true, 'the workspace is open');
    assert.equal(groupOf('p').open, true, 'the Worktrees group is open');
    assert.equal(sessionsOf('p:wt').open, true, 'the worktree Sessions subnode is open');
    assert.ok(rowOf(root, 'w1').classList.contains('active'), 'the row exists and is highlighted');
    assert.ok(rowOf(root, 'disk1'), 'the list lazy-loaded on open');
    assert.equal(sessionsOf('p:wt2').open, false, 'the sibling worktree\'s subnode stays collapsed');
    assert.equal(workspaceDet(root, 'X').open, false, 'the other workspace stays collapsed');
    assert.equal(groupOf('q').open, false, 'the other project\'s Worktrees group stays collapsed');
  });

  await t.test('a collapsed main-checkout Sessions subnode is re-opened on its reused node and its list loads', async () => {
    const loaded = [];
    const { root, sidebar } = await setupSidebar({
      onLoadSessions: async (name) => { loaded.push(name); return []; },
    });
    sidebar.collapsedSessions.add('loose');
    sidebar.collapsedSessions.add('quiet');
    await render(sidebar, {
      projects: [project('loose'), project('quiet')],
      instances: [hand('h1', 'loose'), hand('h2', 'quiet')],
    });
    const det = sessionsDetOf(root, 'loose');
    const quiet = sessionsDetOf(root, 'quiet');
    assert.equal(det.open, false, 'fixture: built collapsed');
    assert.deepEqual(loaded, [], 'fixture: nothing loaded');
    await select(sidebar, 'inst-h1');
    assert.ok(sessionsDetOf(root, 'loose') === det, 'the same node is reused');
    assert.equal(det.open, true, 'the subnode is open');
    assert.deepEqual(loaded, ['loose'], 'only its list loaded');
    assert.ok(rowOf(det, 'h1').classList.contains('active'), 'the row is highlighted');
    assert.equal(quiet.open, false, 'the other project\'s subnode stays collapsed');
  });

  await t.test('the workspace expansion is written to localStorage by the reveal itself, like a click', async () => {
    const { root, sidebar, window } = await setupSidebar();
    await render(sidebar, {
      projects: WS_PROJECTS(), workspaces: ['W', 'X'],
      instances: [worker('w1', 'A', 'p', 'wt')],
    });
    sidebar.setActive('inst-w1');
    // Read before any task runs: no toggle listener has fired yet.
    const stored = JSON.parse(window.localStorage.getItem('code-conductor:workspaces-expanded'));
    assert.deepEqual(stored, ['W'], 'only the revealed workspace is persisted');
    await tick();
    assert.equal(workspaceDet(root, 'W').open, true);
  });

  await t.test('a Worktrees group revealed under an owner filter stays open once the filter clears', async () => {
    const { root, select: filterSelect, sidebar } = await setupSidebar();
    await render(sidebar, {
      projects: WS_PROJECTS(), workspaces: ['W', 'X'],
      instances: [conductor('A'), worker('w1', 'A', 'p', 'wt'), worker('wx', 'A', 'q', 'wtx')],
    });
    await choose(filterSelect, 'A');
    await select(sidebar, 'inst-w1');
    assert.ok(sidebar.expandedWorktrees.has('p'), 'the reveal recorded the expansion the filter listener skips');
    assert.ok(!sidebar.expandedWorktrees.has('q'), 'only the revealed project');
    await choose(filterSelect, '');
    const groupOf = (name) => [...root.querySelectorAll('.project-name')].find(n => n.textContent === name)
      .closest('li').querySelector('details.worktree-group');
    assert.equal(groupOf('p').open, true, 'still open under All');
    assert.equal(groupOf('q').open, false, 'the unrevealed project is back to collapsed');
  });
});

test('Projects-lens filter', async (t) => {
  const PROJECTS = [project('alpha'), project('beta'), project('gamma')];
  const INSTANCES = () => [
    conductor('A'), conductor('B'),
    worker('a1', 'A', 'alpha'), worker('b1', 'B', 'beta'),
    hand('h1', 'gamma'),
    worker('dead', 'A', 'alpha', null, { status: 'exited', ownerSessionId: null }),
  ];
  const setup = async (filter) => {
    const ctx = await setupSidebar();
    await render(ctx.sidebar, { projects: PROJECTS, instances: INSTANCES() });
    if (filter !== '') await choose(ctx.select, filter);
    return ctx;
  };

  await t.test('owner filter A, selecting B\'s worker switches the filter to B and lists the row', async () => {
    const { root, select: filterSelect, sidebar } = await setup('A');
    await select(sidebar, 'inst-b1');
    assert.equal(sidebar.filter, 'B');
    assert.equal(filterSelect.value, 'B');
    assert.ok(rowOf(root, 'b1').classList.contains('active'), 'the row is listed and highlighted');
  });

  await t.test('Hand-spawned only, selecting a conducted worker switches the filter to its owner', async () => {
    const { root, select: filterSelect, sidebar } = await setup('hand');
    await select(sidebar, 'inst-a1');
    assert.equal(sidebar.filter, 'A');
    assert.equal(filterSelect.value, 'A');
    assert.ok(rowOf(root, 'a1').classList.contains('active'));
  });

  await t.test('owner filter, selecting a hand-spawned session switches the filter to Hand-spawned only', async () => {
    const { root, select: filterSelect, sidebar } = await setup('A');
    await select(sidebar, 'inst-h1');
    assert.equal(sidebar.filter, 'hand');
    assert.equal(filterSelect.value, 'hand');
    assert.ok(rowOf(root, 'h1').classList.contains('active'));
  });

  await t.test('owner filter, selecting a dead conducted session (no owner reported) falls back to All', async () => {
    const { root, select: filterSelect, sidebar } = await setup('B');
    await select(sidebar, 'inst-dead');
    assert.equal(sidebar.filter, '');
    assert.equal(filterSelect.value, '');
    assert.ok(rowOf(root, 'dead').classList.contains('active'));
  });

  await t.test('a filter that already shows the row is left alone', async () => {
    const all = await setup('');
    await select(all.sidebar, 'inst-a1');
    assert.equal(all.sidebar.filter, '', 'All stays All');
    const own = await setup('A');
    await select(own.sidebar, 'inst-a1');
    assert.equal(own.sidebar.filter, 'A', 'the matching owner stays selected');
    const handOnly = await setup('hand');
    await select(handOnly.sidebar, 'inst-h1');
    assert.equal(handOnly.sidebar.filter, 'hand', 'Hand-spawned only stays for a hand-spawned session');
  });

  await t.test('selecting a conductor leaves the filter and the Projects groups unchanged', async () => {
    const { root, select: filterSelect, sidebar } = await setup('A');
    const open = () => [...root.querySelectorAll('details')].map(d => d.open);
    const before = open();
    await select(sidebar, 'inst-B');
    assert.equal(sidebar.filter, 'A');
    assert.equal(filterSelect.value, 'A');
    assert.deepEqual(open(), before, 'no Projects group changed');
    assert.equal(sidebar.collapsedSessions.size, 0);
  });
});
