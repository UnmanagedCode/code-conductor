// Migration 0041: playbook-ledger.jsonl → events.jsonl. Pins the mapping row
// by row, that the converted rows fold to the playbook state the old fold
// produced, the move-aside, idempotence, crash resume, and the refusal when
// both files exist and differ.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as m0041 from '../migrations/0041-event-log.mjs';
import { runMigrations } from '../migrations/index.mjs';
import { readEventLog } from '../src/eventLog.ts';
import { equivalenceSides } from './legacy-ledger-oracle.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

// The whole chain runs below, and migration 0004 reads $HOME — never the real one.
process.env.HOME = await mkdtemp('cc-mig41-home-');

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'playbook-ledger-0041.jsonl');
const RAW = await fs.readFile(FIXTURE, 'utf8');

async function mkRoot() {
  const root = await mkdtemp('cc-m0041-');
  await fs.mkdir(path.join(root, '.code-conductor'), { recursive: true });
  await fs.writeFile(path.join(root, '.code-conductor', 'playbook-ledger.jsonl'), RAW);
  return root;
}
const store = (root) => path.join(root, '.code-conductor');
const newFile = (root) => path.join(store(root), 'events.jsonl');
const oldFile = (root) => path.join(store(root), 'playbook-ledger.jsonl');
const backup = (root) => path.join(store(root), 'migrated-backup-0041', 'playbook-ledger.jsonl');
const exists = (p) => fs.access(p).then(() => true, () => false);

const C1 = 'c1000000-0000-4000-8000-000000000001';
const C2 = 'c2000000-0000-4000-8000-000000000002';
const W0 = 'w0000000-0000-4000-8000-000000000000';
const W2 = 'w2000000-0000-4000-8000-000000000002';
const W3 = 'w3000000-0000-4000-8000-000000000003';
const GHOST = 'ghost000-0000-4000-8000-000000000000';
const ts = (s) => `2026-08-06T05:00:${String(s).padStart(2, '0')}.000Z`;
const COND = { type: 'conductor' };
const SYS = { type: 'system' };

// One expected row per fixture line, in file order; the unknown kind and the
// torn last line are skipped.
const EXPECTED = [
  { v: 1, ts: ts(0), kind: 'config', actor: SYS, subject: C1, key: 'enforcement', to: 'warn' },
  { v: 1, ts: ts(1), kind: 'config', actor: SYS, subject: C1, key: 'enforcement', from: 'off', to: 'warn' },
  { v: 1, ts: ts(2), kind: 'call', actor: COND, tool: 'spawn_instance', outcome: 'refused',
    refusal: { code: 'PLAYBOOK_UNKNOWN', reason: 'this spawn has no `needs`, so it starts a new run and must name a `playbook`.' } },
  { v: 1, ts: ts(3), kind: 'call', actor: COND, subject: W0, tool: 'spawn_instance', outcome: 'ok', bind: { playbook: 'classic', stage: 'plan', project: 'demo', worktree: 'wt-a' } },
  { v: 1, ts: ts(4), kind: 'call', actor: COND, subject: W0, tool: 'spawn_instance', outcome: 'ok', bind: { playbook: 'classic', stage: 'plan', project: 'demo', worktree: 'wt-a' } },
  { v: 1, ts: ts(5), kind: 'call', actor: COND, subject: W2, tool: 'spawn_instance', outcome: 'ok', bind: { playbook: 'classic', stage: 'review', provenance: { implement: W0 }, project: 'demo' } },
  { v: 1, ts: ts(6), kind: 'call', actor: COND, subject: W0, tool: 'approve_plan', outcome: 'ok', move: { from: 'plan', to: 'implement' } },
  { v: 1, ts: ts(7), kind: 'call', actor: COND, subject: W0, tool: 'send_prompt', outcome: 'ok', forward: W2 },
  { v: 1, ts: ts(8), kind: 'call', actor: COND, subject: W0, tool: 'send_prompt', outcome: 'ok' },
  { v: 1, ts: ts(9), kind: 'call', actor: COND, subject: W0, tool: 'send_prompt', outcome: 'ok', move: { from: 'implement', to: 'refine', provenance: { review: W2 } } },
  { v: 1, ts: ts(10), kind: 'call', actor: COND, subject: W0, tool: 'send_prompt', outcome: 'refused', refusal: { code: 'TRANSITION_ILLEGAL', reason: 'no edge refine -> plan' }, forward: W2 },
  { v: 1, ts: ts(11), kind: 'call', actor: { type: 'conductor', sessionId: C1 }, subject: W2, tool: 'set_mode', outcome: 'ok' },
  { v: 1, ts: ts(12), kind: 'call', actor: { type: 'conductor', sessionId: C1 }, subject: W2, tool: 'send_prompt', outcome: 'ok', forward: W0 },
  { v: 1, ts: ts(13), kind: 'session', actor: SYS, subject: W2, event: 'exit', cause: 'exited' },
  { v: 1, ts: ts(14), kind: 'session', actor: SYS, subject: W2, event: 'resume' },
  { v: 1, ts: ts(15), kind: 'wake', actor: SYS, subject: W2, recipient: C1, heartbeat: true },
  { v: 1, ts: ts(16), kind: 'wake', actor: SYS, subject: W0, recipient: C1 },
  { v: 1, ts: ts(17), kind: 'session', actor: SYS, subject: W0, event: 'exit', cause: 'crashed' },
  { v: 1, ts: ts(18), kind: 'session', actor: SYS, subject: W3, event: 'exit', cause: 'orphaned' },
  { v: 1, ts: ts(19), kind: 'config', actor: SYS, subject: C1, key: 'enforcement', from: 'warn', to: 'enforce' },
  { v: 1, ts: ts(20), kind: 'config', actor: SYS, subject: C2, key: 'enforcement', to: 'off' },
  { v: 1, ts: ts(21), kind: 'config', actor: SYS, subject: C1, key: 'enforcement', to: 'enforce' },
  { v: 1, ts: ts(22), kind: 'call', actor: COND, subject: GHOST, tool: 'approve_plan', outcome: 'ok', move: { from: 'plan', to: 'implement' } },
];

