// The sidebar's Conductors lens (#conductor-list): one block per conductor, live
// ones first, the rest under a collapsed Inactive group, each expandable into a
// tree of that conductor's chip projects and its live workers in them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertNull } from './dom-assert.mjs';
import { PUB, setupSidebar, tick, project, conductor, worker, hand, rowOf, wtHead } from './sidebar-fixture.mjs';

const { formatAutoResumeTime } = await import(pathToFileURL(path.join(PUB, 'usage.js')).href);
// The clock alone, as the existing formatter renders it.
const clockOf = (t) => formatAutoResumeTime(t).replace('resumes at ', '');

const conductorOf = (list, sid) => list.querySelector(`[data-key="conductor:${sid}"]`);
const conductorRowOf = (list, sid) => conductorOf(list, sid).querySelector('.conductor-row');
const titles = (root) => [...root.querySelectorAll(':scope > li.conductor-block .conductor-title')].map(t => t.textContent);

async function render(sidebar, { projects = [], instances = [], conductRows = [], spawns = {} } = {}) {
  sidebar.setProjects(projects);
  sidebar.setConductSessions(conductRows);
  sidebar.setConductorSpawns(spawns);
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

test('live project chips: one per project with a live owned worker; "no live workers" when a conductor has no live or recorded project', async () => {
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
  assert.ok([...conductorOf(conductorList, 'A').querySelectorAll('.conductor-chip')].every(c => c.classList.contains('live')),
    'every chip of A is live');
  const chipsB = [...conductorOf(conductorList, 'B').querySelectorAll('.conductor-chip')];
  assert.equal(chipsB.length, 1);
  assert.ok(chipsB[0].classList.contains('conductor-chip-none'));
  assert.equal(chipsB[0].textContent, 'no live workers');
});

const chipsOf = (list, sid) => [...conductorOf(list, sid).querySelectorAll('.conductor-chip')]
  .map(c => `${c.textContent}(${c.classList.contains('live') ? 'live' : c.classList.contains('idle') ? 'idle' : '?'})`);
const at = (m) => `2026-0${m}-01T00:00:00.000Z`;

test('idle chips follow the live chips, newest spawn first, and a project with a live worker is never also idle', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: ['alpha', 'zeta', 'older', 'newer'].map(n => project(n)),
    instances: [conductor('A'), worker('w1', 'A', 'zeta'), worker('w2', 'A', 'alpha')],
    spawns: { A: [
      { project: 'zeta', lastSpawnAt: at(5) },
      { project: 'newer', lastSpawnAt: at(3) },
      { project: 'older', lastSpawnAt: at(1) },
    ] },
  });
  assert.deepEqual(chipsOf(conductorList, 'A'), ['alpha(live)', 'zeta(live)', 'newer(idle)', 'older(idle)']);
});

test('an idle chip for a project that is no longer registered is not shown', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: [project('kept')],
    instances: [conductor('A')],
    spawns: { A: [{ project: 'removed', lastSpawnAt: at(2) }, { project: 'kept', lastSpawnAt: at(1) }] },
  });
  assert.deepEqual(chipsOf(conductorList, 'A'), ['kept(idle)']);
});

test('a conductor with only recorded projects shows idle chips and no "no live workers" chip', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: [project('p')],
    instances: [conductor('A')],
    spawns: { A: [{ project: 'p', lastSpawnAt: at(1) }] },
  });
  assertNull(conductorOf(conductorList, 'A').querySelector('.conductor-chip-none'));
  assert.deepEqual(chipsOf(conductorList, 'A'), ['p(idle)']);
});

test('a conductor whose recorded projects are all unregistered shows "no live workers"', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: [project('other')],
    instances: [conductor('A')],
    spawns: { A: [{ project: 'gone-1', lastSpawnAt: at(2) }, { project: 'gone-2', lastSpawnAt: at(1) }] },
  });
  const chips = [...conductorOf(conductorList, 'A').querySelectorAll('.conductor-chip')];
  assert.equal(chips.length, 1);
  assert.ok(chips[0].classList.contains('conductor-chip-none'));
  assert.equal(chips[0].textContent, 'no live workers');
});

test('an inactive conductor shows its recorded projects as idle chips', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: [project('p'), project('q')],
    conductRows: [{ sessionId: 'D', title: 'Done', lastActivity: 1 }],
    spawns: { D: [{ project: 'q', lastSpawnAt: at(2) }, { project: 'p', lastSpawnAt: at(1) }] },
  });
  const det = conductorList.querySelector('details.conductor-inactive');
  assert.ok(det.contains(conductorOf(conductorList, 'D')), 'D sits in the Inactive group');
  assert.deepEqual(chipsOf(conductorList, 'D'), ['q(idle)', 'p(idle)']);
});

test('a chip that goes live replaces its idle chip in place', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  const base = { projects: [project('p')], spawns: { A: [{ project: 'p', lastSpawnAt: at(1) }] } };
  await render(sidebar, { ...base, instances: [conductor('A')] });
  assert.deepEqual(chipsOf(conductorList, 'A'), ['p(idle)']);
  await render(sidebar, { ...base, instances: [conductor('A'), worker('w', 'A', 'p')] });
  assert.deepEqual(chipsOf(conductorList, 'A'), ['p(live)']);
});

test('setConductorSpawns re-renders the chips on its own', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, { projects: [project('p')], instances: [conductor('A')] });
  assert.deepEqual(chipsOf(conductorList, 'A'), ['no live workers(?)']);
  sidebar.setConductorSpawns({ A: [{ project: 'p', lastSpawnAt: at(1) }] });
  await tick();
  assert.deepEqual(chipsOf(conductorList, 'A'), ['p(idle)']);
});

const treeOf = (list, sid) => conductorOf(list, sid).querySelector('.conductor-tree');
const treeLi = (tree, name) => [...tree.querySelectorAll('.project-name')].find(n => n.textContent === name)?.closest('li') ?? null;
const kidClasses = (li) => [...li.children].map(c => c.className);

