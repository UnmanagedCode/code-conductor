// The idle-renewal nudge controller (src/idleRenewNudge.ts): which turn ends
// start an idle stretch, when a stretch fires its one nudge, what skips it
// (transiently, or for the whole stretch) and its lifecycle hooks. The units
// drive tick() against a stub manager with an injected clock, timers and
// setting, so nothing sleeps; the last test wires the real manager, route and
// fake CLI together through the manager's idleNudgeNow seam.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdleRenewNudgeController, IDLE_NUDGE_SWEEP_MS } from '../src/idleRenewNudge.ts';
import { IDLE_NUDGE_MARKER, parseIdleRenewNudge, PROMPT_CACHE_TTL_MINUTES } from '../shared/idleRenewNudge.ts';
import { bootServer, api, waitFor } from './helpers.mjs';
import { getTurnMarks, settleSessionWrites } from '../src/sessionStore.ts';

const MIN = 60_000;
const THRESHOLD = 55;

function stubInst(over = {}) {
  const inst = {
    project: '.conduct', conducted: false, proc: {}, status: 'idle', pristine: false,
    rotationPending: false, renewalPending: false, relaunching: false, rewriteBlocksPrompts: false,
    steerPending: false, activeAgentTaskCount: 0, taskNotificationPending: false,
    autoStoppedForOverage: false, autoResumeAt: null, _overageQueue: [], lastTurnEndWasNudgeChain: false,
    overageUntil: 0,
    overageReportedNow(now) { return now < this.overageUntil; },
    sent: [],
    emitted: [],
    prompt(text, attachments, opts) { this.sent.push({ text, opts }); return Promise.resolve(); },
    _emitUi(ev) { this.emitted.push(ev); },
  };
  return Object.assign(inst, over);
}

function fakeTimers() {
  const armed = [];
  return {
    armed,
    live: () => armed.filter(h => !h.cleared),
    setInterval(fn, ms) { const h = { fn, ms, cleared: false }; armed.push(h); return h; },
    clearInterval(h) { if (h) h.cleared = true; },
  };
}

function rig({ enabled = true, value = THRESHOLD } = {}) {
  const manager = { byId: new Map(), _overageActive: false };
  const clock = { now: 1_000_000 };
  const timers = fakeTimers();
  const setting = { enabled, value };
  const ctl = new IdleRenewNudgeController({
    manager, now: () => clock.now, timers: () => timers, setting: () => setting,
  });
  const add = (id, over) => { const i = stubInst(over); manager.byId.set(id, i); return i; };
  const turnEnd = (id) => ctl.onEvent({ id, ev: { kind: 'turn_end' } });
  const advance = (ms) => { clock.now += ms; };
  return { manager, clock, timers, setting, ctl, add, turnEnd, advance };
}

// INVARIANT: a real turn end opens a stretch; at the threshold one tick sends one
// internal, idleNudge-marked nudge naming the idle minutes.
test('a real turn end then the threshold elapsing sends one idleNudge prompt naming the idle minutes', () => {
  const r = rig();
  const inst = r.add('c1');
  r.turnEnd('c1');
  r.advance(THRESHOLD * MIN);
  r.ctl.tick();
  assert.equal(inst.sent.length, 1);
  assert.deepEqual(inst.sent[0].opts, { internal: true, annotateIfMidTurn: false, idleNudge: true });
  const parsed = parseIdleRenewNudge(inst.sent[0].text);
  assert.ok(parsed, 'the text is a nudge');
  assert.match(parsed.summary, new RegExp(`idle ${THRESHOLD} min`));
});

// INVARIANT: nothing fires before the threshold.
test('no nudge one millisecond before the threshold', () => {
  const r = rig();
  const inst = r.add('c1');
  r.turnEnd('c1');
  r.advance(THRESHOLD * MIN - 1);
  r.ctl.tick();
  assert.equal(inst.sent.length, 0);
});

