// End-to-end REST coverage of the Prune flow:
//   GET  /api/instances/:id/prune/analysis
//   POST /api/instances/:id/prune
//
// The behaviours worth pinning here are the ones a reader would otherwise have
// to infer from the plan: the instanceId and the public sessionId both survive
// (only the internal backing id rotates),
// the original jsonl is untouched and archived, and — the easiest thing to get
// wrong by copying renew_session — the pruned session comes back IDLE with
// nothing seeded as a first turn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';
import { encodeCwd } from '../src/projects.ts';

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

test('prune rotates the BACKING id, PINS the public id, archives the original, and lands idle', async () => {
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
    // Both fields name TRANSCRIPTS — the file that was pruned and the copy that
    // replaced it. The session's own identity is `instance.sessionId`, below.
    assert.equal(pr.body.oldSessionId, sid);
    assert.ok(pr.body.newSessionId && pr.body.newSessionId !== sid);
    assert.ok(pr.body.saved.toolOutputs > 900);
    // The instanceId is the stable handle every side structure keys off — a
    // prune must not rotate it (only the backing id rotates).
    assert.equal(pr.body.instance.id, id, 'same instance, new backing id');

    const inst = ctx.instances.get(id);
    await waitFor(() => inst.status === 'idle');
    // THE identity guarantee: the rotation is invisible on the public surface.
    // This session was resumed from a seeded jsonl with no lineage row, so its
    // public id is the full UUID it already had (the store's base case) — and it
    // is that id, not the new transcript's, that survives the prune.
    assert.equal(inst.sessionId, sid, 'the public id is pinned across a prune');
    assert.equal(pr.body.instance.sessionId, sid, 'and the REST projection reports it');
    assert.equal(inst.backingSessionId, pr.body.newSessionId,
      'only the backing id moved, onto the pruned copy');
    assert.equal(resets.length, 1, 'snapshot_reset emitted exactly once');

    // The lineage row was created lazily off the base case and records the prune.
    // `reason` is load-bearing: a prune segment is a filtered COPY that OVERLAPS
    // its predecessor, so a multi-segment reader must never concatenate across it.
    const { segmentsFor, resolveBacking, publicIdFor } = await import('../src/sessionLineage.ts');
    assert.deepEqual((await segmentsFor(sid)).map(g => [g.id, g.reason]),
      [[sid, 'initial'], [pr.body.newSessionId, 'prune']]);
    assert.equal(await resolveBacking(sid), pr.body.newSessionId,
      'the public id resolves to the PRUNED transcript, not the original');
    assert.equal(await resolveBacking(pr.body.newSessionId), pr.body.newSessionId,
      'and naming a segment directly still opens that segment');
    assert.equal(await publicIdFor(pr.body.newSessionId), sid);

    // Original untouched on disk…
    assert.deepEqual(await fs.readFile(file), originalBytes, 'original jsonl untouched');
    // …and archived, so it shows up under Settings → Archived rather than as a
    // stale live row.
    const { isArchived } = await import('../src/archivedSessions.ts');
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

// The newest assistant line's usage is what a resumed session latches as its ctx
// chip reading (loadHistory's seed), so the three input-side fields are distinct.
const SEEDED_USAGE = { input_tokens: 10, cache_read_input_tokens: 4000, cache_creation_input_tokens: 300, output_tokens: 20 };
const SEEDED_CONTEXT = 10 + 4000 + 300;

test('the analysis carries the ctx chip\'s reading as its baseline', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'aaaaaaa6-2222-3333-4444-555555555555';
    const lines = sessionLines();
    lines[lines.length - 1].message.usage = SEEDED_USAGE;
    await seedSession({ ctx, projectName: 'prunebaseline', sid, lines });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'prunebaseline', mode: 'bypassPermissions', resume: sid,
    });
    await waitFor(() => ctx.instances.get(r.body.id).status === 'idle');
    const analysis = await api(ctx.baseUrl, 'GET', `/api/instances/${r.body.id}/prune/analysis`);
    assert.equal(analysis.status, 200);
    assert.equal(analysis.body.contextTokens, SEEDED_CONTEXT);
  } finally { await ctx.close(); }
});