test('the expanded tree lists live projects then idle projects in chip order; an idle project with no surviving recorded worktree is its project row alone', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: [project('live-p'), project('idle-a', { worktrees: ['wt'] }), project('idle-b')],
    instances: [conductor('A'), worker('w', 'A', 'live-p')],
    spawns: { A: [{ project: 'idle-b', lastSpawnAt: at(1) }, { project: 'idle-a', lastSpawnAt: at(2) }] },
  });
  assert.deepEqual(chipsOf(conductorList, 'A'), ['live-p(live)', 'idle-a(idle)', 'idle-b(idle)'], 'fixture: the chip order');
  conductorOf(conductorList, 'A').querySelector('.conductor-caret').click();
  const tree = treeOf(conductorList, 'A');
  assert.ok(tree, 'the tree is expanded');
  assert.deepEqual([...tree.querySelectorAll('.project-name')].map(n => n.textContent), ['live-p', 'idle-a', 'idle-b'],
    'the tree names the chip projects, in chip order');
  for (const name of ['idle-a', 'idle-b']) {
    const li = treeLi(tree, name);
    assert.deepEqual(kidClasses(li), ['project-row'], `${name}: no session rows and no worktree list`);
    assert.equal(li.querySelectorAll('.session-row').length, 0);
    assertNull(li.querySelector('.add-instance'), `${name}: no + in the tree`);
    assertNull(li.querySelector('.delete-project'), `${name}: no × in the tree`);
  }
  assert.deepEqual(kidClasses(treeLi(tree, 'live-p')), ['project-row', 'sessions-list conductor-direct'], 'the live project keeps its subtree');
  assert.ok(rowOf(tree, 'w'), 'and its worker row');
});

test('an inactive conductor with only idle chips expands into its registered idle projects, with no session rows', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: [project('p'), project('q')],
    conductRows: [{ sessionId: 'D', title: 'Done', lastActivity: 1 }],
    spawns: { D: [
      { project: 'removed', lastSpawnAt: at(3) },
      { project: 'q', lastSpawnAt: at(2) },
      { project: 'p', lastSpawnAt: at(1) },
    ] },
  });
  const det = conductorList.querySelector('details.conductor-inactive');
  det.open = true;
  const d = conductorOf(conductorList, 'D');
  assert.ok(det.contains(d), 'fixture: D sits in the Inactive group');
  d.querySelector('.conductor-caret').click();
  const tree = treeOf(conductorList, 'D');
  assert.ok(tree, 'the tree is expanded');
  assert.deepEqual([...tree.querySelectorAll('.project-name')].map(n => n.textContent), ['q', 'p'],
    'the registered idle projects, newest spawn first; the unregistered one is absent');
  assert.equal(tree.querySelectorAll('.session-row').length, 0);
});

test('a tree project flipping idle → live gains its worker rows in place, and loses them when the worker exits', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: [project('p')],
    instances: [conductor('A')],
    spawns: { A: [{ project: 'p', lastSpawnAt: at(1) }] },
  });
  conductorOf(conductorList, 'A').querySelector('.conductor-caret').click();
  const li = treeLi(treeOf(conductorList, 'A'), 'p');
  assert.deepEqual(kidClasses(li), ['project-row'], 'fixture: p starts idle');
  sidebar.setInstances([conductor('A'), worker('w', 'A', 'p')]);
  await tick();
  const liveLi = treeLi(treeOf(conductorList, 'A'), 'p');
  assert.ok(liveLi === li, 'the same project item after going live');
  assert.deepEqual(kidClasses(li), ['project-row', 'sessions-list conductor-direct']);
  assert.ok(rowOf(li, 'w'), 'the worker row appears under it');
  sidebar.setInstances([conductor('A')]);
  await tick();
  const idleLi = treeLi(treeOf(conductorList, 'A'), 'p');
  assert.ok(idleLi === li, 'the same project item after going idle again');
  assert.deepEqual(kidClasses(li), ['project-row'], 'back to the project row alone');
});

const wtNamesOf = (root) => [...root.querySelectorAll('.worktree-name')].map(n => n.textContent);
const wtItem = (root, name) => wtHead(root, name)?.closest('.worktree-item') ?? null;
async function expand(conductorList, sid) {
  conductorOf(conductorList, sid).querySelector('.conductor-caret').click();
  await tick();
  return treeOf(conductorList, sid);
}

test('an idle project lists its recorded worktrees that still exist, sorted by name, as read-only heads with no session rows', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: [project('p', { worktrees: ['wt-z', 'wt-a', 'unrecorded'] })],
    instances: [conductor('A')],
    spawns: { A: [{ project: 'p', lastSpawnAt: at(1), worktrees: ['wt-z', 'deleted', 'wt-a'] }] },
  });
  const tree = await expand(conductorList, 'A');
  const li = treeLi(tree, 'p');
  assert.deepEqual(kidClasses(li), ['project-row', 'worktree-list']);
  assert.deepEqual(wtNamesOf(li), ['wt-a', 'wt-z'], 'only recorded names still listed, sorted; neither the deleted nor the unrecorded one');
  for (const name of ['wt-a', 'wt-z']) {
    const item = wtItem(li, name);
    assert.equal(item.className, 'worktree-item idle', `${name}: dimmed`);
    assert.deepEqual(kidClasses(item), ['worktree-row'], `${name}: the head alone`);
    assertNull(item.querySelector('.wt-spawn'), `${name}: no +`);
    assertNull(item.querySelector('.wt-remove'), `${name}: no ×`);
    assert.ok(item.querySelector('.commit-log'), `${name}: ≡ stays`);
    assert.ok(item.querySelector('.wt-review'), `${name}: ± stays`);
  }
  assert.equal(li.querySelectorAll('.session-row').length, 0);
});

test('an active project lists its live worktrees with their workers and its recorded-only worktrees without; a worktree with a live worker renders once', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: [project('p', { worktrees: ['wt-live', 'wt-old'] })],
    instances: [conductor('A'), worker('w', 'A', 'p', 'wt-live')],
    spawns: { A: [{ project: 'p', lastSpawnAt: at(1), worktrees: ['wt-live', 'wt-old'] }] },
  });
  const tree = await expand(conductorList, 'A');
  assert.deepEqual(wtNamesOf(tree), ['wt-live', 'wt-old'], 'each name once');
  const live = wtItem(tree, 'wt-live');
  assert.equal(live.className, 'worktree-item');
  assert.deepEqual(kidClasses(live), ['worktree-row', 'sessions-list']);
  assert.ok(rowOf(live, 'w'), 'the live worker under its worktree');
  const old = wtItem(tree, 'wt-old');
  assert.equal(old.className, 'worktree-item idle');
  assert.deepEqual(kidClasses(old), ['worktree-row'], 'no sessions list');
});

