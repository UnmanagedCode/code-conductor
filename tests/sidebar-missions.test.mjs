// The sidebar's Missions lens (#mission-list): one block per conductor, live
// ones first, the rest under a collapsed Inactive group, each expandable into a
// read-only tree of that conductor's live workers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNull } from './dom-assert.mjs';
import { setupSidebar, tick, project, conductor, worker, hand, rowOf, wtHead } from './sidebar-fixture.mjs';

const missionOf = (list, sid) => list.querySelector(`[data-key="mission:${sid}"]`);
const titles = (root) => [...root.querySelectorAll(':scope > li.mission .mission-title')].map(t => t.textContent);

async function render(sidebar, { projects = [], instances = [], conductRows = [] } = {}) {
  sidebar.setProjects(projects);
  sidebar.setConductSessions(conductRows);
  sidebar.setInstances(instances);
  await tick();
}

test('mission rows list live conductors, titled with first-prompt fallback', async () => {
  const { missionList, sidebar } = await setupSidebar();
  await render(sidebar, {
    instances: [
      conductor('A', { title: 'Alpha mission', createdAt: 3000 }),
      conductor('B', { firstPrompt: 'fix   the\nthing', createdAt: 2000 }),
    ],
  });
  const a = missionOf(missionList, 'A').querySelector('.mission-title');
  const b = missionOf(missionList, 'B').querySelector('.mission-title');
  assert.equal(a.textContent, 'Alpha mission');
  assert.equal(a.classList.contains('untitled'), false, 'a set title is not flagged untitled');
  assert.equal(b.textContent, 'fix the thing');
  assert.equal(b.classList.contains('untitled'), true, 'the first-prompt fallback is flagged untitled');
});