test('a latched usage whose prompt sum is zero is no baseline', async () => {
  // Some backends report all-zero usage; a zero is not a measurement of context.
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'aaaaaaa8-2222-3333-4444-555555555555';
    await seedSession({ ctx, projectName: 'prunezerobaseline', sid, lines: sessionLines() });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'prunezerobaseline', mode: 'bypassPermissions', resume: sid,
    });
    await waitFor(() => ctx.instances.get(r.body.id).status === 'idle');
    const inst = ctx.instances.get(r.body.id);
    inst._lastContextUsage = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 12 };
    assert.ok(inst.lastContextUsage, 'the zero reading is latched');
    const analysis = await api(ctx.baseUrl, 'GET', `/api/instances/${r.body.id}/prune/analysis`);
    assert.equal(analysis.status, 200);
    assert.equal(analysis.body.contextTokens, null);
  } finally { await ctx.close(); }
});

test('no ctx reading, no baseline: the analysis right after a prune has none', async () => {
  // A pruned session's jsonl still carries the PRE-prune usage, which the
  // respawn deliberately does not seed; the analysis must not resurrect it.
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'aaaaaaa7-2222-3333-4444-555555555555';
    const lines = sessionLines();
    lines[lines.length - 1].message.usage = SEEDED_USAGE;
    await seedSession({ ctx, projectName: 'prunenobaseline', sid, lines });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'prunenobaseline', mode: 'bypassPermissions', resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    const before = await api(ctx.baseUrl, 'GET', `/api/instances/${id}/prune/analysis`);
    assert.equal(before.body.contextTokens, SEEDED_CONTEXT, 'a reading existed before the prune');

    const pr = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/prune`, { cutTurnIndex: 1 });
    assert.equal(pr.status, 200);
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    const after = await api(ctx.baseUrl, 'GET', `/api/instances/${id}/prune/analysis`);
    assert.equal(after.status, 200);
    assert.equal(after.body.contextTokens, null);
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

test('Instance.forkAtUserMessage claims _mutating with no await after the check', async () => {
  // The guard is only worth anything if the check and the claim are atomic. An
  // await between them lets two requests both pass the check, both set the flag,
  // and the first one's `finally` clear it while the second is still reading —
  // the exact unprotected read the flag exists to prevent.
  //
  // This is asserted structurally, which needs justifying. The interleave is NOT
  // reachable over HTTP: traced with an accessor on `_mutating`, two concurrent
  // fork requests produce `get:false | set:true | get:true | set:false` whether
  // or not the await is present — the second request simply doesn't arrive
  // within the first's microtask-scale import window. So a behavioural test
  // cannot distinguish the two, and the only guard against reintroducing it is
  // to pin the shape.
  // Scoped to the METHOD, which owns the whole guard→claim→read→release
  // sequence (the route only parses the index and spawns what it hands back).
  const src = await fs.readFile(new URL('../src/instances.ts', import.meta.url), 'utf8');
  const method = src.slice(src.indexOf('async forkAtUserMessage('));
  assert.ok(method, 'Instance.forkAtUserMessage must exist — the guard sequence lives there');
  const check = method.indexOf('another rewind/fork/prune is in progress');
  const claim = method.indexOf('this._mutating = true');
  assert.ok(check > 0 && claim > check, 'forkAtUserMessage must check _mutating before claiming it');
  assert.doesNotMatch(
    method.slice(check, claim), /\bawait\b/,
    'no await may sit between the _mutating check and the claim — see this test\'s comment',
  );
  // And the route must NOT have kept a copy of the guard.
  const routes = await fs.readFile(new URL('../src/routes.ts', import.meta.url), 'utf8');
  const route = routes.slice(routes.indexOf("r.post('/instances/:id/fork'"),
                             routes.indexOf("r.post('/instances/:id/fork'") + 1200);
  assert.doesNotMatch(route, /_mutating/,
    'the route must delegate the flag to the instance, not re-check it');
});

test('two concurrent forks cannot both claim the flag', async () => {
  // Mutual exclusion under real concurrent load. This does NOT pin the
  // check-then-await-then-set defect above (see that test for why); it catches
  // the guard being weakened or removed outright.
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'aaaaaaa6-2222-3333-4444-555555555555';
    await seedSession({ ctx, projectName: 'forkrace', sid, lines: sessionLines() });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'forkrace', mode: 'bypassPermissions', resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const [a, b] = await Promise.all([
      api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: 1 }),
      api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: 1 }),
    ]);
    const codes = [a.status, b.status].sort();
    assert.deepEqual(codes, [201, 409],
      `exactly one concurrent fork may proceed, got ${codes.join(' + ')}`);
    // The loser must not have left the flag stuck on the source instance.
    assert.equal(ctx.instances.get(id)._mutating, false);
  } finally { await ctx.close(); }
});

test('a prune-created segment is addressable by its new backing id, permanently', async () => {
  // Design guarantee #3: "any full backing/segment UUID resolves, permanently".
  // `Instance._segments` is the ENTIRE candidate universe for resolveSessionRef —
  // D4 keeps resolution in-memory precisely so it can stay synchronous — so the
  // push in pruneSession is what makes a prune-created segment addressable at all.
  // Without it a live pruned worker named by its NEW backing id resolves to
  // nothing and every handler falls through to SESSION_NOT_LIVE, and segmentCount
  // under-reports. The renew path is covered by the no-duplicate-worker and
  // rotation-tell tests; this is the prune equivalent.
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'ba5eba11-0000-4000-8000-00000000beef';
    await seedSession({ ctx, projectName: 'segaddr', sid, lines: sessionLines() });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'segaddr', mode: 'bypassPermissions', resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    const inst = ctx.instances.get(id);

    const pr = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/prune`, { cutTurnIndex: 1 });
    assert.equal(pr.status, 200);
    await waitFor(() => inst.status === 'idle');
    const newBacking = pr.body.newSessionId;
    assert.equal(inst.backingSessionId, newBacking, 'precondition: the backing id rotated');
    assert.equal(inst.sessionId, sid, 'precondition: the public id is pinned');

    // (1) The new segment resolves — exactly, and to the session's PUBLIC id.
    assert.deepEqual(ctx.instances.resolveSessionRef(newBacking), { sessionId: sid },
      'the prune-created segment must resolve to its session');
    // (2) …and reaches the live instance, which is what every MCP handler needs.
    assert.equal(ctx.instances.liveForSession(newBacking)?.id, id,
      'and it must reach the LIVE instance, not fall through to SESSION_NOT_LIVE');
    assert.equal(ctx.instances.anyForSession(newBacking)?.id, id);
    // (3) The pre-prune segment stays addressable too — "permanently" is the claim.
    assert.deepEqual(ctx.instances.resolveSessionRef(sid), { sessionId: sid });
    // (4) End to end over MCP, by the new backing id: the tool answers, and it
    // answers with the PINNED public id.
    const res = await fetch(ctx.baseUrl + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'set_mode', arguments: { sessionId: newBacking, mode: 'bypassPermissions' } } }),
    });
    const out = JSON.parse(JSON.parse(await res.text()).result.content[0].text);
    assert.equal(out.sessionId, sid, `MCP must resolve the new segment: ${JSON.stringify(out)}`);
    // (5) The count the conductor view reports tracks the real chain length.
    assert.equal(inst.summary().segmentCount, 2, 'two segments after one prune');
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

