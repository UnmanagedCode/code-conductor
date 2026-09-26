// The sidebar's Conductors lens (#conductor-list): one block per conductor, live
// ones first, the rest under a collapsed Inactive group, each expandable into a
// read-only tree of that conductor's live workers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNull } from './dom-assert.mjs';
import { setupSidebar, tick, project, conductor, worker, hand, rowOf, wtHead } from './sidebar-fixture.mjs';

const conductorOf = (list, sid) => list.querySelector(`[data-key="conductor:${sid}"]`);
const titles = (root) => [...root.querySelectorAll(':scope > li.conductor-block .conductor-title')].map(t => t.textContent);

async function render(sidebar, { projects = [], instances = [], conductRows = [] } = {}) {
  sidebar.setProjects(projects);
  sidebar.setConductSessions(conductRows);
  sidebar.setInstances(instances);
  await tick();
}

test('conductor rows list live conductors, titled with first-prompt fallback', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    instances: [
      conductor('A', { title: 'Alpha conductor', createdAt: 3000 }),
      conductor('B', { firstPrompt: 'fix   the\nthing', createdAt: 2000 }),
    ],
  });
  const a = conductorOf(conductorList, 'A').querySelector('.conductor-title');
  const b = conductorOf(conductorList, 'B').querySelector('.conductor-title');
  assert.equal(a.textContent, 'Alpha conductor');
  assert.equal(a.classList.contains('untitled'), false, 'a set title is not flagged untitled');
  assert.equal(b.textContent, 'fix the thing');
  assert.equal(b.classList.contains('untitled'), true, 'the first-prompt fallback is flagged untitled');
});

test('grey project chips: one per project with a live owned worker; "no live workers" when none', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: [project('zeta'), project('alpha', { worktrees: ['wt1'] })],
    instances: [
      conductor('A'), conductor('B'),
      worker('w1', 'A', 'zeta'), worker('w2', 'A', 'alpha', 'wt1'), worker('w3', 'A', 'zeta'),
      worker('dead', 'A', 'other', null, { status: 'exited', ownerSessionId: null }),
    ],
  });
  const chipsA = [...conductorOf(conductorList, 'A').querySelectorAll('.conductor-chip')].map(c => c.textContent);
  assert.deepEqual(chipsA, ['alpha', 'zeta'], 'sorted, distinct, live-owned only');
  const chipsB = [...conductorOf(conductorList, 'B').querySelectorAll('.conductor-chip')];
  assert.equal(chipsB.length, 1);
  assert.ok(chipsB[0].classList.contains('conductor-chip-none'));
  assert.equal(chipsB[0].textContent, 'no live workers');
});

const TREE_FIXTURE = {
  projects: [project('proj', { worktrees: ['wt-b', 'wt-a'] })],
  instances: [
    conductor('A'), conductor('B'),
    worker('wa1', 'A', 'proj', 'wt-a', { createdAt: 10 }),
    worker('wa2', 'A', 'proj', 'wt-a', { createdAt: 20 }),
    worker('wb', 'A', 'proj', 'wt-b'),
    worker('wd', 'A', 'proj'),
    worker('other', 'B', 'proj', 'wt-a'),
    hand('h', 'proj', 'wt-a'),
  ],
};

test('a conductor is collapsed by default; the caret expands a read-only tree in order project row → main-checkout workers → worktree row → workers', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, TREE_FIXTURE);
  const m = conductorOf(conductorList, 'A');
  assertNull(m.querySelector('.conductor-tree'), 'collapsed by default');
  assert.equal(m.querySelector('.conductor-caret').getAttribute('aria-expanded'), 'false');
  m.querySelector('.conductor-caret').click();
  const tree = m.querySelector('.conductor-tree');
  assert.ok(tree, 'caret expands the tree');
  assert.equal(m.querySelector('.conductor-caret').getAttribute('aria-expanded'), 'true');
  const projLi = tree.querySelector(':scope > li');
  const kids = [...projLi.children].map(c => c.className);
  assert.deepEqual(kids, ['project-row', 'sessions-list conductor-direct', 'worktree-list']);
  assert.ok(rowOf(projLi.querySelector('.conductor-direct'), 'wd'), 'the main-checkout worker sits under the project row');
  const wtNames = [...tree.querySelectorAll('.worktree-name')].map(n => n.textContent);
  assert.deepEqual(wtNames, ['wt-a', 'wt-b'], 'worktrees sorted by name');
  const wtA = wtHead(tree, 'wt-a').closest('.worktree-item');
  assert.deepEqual([...wtA.querySelectorAll('.session-row')].map(r => r.title.split('\n')[0]), ['wa2', 'wa1'],
    'workers newest first under their worktree row');
  for (const sel of ['.add-instance', '.delete-project', '.wt-spawn', '.wt-remove', '.session-delete', '.session-promote']) {
    assertNull(tree.querySelector(sel), `no ${sel} inside a conductor tree`);
  }
  assert.ok(tree.querySelector('.commit-log'), '≡ commit log stays');
  assert.ok(tree.querySelector('.wt-review'), '± review stays');
});