test('grey project chips: one per project with a live owned worker; "no live workers" when none', async () => {
  const { missionList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: [project('zeta'), project('alpha', { worktrees: ['wt1'] })],
    instances: [
      conductor('A'), conductor('B'),
      worker('w1', 'A', 'zeta'), worker('w2', 'A', 'alpha', 'wt1'), worker('w3', 'A', 'zeta'),
      worker('dead', 'A', 'other', null, { status: 'exited', ownerSessionId: null }),
    ],
  });
  const chipsA = [...missionOf(missionList, 'A').querySelectorAll('.mission-chip')].map(c => c.textContent);
  assert.deepEqual(chipsA, ['alpha', 'zeta'], 'sorted, distinct, live-owned only');
  const chipsB = [...missionOf(missionList, 'B').querySelectorAll('.mission-chip')];
  assert.equal(chipsB.length, 1);
  assert.ok(chipsB[0].classList.contains('mission-chip-none'));
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

test('a mission is collapsed by default; the caret expands a read-only tree in order project row → main-checkout workers → worktree row → workers', async () => {
  const { missionList, sidebar } = await setupSidebar();
  await render(sidebar, TREE_FIXTURE);
  const m = missionOf(missionList, 'A');
  assertNull(m.querySelector('.mission-tree'), 'collapsed by default');
  assert.equal(m.querySelector('.mission-caret').getAttribute('aria-expanded'), 'false');
  m.querySelector('.mission-caret').click();
  const tree = m.querySelector('.mission-tree');
  assert.ok(tree, 'caret expands the tree');
  assert.equal(m.querySelector('.mission-caret').getAttribute('aria-expanded'), 'true');
  const projLi = tree.querySelector(':scope > li');
  const kids = [...projLi.children].map(c => c.className);
  assert.deepEqual(kids, ['project-row', 'sessions-list mission-direct', 'worktree-list']);
  assert.ok(rowOf(projLi.querySelector('.mission-direct'), 'wd'), 'the main-checkout worker sits under the project row');
  const wtNames = [...tree.querySelectorAll('.worktree-name')].map(n => n.textContent);
  assert.deepEqual(wtNames, ['wt-a', 'wt-b'], 'worktrees sorted by name');
  const wtA = wtHead(tree, 'wt-a').closest('.worktree-item');
  assert.deepEqual([...wtA.querySelectorAll('.session-row')].map(r => r.title.split('\n')[0]), ['wa2', 'wa1'],
    'workers newest first under their worktree row');
  for (const sel of ['.add-instance', '.delete-project', '.wt-spawn', '.wt-remove', '.session-delete', '.session-promote']) {
    assertNull(tree.querySelector(sel), `no ${sel} inside a mission tree`);
  }
  assert.ok(tree.querySelector('.commit-log'), '≡ commit log stays');
  assert.ok(tree.querySelector('.wt-review'), '± review stays');
});

test('the tree shows only this conductor\'s workers', async () => {
  const { missionList, sidebar } = await setupSidebar();
  await render(sidebar, TREE_FIXTURE);
  missionOf(missionList, 'A').querySelector('.mission-caret').click();
  const tree = missionOf(missionList, 'A').querySelector('.mission-tree');
  assertNull(rowOf(tree, 'other'), 'another conductor\'s worker in the same worktree is absent');
  assertNull(rowOf(tree, 'h'), 'a hand-spawned session is absent');
  assert.ok(rowOf(tree, 'wa1'));
});

test('expansion survives setInstances', async () => {
  const { missionList, sidebar } = await setupSidebar();
  await render(sidebar, TREE_FIXTURE);
  const m = missionOf(missionList, 'A');
  m.querySelector('.mission-caret').click();
  sidebar.setInstances([...TREE_FIXTURE.instances, worker('new', 'A', 'proj')]);
  await tick();
  assert.equal(missionOf(missionList, 'A'), m, 'same mission node');
  assert.ok(m.classList.contains('open'));
  assert.ok(rowOf(m.querySelector('.mission-tree'), 'new'), 'and the tree took the new worker');
});

test('worker rows show playbook · stage verbatim; an unbound worker has no .session-stage element', async () => {
  const { missionList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: [project('proj')],
    instances: [
      conductor('A'),
      worker('bound', 'A', 'proj', null, { playbook: 'triage-lab', stage: 'write-it-up ✎' }),
      worker('free', 'A', 'proj'),
    ],
  });
  missionOf(missionList, 'A').querySelector('.mission-caret').click();
  const bound = rowOf(missionList, 'bound');
  assert.equal(bound.querySelector('.session-label-col > .session-stage').textContent, 'triage-lab · write-it-up ✎');
  assert.ok(bound.querySelector('.session-label-col > .session-preview'), 'the label sits above it in the same column');
  assertNull(rowOf(missionList, 'free').querySelector('.session-stage'), 'an unbound worker renders no stage element');
});

test('a stage change re-renders in place', async () => {
  const { missionList, sidebar } = await setupSidebar();
  const base = [conductor('A')];
  await render(sidebar, { projects: [project('proj')], instances: [...base, worker('w', 'A', 'proj', null, { playbook: 'forge', stage: 'plan' })] });
  missionOf(missionList, 'A').querySelector('.mission-caret').click();
  const before = rowOf(missionList, 'w');
  sidebar.setInstances([...base, worker('w', 'A', 'proj', null, { playbook: 'forge', stage: 'implement' })]);
  await tick();
  const after = rowOf(missionList, 'w');
  assert.equal(after, before, 'same row node');
  assert.equal(after.querySelector('.session-stage').textContent, 'forge · implement');
});

test('Inactive (n) is a collapsed <details> after the live missions, listing them newest first', async () => {
  const { missionList, sidebar } = await setupSidebar();
  await render(sidebar, {
    conductRows: [
      { sessionId: 'old', title: 'Old', lastActivity: 100 },
      { sessionId: 'mid', title: 'Mid', lastActivity: 500 },
    ],
    instances: [conductor('L', { title: 'Live' }), conductor('X', { title: 'Exited', status: 'exited', createdAt: 300 })],
  });
  const kids = [...missionList.children].map(c => c.dataset.key);
  assert.deepEqual(kids, ['mission:L', 'inactive']);
  const det = missionList.querySelector('.mission-inactive-item > details.mission-inactive');
  assert.equal(det.open, false, 'collapsed by default');
  assert.equal(det.querySelector('summary').textContent, 'Inactive (3)');
  assert.deepEqual(titles(det.querySelector('.mission-inactive-list')), ['Mid', 'Exited', 'Old']);
});