test('the mapping, row by row: kinds, actors, subjects, causes, the self-loop without move, dropped needs and seq, line order and ts kept', async () => {
  const root = await mkRoot();
  const r = await m0041.run({ root });
  assert.equal(r.applied, true);
  const lines = (await fs.readFile(newFile(root), 'utf8')).split('\n').filter(Boolean);
  assert.deepEqual(lines.map(l => JSON.parse(l)), EXPECTED);
  // Fixed key order: the envelope first, exactly as the writer serialises it.
  for (const l of lines) assert.deepEqual(Object.keys(JSON.parse(l)).slice(0, 4), ['v', 'ts', 'kind', 'actor']);
  for (const l of lines) assert.ok(!/"seq"|"needs"|null/.test(l), l);
  assert.deepEqual(r.summary, {
    rows: EXPECTED.length,
    byKind: { config: 5, call: 12, session: 4, wake: 2 },
    skippedMalformed: 1, skippedUnknown: 1, droppedNeeds: 2, selfLoops: 2, droppedSelfLoopProvenance: 0,
  });
  // The converted file is valid event-log input for the real reader.
  assert.equal((await readEventLog(newFile(root))).length, EXPECTED.length);
});

test('EQUIVALENCE: the converted rows fold to the old fold\'s state — stageHistory with consecutive repeats collapsed, everything else exact', async () => {
  const root = await mkRoot();
  await m0041.run({ root });
  const { legacy, converted } = equivalenceSides(RAW, await fs.readFile(newFile(root), 'utf8'));
  assert.deepEqual(converted, legacy);
  // Premises — the fixture exercises what the comparison is about.
  assert.deepEqual(converted.sessions[W0].stageHistory, ['plan', 'implement', 'refine']);
  assert.deepEqual(converted.sessions[W0].provenance, { review: W2 });
  assert.equal(converted.sessions[W2].runRoot, converted.sessions[W0].runRoot);
  assert.deepEqual(converted.enforcement, { [C1]: 'enforce', [C2]: 'off' });
});

test('the old file is moved aside byte-identical into migrated-backup-0041/, and a re-run is a no-op', async () => {
  const root = await mkRoot();
  await m0041.run({ root });
  assert.equal(await exists(oldFile(root)), false);
  assert.equal(await fs.readFile(backup(root), 'utf8'), RAW);
  const after = await fs.readFile(newFile(root), 'utf8');
  assert.deepEqual(await m0041.run({ root }), { applied: false });
  assert.equal(await fs.readFile(newFile(root), 'utf8'), after);
});

