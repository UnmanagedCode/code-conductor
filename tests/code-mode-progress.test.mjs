// The progress cadence (src/codeMode/progressPump.ts), on a fake clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startProgressPump } from '../src/codeMode/progressPump.ts';
import { PROGRESS_LINE_CAP } from '../src/codeMode/limits.ts';

function rig({ heartbeatMs = 1000, minIntervalMs = 100 } = {}) {
  let t = 0;
  const timers = new Map();
  let nextId = 1;
  const events = [];
  const pump = startProgressPump({
    emit: (progress, message) => events.push({ progress, message, at: t }),
    heartbeatMs, minIntervalMs,
    now: () => t,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, due: t + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
  });
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, v]) => v.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      timers.delete(next[0]);
      t = next[1].due;
      next[1].fn();
    }
    t = end;
  };
  return { pump, events, advance, timers };
}

test('emits "started" at once, then a heartbeat every heartbeatMs of silence', () => {
  const { events, advance } = rig();
  assert.deepEqual(events.map(e => e.message), ['started']);
  advance(2500);
  assert.deepEqual(events.map(e => e.at), [0, 1000, 2000]);
});

test('progress is the elapsed ms and strictly increases', () => {
  const { pump, events, advance } = rig({ minIntervalMs: 0 });
  pump.onOutput('a\n');
  pump.onOutput('b\n');
  advance(1000);
  const p = events.map(e => e.progress);
  assert.deepEqual(p, [...p].sort((a, b) => a - b));
  assert.equal(new Set(p).size, p.length, 'no two events share a progress value');
});

test('output is throttled to minIntervalMs and a trailing emit carries the latest line', () => {
  const { pump, events, advance } = rig({ heartbeatMs: 10_000, minIntervalMs: 100 });
  advance(150);
  pump.onOutput('first\n');
  assert.equal(events.length, 2, 'past the interval: emitted now');
  assert.match(events[1].message, /first$/);
  pump.onOutput('second\n');
  pump.onOutput('third\n');
  assert.equal(events.length, 2, 'inside the interval: held back');
  advance(100);
  assert.equal(events.length, 3, 'one trailing emit');
  assert.match(events[2].message, /third$/, 'the latest line, not the first held one');
});

test('the message is elapsed time plus the last non-empty line, cut at the line cap', () => {
  const { pump, events, advance } = rig({ heartbeatMs: 10_000, minIntervalMs: 0 });
  advance(65_000);
  pump.onOutput('x'.repeat(PROGRESS_LINE_CAP + 50) + '\n\n');
  const last = events.at(-1).message;
  assert.ok(last.startsWith('1m5s · '), last);
  assert.equal(last.length, '1m5s · '.length + PROGRESS_LINE_CAP);
});

test('a multi-line chunk reports its last non-empty line', () => {
  const { pump, events, advance } = rig({ heartbeatMs: 10_000, minIntervalMs: 0 });
  advance(1000);
  pump.onOutput('first\nsecond\n');
  assert.match(events.at(-1).message, / · second$/);
});

test('with no output the message is the elapsed time alone', () => {
  const { events, advance } = rig();
  advance(1000);
  assert.equal(events.at(-1).message, '0m1s');
});

test('stop() clears every timer and silences later output', () => {
  const { pump, events, advance, timers } = rig({ minIntervalMs: 100 });
  pump.onOutput('x\n');
  pump.stop();
  assert.equal(timers.size, 0);
  const n = events.length;
  pump.onOutput('y\n');
  advance(5000);
  assert.equal(events.length, n);
});