// INVARIANT: a later real turn end restarts the stretch from that turn's end.
test('a real turn end mid-stretch moves the deadline', () => {
  const r = rig();
  const inst = r.add('c1');
  r.turnEnd('c1');
  r.advance(30 * MIN);
  r.turnEnd('c1');
  r.advance(25 * MIN);
  r.ctl.tick();
  assert.equal(inst.sent.length, 0, 'not at the old deadline');
  r.advance(30 * MIN);
  r.ctl.tick();
  assert.equal(inst.sent.length, 1, 'at the new one');
});

// INVARIANT: a nudge-chain turn end never starts a stretch, so the nudge cannot re-arm itself.
test('a nudge-chain turn end leaves the stretch spent', () => {
  const r = rig();
  const inst = r.add('c1');
  r.turnEnd('c1');
  r.advance(THRESHOLD * MIN);
  r.ctl.tick();
  assert.equal(inst.sent.length, 1);
  inst.lastTurnEndWasNudgeChain = true;
  r.turnEnd('c1');
  r.advance(59 * MIN);
  r.ctl.tick();
  assert.equal(inst.sent.length, 1);
});

// INVARIANT: once per stretch; the next real turn end re-arms.
test('one nudge per stretch, re-armed by the next real turn end', () => {
  const r = rig();
  const inst = r.add('c1');
  r.turnEnd('c1');
  r.advance(THRESHOLD * MIN);
  r.ctl.tick();
  r.advance(MIN);
  r.ctl.tick();
  assert.equal(inst.sent.length, 1);
  r.turnEnd('c1');
  r.advance(THRESHOLD * MIN);
  r.ctl.tick();
  assert.equal(inst.sent.length, 2);
});

// INVARIANT: each overage signal spends the stretch without a send, and it stays
// spent once the signal clears.
test('an overage signal spends the stretch without a nudge', async (t) => {
  const rows = {
    'manager _overageActive': (r) => { r.manager._overageActive = true; return () => { r.manager._overageActive = false; }; },
    'autoStoppedForOverage': (r, i) => { i.autoStoppedForOverage = true; return () => { i.autoStoppedForOverage = false; }; },
    'autoResumeAt': (r, i) => { i.autoResumeAt = 123; return () => { i.autoResumeAt = null; }; },
    'a queued overage message': (r, i) => { i._overageQueue = [{ text: 'x' }]; return () => { i._overageQueue = []; }; },
    'overageReportedNow': (r, i) => { i.overageUntil = Number.POSITIVE_INFINITY; return () => { i.overageUntil = 0; }; },
  };
  for (const [label, set] of Object.entries(rows)) {
    await t.test(label, () => {
      const r = rig();
      const inst = r.add('c1');
      r.turnEnd('c1');
      r.advance(THRESHOLD * MIN);
      const clear = set(r, inst);
      r.ctl.tick();
      assert.equal(inst.sent.length, 0, 'no send in overage');
      clear();
      r.advance(MIN);
      r.ctl.tick();
      assert.equal(inst.sent.length, 0, 'still spent after it clears');
    });
  }
});

// INVARIANT: a busy instance leaves the stretch unspent; the nudge fires once it is free.
test('a transiently busy conductor is retried, not spent', async (t) => {
  const rows = {
    'mid-turn': { status: 'turn' },
    'rotationPending': { rotationPending: true },
    'steerPending': { steerPending: true },
    'active subagents': { activeAgentTaskCount: 1 },
  };
  for (const [label, busy] of Object.entries(rows)) {
    await t.test(label, () => {
      const r = rig();
      const inst = r.add('c1');
      r.turnEnd('c1');
      r.advance(THRESHOLD * MIN);
      const saved = Object.fromEntries(Object.keys(busy).map(k => [k, inst[k]]));
      Object.assign(inst, busy);
      r.ctl.tick();
      assert.equal(inst.sent.length, 0);
      Object.assign(inst, saved);
      r.advance(MIN);
      r.ctl.tick();
      assert.equal(inst.sent.length, 1);
    });
  }
});

// INVARIANT: a stretch already past the cache TTL is spent without a send.
test('a stretch past the cache TTL is spent without a nudge', () => {
  const r = rig();
  const inst = r.add('c1', { status: 'turn' });
  r.turnEnd('c1');
  r.advance(PROMPT_CACHE_TTL_MINUTES * MIN);
  inst.status = 'idle';
  r.ctl.tick();
  assert.equal(inst.sent.length, 0);
  r.ctl.tick();
  assert.equal(inst.sent.length, 0);
  assert.equal(r.timers.live().length, 0, 'nothing unspent keeps the sweep running');
});