test('a recorded worktree going live gains its worker rows in the same item, and loses them (back to idle) when the worker exits', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: [project('p', { worktrees: ['wt'] })],
    instances: [conductor('A')],
    spawns: { A: [{ project: 'p', lastSpawnAt: at(1), worktrees: ['wt'] }] },
  });
  const item = wtItem(await expand(conductorList, 'A'), 'wt');
  const head = item.querySelector('.worktree-row');
  assert.equal(item.className, 'worktree-item idle', 'fixture: starts recorded-only');
  sidebar.setInstances([conductor('A'), worker('w', 'A', 'p', 'wt')]);
  await tick();
  assert.ok(wtItem(treeOf(conductorList, 'A'), 'wt') === item, 'the same item after going live');
  assert.ok(item.querySelector('.worktree-row') === head, 'the same head');
  assert.equal(item.className, 'worktree-item');
  assert.deepEqual(kidClasses(item), ['worktree-row', 'sessions-list']);
  assert.ok(rowOf(item, 'w'));
  sidebar.setInstances([conductor('A')]);
  await tick();
  assert.ok(wtItem(treeOf(conductorList, 'A'), 'wt') === item, 'the same item after the worker exits');
  assert.equal(item.className, 'worktree-item idle');
  assert.deepEqual(kidClasses(item), ['worktree-row']);
});

test('a recorded worktree dropped from the project\'s worktrees disappears from the tree; the project row stays', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: [project('p', { worktrees: ['wt'] })],
    instances: [conductor('A')],
    spawns: { A: [{ project: 'p', lastSpawnAt: at(1), worktrees: ['wt'] }] },
  });
  const tree = await expand(conductorList, 'A');
  assert.deepEqual(wtNamesOf(tree), ['wt'], 'fixture: listed while it exists');
  sidebar.setProjects([project('p')]);
  await tick();
  const li = treeLi(treeOf(conductorList, 'A'), 'p');
  assert.ok(li, 'the project row stays');
  assert.deepEqual(kidClasses(li), ['project-row']);
  assert.deepEqual(wtNamesOf(treeOf(conductorList, 'A')), []);
});

test('a recorded worktree with another conductor\'s live worker renders idle under this conductor, with no rows', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: [project('p', { worktrees: ['wt'] })],
    instances: [conductor('A'), conductor('B'), worker('bw', 'B', 'p', 'wt')],
    spawns: { A: [{ project: 'p', lastSpawnAt: at(1), worktrees: ['wt'] }] },
  });
  const tree = await expand(conductorList, 'A');
  const item = wtItem(tree, 'wt');
  assert.equal(item.className, 'worktree-item idle');
  assert.deepEqual(kidClasses(item), ['worktree-row']);
  assertNull(rowOf(tree, 'bw'), 'B\'s worker is not listed under A');
});

test('≡ and ± on a recorded-only worktree call onShowCommits / onReviewWorktree with (project, worktree)', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  const seen = [];
  sidebar.onShowCommits = (p, w) => seen.push(['commits', p, w]);
  sidebar.onReviewWorktree = (p, w) => seen.push(['review', p, w]);
  await render(sidebar, {
    projects: [project('p', { worktrees: ['wt'] })],
    instances: [conductor('A')],
    spawns: { A: [{ project: 'p', lastSpawnAt: at(1), worktrees: ['wt'] }] },
  });
  const item = wtItem(await expand(conductorList, 'A'), 'wt');
  item.querySelector('.commit-log').click();
  item.querySelector('.wt-review').click();
  assert.deepEqual(seen, [['commits', 'p', 'wt'], ['review', 'p', 'wt']]);
});

test('a recorded-only worktree matches the listed worktree by name: its head shows that worktree\'s current branch', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  const p = project('p', { worktrees: ['wt'] });
  p.worktrees[0].branch = 'cc/recreated';
  await render(sidebar, {
    projects: [p],
    instances: [conductor('A')],
    spawns: { A: [{ project: 'p', lastSpawnAt: at(1), worktrees: ['wt'] }] },
  });
  const name = wtHead(await expand(conductorList, 'A'), 'wt').querySelector('.worktree-name');
  assert.ok(name.title.startsWith('cc/recreated\n'), `the current meta's branch, got ${JSON.stringify(name.title)}`);
});

test('a live worktree row\'s head reads the listed worktree\'s meta, not the worker instance\'s copy', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  const p = project('p', { worktrees: ['wt'] });
  Object.assign(p.worktrees[0], { branch: 'cc/listed', baseSha: 'listedsha0000ffff', mergeStatus: { ahead: 2, behind: 0 } });
  await render(sidebar, {
    projects: [p],
    instances: [conductor('A'), worker('w', 'A', 'p', 'wt', {
      worktree: { worktreeName: 'wt', branch: 'cc/instance', baseBranch: 'dev', baseSha: 'instsha00000000', mergeStatus: { ahead: 9, behind: 9 } },
    })],
  });
  const item = wtItem(await expand(conductorList, 'A'), 'wt');
  assert.equal(item.className, 'worktree-item', 'fixture: the row is live');
  assert.ok(rowOf(item, 'w'), 'fixture: with its worker');
  const head = item.querySelector('.worktree-row');
  assert.equal(head.querySelector('.worktree-name').title, 'cc/listed\nfrom main @ listedsha000');
  assert.equal(head.querySelector('.worktree-base').textContent, '← main');
  assert.equal(head.querySelector('.wt-unmerged')?.textContent, '↑2', 'the listed merge pill');
  assert.ok(!/9/.test(head.querySelector('.wt-unmerged').textContent), 'not the instance copy\'s ↑9 ↓9');
});