test('an archived conduct row renders in no Missions group', async () => {
  const { missionList, sidebar } = await setupSidebar();
  await render(sidebar, {
    conductRows: [
      { sessionId: 'T', title: 'Temp one', archived: true, lastActivity: 5 },
      { sessionId: 'D', title: 'Kept', lastActivity: 1 },
    ],
    instances: [conductor('L', { title: 'Live' })],
  });
  assertNull(missionOf(missionList, 'T'), 'the archived conductor is in no group');
  const det = missionList.querySelector('.mission-inactive');
  assert.equal(det.querySelector('summary').textContent, 'Inactive (1)');
  assert.deepEqual(titles(det.querySelector('.mission-inactive-list')), ['Kept']);
});

test('only archived conductors: no Inactive group, the empty state', async () => {
  const { missionList, sidebar } = await setupSidebar();
  await render(sidebar, { conductRows: [{ sessionId: 'T', archived: true, lastActivity: 5 }] });
  assertNull(missionList.querySelector('.mission-inactive'), 'no Inactive group');
  const empty = missionList.querySelector('.mission-empty');
  assert.ok(empty, 'the empty-state row is rendered');
  assert.equal(empty.textContent, 'no conductors yet — tap 🎼 Conduct');
});

test('no Inactive group when every conductor is live', async () => {
  const { missionList, sidebar } = await setupSidebar();
  await render(sidebar, { instances: [conductor('A'), conductor('B')] });
  assertNull(missionList.querySelector('.mission-inactive'), 'no Inactive group');
});

test('row click selects a live conductor and resumes an inactive one in .conduct; a caret click does neither', async () => {
  const { missionList, sidebar, calls } = await setupSidebar();
  await render(sidebar, {
    conductRows: [{ sessionId: 'D', lastActivity: 1 }],
    instances: [conductor('A'), conductor('X', { status: 'crashed' })],
  });
  missionOf(missionList, 'A').querySelector('.mission-row').click();
  assert.deepEqual(calls.select, ['inst-A']);
  missionOf(missionList, 'D').querySelector('.mission-row').click();
  assert.deepEqual(calls.resume, [{ projectName: '.conduct', worktreeName: null, sessionId: 'D' }]);
  missionOf(missionList, 'X').querySelector('.mission-row').click();
  assert.deepEqual(calls.select, ['inst-A', 'inst-X'], 'a dead conductor keeps its instanceId and opens like any dead session');
  missionOf(missionList, 'A').querySelector('.mission-caret').click();
  assert.equal(calls.select.length, 2, 'caret click selects nothing');
  assert.equal(calls.resume.length, 1, 'caret click resumes nothing');
});

test('the mission block carries --owner-color equal to conductorColor(sid); an inactive mission has .inactive', async () => {
  const { missionList, sidebar, conductorColor } = await setupSidebar();
  await render(sidebar, { conductRows: [{ sessionId: 'D', lastActivity: 1 }], instances: [conductor('A')] });
  const a = missionOf(missionList, 'A');
  assert.equal(a.style.getPropertyValue('--owner-color'), conductorColor('A'));
  assert.equal(a.classList.contains('inactive'), false);
  const d = missionOf(missionList, 'D');
  assert.equal(d.style.getPropertyValue('--owner-color'), conductorColor('D'));
  assert.ok(d.classList.contains('inactive'));
});

test('rows inside a mission tree carry no .owned bar', async () => {
  const { missionList, sidebar } = await setupSidebar();
  await render(sidebar, TREE_FIXTURE);
  missionOf(missionList, 'A').querySelector('.mission-caret').click();
  const tree = missionOf(missionList, 'A').querySelector('.mission-tree');
  assert.ok(tree.querySelectorAll('.session-row').length > 0, 'fixture renders worker rows');
  assert.equal(tree.querySelectorAll('.owned').length, 0);
});