// INVARIANT: only a top-level conductor gets a stretch.
test('a section lead, a worker and a hand-driven session are never nudged', () => {
  const r = rig();
  const lead = r.add('lead', { conducted: true });
  const worker = r.add('worker', { project: 'app', conducted: true });
  const hand = r.add('hand', { project: 'app' });
  for (const id of ['lead', 'worker', 'hand']) r.turnEnd(id);
  r.advance(THRESHOLD * MIN);
  r.ctl.tick();
  assert.deepEqual([lead.sent.length, worker.sent.length, hand.sent.length], [0, 0, 0]);
  assert.equal(r.timers.armed.length, 0, 'no stretch, no sweep');
});

// INVARIANT: the setting gates firing; enabling it plus sync() picks up a stretch already running.
test('disabled: no nudge; enabling and sync() fires a stretch already past the threshold', () => {
  const r = rig({ enabled: false });
  const inst = r.add('c1');
  r.turnEnd('c1');
  assert.equal(r.timers.live().length, 0, 'no sweep while disabled');
  r.advance(THRESHOLD * MIN);
  r.ctl.tick();
  assert.equal(inst.sent.length, 0);
  r.setting.enabled = true;
  r.ctl.sync();
  assert.equal(r.timers.live().length, 1, 'sync starts the sweep');
  assert.equal(r.timers.live()[0].ms, IDLE_NUDGE_SWEEP_MS);
  r.timers.live()[0].fn();
  assert.equal(inst.sent.length, 1);
});

// INVARIANT: the threshold is read at each tick, so a saved change applies to running stretches.
test('a changed threshold applies to a running stretch', () => {
  const lowered = rig();
  const a = lowered.add('c1');
  lowered.turnEnd('c1');
  lowered.advance(30 * MIN);
  lowered.ctl.tick();
  assert.equal(a.sent.length, 0);
  lowered.setting.value = 20;
  lowered.ctl.tick();
  assert.equal(a.sent.length, 1, 'lowered below the elapsed time: fires');
  assert.match(parseIdleRenewNudge(a.sent[0].text).summary, /idle 30 min/, 'names the elapsed minutes, not the threshold');
  assert.doesNotMatch(a.sent[0].text, /idle 20 min/);

  const raised = rig({ value: 20 });
  const b = raised.add('c1');
  raised.turnEnd('c1');
  raised.advance(30 * MIN);
  raised.setting.value = 45;
  raised.ctl.tick();
  assert.equal(b.sent.length, 0, 'raised above the elapsed time: waits');
});

// INVARIANT: suspend() blocks firing (the restart drain) until resume().
test('no nudge while suspended; it fires after resume', () => {
  const r = rig();
  const inst = r.add('c1');
  r.turnEnd('c1');
  r.ctl.suspend();
  assert.equal(r.timers.live().length, 0, 'suspend stops the sweep');
  r.advance(THRESHOLD * MIN);
  r.ctl.tick();
  assert.equal(inst.sent.length, 0);
  r.ctl.resume();
  assert.equal(r.timers.live().length, 1, 'resume restarts it');
  r.ctl.tick();
  assert.equal(inst.sent.length, 1);
});

// INVARIANT: a relaunch (no proc, exited, relaunching) keeps an unspent stretch,
// which fires once the relaunch lands.
test('a stretch survives a relaunch window and fires after it completes', () => {
  const r = rig();
  const inst = r.add('c1');
  r.turnEnd('c1');
  r.advance(THRESHOLD * MIN);
  Object.assign(inst, { proc: null, status: 'exited', relaunching: true });
  r.ctl.tick();
  assert.equal(inst.sent.length, 0, 'no send mid-relaunch');
  assert.equal(r.timers.live().length, 1, 'the stretch is still unspent, so the sweep keeps running');
  Object.assign(inst, { proc: {}, status: 'idle', relaunching: false });
  r.advance(MIN);
  r.ctl.tick();
  assert.equal(inst.sent.length, 1);
});