test('project chips are display-only: neither kind is a button, and clicking either fires no callback', async () => {
  const { conductorList, sidebar, calls } = await setupSidebar();
  await render(sidebar, {
    projects: [project('p'), project('q')],
    instances: [conductor('A'), worker('w', 'A', 'p')],
    spawns: { A: [{ project: 'q', lastSpawnAt: at(1) }] },
  });
  const chips = [...conductorOf(conductorList, 'A').querySelectorAll('.conductor-chip')];
  assert.deepEqual(chips.map(c => c.className), ['conductor-chip live', 'conductor-chip idle']);
  for (const c of chips) {
    assert.equal(c.tagName, 'SPAN');
    assert.equal(c.hasAttribute('tabindex'), false);
    c.click();
  }
  await tick();
  assert.deepEqual(calls, { select: [], selectOpts: [], resume: [], create: [], close: [], promote: [] });
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

test('a conductor is collapsed by default; the caret expands a tree with no structural actions in order project row → main-checkout workers → worktree row → workers', async () => {
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
  for (const sel of ['.add-instance', '.delete-project', '.wt-spawn', '.wt-remove', '.session-delete']) {
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

test('clicking a live conductor row selects with a user gesture', async () => {
  const { conductorList, sidebar, calls } = await setupSidebar();
  await render(sidebar, { instances: [conductor('A')] });
  conductorOf(conductorList, 'A').querySelector('.conductor-row').click();
  assert.deepEqual(calls.selectOpts, [{ userGesture: true }]);
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

// Invariant: a live conductor row carries no × (it closes from the strip); an inactive row ends in the archive ×; the worker tree has none.
test('a live conductor row has no ×; an inactive conductor row ends in an archive ×; the worker tree has none', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: [project('proj')],
    conductRows: [{ sessionId: 'D', lastActivity: 1, turnEndSeq: 2 }],
    instances: [conductor('A', { turnEndSeq: 2 }), worker('w', 'A', 'proj'), conductor('X', { status: 'exited' })],
  });
  const liveRow = conductorRowOf(conductorList, 'A');
  assertNull(liveRow.querySelector('.session-delete'), 'a live conductor row has no ×');
  assert.ok(liveRow.querySelector(':scope > .session-unread'), 'the unread pill still renders on the live row');
  for (const sid of ['D', 'X']) {
    const row = conductorRowOf(conductorList, sid);
    const x = row.querySelector(':scope > .session-delete');
    assert.ok(x, `${sid}: the inactive row has a × button`);
    assert.equal(row.lastElementChild.dataset.key, 'delete', `${sid}: the × is the row's last child`);
    assert.ok(row.lastElementChild === x, `${sid}: the last child is the × button`);
    assert.equal(x.tagName, 'BUTTON');
    assert.equal(x.textContent, '×');
    assert.equal(x.title, 'Archive session (keeps history)');
    assert.equal(x.getAttribute('aria-label'), 'Archive session (keeps history)');
  }
  assert.ok(conductorRowOf(conductorList, 'D').querySelector(':scope > .session-unread'), 'the unread pill still renders, before the ×');
  conductorOf(conductorList, 'A').querySelector('.conductor-caret').click();
  await tick();
  const tree = conductorOf(conductorList, 'A').querySelector('.conductor-tree');
  assert.ok(tree, 'the tree is expanded');
  assert.ok(rowOf(tree, 'w'), 'the worker row is rendered');
  assertNull(tree.querySelector('.session-delete'), 'no × inside the worker tree');
});

// Invariant: an inactive conductor's × calls onCloseSession with the full close payload and never selects or resumes.
test('× on an inactive conductor closes through onCloseSession with the conductor\'s facts and never selects or resumes', async (t) => {
  const click = async ({ conductRows = [], instances }, sid) => {
    const { conductorList, sidebar, calls } = await setupSidebar();
    await render(sidebar, { conductRows, instances });
    conductorRowOf(conductorList, sid).querySelector(':scope > .session-delete').click();
    assert.deepEqual(calls.select, [], 'the × selects nothing');
    assert.deepEqual(calls.resume, [], 'the × resumes nothing');
    return calls.close;
  };
  await t.test('an inactive disk-only conductor archives its transcript', async () => {
    assert.deepEqual(await click({ conductRows: [{ sessionId: 'D', title: 'Disk', lastActivity: 1 }], instances: [] }, 'D'), [
      { projectName: '.conduct', worktreeName: null, sessionId: 'D', instanceId: null, status: null, temp: false, preview: 'Disk', synthetic: false },
    ]);
  });
  await t.test('an exited conductor with no transcript listed goes the synthetic path', async () => {
    assert.deepEqual(await click({ instances: [conductor('A', { title: 'Alpha', status: 'exited' })] }, 'A'), [
      { projectName: '.conduct', worktreeName: null, sessionId: 'A', instanceId: 'inst-A', status: 'exited', temp: true, preview: 'Alpha', synthetic: true },
    ]);
  });
  await t.test('an exited conductor with a disk row archives its transcript', async () => {
    assert.deepEqual(await click({
      conductRows: [{ sessionId: 'B', lastActivity: 1 }],
      instances: [conductor('B', { firstPrompt: 'plan the work', status: 'crashed', temp: false })],
    }, 'B'), [
      { projectName: '.conduct', worktreeName: null, sessionId: 'B', instanceId: 'inst-B', status: 'crashed', temp: false, preview: 'plan the work', synthetic: false },
    ]);
  });
});

// Invariant: an inactive conductor's × reuses its button across renders and reads the freshest conductor at click time.
test('the × reads the freshest conductor after a re-render', async () => {
  const { conductorList, sidebar, calls } = await setupSidebar();
  await render(sidebar, { conductRows: [{ sessionId: 'A', lastActivity: 1 }], instances: [] });
  const before = conductorRowOf(conductorList, 'A').querySelector(':scope > .session-delete');
  sidebar.setConductSessions([{ sessionId: 'A', title: 'Renamed', lastActivity: 1 }]);
  await tick();
  const after = conductorRowOf(conductorList, 'A').querySelector(':scope > .session-delete');
  assert.ok(after === before, 'the button is reused, not rebuilt');
  after.click();
  assert.deepEqual(calls.close.map(c => [c.sessionId, c.preview]), [['A', 'Renamed']]);
});

// Invariant: when the last live conductor dies its row moves to Inactive and gains the ×, and closing it (after the refresh empties the list) leaves the empty state.
test('a conductor that dies gains the × under Inactive; applying the archive refresh leaves the empty state', async () => {
  const { conductorList, sidebar, calls } = await setupSidebar();
  await render(sidebar, { instances: [conductor('A', { title: 'Alpha' })] });
  assertNull(conductorRowOf(conductorList, 'A').querySelector('.session-delete'), 'no × while live');
  sidebar.setInstances([conductor('A', { title: 'Alpha', status: 'exited' })]);
  await tick();
  conductorRowOf(conductorList, 'A').querySelector(':scope > .session-delete').click();
  assert.deepEqual(calls.close.map(d => d.sessionId), ['A'], 'onCloseSession fired for the only conductor');
  // What the archive's refreshProjects/refreshInstances deliver once it is done.
  sidebar.setInstances([]);
  sidebar.setConductSessions([]);
  await tick();
  assertNull(conductorList.querySelector('.conductor-block'), 'no conductor block remains');
  const empty = conductorList.querySelector('.conductor-empty');
  assert.ok(empty, 'the empty-state row is rendered');
  assert.equal(empty.textContent, 'no conductors yet — tap 🎼 Conduct');
});

// Top-level rules of a stylesheet as { selectors, decls }; at-rule blocks
// (@media etc.) are skipped, so a match is one that applies unconditionally.
function topLevelRules(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let depth = 0, start = 0, head = '';
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) { head = css.slice(start, i).trim(); start = i + 1; }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        if (!head.startsWith('@')) {
          const decls = new Map();
          for (const d of css.slice(start, i).split(';')) {
            const c = d.indexOf(':');
            if (c > 0) decls.set(d.slice(0, c).trim(), d.slice(c + 1).trim());
          }
          rules.push({ selectors: head.split(',').map(x => x.trim().replace(/\s+/g, ' ')), decls });
        }
        start = i + 1;
      }
    }
  }
  return rules;
}