test('a self-loop that carried a provenance loses it with its move, and is counted', () => {
  const raw = JSON.stringify({ seq: 1, ts: ts(1), kind: 'transition', sessionId: W0, from: 'refine', to: 'refine', via: 'send_prompt', provenance: { review: W2 } }) + '\n';
  const { text, summary } = m0041.convertLedger(raw);
  assert.deepEqual(JSON.parse(text), { v: 1, ts: ts(1), kind: 'call', actor: COND, subject: W0, tool: 'send_prompt', outcome: 'ok' });
  assert.equal(summary.selfLoops, 1);
  assert.equal(summary.droppedSelfLoopProvenance, 1);
});

test('no ledger file at all → applied:false, and nothing is created', async () => {
  const root = await mkdtemp('cc-m0041-empty-');
  assert.deepEqual(await m0041.run({ root }), { applied: false });
  assert.equal(await exists(newFile(root)), false);
});

test('crash resume: an events.jsonl identical to the conversion, old file still present → the move-aside completes', async () => {
  const root = await mkRoot();
  const { text } = m0041.convertLedger(RAW);
  await fs.writeFile(newFile(root), text);
  const r = await m0041.run({ root });
  assert.equal(r.applied, true);
  assert.equal(await fs.readFile(newFile(root), 'utf8'), text);
  assert.equal(await exists(oldFile(root)), false);
  assert.equal(await fs.readFile(backup(root), 'utf8'), RAW);
});

test('a backup name already taken gets a timestamp suffix rather than overwriting it', async () => {
  const root = await mkRoot();
  await fs.mkdir(path.dirname(backup(root)), { recursive: true });
  await fs.writeFile(backup(root), 'an earlier backup');
  await m0041.run({ root });
  assert.equal(await fs.readFile(backup(root), 'utf8'), 'an earlier backup');
  const names = await fs.readdir(path.dirname(backup(root)));
  const stamped = names.filter(n => /^playbook-ledger\.jsonl-\d+$/.test(n));
  assert.equal(stamped.length, 1);
  assert.equal(await fs.readFile(path.join(path.dirname(backup(root)), stamped[0]), 'utf8'), RAW);
});

test('STRAGGLER: a ledger recreated after the conversion (an old server\'s late exit rows) is moved aside unconverted and boot continues', async () => {
  // INVARIANT: once events.jsonl and the backup both exist, a reappearing
  // playbook-ledger.jsonl never aborts boot and never touches events.jsonl.
  const root = await mkRoot();
  await m0041.run({ root });
  const events = await fs.readFile(newFile(root), 'utf8');
  const straggler = JSON.stringify({ seq: 99, ts: ts(59), kind: 'retire', sessionId: W0, reason: 'subprocess exited' }) + '\n';
  await fs.writeFile(oldFile(root), straggler);
  const logs = [];
  const r = await m0041.run({ root, log: (m) => logs.push(m) });
  assert.equal(r.applied, true);
  assert.equal(r.summary.straggler, true);
  assert.equal(r.summary.lines, 1);
  assert.match(path.basename(r.summary.movedTo), /^playbook-ledger\.straggler-\d+\.jsonl$/);
  assert.equal(path.dirname(r.summary.movedTo), path.dirname(backup(root)));
  assert.equal(await fs.readFile(r.summary.movedTo, 'utf8'), straggler, 'moved byte-for-byte, unconverted');
  assert.equal(await exists(oldFile(root)), false);
  assert.equal(await fs.readFile(newFile(root), 'utf8'), events, 'the event log is untouched');
  assert.equal(await fs.readFile(backup(root), 'utf8'), RAW, 'the original backup is untouched');
  assert.equal(logs.length, 1, 'the move is reported');
  // …and the whole chain over that store is silent afterwards.
  const chainLogs = [];
  await runMigrations({ root, log: (m) => chainLogs.push(m) });
  assert.deepEqual(chainLogs, []);
});