test('the tree shows only this conductor\'s workers', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, TREE_FIXTURE);
  conductorOf(conductorList, 'A').querySelector('.conductor-caret').click();
  const tree = conductorOf(conductorList, 'A').querySelector('.conductor-tree');
  assertNull(rowOf(tree, 'other'), 'another conductor\'s worker in the same worktree is absent');
  assertNull(rowOf(tree, 'h'), 'a hand-spawned session is absent');
  assert.ok(rowOf(tree, 'wa1'));
});

test('expansion survives setInstances', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, TREE_FIXTURE);
  const m = conductorOf(conductorList, 'A');
  m.querySelector('.conductor-caret').click();
  sidebar.setInstances([...TREE_FIXTURE.instances, worker('new', 'A', 'proj')]);
  await tick();
  assert.equal(conductorOf(conductorList, 'A'), m, 'same conductor node');
  assert.ok(m.classList.contains('open'));
  assert.ok(rowOf(m.querySelector('.conductor-tree'), 'new'), 'and the tree took the new worker');
});

test('worker rows show playbook · stage verbatim; an unbound worker has no .session-stage element', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: [project('proj')],
    instances: [
      conductor('A'),
      worker('bound', 'A', 'proj', null, { playbook: 'triage-lab', stage: 'write-it-up ✎' }),
      worker('free', 'A', 'proj'),
    ],
  });
  conductorOf(conductorList, 'A').querySelector('.conductor-caret').click();
  const bound = rowOf(conductorList, 'bound');
  assert.equal(bound.querySelector('.session-label-col > .session-stage').textContent, 'triage-lab · write-it-up ✎');
  assert.ok(bound.querySelector('.session-label-col > .session-preview'), 'the label sits above it in the same column');
  assertNull(rowOf(conductorList, 'free').querySelector('.session-stage'), 'an unbound worker renders no stage element');
});

test('a stage change re-renders in place', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  const base = [conductor('A')];
  await render(sidebar, { projects: [project('proj')], instances: [...base, worker('w', 'A', 'proj', null, { playbook: 'forge', stage: 'plan' })] });
  conductorOf(conductorList, 'A').querySelector('.conductor-caret').click();
  const before = rowOf(conductorList, 'w');
  sidebar.setInstances([...base, worker('w', 'A', 'proj', null, { playbook: 'forge', stage: 'implement' })]);
  await tick();
  const after = rowOf(conductorList, 'w');
  assert.equal(after, before, 'same row node');
  assert.equal(after.querySelector('.session-stage').textContent, 'forge · implement');
});

test('Inactive (n) is a collapsed <details> after the live conductors, listing them newest first', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    conductRows: [
      { sessionId: 'old', title: 'Old', lastActivity: 100 },
      { sessionId: 'mid', title: 'Mid', lastActivity: 500 },
    ],
    instances: [conductor('L', { title: 'Live' }), conductor('X', { title: 'Exited', status: 'exited', createdAt: 300 })],
  });
  const kids = [...conductorList.children].map(c => c.dataset.key);
  assert.deepEqual(kids, ['conductor:L', 'inactive']);
  const det = conductorList.querySelector('.conductor-inactive-item > details.conductor-inactive');
  assert.equal(det.open, false, 'collapsed by default');
  assert.equal(det.querySelector('summary').textContent, 'Inactive (3)');
  assert.deepEqual(titles(det.querySelector('.conductor-inactive-list')), ['Mid', 'Exited', 'Old']);
});