// INVARIANT: a dead or removed instance's stretch is dropped, not retried forever.
test('a dead or removed instance drops its stretch', async (t) => {
  for (const [label, kill] of [
    ['exited', (r, i) => { i.status = 'exited'; i.proc = null; }],
    ['removed from byId', (r) => { r.manager.byId.delete('c1'); }],
  ]) {
    await t.test(label, () => {
      const r = rig();
      const inst = r.add('c1');
      r.turnEnd('c1');
      r.advance(THRESHOLD * MIN);
      kill(r, inst);
      r.ctl.tick();
      assert.equal(inst.sent.length, 0);
      assert.equal(r.timers.live().length, 0, 'no stretch left to sweep for');
      r.manager.byId.set('c1', Object.assign(inst, { status: 'idle', proc: {} }));
      r.ctl.tick();
      assert.equal(inst.sent.length, 0, 'the dropped stretch never comes back');
    });
  }
});

// INVARIANT: a failed send is reported on the conductor's stream, not swallowed.
test('a rejected nudge send surfaces a stderr line', async () => {
  const r = rig();
  const inst = r.add('c1', { prompt() { return Promise.reject(new Error('not running')); } });
  r.turnEnd('c1');
  r.advance(THRESHOLD * MIN);
  r.ctl.tick();
  await waitFor(() => inst.emitted.length > 0);
  assert.equal(inst.emitted[0].subtype, 'stderr');
  assert.match(inst.emitted[0].data.line, /idle-renewal nudge delivery failed: not running/);
});

// ── end to end: manager + route + fake CLI ──────────────────────────────────

const SCENARIO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'scenario-text-no-ask.json');

// INVARIANT: on the real wiring, a saved setting plus an elapsed clock delivers
// the nudge to a top-level conductor only, and its turn end counts nowhere —
// neither liveTurnEnds nor the stored unread turn marks.
test('end to end: a saved setting nudges an idle conductor, never a non-conductor session, and the nudge turn is silent', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const { baseUrl, instances } = ctx;
    let now = Date.now();
    instances.idleNudgeNow = () => now;
    instances.idleNudgeTimers = fakeTimers();

    await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
    const c = await api(baseUrl, 'POST', '/api/instances', { project: '.conduct', temp: true, mode: 'bypassPermissions' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const conductor = instances.get(c.body.id);
    await api(baseUrl, 'POST', '/api/projects', { name: 'nudge-worker' });
    const w = await api(baseUrl, 'POST', '/api/instances', { project: 'nudge-worker', temp: true, mode: 'bypassPermissions' });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    const worker = instances.get(w.body.id);
    await waitFor(() => conductor.status === 'idle' && worker.status === 'idle');

    for (const inst of [conductor, worker]) {
      await inst.prompt('do the first pass');
      await waitFor(() => inst.status === 'idle' && inst.summary().liveTurnEnds === 1);
    }

    await settleSessionWrites();
    const marksBefore = (await getTurnMarks(conductor.sessionId)).turnEndSeq;
    assert.ok(marksBefore >= 1, 'premise: the real turn end was recorded as unread');

    const saved = await api(baseUrl, 'POST', '/api/settings/models/prefs', { conductorIdleNudge: { enabled: true, value: THRESHOLD } });
    assert.equal(saved.status, 200);
    now += THRESHOLD * MIN;
    instances._idleRenewNudge.tick();

    const echoes = (inst) => inst.ringSnapshot().filter(e => e.kind === 'user_echo' && String(e.text).startsWith(IDLE_NUDGE_MARKER));
    await waitFor(() => echoes(conductor).length === 1 && conductor.status === 'idle');
    await waitFor(() => conductor.lastTurnEndWasNudgeChain);
    assert.equal(conductor.summary().liveTurnEnds, 1, 'the nudge turn end is not counted');
    await settleSessionWrites();
    assert.equal((await getTurnMarks(conductor.sessionId)).turnEndSeq, marksBefore, 'nor recorded as unread');
    assert.equal(echoes(worker).length, 0, 'the non-conductor session is never nudged');
  } finally {
    await ctx.instances.shutdown();
    await ctx.close();
  }
});