test('mission-row dot keeps the running / awaiting-wake / idle semantics', async () => {
  const { missionList, sidebar } = await setupSidebar();
  await render(sidebar, {
    instances: [
      conductor('W', { status: 'idle', awaitingWake: true }),
      conductor('R', { status: 'turn' }),
      conductor('I', { status: 'idle' }),
    ],
  });
  const dot = (sid) => missionOf(missionList, sid).querySelector('.mission-row > .dot');
  assert.equal(dot('W').className, 'dot idle awaiting');
  assert.equal(dot('W').title, 'idle — waiting on a worker');
  assert.equal(dot('R').className, 'dot turn');
  assert.equal(dot('I').className, 'dot idle');
});

test('setActive marks the mission row and the worker row .active', async () => {
  const { missionList, sidebar } = await setupSidebar();
  await render(sidebar, TREE_FIXTURE);
  missionOf(missionList, 'A').querySelector('.mission-caret').click();
  sidebar.setActive('inst-A');
  assert.ok(missionOf(missionList, 'A').querySelector('.mission-row').classList.contains('active'));
  assert.equal(missionOf(missionList, 'B').querySelector('.mission-row').classList.contains('active'), false);
  sidebar.setActive('inst-wa1');
  assert.equal(missionOf(missionList, 'A').querySelector('.mission-row').classList.contains('active'), false);
  assert.ok(rowOf(missionList, 'wa1').classList.contains('active'));
});

test('empty state with no conductors', async () => {
  const { missionList, sidebar } = await setupSidebar();
  await render(sidebar, { projects: [project('proj')], instances: [hand('h', 'proj')] });
  assert.equal(missionList.children.length, 1);
  assert.equal(missionList.firstElementChild.textContent, 'no conductors yet — tap 🎼 Conduct');
});

test('tickAgo refreshes mission-row ago labels', async () => {
  const { missionList, sidebar } = await setupSidebar();
  await render(sidebar, { instances: [conductor('A', { createdAt: Date.now() - 5 * 60_000 })] });
  const ago = missionOf(missionList, 'A').querySelector('.mission-row .session-ago');
  assert.equal(ago.textContent, '5m ago');
  ago.dataset.activity = String(Date.now() - 2 * 3600_000);
  sidebar.tickAgo();
  assert.equal(ago.textContent, '2h ago');
});

test('a live mission-row dot gains the waiting-on-you ring over its fill; an inactive mission is never ringed', async () => {
  const { missionList, sidebar } = await setupSidebar();
  await render(sidebar, {
    conductRows: [{ sessionId: 'D', lastActivity: 1, awaitingUser: 'question', awaitingUserSource: 'tool' }],
    instances: [
      conductor('I', { status: 'idle', awaitingUser: 'plan', awaitingUserSource: 'tool' }),
      conductor('T', { status: 'turn', awaitingUser: 'question', awaitingUserSource: 'text' }),
      conductor('W', { status: 'idle', awaitingWake: true, awaitingUser: 'question', awaitingUserSource: 'tool' }),
      conductor('X', { status: 'exited', awaitingUser: 'question', awaitingUserSource: 'tool' }),
    ],
  });
  const dot = (sid) => missionOf(missionList, sid).querySelector('.mission-row > .dot');
  assert.equal(dot('I').className, 'dot idle needs-you');
  assert.equal(dot('I').title, 'waiting on you (plan approval) · idle');
  assert.equal(dot('T').className, 'dot turn needs-you');
  assert.equal(dot('T').title, 'waiting on you (asked in text) · running');
  assert.equal(dot('W').className, 'dot idle awaiting needs-you');
  assert.equal(dot('W').title, 'waiting on you (question) · on a worker');
  assert.equal(dot('D').className, 'dot offline', 'a disk-only mission is offline and unringed');
  assert.equal(dot('X').className, 'dot exited', 'an exited instance is unringed');
});