test('an archived conduct row renders in no Conductors group', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    conductRows: [
      { sessionId: 'T', title: 'Temp one', archived: true, lastActivity: 5 },
      { sessionId: 'D', title: 'Kept', lastActivity: 1 },
    ],
    instances: [conductor('L', { title: 'Live' })],
  });
  assertNull(conductorOf(conductorList, 'T'), 'the archived conductor is in no group');
  const det = conductorList.querySelector('.conductor-inactive');
  assert.equal(det.querySelector('summary').textContent, 'Inactive (1)');
  assert.deepEqual(titles(det.querySelector('.conductor-inactive-list')), ['Kept']);
});

test('only archived conductors: no Inactive group, the empty state', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, { conductRows: [{ sessionId: 'T', archived: true, lastActivity: 5 }] });
  assertNull(conductorList.querySelector('.conductor-inactive'), 'no Inactive group');
  const empty = conductorList.querySelector('.conductor-empty');
  assert.ok(empty, 'the empty-state row is rendered');
  assert.equal(empty.textContent, 'no conductors yet — tap 🎼 Conduct');
});

// The group is dropped when every conductor goes live and rebuilt when one
// stops; the user's open/closed choice must survive that rebuild.
test('the Inactive group keeps the user\'s open or closed choice across its removal and re-creation', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, { conductRows: [{ sessionId: 'D', lastActivity: 1 }], instances: [conductor('L')] });
  const group = () => conductorList.querySelector('details.conductor-inactive');
  const setOpen = async (det, open) => {
    det.open = open;
    det.dispatchEvent(new det.ownerDocument.defaultView.Event('toggle'));
    await tick();
  };
  const rebuild = async () => {
    const before = group();
    sidebar.setInstances([conductor('L'), conductor('D')]);
    await tick();
    assertNull(group(), 'every conductor live: the group is removed');
    sidebar.setInstances([conductor('L')]);
    await tick();
    assert.ok(group(), 'D stopped: the group is back');
    assert.notEqual(group(), before, 'the <details> is re-created, not reused');
  };
  await setOpen(group(), true);
  await rebuild();
  assert.equal(group().open, true, 'opened by the user: re-created open');
  await setOpen(group(), false);
  await rebuild();
  assert.equal(group().open, false, 'closed by the user: re-created closed');
});

test('no Inactive group when every conductor is live', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, { instances: [conductor('A'), conductor('B')] });
  assertNull(conductorList.querySelector('.conductor-inactive'), 'no Inactive group');
});

test('row click selects a live conductor and resumes an inactive one in .conduct; a caret click does neither', async () => {
  const { conductorList, sidebar, calls } = await setupSidebar();
  await render(sidebar, {
    conductRows: [{ sessionId: 'D', lastActivity: 1 }],
    instances: [conductor('A'), conductor('X', { status: 'crashed' })],
  });
  conductorOf(conductorList, 'A').querySelector('.conductor-row').click();
  assert.deepEqual(calls.select, ['inst-A']);
  conductorOf(conductorList, 'D').querySelector('.conductor-row').click();
  assert.deepEqual(calls.resume, [{ projectName: '.conduct', worktreeName: null, sessionId: 'D' }]);
  conductorOf(conductorList, 'X').querySelector('.conductor-row').click();
  assert.deepEqual(calls.select, ['inst-A', 'inst-X'], 'a dead conductor keeps its instanceId and opens like any dead session');
  conductorOf(conductorList, 'A').querySelector('.conductor-caret').click();
  assert.equal(calls.select.length, 2, 'caret click selects nothing');
  assert.equal(calls.resume.length, 1, 'caret click resumes nothing');
});

test('the conductor block carries --owner-color equal to conductorColor(sid); an inactive conductor has .inactive', async () => {
  const { conductorList, sidebar, conductorColor } = await setupSidebar();
  await render(sidebar, { conductRows: [{ sessionId: 'D', lastActivity: 1 }], instances: [conductor('A')] });
  const a = conductorOf(conductorList, 'A');
  assert.equal(a.style.getPropertyValue('--owner-color'), conductorColor('A'));
  assert.equal(a.classList.contains('inactive'), false);
  const d = conductorOf(conductorList, 'D');
  assert.equal(d.style.getPropertyValue('--owner-color'), conductorColor('D'));
  assert.ok(d.classList.contains('inactive'));
});

