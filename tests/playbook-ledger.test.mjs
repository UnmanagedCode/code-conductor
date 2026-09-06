// The append-only ledger and the projection folded from it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createPlaybookLedger, ledgerFile, foldProjection, readEvents,
  runMembers, runRootOf, sameRun, liveSessionsInStage, hasEverBeen,
} from '../src/playbookLedger.ts';

async function tmpLedger() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pbledger-'));
  const file = path.join(dir, 'nested', 'playbook-ledger.jsonl');
  return { dir, file, ledger: createPlaybookLedger({ file: () => file }) };
}

function fold(events) {
  return foldProjection(events.map((e, i) => ({ seq: i + 1, ts: `2026-08-05T00:00:0${i % 10}Z`, ...e })));
}

// ── the store path (a hard requirement, not a style note) ───────────────────

test('the default store path resolves LAZILY, per call, from PROJECTS_ROOT', async () => {
  const before = process.env.PROJECTS_ROOT;
  try {
    process.env.PROJECTS_ROOT = '/tmp/cc-lazy-a';
    const a = ledgerFile();
    process.env.PROJECTS_ROOT = '/tmp/cc-lazy-b';
    const b = ledgerFile();
    assert.notEqual(a, b, 'ledgerFile() must re-resolve each call, not cache a module-load value');
    assert.equal(a, path.join('/tmp/cc-lazy-a', '.code-conductor', 'playbook-ledger.jsonl'));
    assert.equal(b, path.join('/tmp/cc-lazy-b', '.code-conductor', 'playbook-ledger.jsonl'));
    // The default ledger delegates to that same function rather than a snapshot.
    assert.equal(createPlaybookLedger().file(), b);
  } finally {
    if (before === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = before;
  }
});

test('appends land ONLY in the injected file — nothing is written to the default path', async () => {
  const { dir, file, ledger } = await tmpLedger();
  try {
    await ledger.load();
    await ledger.append({ kind: 'spawn', sessionId: 's1', playbook: 'solo', stage: 'plan' });
    assert.equal((await fs.readFile(file, 'utf8')).trim().split('\n').length, 1);
    // the real store path must not have been created by this test
    await assert.rejects(() => fs.stat(ledgerFile()), /ENOENT/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('append is append-only JSONL: one line per event, prior lines untouched', async () => {
  const { dir, file, ledger } = await tmpLedger();
  try {
    await ledger.load();
    const a = await ledger.append({ kind: 'spawn', sessionId: 's1', playbook: 'solo', stage: 'plan' });
    const firstLine = (await fs.readFile(file, 'utf8')).split('\n')[0];
    const b = await ledger.append({ kind: 'transition', sessionId: 's1', from: 'plan', to: 'implement', via: 'approve_plan' });
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], firstLine, 'an append must not rewrite the existing document');
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    assert.ok(a.ts && b.ts, 'each event carries a ts');
    // NO definition hash on the spawn event — definitions are deliberately not
    // pinned to a run (settled: let live workers drift onto the reloaded graph).
    assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(),
      ['kind', 'playbook', 'seq', 'sessionId', 'stage', 'ts']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ── fold ───────────────────────────────────────────────────────────────────

test('fold builds the projection across all five event kinds', () => {
  const p = fold([
    { kind: 'spawn', sessionId: 's1', playbook: 'solo', stage: 'plan', project: 'demo', worktree: 'demo_wt' },
    { kind: 'transition', sessionId: 's1', from: 'plan', to: 'implement', via: 'approve_plan' },
    { kind: 'refusal', sessionId: 's1', tool: 'describe_session', code: 'TOOL_DENIED_IN_STAGE', reason: 'nope' },
    // `from: 'off'` on purpose: the ledger is an append-only record of what WAS
    // true, and 'off' was a level before it was retired. The fold stores the mode
    // as a bare string precisely so history stays readable after the live
    // allow-list narrows — nothing rewrites past events.
    { kind: 'enforcement', conductorSessionId: 'c1', from: 'off', to: 'enforce' },
    { kind: 'spawn', sessionId: 's2', playbook: 'solo', stage: 'review', provenance: { implement: 's1' } },
    { kind: 'retire', sessionId: 's2', reason: 'killed' },
  ]);
  const s1 = p.bySession.get('s1');
  assert.equal(s1.stage, 'implement');
  assert.deepEqual(s1.stageHistory, ['plan', 'implement']);
  assert.equal(s1.project, 'demo');
  assert.equal(s1.worktree, 'demo_wt');
  // `retire` is audit-only — it must not touch s2's stage or provenance. Liveness
  // is answered from InstanceManager.isSessionLive, never folded here.
  assert.equal(p.bySession.get('s2').stage, 'review', 'retire must not touch stage');
  assert.deepEqual(p.bySession.get('s2').provenance, { implement: 's1' });
  assert.equal(p.enforcement.get('c1'), 'enforce', 'enforcement events fold into the projection');
  assert.equal(p.seq, 6);
  // a refusal is audit-only: it changed no worker state
  assert.equal(p.bySession.size, 2);
});

test('retire preserves stageHistory, so a retired worker still answers a need\'s provenance half', () => {
  const p = fold([
    { kind: 'spawn', sessionId: 's1', playbook: 'solo', stage: 'plan' },
    { kind: 'transition', sessionId: 's1', from: 'plan', to: 'implement', via: 'approve_plan' },
    { kind: 'retire', sessionId: 's1', reason: 'killed' },
  ]);
  assert.equal(p.bySession.get('s1').stage, 'implement', 'retire must not touch stage');
  assert.equal(hasEverBeen(p, 's1', 'plan'), true);
  assert.equal(hasEverBeen(p, 's1', 'implement'), true);
  assert.equal(hasEverBeen(p, 's1', 'review'), false);
});

test('stageHistory records every entry in order, including a re-entered stage', () => {
  const p = fold([
    { kind: 'spawn', sessionId: 's1', playbook: 'x', stage: 'a' },
    { kind: 'transition', sessionId: 's1', from: 'a', to: 'b', via: 'send_prompt' },
    { kind: 'transition', sessionId: 's1', from: 'b', to: 'a', via: 'send_prompt' },
  ]);
  assert.deepEqual(p.bySession.get('s1').stageHistory, ['a', 'b', 'a']);
  assert.equal(p.bySession.get('s1').stage, 'a');
});

test('liveSessionsInStage filters by the SUPPLIED isLive oracle, not by anything folded from the ledger', () => {
  const events = [
    { kind: 'spawn', sessionId: 'root', playbook: 'x', stage: 'a' },
    { kind: 'spawn', sessionId: 'w1', playbook: 'x', stage: 'b', provenance: { a: 'root' } },
    { kind: 'spawn', sessionId: 'w2', playbook: 'x', stage: 'b', provenance: { a: 'root' } },
  ];
  const p = fold(events);
  assert.deepEqual(liveSessionsInStage(p, 'root', 'b', () => true).sort(), ['w1', 'w2']);
  // The SAME projection — no retire event anywhere in it — reads w1 as gone the
  // moment the oracle says so. Pins that liveness is an external input, not a
  // ledger-side fold: a mutant reading a projection-derived bit instead of
  // calling isLive would return ['w1', 'w2'] here regardless of the oracle.
  assert.deepEqual(liveSessionsInStage(p, 'root', 'b', sid => sid !== 'w1'), ['w2']);
});

test('`retire` and `resume` are audit-only: neither touches stage, stageHistory, provenance or run membership', () => {
  // Implementing the resume as a second `spawn` instead — the obvious shortcut,
  // since a resume comes in through spawn_instance — would fold through the spawn
  // arm and REPLACE this state: stageHistory collapses to ['implement'] and
  // provenance empties, which silently breaks hasEverBeen for every downstream
  // `needs`. Neither event carries a liveness bit any more — that question is
  // answered from InstanceManager.isSessionLive, never from this projection.
  const events = [
    { kind: 'spawn', sessionId: 'root', playbook: 'solo', stage: 'plan' },
    { kind: 'spawn', sessionId: 'w1', playbook: 'solo', stage: 'plan' },
    { kind: 'transition', sessionId: 'w1', from: 'plan', to: 'implement', via: 'approve_plan',
      provenance: { plan: 'root' } },
    { kind: 'retire', sessionId: 'w1', reason: 'subprocess exited' },
  ];
  const dead = fold(events).bySession.get('w1');
  assert.equal(dead.stage, 'implement', 'retire must not touch stage');
  assert.deepEqual(dead.stageHistory, ['plan', 'implement'], 'retire must not touch stageHistory');
  assert.deepEqual(dead.provenance, { plan: 'root' }, 'retire must not touch provenance');
  assert.equal(dead.runRoot, 'root', 'retire must not touch run membership');

  const back = fold([...events, { kind: 'resume', sessionId: 'w1' }]);
  const st = back.bySession.get('w1');
  assert.equal(st.stage, 'implement');
  assert.deepEqual(st.stageHistory, ['plan', 'implement'], 'stageHistory must survive the resume');
  assert.deepEqual(st.provenance, { plan: 'root' }, 'the run-graph edges must survive the resume');
  assert.equal(st.runRoot, 'root', 'run membership must survive the resume');
  assert.equal(hasEverBeen(back, 'w1', 'plan'), true,
    'a downstream `needs` anchored on `plan` must still be satisfiable after a resume');
  // The slot it holds is counted whenever the oracle says so — the fold itself
  // carries no opinion.
  assert.deepEqual(liveSessionsInStage(back, 'root', 'implement', () => true), ['w1']);
});

test('a `resume` for an unknown worker is folded as a no-op rather than materialising one', () => {
  const p = fold([{ kind: 'resume', sessionId: 'ghost' }]);
  assert.equal(p.bySession.size, 0, 'a resume must never invent a worker with no binding');
});

// ── run components ─────────────────────────────────────────────────────────

test('run membership is the connected component over `needs` edges', () => {
  const p = fold([
    { kind: 'spawn', sessionId: 'A-root', playbook: 'solo', stage: 'plan' },
    { kind: 'spawn', sessionId: 'A-rev', playbook: 'solo', stage: 'review', provenance: { implement: 'A-root' } },
    { kind: 'spawn', sessionId: 'B-root', playbook: 'solo', stage: 'plan' },
    { kind: 'spawn', sessionId: 'B-rev', playbook: 'solo', stage: 'review', provenance: { implement: 'B-root' } },
  ]);
  assert.deepEqual(runMembers(p, 'A-root').sort(), ['A-rev', 'A-root']);
  assert.deepEqual(runMembers(p, 'B-rev').sort(), ['B-rev', 'B-root']);
  assert.equal(sameRun(p, 'A-root', 'A-rev'), true);
  assert.equal(sameRun(p, 'A-root', 'B-root'), false, 'two concurrent runs must stay distinct components');
  assert.notEqual(runRootOf(p, 'A-rev'), runRootOf(p, 'B-rev'));
  assert.equal(p.bySession.get('A-rev').runRoot, 'A-root');
  assert.equal(runRootOf(p, 'never-seen'), null);
  assert.deepEqual(runMembers(p, 'never-seen'), []);
});

test('a transition-carried needs edge also joins the run', () => {
  const p = fold([
    { kind: 'spawn', sessionId: 'root', playbook: 'x', stage: 'a' },
    { kind: 'spawn', sessionId: 'other', playbook: 'x', stage: 'a' },
    { kind: 'transition', sessionId: 'other', from: 'a', to: 'b', via: 'send_prompt', provenance: { a: 'root' } },
  ]);
  assert.equal(sameRun(p, 'root', 'other'), true);
  assert.deepEqual(p.bySession.get('other').provenance, { a: 'root' });
});

test('a transition for an unknown worker is folded as a no-op rather than throwing', () => {
  const p = fold([{ kind: 'transition', sessionId: 'ghost', from: 'a', to: 'b', via: 'send_prompt' }]);
  assert.equal(p.bySession.size, 0);
});

// ── durability ─────────────────────────────────────────────────────────────

test('state survives a restart: a fresh ledger folds the same projection from disk', async () => {
  const { dir, file } = await tmpLedger();
  try {
    const first = createPlaybookLedger({ file: () => file });
    await first.load();
    await first.append({ kind: 'spawn', sessionId: 's1', playbook: 'solo', stage: 'plan' });
    await first.append({ kind: 'transition', sessionId: 's1', from: 'plan', to: 'implement', via: 'approve_plan' });
    await first.append({ kind: 'spawn', sessionId: 's2', playbook: 'solo', stage: 'review', provenance: { implement: 's1' } });
    await first.append({ kind: 'enforcement', conductorSessionId: 'c1', from: 'warn', to: 'enforce' });

    // A new process: nothing in memory, everything folded from the file.
    const second = createPlaybookLedger({ file: () => file });
    const p = await second.load();
    assert.equal(p.bySession.get('s1').stage, 'implement');
    assert.deepEqual(p.bySession.get('s1').stageHistory, ['plan', 'implement']);
    assert.equal(sameRun(p, 's1', 's2'), true);
    assert.equal(p.enforcement.get('c1'), 'enforce');
    assert.equal(p.seq, 4);
    // seq continues from the folded high-water mark rather than restarting at 1
    assert.equal((await second.append({ kind: 'retire', sessionId: 's2', reason: 'killed' })).seq, 5);
    assert.equal(second.projection().bySession.get('s2').stage, 'review',
      'the live projection is updated through the same applyEvent path as the fold, and retire leaves stage untouched');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a missing ledger file folds to an empty projection', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pbledger-'));
  try {
    const p = await createPlaybookLedger({ file: () => path.join(dir, 'absent.jsonl') }).load();
    assert.equal(p.bySession.size, 0);
    assert.equal(p.seq, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a torn or malformed line is skipped, not thrown — one bad line must not hide every worker', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pbledger-'));
  const file = path.join(dir, 'ledger.jsonl');
  try {
    await fs.writeFile(file,
      JSON.stringify({ seq: 1, ts: 't', kind: 'spawn', sessionId: 's1', playbook: 'solo', stage: 'plan' }) + '\n' +
      '[1,2,3]\n' +
      JSON.stringify({ seq: 2, ts: 't', noKind: true }) + '\n' +
      JSON.stringify({ seq: 3, ts: 't', kind: 'transition', sessionId: 's1', from: 'plan', to: 'implement', via: 'approve_plan' }) + '\n' +
      '{"seq":4,"ts":"t","kind":"spaw',  // torn trailing write, no newline
      'utf8');
    const events = await readEvents(file);
    assert.equal(events.length, 2, 'the two well-formed events survive');
    const p = foldProjection(events);
    assert.equal(p.bySession.get('s1').stage, 'implement');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