test('styles.css: a recorded-only worktree row in the conductor tree is dimmed (a top-level rule for .conductor-tree .worktree-item.idle > .worktree-row sets opacity .7)', async () => {
  const rules = topLevelRules(await fs.readFile(path.join(PUB, 'styles.css'), 'utf8'));
  assert.ok(rules.some(r => r.selectors.includes('.conductor-chip.idle') && r.decls.get('opacity') === '.7'),
    'sanity: the parser finds the idle chip dimming');
  const dim = rules.filter(r => r.selectors.includes('.conductor-tree .worktree-item.idle > .worktree-row'));
  assert.ok(dim.length > 0, 'a rule selects .conductor-tree .worktree-item.idle > .worktree-row');
  assert.ok(dim.some(r => r.decls.get('opacity') === '.7'),
    `that rule sets opacity: .7 (found: ${JSON.stringify(dim.map(r => r.decls.get('opacity') ?? null))})`);
});

test('styles.css: hovering a conductor row reveals its × (a top-level rule for .conductor-row:hover .session-delete sets opacity 1)', async () => {
  const rules = topLevelRules(await fs.readFile(path.join(PUB, 'styles.css'), 'utf8'));
  assert.ok(rules.some(r => r.selectors.includes('.session-row:hover .session-delete') && r.decls.get('opacity') === '1'),
    'sanity: the parser finds the session-row hover reveal');
  const hover = rules.filter(r => r.selectors.includes('.conductor-row:hover .session-delete'));
  assert.ok(hover.length > 0, 'a rule selects .conductor-row:hover .session-delete');
  assert.ok(hover.some(r => r.decls.get('opacity') === '1'),
    `that rule sets opacity: 1 (found: ${JSON.stringify(hover.map(r => r.decls.get('opacity') ?? null))})`);
});

// Invariant: hovering a strip entry reveals its × (the .strip-list > li:hover rule sets opacity 1).
test('styles.css: hovering a strip entry reveals its × (a top-level rule for .strip-list > li:hover .session-delete sets opacity 1)', async () => {
  const rules = topLevelRules(await fs.readFile(path.join(PUB, 'styles.css'), 'utf8'));
  const hover = rules.filter(r => r.selectors.includes('.strip-list > li:hover .session-delete'));
  assert.ok(hover.length > 0, 'a rule selects .strip-list > li:hover .session-delete');
  assert.ok(hover.some(r => r.decls.get('opacity') === '1'),
    `that rule sets opacity: 1 (found: ${JSON.stringify(hover.map(r => r.decls.get('opacity') ?? null))})`);
});

// Invariant: the strip × (the entry's sibling) is drawn inside the entry's box, and that box spans the full row.
test('styles.css: the strip × is drawn inside its entry\'s full-row box (out of flow in a positioned li, over right padding the entry reserves)', async (t) => {
  const rules = topLevelRules(await fs.readFile(path.join(PUB, 'styles.css'), 'utf8'));
  const of = (sel) => rules.filter(r => r.selectors.includes(sel));
  const any = (sel, prop, want) => of(sel).some(r => r.decls.get(prop) === want);
  const px = (sel, prop) => {
    const v = of(sel).map(r => r.decls.get(prop)).find(d => /^-?[\d.]+px$/.test(d ?? ''));
    return v === undefined ? NaN : parseFloat(v);
  };
  const closeSel = '.strip-list > li > .session-delete';

  // Invariant: the li is the × 's containing block.
  await t.test('li is the containing block', () => {
    assert.ok(any('.strip-list > li', 'position', 'relative'), 'a rule for .strip-list > li sets position: relative');
  });

  // Invariant: the × leaves the flex row and is pinned to the right edge at full row height.
  await t.test('the × is out of flow at the right edge', () => {
    assert.ok(any(closeSel, 'position', 'absolute'), `${closeSel} sets position: absolute`);
    assert.ok(any(closeSel, 'top', '0'), `${closeSel} sets top: 0`);
    assert.ok(any(closeSel, 'bottom', '0'), `${closeSel} sets bottom: 0`);
    assert.ok(Number.isFinite(px(closeSel, 'right')), `${closeSel} sets a px right`);
    assert.ok(Number.isFinite(px(closeSel, 'width')), `${closeSel} sets a px width`);
  });

  // Invariant: the entry is the li's only in-flow item and grows, so its box is the whole row.
  await t.test('the entry fills the row', () => {
    assert.ok(any('.strip-entry', 'flex', '1 1 auto'), '.strip-entry sets flex: 1 1 auto');
    for (const r of of('.strip-list > li')) {
      for (const p of ['gap', 'padding', 'padding-right'])
        assert.ok(!r.decls.has(p), `.strip-list > li sets no ${p} (it would shrink the entry's box)`);
    }
  });

  // Invariant: the entry's right padding is at least the × 's right offset plus its width, so the title stops before the ×.
  await t.test('the entry reserves the × \'s width', () => {
    const pad = of('.strip-entry').map(r => r.decls.get('padding')).find(Boolean);
    assert.ok(pad, '.strip-entry sets a padding shorthand');
    const v = pad.split(/\s+/);
    const right = parseFloat(v.length === 1 ? v[0] : v[1]);
    const need = px(closeSel, 'right') + px(closeSel, 'width');
    assert.ok(right >= need, `right padding ${right}px >= × right + width ${need}px`);
  });

  // Invariant: the hover fill follows the li, so it holds while the pointer is on the ×.
  await t.test('hover fill survives the pointer on the ×', () => {
    assert.ok(any('.strip-list > li:hover > .strip-entry:not(:disabled)', 'background', 'var(--panel-2)'),
      'a rule for .strip-list > li:hover > .strip-entry:not(:disabled) sets background: var(--panel-2)');
    assert.equal(of('.strip-entry:hover:not(:disabled)').length, 0,
      'no rule still fills on the entry button\'s own :hover');
  });

  // Invariant: the global button:hover fill must not paint a rectangle on the × inside the entry's rounded, outlined box.
  await t.test('the × keeps a transparent background on hover', () => {
    assert.ok(any(`${closeSel}:hover:not(:disabled)`, 'background', 'transparent'),
      `a rule for ${closeSel}:hover:not(:disabled) sets background: transparent`);
  });
});

const expandA = (conductorList) => {
  conductorOf(conductorList, 'A').querySelector('.conductor-caret').click();
  return conductorOf(conductorList, 'A').querySelector('.conductor-tree');
};