test('rows inside a conductor tree carry no .owned bar', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, TREE_FIXTURE);
  conductorOf(conductorList, 'A').querySelector('.conductor-caret').click();
  const tree = conductorOf(conductorList, 'A').querySelector('.conductor-tree');
  assert.ok(tree.querySelectorAll('.session-row').length > 0, 'fixture renders worker rows');
  assert.equal(tree.querySelectorAll('.owned').length, 0);
});

test('conductor-row dot keeps the running / awaiting-wake / idle semantics', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    instances: [
      conductor('W', { status: 'idle', awaitingWake: true }),
      conductor('R', { status: 'turn' }),
      conductor('I', { status: 'idle' }),
    ],
  });
  const dot = (sid) => conductorOf(conductorList, sid).querySelector('.conductor-row > .dot');
  assert.equal(dot('W').className, 'dot idle awaiting');
  assert.equal(dot('W').title, 'idle — waiting on a worker');
  assert.equal(dot('R').className, 'dot turn');
  assert.equal(dot('I').className, 'dot idle');
});

test('setActive marks the conductor row and the worker row .active', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, TREE_FIXTURE);
  conductorOf(conductorList, 'A').querySelector('.conductor-caret').click();
  sidebar.setActive('inst-A');
  assert.ok(conductorOf(conductorList, 'A').querySelector('.conductor-row').classList.contains('active'));
  assert.equal(conductorOf(conductorList, 'B').querySelector('.conductor-row').classList.contains('active'), false);
  sidebar.setActive('inst-wa1');
  assert.equal(conductorOf(conductorList, 'A').querySelector('.conductor-row').classList.contains('active'), false);
  assert.ok(rowOf(conductorList, 'wa1').classList.contains('active'));
});

test('empty state with no conductors', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, { projects: [project('proj')], instances: [hand('h', 'proj')] });
  assert.equal(conductorList.children.length, 1);
  assert.equal(conductorList.firstElementChild.textContent, 'no conductors yet — tap 🎼 Conduct');
});

test('tickAgo refreshes conductor-row ago labels', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, { instances: [conductor('A', { createdAt: Date.now() - 5 * 60_000 })] });
  const ago = conductorOf(conductorList, 'A').querySelector('.conductor-row .session-ago');
  assert.equal(ago.textContent, '5m ago');
  ago.dataset.activity = String(Date.now() - 2 * 3600_000);
  sidebar.tickAgo();
  assert.equal(ago.textContent, '2h ago');
});

test('a live conductor-row dot gains the waiting-on-you ring over its fill; an inactive conductor is never ringed', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    conductRows: [{ sessionId: 'D', lastActivity: 1, awaitingUser: 'question', awaitingUserSource: 'tool' }],
    instances: [
      conductor('I', { status: 'idle', awaitingUser: 'plan', awaitingUserSource: 'tool' }),
      conductor('T', { status: 'turn', awaitingUser: 'question', awaitingUserSource: 'text' }),
      conductor('W', { status: 'idle', awaitingWake: true, awaitingUser: 'question', awaitingUserSource: 'tool' }),
      conductor('X', { status: 'exited', awaitingUser: 'question', awaitingUserSource: 'tool' }),
    ],
  });
  const dot = (sid) => conductorOf(conductorList, sid).querySelector('.conductor-row > .dot');
  assert.equal(dot('I').className, 'dot idle needs-you');
  assert.equal(dot('I').title, 'waiting on you (plan approval) · idle');
  assert.equal(dot('T').className, 'dot turn needs-you');
  assert.equal(dot('T').title, 'waiting on you (asked in text) · running');
  assert.equal(dot('W').className, 'dot idle awaiting needs-you');
  assert.equal(dot('W').title, 'waiting on you (question) · on a worker');
  assert.equal(dot('D').className, 'dot offline', 'a disk-only conductor is offline and unringed');
  assert.equal(dot('X').className, 'dot exited', 'an exited instance is unringed');
});