test('STRAGGLER, audit-only: every kind that converts to no playbook state is moved aside', async () => {
  // INVARIANT: retire, resume, wake, interaction, refusal and a same-stage
  // transition convert to session / wake / plain call rows — nothing a fold
  // reads — so such a straggler never blocks boot.
  const root = await mkRoot();
  await m0041.run({ root });
  const rows = [
    { kind: 'retire', sessionId: W0, reason: 'subprocess exited' },
    { kind: 'resume', sessionId: W0 },
    { kind: 'wake', sessionId: W0, conductorSessionId: C1 },
    { kind: 'interaction', tool: 'set_mode', sessionId: W0, conductorSessionId: C1 },
    { kind: 'refusal', tool: 'send_prompt', sessionId: W0, code: 'X', reason: 'y' },
    { kind: 'transition', sessionId: W0, from: 'refine', to: 'refine', via: 'send_prompt' },
  ];
  const straggler = rows.map((r, i) => JSON.stringify({ seq: 100 + i, ts: ts(i), ...r })).join('\n') + '\n';
  await fs.writeFile(oldFile(root), straggler);
  const r = await m0041.run({ root, log: () => {} });
  assert.equal(r.summary.straggler, true);
  assert.equal(r.summary.lines, rows.length);
  assert.equal(await fs.readFile(r.summary.movedTo, 'utf8'), straggler);
});

test('STRAGGLER holding playbook state — a spawn, a real transition or an enforcement row — is refused, and nothing moves', async (t) => {
  // INVARIANT: a straggler is only dropped when it carries no state the
  // projection would need; one row of binding, stage move or enforcement
  // makes it a conflict to resolve by hand.
  const cases = {
    spawn: { kind: 'spawn', sessionId: W3, playbook: 'classic', stage: 'plan' },
    transition: { kind: 'transition', sessionId: W0, from: 'refine', to: 'review', via: 'send_prompt' },
    enforcement: { kind: 'enforcement', conductorSessionId: C1, from: 'enforce', to: 'warn' },
  };
  for (const [kind, row] of Object.entries(cases)) {
    await t.test(kind, async () => {
      const root = await mkRoot();
      await m0041.run({ root });
      const events = await fs.readFile(newFile(root), 'utf8');
      const straggler = [
        JSON.stringify({ seq: 100, ts: ts(1), kind: 'retire', sessionId: W2, reason: 'subprocess exited' }),
        JSON.stringify({ seq: 101, ts: ts(2), ...row }),
      ].join('\n') + '\n';
      await fs.writeFile(oldFile(root), straggler);
      await assert.rejects(m0041.run({ root }), /holds playbook state .* resolve it by hand/);
      assert.equal(await fs.readFile(oldFile(root), 'utf8'), straggler, 'the straggler stays where it is');
      assert.equal(await fs.readFile(newFile(root), 'utf8'), events, 'the event log is untouched');
      const backups = await fs.readdir(path.dirname(backup(root)));
      assert.deepEqual(backups, ['playbook-ledger.jsonl'], 'nothing was moved aside');
    });
  }
});

test('a straggler through the whole chain: runMigrations does not throw on a recreated ledger', async () => {
  const root = await mkRoot();
  await runMigrations({ root, log: () => {} });
  await fs.writeFile(oldFile(root), JSON.stringify({ seq: 1, ts: ts(1), kind: 'retire', sessionId: W2, reason: 'subprocess exited' }) + '\n');
  await runMigrations({ root, log: () => {} });
  assert.equal(await exists(oldFile(root)), false);
});

test('CONFLICT: an events.jsonl that differs from the conversion, with NO backup yet, is refused: both files stay untouched', async () => {
  // INVARIANT: the throw is kept for the one genuine conflict — two files,
  // neither converted from the other.
  const root = await mkRoot();
  await fs.writeFile(newFile(root), '{"v":1,"ts":"2026-11-01T00:00:00Z","kind":"wake","actor":{"type":"system"},"subject":"x","recipient":"y"}\n');
  assert.equal(await exists(backup(root)), false, 'premise: no conversion has happened');
  const before = await fs.readFile(newFile(root), 'utf8');
  await assert.rejects(m0041.run({ root }), /both exist and differ/);
  assert.equal(await fs.readFile(newFile(root), 'utf8'), before);
  assert.equal(await fs.readFile(oldFile(root), 'utf8'), RAW);
});

test('the whole migration chain over the store, run twice: the second run is silent', async () => {
  const root = await mkRoot();
  await runMigrations({ root, log: () => {} });
  assert.equal(await exists(newFile(root)), true);
  const logs = [];
  await runMigrations({ root, log: (m) => logs.push(m) });
  assert.deepEqual(logs, []);
});