test('a live temp worker row ends in the ↑ promote button; a non-temp worker has none', async (t) => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: [project('proj', { worktrees: ['wt1'] })],
    instances: [
      conductor('A'),
      worker('t', 'A', 'proj', null, { temp: true }),
      worker('tw', 'A', 'proj', 'wt1', { temp: true }),
      worker('n', 'A', 'proj'),
    ],
  });
  const tree = expandA(conductorList);
  for (const sid of ['t', 'tw']) {
    await t.test(`temp worker ${sid}`, () => {
      const row = rowOf(tree, sid);
      assert.ok(row, 'the worker row renders');
      const ups = row.querySelectorAll('.session-promote');
      assert.equal(ups.length, 1, 'exactly one ↑');
      const btn = ups[0];
      assert.equal(btn.tagName, 'BUTTON');
      assert.equal(btn.textContent, '↑');
      assert.equal(btn.title, 'Make persistent');
      assert.equal(btn.getAttribute('aria-label'), 'Make persistent');
      assert.ok(row.lastElementChild === btn, 'the ↑ is the row\'s last child');
      assert.equal(btn.dataset.key, 'promote');
      assertNull(row.querySelector('.session-delete'), 'no × beside it');
    });
  }
  await t.test('non-temp worker', () => {
    const row = rowOf(tree, 'n');
    assert.ok(row, 'the worker row renders');
    assertNull(row.querySelector('.session-promote'), 'no ↑ on a non-temp worker');
    assertNull(row.querySelector('.session-delete'), 'and no ×');
  });
});

test('an exited or crashed temp worker has no ↑', async (t) => {
  for (const status of ['exited', 'crashed']) {
    await t.test(status, async () => {
      const { conductorList, sidebar } = await setupSidebar();
      await render(sidebar, {
        projects: [project('proj')],
        instances: [conductor('A'), worker('x', 'A', 'proj', null, { temp: true, status })],
      });
      const row = rowOf(expandA(conductorList), 'x');
      assert.ok(row, 'the dead worker still has a row in the tree');
      assertNull(row.querySelector('.session-promote'), `no ↑ on a ${status} temp worker`);
    });
  }
});

test('↑ promotes through onPromoteSession with the worker\'s instance id and never selects or resumes', async (t) => {
  for (const wt of [null, 'wt1']) {
    await t.test(wt ? 'in a worktree' : 'in the main checkout', async () => {
      const { conductorList, sidebar, calls } = await setupSidebar();
      await render(sidebar, {
        projects: [project('proj', { worktrees: ['wt1'] })],
        instances: [conductor('A'), worker('t', 'A', 'proj', wt, { temp: true, firstPrompt: 'do the work' })],
      });
      rowOf(expandA(conductorList), 't').querySelector('.session-promote').click();
      assert.deepEqual(calls.promote, [{ projectName: 'proj', instanceId: 'inst-t', preview: 'do the work' }]);
      assert.deepEqual(calls.select, [], 'the click does not select the worker');
      assert.deepEqual(calls.resume, [], 'nor resume it');
    });
  }
});

test('↑ reads the freshest instance after a re-render', async () => {
  const { conductorList, sidebar, calls } = await setupSidebar();
  await render(sidebar, {
    projects: [project('proj')],
    instances: [conductor('A'), worker('t', 'A', 'proj', null, { temp: true })],
  });
  const tree = expandA(conductorList);
  const before = rowOf(tree, 't').querySelector('.session-promote');
  sidebar.setInstances([conductor('A'), worker('t', 'A', 'proj', null, { temp: true, id: 'inst-t2' })]);
  await tick();
  const after = rowOf(tree, 't').querySelector('.session-promote');
  assert.ok(after === before, 'the button is reused, not rebuilt');
  after.click();
  assert.equal(calls.promote.length, 1);
  assert.equal(calls.promote[0].instanceId, 'inst-t2');
});

test('promoting drops the ↑ in place; the worker stays in the tree', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: [project('proj')],
    instances: [conductor('A'), worker('t', 'A', 'proj', null, { temp: true })],
  });
  const tree = expandA(conductorList);
  const row = rowOf(tree, 't');
  assert.ok(row.querySelector('.session-promote'), 'sanity: ↑ before the promote');
  assert.ok(row.classList.contains('temp'));
  sidebar.setInstances([conductor('A'), worker('t', 'A', 'proj', null, { temp: false })]);
  await tick();
  const after = rowOf(conductorOf(conductorList, 'A').querySelector('.conductor-tree'), 't');
  assert.ok(after === row, 'the same row node stays under the conductor tree');
  assertNull(after.querySelector('.session-promote'), 'the ↑ is gone');
  assert.ok(!after.classList.contains('temp'), 'the live temp:false is authoritative');
});

test('a worker dying drops the ↑ in place', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    projects: [project('proj')],
    instances: [conductor('A'), worker('t', 'A', 'proj', null, { temp: true })],
  });
  const tree = expandA(conductorList);
  const row = rowOf(tree, 't');
  assert.ok(row.querySelector('.session-promote'), 'sanity: ↑ while idle');
  sidebar.setInstances([conductor('A'), worker('t', 'A', 'proj', null, { temp: true, status: 'exited' })]);
  await tick();
  const after = rowOf(conductorOf(conductorList, 'A').querySelector('.conductor-tree'), 't');
  assert.ok(after === row, 'the same row node');
  assertNull(after.querySelector('.session-promote'), 'the ↑ is gone once the worker exits');
});

// Invariant: a live temp conductor row's ↑ is its last child (no × on a live row), after the unread pill when there is one.
test('a live temp conductor row ends in the ↑ Make persistent button', async (t) => {
  const check = (row) => {
    const ups = row.querySelectorAll(':scope > .session-promote');
    assert.equal(ups.length, 1, 'exactly one ↑');
    const btn = ups[0];
    assert.equal(btn.tagName, 'BUTTON');
    assert.equal(btn.textContent, '↑');
    assert.equal(btn.title, 'Make persistent');
    assert.equal(btn.getAttribute('aria-label'), 'Make persistent');
    assert.equal(btn.dataset.key, 'promote');
    assert.ok(row.lastElementChild === btn, 'the ↑ is the row\'s last child');
    assertNull(row.querySelector('.session-delete'), 'no × on a live row');
    return btn;
  };
  await t.test('without an unread pill', async () => {
    const { conductorList, sidebar } = await setupSidebar();
    await render(sidebar, { instances: [conductor('A')] });
    check(conductorRowOf(conductorList, 'A'));
  });
  await t.test('with an unread pill: unread → ↑', async () => {
    const { conductorList, sidebar } = await setupSidebar();
    await render(sidebar, { instances: [conductor('A', { turnEndSeq: 3 })] });
    const btn = check(conductorRowOf(conductorList, 'A'));
    assert.equal(btn.previousElementSibling.dataset.key, 'unread', 'the unread pill precedes the ↑');
  });
});