test('every conductor row, live and inactive, ends in a × archive button; the worker tree has none', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: [project('proj')],
    conductRows: [{ sessionId: 'D', lastActivity: 1 }],
    instances: [conductor('A'), worker('w', 'A', 'proj')],
  });
  sidebar.setUnread(new Map([['A', 2]]));
  await tick();
  for (const sid of ['A', 'D']) {
    const row = conductorOf(conductorList, sid).querySelector('.conductor-row');
    const x = row.querySelector(':scope > .session-delete');
    assert.ok(x, `${sid}: the row has a × button`);
    assert.equal(row.lastElementChild, x, `${sid}: the × is the row's last child`);
    assert.equal(x.tagName, 'BUTTON');
    assert.equal(x.textContent, '×');
    assert.equal(x.title, 'archive session (keeps history)');
  }
  assert.ok(conductorOf(conductorList, 'A').querySelector('.conductor-row > .session-unread'), 'the unread pill still renders, before the ×');
  conductorOf(conductorList, 'A').querySelector('.conductor-caret').click();
  await tick();
  const tree = conductorOf(conductorList, 'A').querySelector('.conductor-tree');
  assert.ok(tree, 'the tree is expanded');
  assert.ok(rowOf(tree, 'w'), 'the worker row is rendered');
  assertNull(tree.querySelector('.session-delete'), 'no × inside the worker tree');
});

test('× archives through onDeleteSession with the conductor\'s id and never selects or resumes', async (t) => {
  const click = async ({ conductRows = [], instances }, sid) => {
    const { conductorList, sidebar, calls } = await setupSidebar();
    await render(sidebar, { conductRows, instances });
    conductorOf(conductorList, sid).querySelector('.conductor-row > .session-delete').click();
    assert.deepEqual(calls.select, [], 'the × selects nothing');
    assert.deepEqual(calls.resume, [], 'the × resumes nothing');
    return calls.delete;
  };
  await t.test('a live conductor with no transcript listed goes the synthetic path', async () => {
    assert.deepEqual(await click({ instances: [conductor('A', { title: 'Alpha' })] }, 'A'), [
      { projectName: '.conduct', worktreeName: null, sessionId: 'A', preview: 'Alpha', synthetic: true },
    ]);
  });
  await t.test('an inactive disk-only conductor archives its transcript', async () => {
    assert.deepEqual(await click({ conductRows: [{ sessionId: 'D', title: 'Disk', lastActivity: 1 }], instances: [] }, 'D'), [
      { projectName: '.conduct', worktreeName: null, sessionId: 'D', preview: 'Disk', synthetic: false },
    ]);
  });
  await t.test('a live conductor with a disk row archives its transcript', async () => {
    assert.deepEqual(await click({
      conductRows: [{ sessionId: 'B', lastActivity: 1 }],
      instances: [conductor('B', { firstPrompt: 'plan the work' })],
    }, 'B'), [
      { projectName: '.conduct', worktreeName: null, sessionId: 'B', preview: 'plan the work', synthetic: false },
    ]);
  });
});

test('the × reads the freshest conductor after a re-render', async () => {
  const { conductorList, sidebar, calls } = await setupSidebar();
  await render(sidebar, { instances: [conductor('A')] });
  const before = conductorOf(conductorList, 'A').querySelector('.conductor-row > .session-delete');
  sidebar.setConductSessions([{ sessionId: 'A', lastActivity: 1 }]);
  sidebar.setInstances([conductor('A', { title: 'Renamed' })]);
  await tick();
  const after = conductorOf(conductorList, 'A').querySelector('.conductor-row > .session-delete');
  assert.equal(after, before, 'the button is reused, not rebuilt');
  after.click();
  assert.deepEqual(calls.delete, [
    { projectName: '.conduct', worktreeName: null, sessionId: 'A', preview: 'Renamed', synthetic: false },
  ]);
});

test('archiving the only conductor leaves the empty state', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, { instances: [conductor('A')] });
  assert.ok(conductorOf(conductorList, 'A'));
  sidebar.setInstances([]);
  sidebar.setConductSessions([]);
  await tick();
  assertNull(conductorList.querySelector('.conductor-block'), 'no conductor block remains');
  const empty = conductorList.querySelector('.conductor-empty');
  assert.ok(empty, 'the empty-state row is rendered');
  assert.equal(empty.textContent, 'no conductors yet — tap 🎼 Conduct');
});
