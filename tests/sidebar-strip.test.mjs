// The sidebar's needs-you strip (#sidebar-strip-slot): Waiting on you /
// Running / Finished groups over the live conductors and hand-spawned
// sessions, with the waiting-on-you ring on the entry dots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupSidebar, tick, project, conductor, worker, hand, rowOf } from './sidebar-fixture.mjs';

async function render(sidebar, { projects = [project('p')], instances = [], conductRows = [] } = {}) {
  sidebar.setProjects(projects);
  sidebar.setConductSessions(conductRows);
  sidebar.setInstances(instances);
  await tick();
}

const entryOf = (strip, sid) => strip.querySelector(`[data-key="entry:${sid}"] > .strip-entry`);
const groupSids = (strip, name) =>
  [...strip.querySelectorAll(`.strip-group.${name} .strip-list > li`)].map(li => li.dataset.key.slice(6));
const heads = (strip) => [...strip.querySelectorAll('.strip-head')].map(h => h.textContent);
const ask = (kind, source) => ({ awaitingUser: kind, awaitingUserSource: source });

test('the slot has no children when nothing is eligible', async () => {
  const { strip, sidebar } = await setupSidebar();
  await render(sidebar, { instances: [] });
  assert.equal(strip.children.length, 0, 'nothing live');
  await render(sidebar, { instances: [worker('w1', 'X', 'p'), worker('w2', 'X', 'p', null, { status: 'turn', ...ask('question', 'tool') })] });
  assert.equal(strip.children.length, 0, 'only conducted workers');
  await render(sidebar, { instances: [hand('h1', 'p', null, { status: 'turn' }), hand('h2', 'p', null, { status: 'spawning' })] });
  assert.equal(strip.children.length, 0, 'only running hand-spawned sessions');
});

test('groups render Waiting → Running → Finished with counts, and empty groups are omitted', async () => {
  const { strip, sidebar } = await setupSidebar();
  await render(sidebar, {
    instances: [
      conductor('F', { title: 'F' }),
      conductor('R', { title: 'R', status: 'turn' }),
      conductor('W', { title: 'W', ...ask('plan', 'tool') }),
      hand('h', 'p', null, { title: 'h', ...ask('question', 'text') }),
    ],
  });
  assert.equal(strip.children.length, 1);
  assert.ok(strip.firstElementChild.classList.contains('sidebar-strip'));
  assert.deepEqual(heads(strip), ['Waiting on you (2)', 'Running (1)', 'Finished (1)']);
  assert.deepEqual([...strip.querySelectorAll('.strip-group')].map(g => g.className), [
    'strip-group waiting', 'strip-group running', 'strip-group finished',
  ]);
  assert.deepEqual(groupSids(strip, 'waiting'), ['W', 'h']);
  await render(sidebar, { instances: [conductor('F', { title: 'F' })] });
  assert.deepEqual(heads(strip), ['Finished (1)'], 'waiting and running are gone once empty');
});

test('no visible state text: an entry shows its label only; title and aria-label carry the reason, distinct per ask', async () => {
  const { strip, sidebar } = await setupSidebar();
  await render(sidebar, {
    instances: [
      conductor('Q', { title: 'Qm', ...ask('question', 'tool') }),
      conductor('P', { title: 'Pm', ...ask('plan', 'tool') }),
      conductor('T', { title: 'Tm', ...ask('question', 'text') }),
      conductor('R', { title: 'Rm', status: 'turn' }),
      conductor('F', { title: 'Fm' }),
    ],
  });
  for (const [sid, label] of [['Q', 'Qm'], ['P', 'Pm'], ['T', 'Tm'], ['R', 'Rm'], ['F', 'Fm']]) {
    assert.equal(entryOf(strip, sid).textContent, label, `${sid} renders its label and nothing else`);
  }
  const aria = (sid) => entryOf(strip, sid).getAttribute('aria-label');
  assert.equal(aria('Q'), 'Qm — question · idle');
  assert.equal(aria('P'), 'Pm — plan approval · idle');
  assert.equal(aria('T'), 'Tm — asked in text · idle');
  assert.equal(aria('R'), 'Rm — working');
  assert.equal(aria('F'), 'Fm — turn ended');
  assert.equal(entryOf(strip, 'P').title, 'Pm\nplan approval · idle');
  assert.equal(new Set([aria('Q'), aria('P'), aria('T')]).size, 3);
});

