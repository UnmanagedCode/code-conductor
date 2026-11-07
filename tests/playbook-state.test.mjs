// The playbook projection folded from event-log rows (src/playbookState.ts):
// only a `call` with `bind` or `move` and a `config` row change state; every
// other row is history. Pure — fixture rows, no filesystem — except the boot
// fold through a gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  foldPlaybookState, runRootOf, runMembers, sameRun, liveSessionsInStage, liveSessionsOnPlaybook, hasEverBeen, playbookBinding,
} from '../src/playbookState.ts';
import { createPlaybookGate } from '../src/mcp/playbookGate.ts';
import { proj, bindRow, moveRow, callRow, exitRow, resumeRow, OPEN_LEASE } from './playbook-fixtures.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

const config = (subject, to, from) => ({ kind: 'config', actor: { type: 'system' }, subject, key: 'enforcement', ...(from ? { from } : {}), to });

test('a bind creates the worker\'s state: playbook, stage, a one-entry stageHistory, provenance, project, worktree', () => {
  const p = proj([bindRow('w1', 'classic', 'plan', { project: 'demo', worktree: 'wt-1' })]);
  assert.deepEqual(p.bySession.get('w1'), {
    sessionId: 'w1', playbook: 'classic', stage: 'plan', stageHistory: ['plan'], provenance: {},
    runRoot: 'w1', project: 'demo', worktree: 'wt-1',
  });
});

test('a second bind for one session REPLACES its state — stageHistory and provenance start over', () => {
  const p = proj([
    bindRow('w1', 'classic', 'plan'),
    moveRow('w1', 'plan', 'implement', { provenance: { plan: 'x' } }),
    bindRow('w1', 'research', 'scope'),
  ]);
  const st = p.bySession.get('w1');
  assert.deepEqual([st.playbook, st.stage, st.stageHistory, st.provenance], ['research', 'scope', ['scope'], {}]);
});

test('a move sets the stage, appends it to stageHistory and merges its provenance into the worker\'s', () => {
  const p = proj([
    bindRow('a', 'pb', 'build'),
    bindRow('w', 'pb', 'plan', { provenance: { seed: 's1' } }),
    moveRow('w', 'plan', 'review', { provenance: { build: 'a' } }),
    moveRow('w', 'review', 'plan'),
  ]);
  const st = p.bySession.get('w');
  assert.equal(st.stage, 'plan');
  assert.deepEqual(st.stageHistory, ['plan', 'review', 'plan'], 'a re-entered stage is recorded again');
  assert.deepEqual(st.provenance, { seed: 's1', build: 'a' });
  assert.ok(sameRun(p, 'w', 'a'), 'a move\'s provenance joins the run');
});

test('a same-stage call (no move) folds nothing — stageHistory never repeats a stage', () => {
  const p = proj([bindRow('w', 'pb', 'refine'), callRow('w', 'send_prompt'), callRow('w', 'send_prompt')]);
  assert.deepEqual(p.bySession.get('w').stageHistory, ['refine']);
});

test('session, turn and wake rows and refused/failed calls fold nothing, even for an unknown session', () => {
  const rows = [
    bindRow('w', 'pb', 'plan'),
    exitRow('w'), resumeRow('w'), exitRow('ghost'), resumeRow('ghost'),
    { kind: 'turn', actor: { type: 'human' }, subject: 'w', event: 'start' },
    { kind: 'turn', actor: { type: 'system' }, subject: 'w', event: 'end', stopReason: 'end_turn' },
    { kind: 'wake', actor: { type: 'system' }, subject: 'w', recipient: 'c' },
    { kind: 'call', actor: { type: 'conductor', sessionId: 'c' }, subject: 'w', tool: 'send_prompt', outcome: 'refused', refusal: { code: 'X', reason: 'y' } },
    { kind: 'call', actor: { type: 'conductor', sessionId: 'c' }, tool: 'spawn_instance', outcome: 'failed', failure: { reason: 'z' } },
  ];
  assert.deepEqual(proj(rows), proj([bindRow('w', 'pb', 'plan')]));
  assert.equal(proj(rows).bySession.has('ghost'), false);
});

