// End-to-end REST coverage of the Prune flow:
//   GET  /api/instances/:id/prune/analysis
//   POST /api/instances/:id/prune
//
// The behaviours worth pinning here are the ones a reader would otherwise have
// to infer from the plan: the instanceId survives (only the sessionId rotates),
// the original jsonl is untouched and archived, and — the easiest thing to get
// wrong by copying renew_session — the pruned session comes back IDLE with
// nothing seeded as a first turn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';
import { encodeCwd } from '../src/projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-resume.json');
// scenario-instance's second turn hangs mid-stream (no turn_end), which is how
// the other lifecycle tests catch an instance in `turn` status.
const SCENARIO_HANG = path.join(__dirname, 'fixtures', 'scenario-instance.json');

const bigText = 'y'.repeat(4000);

function sessionLines() {
  return [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/x.ts' } },
    ] } },
    { type: 'user', uuid: 'r1', toolUseResult: { type: 'text' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: bigText }] } },
    { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [
      { type: 'text', text: 'first reply' },
    ] } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
    { type: 'assistant', uuid: 'a3', message: { id: 'm3', role: 'assistant', content: [
      { type: 'text', text: 'second reply' },
    ] } },
  ];
}

async function seedSession({ ctx, projectName, sid, lines }) {
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: projectName });
  const projectPath = path.join(ctx.projectsRoot, projectName);
  const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(projectPath));
  await fs.mkdir(sessionDir, { recursive: true });
  const file = path.join(sessionDir, `${sid}.jsonl`);
  await fs.writeFile(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return { projectPath, sessionDir, file };
}

test('prune rotates the sessionId in place, archives the original, and lands idle', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'aaaaaaa1-2222-3333-4444-555555555555';
    const { sessionDir, file } = await seedSession({
      ctx, projectName: 'prunable', sid, lines: sessionLines(),
    });
    const originalBytes = await fs.readFile(file);

    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'prunable', mode: 'bypassPermissions', resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const analysis = await api(ctx.baseUrl, 'GET', `/api/instances/${id}/prune/analysis`);
    assert.equal(analysis.status, 200);
    assert.equal(analysis.body.turnCount, 2);
    assert.ok(analysis.body.turns[0].toolOutput > 900, 'the big Read output is prunable');

    const resets = [];
    ctx.instances.on('snapshot_reset', (snap) => { if (snap.id === id) resets.push(snap); });

    const pr = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/prune`, {
      cutTurnIndex: 1, pruneThinking: true, inputMode: 'truncate',
    });
    assert.equal(pr.status, 200);
    assert.equal(pr.body.oldSessionId, sid);
    assert.ok(pr.body.newSessionId && pr.body.newSessionId !== sid);
    assert.ok(pr.body.saved.toolOutputs > 900);
    // The instanceId is the stable handle every side structure keys off — a
    // prune must not rotate it (only the sessionId rotates).
    assert.equal(pr.body.instance.id, id, 'same instance, new sessionId');

    const inst = ctx.instances.get(id);
    await waitFor(() => inst.status === 'idle');
    assert.equal(inst.sessionId, pr.body.newSessionId);
    assert.equal(resets.length, 1, 'snapshot_reset emitted exactly once');

    // Original untouched on disk…
    assert.deepEqual(await fs.readFile(file), originalBytes, 'original jsonl untouched');
    // …and archived, so it shows up under Settings → Archived rather than as a
    // stale live row.
    const { isArchived } = await import('../src/archivedSessions.js');
    assert.equal(await isArchived(sid), true, 'the abandoned session is archived');

    // The pruned copy carries the stub and still has both user turns.
    const pruned = (await fs.readFile(path.join(sessionDir, `${pr.body.newSessionId}.jsonl`), 'utf8'))
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    const result = pruned.find(o => o.uuid === 'r1');
    assert.ok(Array.isArray(result.message.content[0].content),
      'a pruned Read result is a block array so read-before-edit re-arms');
    assert.match(result.message.content[0].content[0].text, /^\[pruned: /);
    assert.equal(pruned.find(o => o.uuid === 'a3').message.content[0].text, 'second reply',
      'the newest turn is verbatim');

    // The single most important divergence from renew_session: NOTHING is
    // seeded as a first user turn, so the session waits for the user.
    const echoes = inst.ringSnapshot().filter(ev => ev.kind === 'user_echo').map(ev => ev.text);
    assert.deepEqual(echoes, ['first', 'second'], 'replayed history only — no seeded prompt');
    assert.equal(inst.status, 'idle');
  } finally { await ctx.close(); }
});

test('a prompt landing mid-rewrite is refused instead of corrupting the transform', async () => {
  // Between the caller's idle check and the kill completing, the subprocess is
  // still writable: a prompt landing there would have its partial tail persisted
  // by the CLI and folded into the rewritten file. `_mutating` closes that window
  // for prune, rewind and fork alike.
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'aaaaaaa3-2222-3333-4444-555555555555';
    await seedSession({ ctx, projectName: 'prunerace', sid, lines: sessionLines() });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'prunerace', mode: 'bypassPermissions', resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    const inst = ctx.instances.get(id);

    inst._mutating = true;
    try {
      await assert.rejects(() => inst.prompt('sneaky'), /being rewritten/);
    } finally { inst._mutating = false; }

    // The guard lifts cleanly — no lingering refusal once the rewrite is done.
    await inst.prompt('fine now');
    await waitFor(() => inst.status === 'idle');
  } finally { await ctx.close(); }
});

test('fork guards its jsonl read with the same flag', async () => {
  // Fork never kills the source subprocess, so `!this.proc` does not cover it —
  // without `_mutating` a prompt lands on stdin mid-read and its persisted tail
  // can be folded into the copied prefix. Observe the flag directly rather than
  // trying to win a race: an accessor records every write the route makes.
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'aaaaaaa4-2222-3333-4444-555555555555';
    await seedSession({ ctx, projectName: 'forkguard', sid, lines: sessionLines() });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'forkguard', mode: 'bypassPermissions', resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    const inst = ctx.instances.get(id);

    const writes = [];
    let flag = false;
    Object.defineProperty(inst, '_mutating', {
      configurable: true,
      get: () => flag,
      set: (v) => { flag = v; writes.push(v); },
    });

    const fk = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: 1 });
    assert.equal(fk.status, 201);
    assert.deepEqual(writes, [true, false], 'fork must set and clear _mutating around its read');
    assert.equal(inst._mutating, false, 'the flag is cleared even though fork leaves the source alive');

    // …and fork refuses to read a jsonl another rewrite is already rewriting.
    inst._mutating = true;
    try {
      const clash = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: 1 });
      assert.equal(clash.status, 409);
    } finally { inst._mutating = false; }
  } finally { await ctx.close(); }
});

test('a failed prune does not leave the recovered session on a suppressed ctx reading', async () => {
  // `_skipUsageSeed` is set for the PRUNED session's replay. If launch throws
  // after that, the catch replays the ORIGINAL — whose jsonl usage is accurate —
  // so the flag must not carry over and blank its ctx chip.
  //
  // Assert the OBSERVABLE consequence (was the reading seeded?), not the flag:
  // loadHistory consumes and clears `_skipUsageSeed` itself, so reading it back
  // afterwards is always false and would make this test unfalsifiable.
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'aaaaaaa5-2222-3333-4444-555555555555';
    // The fixture needs real usage on its newest assistant line, else there is
    // nothing to seed and the assertion below is vacuous either way.
    const lines = sessionLines();
    lines[lines.length - 1].message.usage = {
      input_tokens: 10, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0,
      output_tokens: 20,
    };
    await seedSession({ ctx, projectName: 'prunerecover', sid, lines });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'prunerecover', mode: 'bypassPermissions', resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    const inst = ctx.instances.get(id);

    // Fail the pruned launch only; let the recovery launch succeed.
    const realLaunch = inst.launch.bind(inst);
    let calls = 0;
    inst.launch = async (opts) => {
      calls += 1;
      if (calls === 1) throw new Error('simulated launch failure');
      return realLaunch(opts);
    };

    const pr = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/prune`, { cutTurnIndex: 1 });
    assert.equal(pr.status, 500, 'the real cause surfaces rather than being swallowed');
    await waitFor(() => inst.status === 'idle');
    assert.equal(inst.sessionId, sid, 'recovered onto the original session');
    assert.ok(inst.lastContextUsage,
      "the recovered original's ctx reading must be seeded — the pruned run's suppression leaked");
    assert.equal(inst.lastContextUsage.cache_read_input_tokens, 4000);
  } finally { await ctx.close(); }
});