test('entry dots: the ring over idle, turn and on-a-worker fills in Waiting; plain dots in Running and Finished', async () => {
  const { strip, sidebar } = await setupSidebar();
  await render(sidebar, {
    instances: [
      conductor('WI', ask('question', 'tool')),
      conductor('WT', { status: 'turn', ...ask('question', 'text') }),
      conductor('WA', { awaitingWake: true, ...ask('plan', 'tool') }),
      conductor('RT', { status: 'turn' }),
      conductor('RA', { awaitingWake: true }),
      conductor('F'),
    ],
  });
  const dot = (sid) => entryOf(strip, sid).querySelector('.dot');
  assert.equal(dot('WI').className, 'dot idle needs-you');
  assert.equal(dot('WT').className, 'dot turn needs-you');
  assert.equal(dot('WA').className, 'dot idle awaiting needs-you');
  assert.equal(dot('WI').title, 'waiting on you (question) · idle');
  assert.equal(dot('WT').title, 'waiting on you (asked in text) · running');
  assert.equal(dot('WA').title, 'waiting on you (plan approval) · on a worker');
  assert.equal(dot('RT').className, 'dot turn');
  assert.equal(dot('RA').className, 'dot idle awaiting');
  assert.equal(dot('F').className, 'dot idle');
  assert.equal(entryOf(strip, 'RA').getAttribute('aria-label').endsWith('— on a worker'), true);
});

test('conductor entries carry the conductor colour bar; hand-spawned entries carry none', async () => {
  const { strip, sidebar, conductorColor } = await setupSidebar();
  await render(sidebar, { instances: [conductor('C1'), hand('h1', 'p')] });
  const c = entryOf(strip, 'C1');
  assert.ok(c.classList.contains('owned'));
  assert.equal(c.style.getPropertyValue('--owner-color'), conductorColor('C1'));
  const h = entryOf(strip, 'h1');
  assert.equal(h.classList.contains('owned'), false);
  assert.equal(h.style.getPropertyValue('--owner-color'), '');
});

test('a click selects the live instance and never resumes a session', async () => {
  const { strip, sidebar, calls } = await setupSidebar();
  await render(sidebar, { instances: [conductor('C1', ask('plan', 'tool')), hand('h1', 'p')] });
  entryOf(strip, 'C1').click();
  entryOf(strip, 'h1').click();
  assert.deepEqual(calls.select, ['inst-C1', 'inst-h1']);
  assert.deepEqual(calls.resume, []);
});

test('a click after a crash + resume selects the new instanceId', async () => {
  const { strip, sidebar, calls } = await setupSidebar();
  await render(sidebar, { instances: [conductor('C1')] });
  const node = entryOf(strip, 'C1');
  await render(sidebar, { instances: [conductor('C1', { id: 'inst-C1-b' })] });
  assert.equal(entryOf(strip, 'C1'), node, 'the entry is reused in place');
  node.click();
  assert.deepEqual(calls.select, ['inst-C1-b']);
});

test('setActive marks the selected entry .active and only it', async () => {
  const { strip, sidebar } = await setupSidebar();
  await render(sidebar, { instances: [conductor('C1'), hand('h1', 'p')] });
  sidebar.setActive('inst-h1');
  assert.ok(entryOf(strip, 'h1').classList.contains('active'));
  assert.equal(entryOf(strip, 'C1').classList.contains('active'), false);
  sidebar.setActive('inst-C1');
  assert.equal(entryOf(strip, 'h1').classList.contains('active'), false);
  assert.ok(entryOf(strip, 'C1').classList.contains('active'));
});

