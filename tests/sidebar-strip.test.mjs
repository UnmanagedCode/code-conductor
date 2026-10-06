// The sidebar's needs-you strip (#sidebar-strip-slot): Waiting on you /
// Running / Finished groups over the live conductors and hand-spawned
// sessions, with the waiting-on-you ring on the entry dots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertNull } from './dom-assert.mjs';
import { PUB, setupSidebar, tick, project, conductor, worker, hand, rowOf } from './sidebar-fixture.mjs';

const { formatAutoResumeTime } = await import(pathToFileURL(path.join(PUB, 'usage.js')).href);
// The clock alone, as the existing formatter renders it.
const clockOf = (t) => formatAutoResumeTime(t).replace('resumes at ', '');

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
// The ring selector styles.css draws on an unread entry's status dot.
const RING = '.strip-entry.unread > .dot';
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

test('clicking a needs-you entry selects with a user gesture', async () => {
  const { strip, sidebar, calls } = await setupSidebar();
  await render(sidebar, { instances: [conductor('C1', ask('plan', 'tool'))] });
  entryOf(strip, 'C1').click();
  assert.deepEqual(calls.selectOpts, [{ userGesture: true }]);
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

test('a conductor entry takes its merged conductor title from the disk row', async () => {
  const { strip, sidebar } = await setupSidebar();
  await render(sidebar, {
    conductRows: [{ sessionId: 'A', title: 'Disk title', lastActivity: 1 }],
    instances: [conductor('A')],
  });
  assert.equal(entryOf(strip, 'A').textContent, 'Disk title');
});

test('the ring shows only on strip entries and conductor rows: a Projects-lens session row and a Conductors worker row are never ringed', async () => {
  const { strip, root, conductorList, sidebar } = await setupSidebar();
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
  conductorList.querySelector('[data-key="conductor:A"] .conductor-caret').click();
  await tick();

  // The same sessions are ringed where the ring belongs.
  assert.equal(entryOf(strip, 'h').querySelector('.dot').className, 'dot idle needs-you');
  assert.equal(entryOf(strip, 'A').querySelector('.dot').className, 'dot idle needs-you');
  assert.equal(conductorList.querySelector('[data-key="conductor:A"] .conductor-row > .dot').className, 'dot idle needs-you');

  const dotIn = (list, sid) => rowOf(list, sid)?.querySelector('.dot') ?? null;
  const projH = dotIn(root, 'h'), projW = dotIn(root, 'w'), treeW = dotIn(conductorList, 'w');
  assert.ok(projH && projW && treeW, 'the Projects rows for h and w and the Conductors worker row for w are rendered');
  for (const [where, dot] of [['Projects h', projH], ['Projects w', projW], ['Conductors worker w', treeW]]) {
    assert.equal(dot.classList.contains('needs-you'), false, `${where}: ${dot.className}`);
    assert.doesNotMatch(dot.title, /waiting on you/, `${where}: ${dot.title}`);
  }
});

const closeOf = (strip, sid) => strip.querySelector(`[data-key="entry:${sid}"] > .session-delete`);

// Invariant: every strip entry, conductor or hand-spawned, ends in a × button that directly follows its .strip-entry.
test('every strip entry carries a × as the sibling right after its entry button', async () => {
  const { strip, sidebar } = await setupSidebar();
  await render(sidebar, {
    instances: [conductor('C1'), conductor('C2', { status: 'turn' }), conductor('C3', ask('plan', 'tool')), hand('h1', 'p'), hand('h2', 'p', null, ask('question', 'text'))],
  });
  for (const sid of ['C1', 'C2', 'C3', 'h1', 'h2']) {
    const x = closeOf(strip, sid);
    assert.ok(x, `${sid}: has a ×`);
    assert.equal(x.tagName, 'BUTTON');
    assert.equal(x.textContent, '×');
    assert.ok(entryOf(strip, sid).nextElementSibling === x, `${sid}: the × follows the entry button`);
    assert.ok(x.parentElement.lastElementChild === x, `${sid}: the × is the entry's last child`);
  }
});

// Invariant: the × title and aria-label name the action its state maps to — Stop for live persistent, Archive for live temp — for both entry kinds.
test('the strip × is titled Stop session for a live persistent entry and Archive session for a live temp one', async (t) => {
  const { strip, sidebar } = await setupSidebar();
  await render(sidebar, {
    instances: [
      conductor('Cp', { temp: false }), conductor('Ct', { temp: true }),
      hand('hp', 'p', null, { temp: false }), hand('ht', 'p', null, { temp: true }),
    ],
  });
  const want = { Cp: 'Stop session', hp: 'Stop session', Ct: 'Archive session (keeps history)', ht: 'Archive session (keeps history)' };
  for (const [sid, title] of Object.entries(want)) {
    await t.test(sid, () => {
      assert.equal(closeOf(strip, sid).title, title);
      assert.equal(closeOf(strip, sid).getAttribute('aria-label'), title);
    });
  }
});

// Invariant: a re-render that flips a session's temp flag re-titles the SAME × node (the label is patched every render).
test('the strip × is reused and re-titled when the session is made persistent', async () => {
  const { strip, sidebar } = await setupSidebar();
  await render(sidebar, { instances: [conductor('A', { temp: true })] });
  const node = closeOf(strip, 'A');
  assert.equal(node.title, 'Archive session (keeps history)');
  await render(sidebar, { instances: [conductor('A', { temp: false })] });
  assert.ok(closeOf(strip, 'A') === node, 'the × node is reused in place');
  assert.equal(node.title, 'Stop session');
  assert.equal(node.getAttribute('aria-label'), 'Stop session');
});

// Invariant: clicking a strip × sends the entry's full close payload (conductor and hand-spawned shapes) and neither selects nor resumes.
test('a strip × closes through onCloseSession with the entry\'s facts and never selects or resumes', async (t) => {
  await t.test('a live persistent conductor', async () => {
    const { strip, sidebar, calls } = await setupSidebar();
    await render(sidebar, { instances: [conductor('A', { title: 'Alpha', temp: false })] });
    closeOf(strip, 'A').click();
    assert.deepEqual(calls.close, [
      { projectName: '.conduct', worktreeName: null, sessionId: 'A', instanceId: 'inst-A', status: 'idle', temp: false, preview: 'Alpha', synthetic: true },
    ]);
    assert.deepEqual(calls.select, []);
    assert.deepEqual(calls.resume, []);
  });
  await t.test('a live temp conductor with a transcript on disk', async () => {
    const { strip, sidebar, calls } = await setupSidebar();
    await render(sidebar, { conductRows: [{ sessionId: 'B', title: 'Beta', lastActivity: 1 }], instances: [conductor('B', { status: 'turn' })] });
    closeOf(strip, 'B').click();
    assert.deepEqual(calls.close, [
      { projectName: '.conduct', worktreeName: null, sessionId: 'B', instanceId: 'inst-B', status: 'turn', temp: true, preview: 'Beta', synthetic: false },
    ]);
  });
  await t.test('a hand-spawned session in a worktree', async () => {
    const { strip, sidebar, calls } = await setupSidebar();
    await render(sidebar, { projects: [project('p', { worktrees: ['wt'] })], instances: [hand('h', 'p', 'wt', { title: 'Hand', temp: false })] });
    closeOf(strip, 'h').click();
    assert.deepEqual(calls.close, [
      { projectName: 'p', worktreeName: 'wt', sessionId: 'h', instanceId: 'inst-h', status: 'idle', temp: false, preview: 'Hand', synthetic: false },
    ]);
    assert.deepEqual(calls.select, []);
    assert.deepEqual(calls.resume, []);
  });
  await t.test('a hand-spawned temp session is synthetic: its transcript is never listed while it lives', async () => {
    const { strip, sidebar, calls } = await setupSidebar();
    await render(sidebar, { instances: [hand('h', 'p', null, { title: 'Hand', temp: true })] });
    closeOf(strip, 'h').click();
    assert.equal(calls.close.length, 1);
    assert.equal(calls.close[0].temp, true);
    assert.equal(calls.close[0].synthetic, true);
  });
});

// Invariant: the × reads its entry's freshest instance at click time after a crash + resume.
test('a strip × after a crash + resume closes the new instanceId', async () => {
  const { strip, sidebar, calls } = await setupSidebar();
  await render(sidebar, { instances: [conductor('C1')] });
  const node = closeOf(strip, 'C1');
  await render(sidebar, { instances: [conductor('C1', { id: 'inst-C1-b' })] });
  assert.ok(closeOf(strip, 'C1') === node, 'the × is reused in place');
  node.click();
  assert.deepEqual(calls.close.map(c => c.instanceId), ['inst-C1-b']);
});

// Invariant: the Finished group marks its unread entries (turnEndSeq >
// viewedSeq): .strip-entry.unread, whose status dot the ring selector matches;
// the entry holds only the dot and the title, with no trailing element. The
// head counts them as `· K new`, and the reason says `· unread`; a read entry
// carries none of it, and viewing an entry clears all of it.
test('unread Finished entries: the ring, the class, the head count and the reason', async (t) => {
  const { strip, sidebar } = await setupSidebar();
  const fixture = (u) => [
    conductor('U', { title: 'Um', turnEndSeq: 2, viewedSeq: 1, ...u }),
    hand('h', 'p', null, { title: 'hm', turnEndSeq: 1, viewedSeq: 0 }),
    conductor('S', { title: 'Sm', turnEndSeq: 2, viewedSeq: 2 }),
  ];
  await render(sidebar, { instances: fixture() });
  const dotOf = (sid) => entryOf(strip, sid).querySelector(':scope > .dot');

  await t.test('an unread entry has .unread and a ringed dot', () => {
    for (const sid of ['U', 'h']) {
      const e = entryOf(strip, sid);
      assert.ok(e.classList.contains('unread'), `${sid}: .unread`);
      assert.ok(dotOf(sid).matches(RING), `${sid}: ringed dot`);
      assert.equal(dotOf(sid).className, 'dot idle', `${sid}: plain idle fill`);
      assert.equal(e.children.length, 2, `${sid}: dot and title only`);
      assert.ok(e.lastElementChild.classList.contains('strip-title'), `${sid}: no trailing element`);
    }
  });
  await t.test('a read entry has neither', () => {
    assert.ok(!entryOf(strip, 'S').classList.contains('unread'));
    assert.ok(!dotOf('S').matches(RING));
    assert.equal(entryOf(strip, 'S').children.length, 2);
  });
  await t.test('the head counts the unread entries', () => {
    assert.deepEqual(heads(strip), ['Finished (3 · 2 new)']);
  });
  await t.test('the reason says unread', () => {
    assert.equal(entryOf(strip, 'U').getAttribute('aria-label'), 'Um — turn ended · unread');
    assert.equal(entryOf(strip, 'U').title, 'Um\nturn ended · unread');
    assert.equal(entryOf(strip, 'S').getAttribute('aria-label'), 'Sm — turn ended');
  });
  await t.test('viewing an entry clears its ring and class, and the head drops the suffix once none is unread', async () => {
    assert.equal(strip.querySelectorAll('.strip-unread').length, 0, 'no trailing-dot element before viewing');
    await render(sidebar, { instances: fixture({ viewedSeq: 2 }) });
    assert.ok(!entryOf(strip, 'U').classList.contains('unread'));
    assert.ok(!dotOf('U').matches(RING));
    assert.equal(strip.querySelectorAll('.strip-unread').length, 0, 'no trailing-dot element after viewing');
    assert.deepEqual(heads(strip), ['Finished (3 · 1 new)']);
    await render(sidebar, { instances: fixture({ viewedSeq: 2 }).filter(i => i.sessionId !== 'h') });
    assert.deepEqual(heads(strip), ['Finished (2)']);
  });
});

// Invariant: only Finished shows unread — a Waiting or Running entry with
// unread counters gets no ring and no class, and those heads keep their plain
// count.
test('unread counters on Waiting and Running entries render nothing', async () => {
  const { strip, sidebar } = await setupSidebar();
  await render(sidebar, { instances: [
    conductor('W', { title: 'Wm', turnEndSeq: 3, viewedSeq: 0, ...ask('question', 'tool') }),
    conductor('R', { title: 'Rm', status: 'turn', turnEndSeq: 3, viewedSeq: 0 }),
  ] });
  assert.deepEqual(heads(strip), ['Waiting on you (1)', 'Running (1)']);
  for (const sid of ['W', 'R']) {
    assert.ok(!entryOf(strip, sid).classList.contains('unread'), `${sid}: no .unread`);
    assert.ok(!entryOf(strip, sid).querySelector(':scope > .dot').matches(RING), `${sid}: no ring`);
    assert.ok(!entryOf(strip, sid).getAttribute('aria-label').includes('unread'), `${sid}: no unread reason`);
  }
});

// Invariant: a strip entry with an armed resume carries the compact badge —
// the queued count first ("N · ⏸ <time>"), the full wording in its tooltip —
// after the title, updated in place and removed (entry kept) on clear.
test('an armed strip entry shows the compact auto-resume badge, count first, updated in place and dropped on clear', async () => {
  const { strip, sidebar } = await setupSidebar();
  const T = 1_900_000_000;
  const badgesOf = () => entryOf(strip, 'A').querySelectorAll('.session-resume-badge');
  await render(sidebar, { instances: [conductor('A', { autoResumeAt: T, queuedCount: 2 })] });
  const li = entryOf(strip, 'A');
  assert.equal(badgesOf().length, 1, 'one badge in the entry');
  const badge = badgesOf()[0];
  assert.equal(badge.textContent, `2 · ⏸ ${clockOf(T)}`);
  assert.equal(badge.title, `${formatAutoResumeTime(T)} · 2 queued\nauto-stopped on overage — 2 messages queued; will resume when the window resets`);
  assert.deepEqual([...li.children].map(c => c.classList[0]), ['dot', 'strip-title', 'session-resume-badge']);

  await render(sidebar, { instances: [conductor('A', { autoResumeAt: T, queuedCount: 0 })] });
  assert.ok(badgesOf()[0] === badge, 'the badge is updated in place');
  assert.equal(badge.textContent, `⏸ ${clockOf(T)}`, 'no count with nothing queued');

  await render(sidebar, { instances: [conductor('A', { autoResumeAt: null, queuedCount: 0 })] });
  assertNull(entryOf(strip, 'A').querySelector('.session-resume-badge'), 'the badge goes with the armed resume');
  assert.ok(entryOf(strip, 'A') === li, 'the entry itself is kept');
});

// Invariant: hand-spawned entries carry the badge as conductor entries do.
test("an armed hand-spawned strip entry carries the badge too", async () => {
  const { strip, sidebar } = await setupSidebar();
  const T = 1_900_000_000;
  await render(sidebar, { instances: [hand('h', 'p', null, { autoResumeAt: T, queuedCount: 1 })] });
  assert.deepEqual(groupSids(strip, 'finished'), ['h']);
  assert.equal(entryOf(strip, 'h').querySelector('.session-resume-badge')?.textContent, `1 · ⏸ ${clockOf(T)}`);
});

// Invariant: the aria-label replaces the entry's content, so it carries the
// full resume wording while armed and is unchanged otherwise.
test("an armed entry's aria-label carries the full resume wording", async () => {
  const { strip, sidebar } = await setupSidebar();
  const T = 1_900_000_000;
  await render(sidebar, { instances: [
    conductor('A', { title: 'Am', autoResumeAt: T, queuedCount: 2 }),
    conductor('B', { title: 'Bm' }),
  ] });
  assert.equal(entryOf(strip, 'A').getAttribute('aria-label'), `Am — turn ended — ${formatAutoResumeTime(T)} · 2 queued`);
  assert.equal(entryOf(strip, 'B').getAttribute('aria-label'), 'Bm — turn ended');
});

// Invariant: the strip title keeps a non-zero floor and a 0 flex basis, so
// only the resume badge gives way when the entry is narrow.
test('the strip title keeps a non-zero floor and only the resume badge gives way', async () => {
  const { window, strip, sidebar } = await setupSidebar({ withCss: true });
  await render(sidebar, { instances: [conductor('A', { autoResumeAt: 1_900_000_000, queuedCount: 1 })] });
  const title = entryOf(strip, 'A').querySelector('.strip-title');
  const badge = entryOf(strip, 'A').querySelector('.session-resume-badge');
  assert.ok(title && badge, 'sanity: both render');
  const t = window.getComputedStyle(title);
  assert.ok(parseFloat(t.minWidth) > 0, `title min-width is a non-zero floor (got ${t.minWidth})`);
  assert.equal(parseFloat(t.flexBasis), 0, `title flex-basis 0 (got ${t.flexBasis})`);
  assert.equal(t.flexGrow, '1', 'title takes the spare width');
  const b = window.getComputedStyle(badge);
  assert.ok(parseFloat(b.flexShrink) > 0, 'badge may shrink');
  assert.equal(parseFloat(b.minWidth), 0, 'badge down to nothing');
  assert.equal(b.overflow, 'hidden');
  assert.equal(b.textOverflow, 'ellipsis');
});