test('a failed prune reverts the recorded rotation — no segment the process never ran', async () => {
  // Prune records its segment BEFORE launch(), because it is the one rotation
  // that CAN be durable before first use. That ordering is only safe if the
  // rollback undoes it: otherwise a throw inside launch() leaves `current`
  // pointing at a pruned file the session is not running, and a later restart
  // resumes the wrong transcript.
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'aaaaaaa7-2222-3333-4444-555555555555';
    await seedSession({ ctx, projectName: 'prunerevert', sid, lines: sessionLines() });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'prunerevert', mode: 'bypassPermissions', resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    const inst = ctx.instances.get(id);
    const { segmentsFor, resolveBacking } = await import('../src/sessionLineage.ts');
    assert.deepEqual(await segmentsFor(sid), [], 'precondition: no lineage row yet (base case)');

    // Fail the pruned launch only; let the recovery launch succeed. This is the
    // exact window the revert protects: after recordRotation, before the process
    // ever runs the new id.
    const realLaunch = inst.launch.bind(inst);
    let calls = 0;
    inst.launch = async (opts) => {
      calls += 1;
      if (calls === 1) throw new Error('simulated launch failure');
      return realLaunch(opts);
    };

    const pr = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/prune`, { cutTurnIndex: 1 });
    assert.equal(pr.status, 500, 'the real cause surfaces');
    await waitFor(() => inst.status === 'idle');

    assert.equal(inst.sessionId, sid, 'the public id never moved');
    assert.equal(inst.backingSessionId, sid, 'the backing id is restored to the pre-prune segment');
    assert.deepEqual(inst._segments, [sid], 'and the in-memory chain has no phantom segment');
    // revertRotation dropped the trailing `initial`-only row entirely, restoring
    // the base case EXACTLY — not a stub row that merely happens to resolve.
    assert.deepEqual(await segmentsFor(sid), [], 'the lazily-created row is gone');
    assert.equal(await resolveBacking(sid), sid, 'so the public id resolves to the intact original');
  } finally { await ctx.close(); }
});

test('a subscriber woken by a prune does not hang, and is not told the worker failed', async () => {
  // Prune deliberately comes up IDLE with NO turn, so there is no turn_end to
  // deliver on. Without the rotation-completion trigger the hub's rotation defer
  // would hold the one-shot until the 30-minute watchdog fired and told the
  // conductor its worker "did NOT finish" — for a prune that SUCCEEDED. That is why
  // the defer needed an explicit completion trigger rather than turn_end-retry.
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'aaaaaaa8-2222-3333-4444-555555555555';
    await seedSession({ ctx, projectName: 'prunesub', sid, lines: sessionLines() });
    const target = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'prunesub', mode: 'bypassPermissions', resume: sid,
    });
    const caller = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'prunesub', mode: 'bypassPermissions',
    });
    const tInst = ctx.instances.get(target.body.id);
    const cInst = ctx.instances.get(caller.body.id);
    await waitFor(() => tInst.status === 'idle' && cInst.status === 'idle');

    // A generous heartbeat window: if this test ever passes by a HEARTBEAT rather
    // than by the rotation trigger, it would have to wait this out, so it cannot.
    // The arm itself is the real path — ownership recorded, then the target's turn
    // start — driven directly here because these instances came up over REST with
    // no conductor to dispatch from.
    ctx.instances.noteDispatch(cInst.sessionId, tInst.sessionId, 600_000);
    ctx.instances._idleHub.onTurnStart(tInst.id);
    assert.equal(ctx.instances._idleHub.hasArmedWake(tInst.id), true);

    const pr = await api(ctx.baseUrl, 'POST', `/api/instances/${target.body.id}/prune`, { cutTurnIndex: 1 });
    assert.equal(pr.status, 200);

    const stub = await waitFor(() => cInst.ringSnapshot().find(ev => ev.kind === 'user_echo'
      && typeof ev.text === 'string' && ev.text.includes('get_recent_messages')));
    assert.ok(!stub.text.includes('did NOT finish'),
      `a successful prune must not wake the conductor with the failure stub: ${stub.text}`);
    // The wake names the PINNED public id, so the conductor's next call still works.
    assert.ok(stub.text.includes(tInst.sessionId), `the wake must name the public id: ${stub.text}`);
    assert.ok(!stub.text.includes(tInst.backingSessionId),
      `and never the rotated backing id: ${stub.text}`);
    assert.equal(ctx.instances._idleHub.hasArmedWake(tInst.id), false, 'the wake was consumed');
    // …and the target really did come up idle with no turn of its own.
    assert.equal(tInst.status, 'idle');
    assert.equal(tInst.rotationPending, false, 'the rotation window is closed');
    assert.equal(tInst.rotationReason, 'prune', 'and the completed rotation is recorded as a prune');
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

    // cutTurnIndex == turnCount is a legal FULL prune now; turnCount+1 names no
    // turn at all and is what the cap refuses. This one throws AFTER the
    // subprocess has been killed (the range check needs the turn count, so it
    // can't be hoisted above the kill), which makes it the natural exercise of
    // the fail-safe path: a mid-transform throw must not leave the instance
    // wedged with no proc and no respawn.
    const tooFar = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/prune`, { cutTurnIndex: 3 });
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