test('a live flip moves an entry from Waiting to Finished when awaitingUser clears, and the strip vanishes when the last session dies', async () => {
  const { strip, sidebar } = await setupSidebar();
  await render(sidebar, { instances: [conductor('A', ask('question', 'text'))] });
  assert.deepEqual(groupSids(strip, 'waiting'), ['A']);
  await render(sidebar, { instances: [conductor('A', { status: 'turn', awaitingUser: null, awaitingUserSource: null })] });
  assert.deepEqual(groupSids(strip, 'waiting'), []);
  assert.deepEqual(groupSids(strip, 'running'), ['A']);
  await render(sidebar, { instances: [conductor('A')] });
  assert.deepEqual(groupSids(strip, 'finished'), ['A']);
  assert.equal(entryOf(strip, 'A').querySelector('.dot').className, 'dot idle');
  await render(sidebar, { instances: [conductor('A', { status: 'exited' })] });
  assert.equal(strip.children.length, 0);
});

test('the strip ignores the conductor filter: hand-only and a selected conductor leave it unchanged', async () => {
  const { strip, sidebar, select } = await setupSidebar();
  await render(sidebar, {
    instances: [conductor('A', ask('plan', 'tool')), conductor('B', { status: 'turn' }), worker('w', 'B', 'p'), hand('h', 'p')],
  });
  const snapshot = () => ({ w: groupSids(strip, 'waiting'), r: groupSids(strip, 'running'), f: groupSids(strip, 'finished') });
  const all = snapshot();
  assert.deepEqual(all, { w: ['A'], r: ['B'], f: ['h'] });
  select.value = 'hand';
  select.dispatchEvent(new select.ownerDocument.defaultView.Event('change'));
  await tick();
  assert.equal(sidebar.filter, 'hand');
  assert.deepEqual(snapshot(), all);
  select.value = 'B';
  select.dispatchEvent(new select.ownerDocument.defaultView.Event('change'));
  await tick();
  assert.equal(sidebar.filter, 'B');
  assert.deepEqual(snapshot(), all);
});

test('a conductor entry takes its merged mission title from the disk row', async () => {
  const { strip, sidebar } = await setupSidebar();
  await render(sidebar, {
    conductRows: [{ sessionId: 'A', title: 'Disk title', lastActivity: 1 }],
    instances: [conductor('A')],
  });
  assert.equal(entryOf(strip, 'A').textContent, 'Disk title');
});

test('the ring shows only on strip entries and Missions conductor rows: a Projects-lens session row and a Missions worker row are never ringed', async () => {
  const { strip, root, missionList, sidebar } = await setupSidebar();
  const q = ask('question', 'tool');
  await render(sidebar, {
    projects: [project('p', { worktrees: ['wt'] })],
    instances: [
      conductor('A', q),
      hand('h', 'p', null, ask('question', 'text')),
      // A worker never carries awaitingUser on the server; forced here so the
      // row builders, not the data, are what keeps it unringed.
      worker('w', 'A', 'p', 'wt', q),
    ],
  });
  for (const d of root.querySelectorAll('details.worktree-group')) d.open = true;
  await tick();
  await tick();
  missionList.querySelector('[data-key="mission:A"] .mission-caret').click();
  await tick();

  // The same sessions are ringed where the ring belongs.
  assert.equal(entryOf(strip, 'h').querySelector('.dot').className, 'dot idle needs-you');
  assert.equal(entryOf(strip, 'A').querySelector('.dot').className, 'dot idle needs-you');
  assert.equal(missionList.querySelector('[data-key="mission:A"] .mission-row > .dot').className, 'dot idle needs-you');

  const dotIn = (list, sid) => rowOf(list, sid)?.querySelector('.dot') ?? null;
  const projH = dotIn(root, 'h'), projW = dotIn(root, 'w'), treeW = dotIn(missionList, 'w');
  assert.ok(projH && projW && treeW, 'the Projects rows for h and w and the Missions worker row for w are rendered');
  for (const [where, dot] of [['Projects h', projH], ['Projects w', projW], ['Missions worker w', treeW]]) {
    assert.equal(dot.classList.contains('needs-you'), false, `${where}: ${dot.className}`);
    assert.doesNotMatch(dot.title, /waiting on you/, `${where}: ${dot.title}`);
  }
});