test('prune is refused mid-turn and on a session with nothing to cut', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'aaaaaaa2-2222-3333-4444-555555555555';
    await seedSession({ ctx, projectName: 'prunegate', sid, lines: sessionLines() });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'prunegate', mode: 'bypassPermissions', resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    // cutTurnIndex == turnCount would prune the newest turn — the cap refuses it.
    // This one throws AFTER the subprocess has been killed (the range check needs
    // the turn count, so it can't be hoisted above the kill), which makes it the
    // natural exercise of the fail-safe path: a mid-transform throw must not
    // leave the instance wedged with no proc and no respawn.
    const tooFar = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/prune`, { cutTurnIndex: 2 });
    assert.equal(tooFar.status, 400);
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    assert.ok(ctx.instances.get(id).proc, 'a failed prune must respawn the instance, not wedge it');
    assert.equal(ctx.instances.get(id).sessionId, sid,
      'a failed prune falls back to the UNPRUNED session');
    // …and the recovered session is actually usable, not just present.
    await ctx.instances.get(id).prompt('still here?');
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const negative = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/prune`, { cutTurnIndex: -1 });
    assert.equal(negative.status, 400);
    // An unknown inputMode is rejected BEFORE the kill — the proc is untouched.
    const procBefore = ctx.instances.get(id).proc;
    const badMode = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/prune`,
      { cutTurnIndex: 1, inputMode: 'bogus' });
    assert.equal(badMode.status, 400);
    assert.equal(ctx.instances.get(id).proc, procBefore, 'a rejected request must not kill the subprocess');

    // Mid-turn: a prune would kill the subprocess under a running turn.
    const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
    process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_HANG;
    try {
      const hangR = await api(ctx.baseUrl, 'POST', '/api/instances', {
        project: 'prunegate', mode: 'bypassPermissions',
      });
      const hangId = hangR.body.id;
      await waitFor(() => ctx.instances.get(hangId).status === 'idle' && ctx.instances.get(hangId).sessionId);
      await ctx.instances.get(hangId).prompt('first');
      await waitFor(() => ctx.instances.get(hangId).status === 'idle');
      await ctx.instances.get(hangId).prompt('hang');
      await waitFor(() => ctx.instances.get(hangId).status === 'turn');
      const midTurn = await api(ctx.baseUrl, 'POST', `/api/instances/${hangId}/prune`, { cutTurnIndex: 1 });
      assert.equal(midTurn.status, 409);
    } finally {
      if (prevScenario === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
      else process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
    }
  } finally { await ctx.close(); }
});