test('no ↑ on a non-temp, dead or disk-only conductor row; only the not-live ones carry the ×', async (t) => {
  const none = async ({ conductRows = [], instances = [] }, sid, hasClose) => {
    const { conductorList, sidebar } = await setupSidebar();
    await render(sidebar, { conductRows, instances });
    const row = conductorRowOf(conductorList, sid);
    assert.ok(row, 'the conductor row renders');
    assertNull(row.querySelector('.session-promote'), 'no ↑');
    assert.equal(!!row.querySelector(':scope > .session-delete'), hasClose, hasClose ? 'the × is there' : 'no × on a live row');
  };
  await t.test('a live non-temp conductor', () => none({ instances: [conductor('A', { temp: false })] }, 'A', false));
  for (const status of ['exited', 'crashed']) {
    await t.test(`an ${status} temp conductor`, () => none({ instances: [conductor('A', { status })] }, 'A', true));
  }
  await t.test('a disk-only conductor', () => none({ conductRows: [{ sessionId: 'D', lastActivity: 1 }] }, 'D', true));
});

test('↑ promotes through onPromoteSession with the conductor\'s instance id and never selects or resumes', async (t) => {
  await t.test('a titled conductor', async () => {
    const { conductorList, sidebar, calls } = await setupSidebar();
    await render(sidebar, { instances: [conductor('A', { title: 'Alpha' })] });
    conductorRowOf(conductorList, 'A').querySelector('.session-promote').click();
    await tick();
    assert.deepEqual(calls.promote, [{ projectName: '.conduct', instanceId: 'inst-A', preview: 'Alpha' }]);
    assert.deepEqual(calls.select, [], 'the click does not select the conductor');
    assert.deepEqual(calls.resume, [], 'nor resume it');
  });
  await t.test('an untitled conductor sends its rendered first-prompt label', async () => {
    const { conductorList, sidebar, calls } = await setupSidebar();
    await render(sidebar, { instances: [conductor('A', { firstPrompt: 'plan   the\nwork' })] });
    const row = conductorRowOf(conductorList, 'A');
    assert.equal(row.querySelector('.conductor-title').textContent, 'plan the work', 'the row renders the first-prompt fallback');
    row.querySelector('.session-promote').click();
    assert.deepEqual(calls.promote, [{ projectName: '.conduct', instanceId: 'inst-A', preview: 'plan the work' }]);
  });
});

test('conductor ↑ reads the freshest instance after a re-render', async () => {
  const { conductorList, sidebar, calls } = await setupSidebar();
  await render(sidebar, { instances: [conductor('A')] });
  const before = conductorRowOf(conductorList, 'A').querySelector('.session-promote');
  sidebar.setInstances([conductor('A', { id: 'inst-A2', title: 'Renamed' })]);
  await tick();
  const after = conductorRowOf(conductorList, 'A').querySelector('.session-promote');
  assert.ok(after === before, 'the button is reused, not rebuilt');
  after.click();
  assert.deepEqual(calls.promote, [{ projectName: '.conduct', instanceId: 'inst-A2', preview: 'Renamed' }]);
});

test('promoting a conductor drops the ↑ in place; a later onDisk merge does not duplicate the row', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, { instances: [conductor('A', { title: 'Alpha' })] });
  const row = conductorRowOf(conductorList, 'A');
  assert.ok(row.querySelector('.session-promote'), 'sanity: ↑ before the promote');
  sidebar.setInstances([conductor('A', { title: 'Alpha', temp: false })]);
  await tick();
  assert.ok(conductorRowOf(conductorList, 'A') === row, 'the same row node');
  assertNull(row.querySelector('.session-promote'), 'the ↑ is gone');
  assert.ok(!conductorOf(conductorList, 'A').classList.contains('inactive'), 'still in the live list');
  sidebar.setConductSessions([{ sessionId: 'A', lastActivity: 1 }]);
  await tick();
  assert.equal(conductorList.querySelectorAll('[data-key="conductor:A"]').length, 1, 'one block for the conductor');
  assert.ok(conductorRowOf(conductorList, 'A') === row, 'still the same row node');
  assertNull(row.querySelector('.session-delete'), 'a live row never gains a ×');
});

test('a temp conductor dying loses its ↑ as it moves to Inactive', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, { instances: [conductor('A')] });
  assert.ok(conductorRowOf(conductorList, 'A').querySelector('.session-promote'), 'sanity: ↑ while idle');
  sidebar.setInstances([conductor('A', { status: 'exited' })]);
  await tick();
  const block = conductorOf(conductorList, 'A');
  assert.ok(block.closest('.conductor-inactive-list'), 'the conductor now sits under Inactive');
  assertNull(block.querySelector('.session-promote'), 'the ↑ is gone once the conductor exits');
});

// Invariant: the owner bar is the block's inset box-shadow, which paints under the header row; a header
// highlight (hover fill, selected fill + outline) that starts at the block's left edge covers the bar,
// so the row's box starts past it, and its padding gives the width back so the content does not move.
test('styles.css: a conductor row\'s highlight box starts past its block\'s bar, in every state, without moving its content', async () => {
  const rules = topLevelRules(await fs.readFile(path.join(PUB, 'styles.css'), 'utf8'));
  const barWidth = (sel) => {
    const v = rules.filter(r => r.selectors.includes(sel)).map(r => r.decls.get('box-shadow')).find(Boolean);
    const m = /^inset (-?[\d.]+)px 0 0 /.exec(v ?? '');
    return m ? parseFloat(m[1]) : NaN;
  };
  const live = barWidth('.conductor-block'), faded = barWidth('.conductor-block.inactive');

  // Invariant: the live and the inactive block draw the same bar width, so one margin clears both.
  assert.ok(live > 0, 'the .conductor-block rule declares an inset box-shadow bar');
  assert.equal(faded, live, 'the inactive block\'s bar is as wide as the live block\'s');

  const { window, conductorList, sidebar } = await setupSidebar({ withCss: true });
  await render(sidebar, {
    conductRows: [{ sessionId: 'B', title: 'Inactive B', lastActivity: 100 }],
    instances: [conductor('A', { title: 'Live A' })],
  });
  sidebar.setActive('inst-A');
  await tick();
  const rows = {
    selected: conductorRowOf(conductorList, 'A'),
    inactive: conductorRowOf(conductorList, 'B'),
  };
  assert.ok(rows.selected.classList.contains('active'), 'sanity: the live conductor\'s row is the selected one');
  assert.ok(conductorOf(conductorList, 'B').classList.contains('inactive'), 'sanity: B renders as an inactive block');
  for (const [state, row] of Object.entries(rows)) {
    const cs = window.getComputedStyle(row);
    // Invariant: the row's box (hence its fill and outline) starts past the bar.
    assert.equal(cs.marginLeft, `${live}px`, `${state} row: margin-left clears the bar`);
    // Invariant: margin + padding is the 8px content inset the .conductor-chips column aligns with.
    assert.equal(parseFloat(cs.marginLeft) + parseFloat(cs.paddingLeft), 8, `${state} row: content inset stays 8px`);
  }

  // Invariant: no state rule resets the inset (happy-dom computes no :hover, so scan the rules).
  const stateRules = rules.filter(r => r.selectors.some(s => /\.conductor-row(:hover|\.active)/.test(s)
    && !/\.conductor-row(:hover|\.active)\s+\S/.test(s)));
  assert.ok(stateRules.length >= 2, 'sanity: the scan finds the hover and the selected rules');
  // Invariant: no state rule declares any margin* or padding* property, logical spellings included
  // (margin-inline-start is the left margin in a left-to-right document).
  const insetProp = /^(margin|padding)(-|$)/;
  for (const p of ['margin', 'margin-left', 'margin-inline', 'margin-inline-start', 'padding-inline-start', 'padding']) {
    assert.ok(insetProp.test(p), `sanity: the scan matches ${p}`);
  }
  for (const r of stateRules) {
    const hits = [...r.decls.keys()].filter(p => insetProp.test(p));
    assert.deepEqual(hits, [], `${r.selectors.join(', ')} must not declare margin or padding`);
  }
});