test('a move onto the stage the worker already holds folds nothing — stageHistory never repeats (defensive dedupe)', () => {
  const p = proj([
    bindRow('w', 'pb', 'plan'),
    moveRow('w', 'plan', 'impl', { provenance: { plan: 'x' } }),
    moveRow('w', 'plan', 'impl', { provenance: { other: 'y' } }),
  ]);
  const st = p.bySession.get('w');
  assert.deepEqual([st.stage, st.stageHistory, st.provenance], ['impl', ['plan', 'impl'], { plan: 'x' }]);
  assert.equal(sameRun(p, 'w', 'y'), false, 'the skipped move adds no run edge either');
});

test('a move for an unknown worker is folded as a no-op rather than materialising one', () => {
  const p = proj([moveRow('ghost', 'a', 'b')]);
  assert.equal(p.bySession.size, 0);
});

test('run membership is the connected component over provenance edges (union-find), refreshed on every bind/move', () => {
  const p = proj([
    bindRow('root', 'pb', 'plan'),
    bindRow('child', 'pb', 'impl', { provenance: { plan: 'root' } }),
    bindRow('grand', 'pb', 'review', { provenance: { impl: 'child' } }),
    bindRow('lone', 'pb', 'plan'),
  ]);
  assert.equal(runRootOf(p, 'grand'), 'root');
  assert.equal(p.bySession.get('grand').runRoot, 'root');
  assert.deepEqual(runMembers(p, 'child').sort(), ['child', 'grand', 'root']);
  assert.equal(sameRun(p, 'lone', 'root'), false);
  assert.equal(runRootOf(p, 'nobody'), null);
  assert.deepEqual(runMembers(p, 'nobody'), []);
});

test('a config row sets the conductor\'s enforcement level from `to` — a birth and a change by the same path', () => {
  const p = proj([config('c1', 'warn'), config('c2', 'enforce'), config('c1', 'enforce', 'warn')]);
  assert.deepEqual([...p.enforcement], [['c1', 'enforce'], ['c2', 'enforce']]);
});

test('the run-graph readers answer from the fold plus the SUPPLIED liveness oracle', () => {
  const p = proj([
    bindRow('a', 'pb', 'review'),
    bindRow('b', 'pb', 'review', { provenance: { x: 'a' } }),
    bindRow('c', 'other', 'plan'),
  ]);
  const live = new Set(['a']);
  assert.deepEqual(liveSessionsInStage(p, 'b', 'review', s => live.has(s)), ['a']);
  assert.deepEqual(liveSessionsOnPlaybook(p, 'pb', s => live.has(s)), ['a']);
  assert.equal(hasEverBeen(p, 'b', 'review'), true);
  assert.equal(hasEverBeen(p, 'b', 'plan'), false);
  assert.deepEqual(playbookBinding(p, 'c'), { playbook: 'other', stage: 'plan' });
  assert.deepEqual(playbookBinding(p, 'nope'), { playbook: null, stage: null });
  assert.deepEqual(playbookBinding(null, 'c'), { playbook: null, stage: null });
  assert.deepEqual(playbookBinding(p, 42), { playbook: null, stage: null });
});

test('foldPlaybookState over rows read from disk: a gate folds the file on first use; a missing file is an empty projection and creates nothing', async () => {
  const dir = await mkdtemp('cc-pbstate-');
  const missing = path.join(dir, 'none', 'events.jsonl');
  const empty = await createPlaybookGate({ instances: null, lease: OPEN_LEASE, file: () => missing }).readProjection();
  assert.equal(empty.bySession.size, 0);
  await assert.rejects(fs.access(missing), { code: 'ENOENT' });

  const file = path.join(dir, 'events.jsonl');
  const rows = [bindRow('w', 'pb', 'plan'), moveRow('w', 'plan', 'impl'), config('c', 'warn')]
    .map((r, i) => ({ v: 1, ts: `2026-11-01T00:00:0${i}Z`, ...r }));
  await fs.writeFile(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const p = await createPlaybookGate({ instances: null, lease: OPEN_LEASE, file: () => file }).readProjection();
  assert.deepEqual(p, foldPlaybookState(rows));
  assert.equal(p.bySession.get('w').stage, 'impl');
});