// Invariant: a conductor row's unread pill is the server's turn marks
// (turnEndSeq − viewedSeq), read off the live instance or, for an inactive
// conductor, its .conduct disk row; a read conductor gets no pill.
test('a conductor row pills its turn-mark difference from a live instance or a .conduct row', async () => {
  const { conductorList, sidebar } = await setupSidebar();
  await render(sidebar, {
    conductRows: [{ sessionId: 'D', lastActivity: 1, turnEndSeq: 4, viewedSeq: 1 }, { sessionId: 'R', lastActivity: 2, turnEndSeq: 2, viewedSeq: 2 }],
    instances: [conductor('A', { turnEndSeq: 2, viewedSeq: 0 }), conductor('B', { turnEndSeq: 1, viewedSeq: 1 })],
  });
  const pill = (sid) => conductorRowOf(conductorList, sid).querySelector(':scope > .session-unread');
  assert.equal(pill('A')?.textContent, '2', 'live conductor');
  assert.equal(pill('D')?.textContent, '3', 'inactive conductor, from its disk row');
  assertNull(pill('B'), 'a read live conductor has no pill');
  assertNull(pill('R'), 'a read disk conductor has no pill');
});

// Invariant: an armed conductor's compact auto-resume badge shows in the
// needs-you strip and on no Conductors-lens row — neither the conductor's own
// nor a worker's in its expanded tree.
test("an armed conductor's badge shows in the needs-you strip and on no Conductors-lens row", async () => {
  const { conductorList, strip, sidebar } = await setupSidebar();
  const T = 1_900_000_000;
  await render(sidebar, {
    projects: [project('p')],
    instances: [conductor('A', { autoResumeAt: T, queuedCount: 2 }), worker('w', 'A', 'p', null, { autoResumeAt: T, queuedCount: 1 })],
  });
  const tree = await expand(conductorList, 'A');
  assert.ok(rowOf(tree, 'w'), 'sanity: the worker row renders in the tree');
  assertNull(conductorList.querySelector('.session-resume-badge'), 'no conductor or worker row carries the badge');
  assert.equal(strip.querySelector('[data-key="entry:A"] .session-resume-badge')?.textContent, `2 · ⏸ ${clockOf(T)}`);
});

// Invariant: a row's label never shrinks to nothing — its flex basis is 0, so
// any spare width goes to it — while the ago label and the ↑ / × buttons keep
// their size, so nothing is pushed past the row's edge. Applies to the
// conductor row's title, a session row's preview and a worker row's label
// column.
test('a row label keeps a non-zero floor and the ago label and ↑ / × keep their size', async () => {
  const { window, root, conductorList, sidebar } = await setupSidebar({ withCss: true });
  const T = 1_900_000_000;
  await render(sidebar, {
    projects: [project('p')],
    instances: [
      conductor('A'),
      worker('w', 'A', 'p', null, { temp: true }),
      hand('h', 'p', null, { temp: true }),
    ],
  });
  const tree = await expand(conductorList, 'A');
  const cRow = conductorRowOf(conductorList, 'A');
  const labels = {
    'conductor title': cRow.querySelector('.conductor-title'),
    'worker label column': rowOf(tree, 'w').querySelector('.session-label-col'),
    'session preview': rowOf(root, 'h').querySelector('.session-preview'),
  };
  for (const [name, node] of Object.entries(labels)) {
    assert.ok(node, `sanity: the ${name} renders`);
    const cs = window.getComputedStyle(node);
    assert.ok(parseFloat(cs.minWidth) > 0, `${name}: min-width is a non-zero floor (got ${cs.minWidth})`);
    assert.equal(parseFloat(cs.flexBasis), 0, `${name}: flex-basis 0, so spare width grows it (got ${cs.flexBasis})`);
    assert.equal(cs.flexGrow, '1', `${name}: takes the spare width`);
  }
  // Invariant: inside the worker row's label column (a column flexbox, so the
  // flex basis is a height) the preview sizes from its content and never
  // shrinks: a 0 basis or a shrinkable preview with overflow: hidden (whose
  // automatic min-height is 0) collapses the worker's name to 0px high.
  const colPreview = labels['worker label column'].querySelector(':scope > .session-preview');
  assert.ok(colPreview, 'sanity: the label column holds the preview');
  assert.equal(window.getComputedStyle(labels['worker label column']).flexDirection, 'column', 'sanity: the label column is a column flexbox');
  const pcs = window.getComputedStyle(colPreview);
  assert.equal(pcs.flexBasis, 'auto', `column preview: flex-basis auto, its content height (got ${pcs.flexBasis})`);
  assert.equal(pcs.flexShrink, '0', `column preview: never shrinks below that height (got ${pcs.flexShrink})`);
  assert.equal(pcs.flexGrow, '0', `column preview: leaves the stage line its own height (got ${pcs.flexGrow})`);

  const rows = { 'conductor row': cRow, 'worker row': rowOf(tree, 'w'), 'session row': rowOf(root, 'h') };
  for (const [name, row] of Object.entries(rows)) {
    const fixed = [...row.querySelectorAll(':scope > .session-ago, :scope > .session-promote, :scope > .session-delete')];
    assert.ok(fixed.some(n => n.classList.contains('session-promote')), `sanity: the ${name} carries ↑`);
    for (const n of fixed) assert.equal(window.getComputedStyle(n).flexShrink, '0', `${name} ${n.className}: keeps its size`);
  }
});
