// Playbook enforcement, end to end through the MCP router with the fake claude
// engine — the wiring the pure decide() unit tests cannot reach: the single
// checkpoint in dispatch(), the ledger writes, `needs` prefix resolution, the
// conductor-only scope, and the playbookEnforcement toggle.
//
// The caller here is a REAL conductor (a `.conduct` instance whose instanceId
// rides `?caller=`), because "policy applies only to the conductor" is one of
// the invariants under test — a stand-in project would prove nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor, instForSession } from './helpers.mjs';
import { ledgerFile, readEvents, foldProjection } from '../src/playbookLedger.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-ws.json');

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  });
}

async function makeRealRepo(projectsRoot, name) {
  const repoPath = path.join(projectsRoot, name);
  await fs.mkdir(repoPath, { recursive: true });
  await git(repoPath, 'init', '-q', '-b', 'main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# test\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'initial');
  return repoPath;
}

let nextRpcId = 1;

// Boot a server, a real git project, and a live conductor at `enforcement`.
// `call(name, args)` issues a tools/call AS THE CONDUCTOR; `callAs(handle, …)`
// issues one as somebody else (or nobody).
async function setup({ enforcement } = {}) {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  await makeRealRepo(ctx.projectsRoot, 'demo');
  await api(ctx.baseUrl, 'POST', '/api/projects/.conduct/ensure');
  const spawned = await api(ctx.baseUrl, 'POST', '/api/instances', {
    project: '.conduct', mode: 'bypassPermissions', temp: true,
    ...(enforcement ? { playbookEnforcement: enforcement } : {}),
  });
  assert.equal(spawned.status, 201, `conductor spawn failed: ${JSON.stringify(spawned.body)}`);
  const conductorId = spawned.body.id;
  await waitFor(() => ctx.instances.get(conductorId)?.status === 'idle');

  async function callAs(handle, name, args) {
    const url = ctx.baseUrl + '/mcp' + (handle ? `?caller=${encodeURIComponent(handle)}` : '');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await res.json();
    assert.ok(body.result, `tools/call ${name} returned no result: ${JSON.stringify(body)}`);
    assert.notEqual(body.result.isError, true,
      `tools/call ${name} hard-errored: ${body.result.content?.[0]?.text}`);
    return JSON.parse(body.result.content[0].text);
  }

  return {
    ...ctx,
    conductorId,
    call: (name, args) => callAs(conductorId, name, args),
    callAs,
    // Spawn a worker and wait until its session is up, so its sessionId is a
    // valid handle for the next call.
    async spawnWorker(args) {
      const out = await callAs(conductorId, 'spawn_instance', args);
      if (out.sessionId) await waitFor(() => instForSession(ctx.instances, out.sessionId)?.sessionId);
      return out;
    },
    events: () => readEvents(ledgerFile()),
    async ledgerExists() {
      try { await fs.access(ledgerFile()); return true; } catch { return false; }
    },
    setEnforcement(mode) {
      // Over the WebSocket, the same channel the session hamburger uses for the
      // sibling autoApprovePlan toggle.
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(ctx.wsUrl);
        ws.once('error', reject);
        ws.once('open', () => ws.send(JSON.stringify({
          t: 'playbook_enforcement', id: conductorId, mode, reqId: 'r1',
        })));
        ws.on('message', raw => {
          const m = JSON.parse(raw.toString());
          if (m.t === 'ack' && m.reqId === 'r1') { ws.close(); resolve(m); }
        });
      });
    },
  };
}

// Enforcement events are appended off the status stream, asynchronously from the
// WS ack that triggered them, so both directions have to be waited on:
// `expectEnforcementEvents` waits FOR the count, and `expectNoMoreEnforcement`
// gives the append real chances to land and requires that it doesn't.
async function expectEnforcementEvents(t, n) {
  const all = await waitFor(async () => {
    const evs = (await t.events()).filter(e => e.kind === 'enforcement');
    return evs.length >= n ? evs : false;
  });
  assert.equal(all.length, n, `expected exactly ${n} enforcement events, got ${all.length}`);
  return all;
}

async function expectNoMoreEnforcement(t, n) {
  await assert.rejects(
    () => waitFor(async () => (await t.events()).filter(e => e.kind === 'enforcement').length > n,
      { timeout: 1000, interval: 20 }),
    /timeout/,
    `no enforcement event beyond the expected ${n} may be recorded`);
}

// Captures every frame so a `t:'event'` push can be awaited by predicate.
// Same helper as tests/ws.test.mjs.
function wsClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.on('message', raw => {
      try { messages.push(JSON.parse(raw.toString())); } catch { messages.push(raw.toString()); }
    });
    ws.once('open', () => resolve({
      ws,
      messages,
      send(obj) { ws.send(JSON.stringify(obj)); },
      close() { return new Promise(r => { ws.once('close', r); ws.close(); }); },
      wait(predicate, timeout = 4000) { return waitFor(() => messages.find(predicate), { timeout }); },
    }));
    ws.once('error', reject);
  });
}

// Subscribe to the conductor's stream and wait until it's live, so no
// playbook_warn push can race ahead of the subscription.
async function watchConductor(t) {
  const c = await wsClient(t.wsUrl);
  c.send({ t: 'subscribe', id: t.conductorId, reqId: 'sub' });
  await c.wait(m => m.t === 'ack' && m.reqId === 'sub' && m.ok);
  const warnings = () => c.messages.filter(m =>
    m.t === 'event' && m.ev?.kind === 'system' && m.ev?.subtype === 'playbook_warn');
  return {
    ...c,
    warnings,
    waitForWarning: () => c.wait(m =>
      m.t === 'event' && m.ev?.kind === 'system' && m.ev?.subtype === 'playbook_warn'),
    // The emit is synchronous with the refused call, but give it real chances
    // to land before concluding it never will.
    async expectNoWarning() {
      await assert.rejects(
        () => waitFor(() => warnings().length > 0, { timeout: 1000, interval: 20 }),
        /timeout/,
        'no playbook_warn may be pushed');
    },
  };
}

const refused = (res, code) => {
  assert.equal(res.ok, false, `expected a refusal, got ${JSON.stringify(res)}`);
  assert.equal(res.code, code, `expected ${code}, got ${res.code}: ${res.reason}`);
  return res;
};

// ── `warn`: everything is checked and recorded, nothing is refused ──────────
//
// There is no inert level any more. `warn` differs from `enforce` on exactly one
// thing — whether the refusal reaches the caller — so these tests pin that the
// permissive level still decides, still patches and still writes.

test('warn: an illegal spawn PROCEEDS, is ledgered as a refusal, and stays untracked', async () => {
  const t = await setup({ enforcement: 'warn' });
  try {
    // No playbook at all: `enforce` refuses this with PLAYBOOK_UNKNOWN.
    const w = await t.spawnWorker({ project: 'demo', mode: 'plan', createWorktree: true });
    assert.ok(w.sessionId, 'warn lets a spawn with no playbook through');

    const refusals = await waitFor(async () => {
      const evs = (await t.events()).filter(e => e.kind === 'refusal');
      return evs.length > 0 ? evs : false;
    });
    assert.equal(refusals[0].code, 'PLAYBOOK_UNKNOWN',
      'the ledger is the only trace that the call should not have been allowed');
    assert.equal(refusals[0].tool, 'spawn_instance');

    // Refused-but-allowed means NO binding was written, so the worker is
    // ungoverned even after a flip to enforce.
    assert.equal((await t.events()).filter(e => e.kind === 'spawn').length, 0,
      'an illegal spawn records no binding');
    assert.equal((await t.call('send_prompt', {
      sessionId: w.sessionId, text: 'go', stage: 'refine', subscribe: false,
    })).ok, undefined, 'an untracked worker is ungoverned at either level');
  } finally { await t.close(); }
});

test('warn: a LEGAL spawn is patched by `require` and recorded, exactly as under enforce', async () => {
  const t = await setup({ enforcement: 'warn' });
  try {
    // Neither mode nor createWorktree is passed; the plan stage pins both. Proof
    // that warn runs the full decide()+patch path rather than passing args through.
    const w = await t.spawnWorker({ project: 'demo', playbook: 'classic', stage: 'plan' });
    assert.equal(w.mode, 'plan', 'warn applies the stage\'s require');
    assert.ok(w.worktree?.worktreeName, 'require filled in createWorktree under warn');

    const spawn = await waitFor(async () =>
      (await t.events()).find(e => e.kind === 'spawn') ?? false);
    assert.deepEqual({ playbook: spawn.playbook, stage: spawn.stage },
      { playbook: 'classic', stage: 'plan' }, 'the binding is written under warn');
  } finally { await t.close(); }
});

// ── a full classic run under `enforce` ──────────────────────────────────────

test('enforce: a full classic run — require fill-in, self-edge, approve_plan gate, needs, capacity', async () => {
  const t = await setup({ enforcement: 'enforce' });
  try {
    // `require` FILLS IN omitted arguments: neither mode nor createWorktree is
    // passed, and both come back as the plan stage pins them.
    const impl = await t.spawnWorker({ project: 'demo', playbook: 'classic', stage: 'plan' });
    assert.equal(impl.mode, 'plan', 'require filled in mode');
    assert.ok(impl.worktree?.worktreeName, 'require filled in createWorktree');
    const wtName = impl.worktree.worktreeName;

    // A SELF-EDGE — every ordinary follow-up prompt is one. Always legal, and
    // explicitly NOT a transition.
    assert.equal((await t.call('send_prompt', {
      sessionId: impl.sessionId, text: 'plan it', stage: 'plan', subscribe: false,
    })).ok, undefined);
    assert.equal((await t.events()).filter(e => e.kind === 'transition').length, 0,
      'a self-edge must not be ledgered as a transition');

    // plan -> implement fires on approve_plan ONLY; send_prompt cannot sneak
    // a worker past plan approval.
    const snuck = await t.call('send_prompt', {
      sessionId: impl.sessionId, text: 'just implement it', stage: 'implement', subscribe: false,
    });
    refused(snuck, 'TRANSITION_ILLEGAL');
    assert.match(snuck.reason, /approve_plan/, 'the refusal names the tool that does drive the edge');
    assert.deepEqual(snuck.legalMoves.transitions, [{ to: 'implement', via: 'approve_plan' }]);

    // The declared `on` auto-fires the edge.
    await t.call('approve_plan', { sessionId: impl.sessionId, subscribe: false });
    const moved = (await t.events()).find(e => e.kind === 'transition');
    assert.deepEqual(
      { from: moved.from, to: moved.to, via: moved.via, sessionId: moved.sessionId },
      { from: 'plan', to: 'implement', via: 'approve_plan', sessionId: impl.sessionId });

    // A spawn into a transition-only stage is refused without either stage
    // having to say so — spawn_instance fails closed.
    refused(await t.call('spawn_instance', { project: 'demo', playbook: 'classic', stage: 'implement' }),
      'STAGE_NOT_SPAWNABLE');
    refused(await t.call('spawn_instance', { project: 'demo', playbook: 'classic', stage: 'refine' }),
      'STAGE_NOT_SPAWNABLE');

    // `needs` on SPAWN-entry: review requires a worker currently in implement.
    refused(await t.call('spawn_instance', {
      project: 'demo', playbook: 'classic', stage: 'review', worktree: wtName,
    }), 'NEEDS_UNSATISFIED');
    const rev = await t.spawnWorker({
      project: 'demo', playbook: 'classic', stage: 'review', worktree: wtName,
      needs: { implement: impl.sessionId },
    });
    assert.ok(rev.sessionId, 'satisfying needs admits the spawn');
    assert.equal(rev.model !== null, true, 'the reviewer role resolved to a model');

    // Permission comes from the worker's CURRENT stage: review denies both.
    refused(await t.call('sync_worktree', { sessionId: rev.sessionId }), 'TOOL_DENIED_IN_STAGE');
    refused(await t.call('approve_plan', { sessionId: rev.sessionId, subscribe: false }),
      'TOOL_DENIED_IN_STAGE');
    // ...and the same tool is permitted for the implementer, in `implement`.
    assert.notEqual((await t.call('sync_worktree', { sessionId: impl.sessionId })).code,
      'TOOL_DENIED_IN_STAGE');

    // workers:"one" is scoped to the RUN and counts LIVE workers. The three
    // calls below are the SAME spawn, and only the middle one differs in whether
    // a live reviewer exists — so capacity, not anything else, is what moves.
    const secondReviewer = {
      project: 'demo', playbook: 'classic', stage: 'review', worktree: wtName,
      needs: { implement: impl.sessionId },
    };
    refused(await t.call('spawn_instance', secondReviewer), 'STAGE_AT_CAPACITY');
    // A retire frees the slot. kill_instance exits the subprocess, so the retire
    // arrives on the one status-stream path rather than a separate kill path.
    await t.call('kill_instance', { sessionId: rev.sessionId });
    await waitFor(async () => (await t.events()).some(e => e.kind === 'retire'));
    const retire = (await t.events()).find(e => e.kind === 'retire');
    assert.equal(retire.sessionId, rev.sessionId);
    // ...so the identical spawn now succeeds.
    const rev2 = await t.spawnWorker(secondReviewer);
    assert.ok(rev2.sessionId, 'killing the occupant freed the workers:"one" slot');

    // `needs` on TRANSITION-entry, not just spawn-entry: refine requires the
    // reviewer, and the DESTINATION stage's conditions are what get checked.
    refused(await t.call('send_prompt', {
      sessionId: impl.sessionId, text: 'refine', stage: 'refine', subscribe: false,
    }), 'NEEDS_UNSATISFIED');
    // The retired reviewer cannot satisfy it either — `at:"current"` means now.
    refused(await t.call('send_prompt', {
      sessionId: impl.sessionId, text: 'refine', stage: 'refine', subscribe: false,
      needs: { review: rev.sessionId },
    }), 'NEEDS_UNSATISFIED');
    assert.equal((await t.call('send_prompt', {
      sessionId: impl.sessionId, text: 'refine', stage: 'refine', subscribe: false,
      needs: { review: rev2.sessionId },
    })).ok, undefined, 'supplying the destination stage\'s needs admits the transition');

    // The projection folded from disk reproduces the run — state survives a
    // restart because the JSONL, not memory, is the source of truth.
    const projection = foldProjection(await t.events());
    const state = projection.bySession.get(impl.sessionId);
    assert.deepEqual(state.stageHistory, ['plan', 'implement', 'refine']);
    assert.equal(state.playbook, 'classic');
    assert.equal(projection.bySession.get(rev.sessionId).live, false);
    assert.equal(projection.bySession.get(rev2.sessionId).runRoot, state.runRoot,
      'the reviewer joined the implementer\'s run via its needs edge');
  } finally { await t.close(); }
});

test('enforce: needs accepts a sessionId prefix, and refuses an ambiguous one', async () => {
  const t = await setup({ enforcement: 'enforce' });
  try {
    const impl = await t.spawnWorker({ project: 'demo', playbook: 'classic', stage: 'plan' });
    const wtName = impl.worktree.worktreeName;
    await t.call('approve_plan', { sessionId: impl.sessionId, subscribe: false });

    const prefix = impl.sessionId.slice(0, 8);
    const rev = await t.spawnWorker({
      project: 'demo', playbook: 'classic', stage: 'review', worktree: wtName,
      needs: { implement: prefix },
    });
    assert.ok(rev.sessionId, 'an 8-char needs prefix resolved to the full sessionId');

    // Ambiguity is reported the same way a top-level sessionId prefix is, and
    // names which needs entry was ambiguous.
    const fake = prefix + 'ffffffff-ffff-ffff-ffff-ffffffffffff'.slice(8);
    t.instances.byId.set('fake-ambig', { id: 'fake-ambig', sessionId: fake, kill: async () => {} });
    try {
      const res = await t.call('spawn_instance', {
        project: 'demo', playbook: 'classic', stage: 'review', worktree: wtName,
        needs: { implement: prefix },
      });
      refused(res, 'SESSION_AMBIGUOUS');
      assert.match(res.reason, /needs\.implement/);
    } finally { t.instances.byId.delete('fake-ambig'); }
  } finally { await t.close(); }
});

test('enforce: a worker whose subprocess exits is retired without a kill_instance', async () => {
  const t = await setup({ enforcement: 'enforce' });
  try {
    const impl = await t.spawnWorker({ project: 'demo', playbook: 'classic', stage: 'plan' });
    // Kill the subprocess out from under the orchestrator — no MCP call, so the
    // gate learns about it only from the manager's status stream. Without that
    // the worker would hold its stage's capacity slot forever.
    await instForSession(t.instances, impl.sessionId).kill();
    await waitFor(async () => (await t.events()).some(e => e.kind === 'retire'));
    const retire = (await t.events()).find(e => e.kind === 'retire');
    assert.equal(retire.sessionId, impl.sessionId);
    assert.match(retire.reason, /subprocess (exited|crashed)/);
    assert.equal(foldProjection(await t.events()).bySession.get(impl.sessionId).live, false);
  } finally { await t.close(); }
});

test('an untracked worker\'s exit writes no retire', async () => {
  // Under `warn` the playbook-less spawn proceeds without a binding, which is the
  // only way to get an untracked worker now that no level is inert. The ledger
  // itself DOES exist here (birth + the refusal), so the assertion is on the
  // absence of the retire event, not of the file.
  const t = await setup({ enforcement: 'warn' });
  try {
    const w = await t.spawnWorker({ project: 'demo', mode: 'plan', createWorktree: true });
    await instForSession(t.instances, w.sessionId).kill();
    // The retire append is fire-and-forget off the status stream, so asserting
    // once here would race AHEAD of the write and pass on timing rather than on
    // suppression. Give the append path real, repeated chances to land and
    // require that it never does — a sibling test proves the same path writes
    // within milliseconds when the worker IS tracked.
    await assert.rejects(
      () => waitFor(async () => (await t.events()).some(e => e.kind === 'retire'),
        { timeout: 1000, interval: 20 }),
      /timeout/,
      'the exit listener must stay inert while nothing is tracked');
  } finally { await t.close(); }
});

// The restart window: a worker bound by a PREVIOUS run of the orchestrator exits
// before this process has made any governed call. The retire path must fold the
// ledger itself rather than assume enforcement already did, or that worker never
// retires and holds its stage's workers:"one" slot in the on-disk ledger forever.
//
// Staged the way production reaches it — the ledger is already on disk when the
// conductor boots — which is why this test builds its own fixture instead of
// using setup(): the binding has to predate the conductor, and setup() spawns the
// conductor first.
test('a worker bound by a previous run still retires when it exits', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    await api(ctx.baseUrl, 'POST', '/api/projects/.conduct/ensure');

    // A worker created directly, so no governed call is involved in its birth.
    const worker = await api(ctx.baseUrl, 'POST', '/api/instances',
      { project: 'demo', mode: 'plan', temp: true });
    assert.equal(worker.status, 201, `worker spawn failed: ${JSON.stringify(worker.body)}`);
    await waitFor(() => ctx.instances.get(worker.body.id)?.sessionId);
    const sessionId = ctx.instances.get(worker.body.id).sessionId;

    // The earlier run's ledger, hand-authored as if it had tracked this worker.
    await fs.mkdir(path.dirname(ledgerFile()), { recursive: true });
    await fs.writeFile(ledgerFile(), JSON.stringify({
      seq: 1, ts: '2026-08-05T00:00:00Z', kind: 'spawn',
      sessionId, playbook: 'classic', stage: 'plan', project: 'demo',
    }) + '\n');

    // Only now does a conductor exist, and it makes no tools/call at all.
    const spawned = await api(ctx.baseUrl, 'POST', '/api/instances',
      { project: '.conduct', mode: 'bypassPermissions', temp: true });
    assert.equal(spawned.status, 201);
    await waitFor(() => ctx.instances.get(spawned.body.id)?.status === 'idle');

    await ctx.instances.get(worker.body.id).kill();
    await waitFor(async () => (await readEvents(ledgerFile())).some(e => e.kind === 'retire'));
    const folded = foldProjection(await readEvents(ledgerFile()));
    assert.equal(folded.bySession.get(sessionId).live, false,
      'the slot is freed even though enforcement never decided a single call');
  } finally { await ctx.close(); }
});

// ── split: the planner can never implement ─────────────────────────────────

test('enforce: in split the planner cannot reach implement by any route', async () => {
  const t = await setup({ enforcement: 'enforce' });
  try {
    const planner = await t.spawnWorker({ project: 'demo', playbook: 'split', stage: 'plan' });
    assert.equal(planner.mode, 'plan');

    // No outgoing edge from `plan` at all — not merely the wrong driver.
    const res = refused(await t.call('send_prompt', {
      sessionId: planner.sessionId, text: 'implement it', stage: 'implement', subscribe: false,
    }), 'TRANSITION_ILLEGAL');
    assert.deepEqual(res.legalMoves.transitions, [], 'split.plan is a dead end by construction');
    // Nor by escalating its permissions.
    refused(await t.call('set_mode', { sessionId: planner.sessionId, mode: 'bypassPermissions' }),
      'TOOL_DENIED_IN_STAGE');
    // Nor by approving it into place — approve_plan drives no edge here.
    await t.call('approve_plan', { sessionId: planner.sessionId, subscribe: false });
    assert.equal(foldProjection(await t.events()).bySession.get(planner.sessionId).stage, 'plan');

    // The only route is a FRESH worker, which inherits the playbook from its
    // needs ancestor rather than restating it.
    const dev = await t.spawnWorker({
      project: 'demo', stage: 'implement', worktree: planner.worktree.worktreeName,
      needs: { plan: planner.sessionId },
    });
    assert.ok(dev.sessionId);
    const folded = foldProjection(await t.events());
    assert.equal(folded.bySession.get(dev.sessionId).playbook, 'split', 'playbook inherited via needs');
    assert.notEqual(dev.sessionId, planner.sessionId);
  } finally { await t.close(); }
});

// ── warn, and the conductor-only scope ─────────────────────────────────────

test('warn: an illegal move proceeds but is recorded as a refusal', async () => {
  const t = await setup({ enforcement: 'warn' });
  try {
    const impl = await t.spawnWorker({ project: 'demo', playbook: 'classic', stage: 'plan' });
    // The same call that `enforce` refuses TRANSITION_ILLEGAL goes through.
    assert.equal((await t.call('send_prompt', {
      sessionId: impl.sessionId, text: 'skip ahead', stage: 'implement', subscribe: false,
    })).ok, undefined, 'warn allows the call');
    const refusals = (await t.events()).filter(e => e.kind === 'refusal');
    assert.equal(refusals.length, 1, 'warn still records what it let through');
    assert.equal(refusals[0].code, 'TRANSITION_ILLEGAL');
    assert.equal(refusals[0].tool, 'send_prompt');
    // Allowed-but-refused means the move did NOT happen — no transition event,
    // so the worker is still in `plan`.
    assert.equal(foldProjection(await t.events()).bySession.get(impl.sessionId).stage, 'plan');
  } finally { await t.close(); }
});

// warn's whole point is to warn a human, and the ledger has no reader — so the
// refusal is also pushed to the CONDUCTOR's own event stream as a UI-only
// system bubble. It made the call, and a refusal may name no worker at all.

test('warn: an illegal move pushes a playbook_warn event to the conductor\'s stream', async () => {
  const t = await setup({ enforcement: 'warn' });
  let c = null;
  try {
    const impl = await t.spawnWorker({ project: 'demo', playbook: 'classic', stage: 'plan' });
    c = await watchConductor(t);
    assert.equal((await t.call('send_prompt', {
      sessionId: impl.sessionId, text: 'skip ahead', stage: 'implement', subscribe: false,
    })).ok, undefined, 'warn still allows the call');

    const m = await c.waitForWarning();
    // Addressed to the conductor, not the worker it targets.
    assert.equal(m.id, t.conductorId, 'the bubble lands on the conductor');
    assert.notEqual(m.id, instForSession(t.instances, impl.sessionId).id);
    // Every payload field comes from the real decision, not a placeholder.
    assert.deepEqual(m.ev.data, {
      tool: 'send_prompt',
      code: 'TRANSITION_ILLEGAL',
      reason: m.ev.data.reason,
      sessionId: impl.sessionId,
    });
    assert.match(m.ev.data.reason, /\S/, 'the refusal reason is carried, not blank');
    assert.equal(m.ev.data.reason,
      (await t.events()).find(e => e.kind === 'refusal').reason,
      'the bubble and the ledger row state the same reason');

    // Additive: the ledger row and warn's proceed-anyway semantics are intact.
    const refusals = (await t.events()).filter(e => e.kind === 'refusal');
    assert.equal(refusals.length, 1, 'the append is not replaced by the emit');
    assert.equal(refusals[0].code, 'TRANSITION_ILLEGAL');
    assert.equal(foldProjection(await t.events()).bySession.get(impl.sessionId).stage, 'plan');
    assert.equal(c.warnings().length, 1, 'exactly one bubble per refusal');
  } finally { if (c) await c.close(); await t.close(); }
});

test('warn: a refusal that names no worker omits sessionId entirely', async () => {
  const t = await setup({ enforcement: 'warn' });
  try {
    // Observed on the instance's own 'event' channel, NOT over the WebSocket:
    // JSON.stringify drops an undefined value, so the wire cannot tell an
    // omitted key from `sessionId: undefined` and only the raw object can.
    const raw = [];
    t.instances.get(t.conductorId).on('event',
      ev => { if (ev?.kind === 'system' && ev.subtype === 'playbook_warn') raw.push(ev); });

    // A bare spawn names no playbook — and, being a spawn, no target session.
    const out = await t.call('spawn_instance', { project: 'demo', mode: 'plan' });
    assert.ok(out.sessionId, 'warn still allows the spawn');

    await waitFor(() => raw.length > 0);
    assert.equal(raw[0].data.code, 'PLAYBOOK_UNKNOWN');
    assert.equal(raw[0].data.tool, 'spawn_instance');
    assert.ok(!('sessionId' in raw[0].data),
      'absent rather than undefined — the key must not be emitted at all');
  } finally { await t.close(); }
});

test('enforce: a refusal pushes no playbook_warn — the caller already got it', async () => {
  const t = await setup({ enforcement: 'enforce' });
  let c = null;
  try {
    const impl = await t.spawnWorker({ project: 'demo', playbook: 'classic', stage: 'plan' });
    c = await watchConductor(t);
    refused(await t.call('send_prompt', {
      sessionId: impl.sessionId, text: 'skip ahead', stage: 'implement', subscribe: false,
    }), 'TRANSITION_ILLEGAL');
    // The refusal reached the ledger, so the gate ran — the emit is what's
    // absent, which pins it INSIDE the warn branch rather than above it.
    assert.equal((await t.events()).filter(e => e.kind === 'refusal').length, 1);
    await c.expectNoWarning();
  } finally { if (c) await c.close(); await t.close(); }
});

test('policy applies only to the conductor: the same calls from a worker or no caller are ungoverned', async () => {
  const t = await setup({ enforcement: 'enforce' });
  try {
    // Under the conductor, a bare spawn is refused for naming no playbook.
    refused(await t.call('spawn_instance', { project: 'demo', mode: 'plan' }), 'PLAYBOOK_UNKNOWN');

    // A NON-conductor caller (an ordinary worker driving the MCP itself) is not
    // governed — worker-side calls keep their existing recursion rules.
    const worker = await t.spawnWorker({ project: 'demo', playbook: 'classic', stage: 'plan' });
    const workerHandle = instForSession(t.instances, worker.sessionId).id;
    const asWorker = await t.callAs(workerHandle, 'spawn_instance', { project: 'demo', mode: 'plan' });
    assert.ok(asWorker.sessionId, 'a worker\'s own spawn is ungoverned');

    // The case where being a conductor is the OPERATIVE term rather than
    // incidental: a NON-.conduct instance that is itself carrying
    // playbookEnforcement:'enforce'. The spawn route accepts the field for any
    // project, so a permissive level cannot be what makes this caller ungoverned
    // — only the conductor check can.
    const rogue = await api(t.baseUrl, 'POST', '/api/instances', {
      project: 'demo', mode: 'bypassPermissions', temp: true, playbookEnforcement: 'enforce',
    });
    assert.equal(rogue.status, 201);
    await waitFor(() => t.instances.get(rogue.body.id)?.status === 'idle');
    assert.equal(t.instances.get(rogue.body.id).playbookEnforcement, 'enforce',
      'the enforcing-but-not-a-conductor precondition actually holds');
    const asRogue = await t.callAs(rogue.body.id, 'spawn_instance', { project: 'demo', mode: 'plan' });
    assert.ok(asRogue.sessionId, 'only the conductor is governed, whatever a worker\'s own setting says');

    // The rogue must also be invisible to the AUDIT trail, which is a separate
    // guard from the one above: the birth-event path lives on the status stream,
    // not in check(), so the spawn refusal alone leaves it unobserved. The only
    // enforcement event may be the conductor's own birth — a rogue birth event
    // would make a non-conductor look like a governed actor to anything reading
    // projection.enforcement.
    const own = await expectEnforcementEvents(t, 1);
    assert.equal(own[0].conductorSessionId, t.instances.get(t.conductorId).sessionId,
      'the one enforcement event belongs to the real conductor');
    await expectNoMoreEnforcement(t, 1);

    // And no ?caller= at all (a human or an unattributed client) likewise.
    const anon = await t.callAs(null, 'spawn_instance', { project: 'demo', mode: 'plan' });
    assert.ok(anon.sessionId, 'an unattributed spawn is ungoverned');
  } finally { await t.close(); }
});

// ── the toggle ─────────────────────────────────────────────────────────────

test('the enforcement toggle takes effect on the next call and lands in the ledger', async () => {
  // Starts at `warn` — the OFF position of the menu toggle — where an unlabelled
  // spawn is allowed through, so the flip has something observable to change.
  const t = await setup({ enforcement: 'warn' });
  try {
    const w = await t.spawnWorker({ project: 'demo', mode: 'plan', createWorktree: true });
    assert.ok(w.sessionId);

    const ack = await t.setEnforcement('enforce');
    assert.equal(ack.ok, true);
    assert.equal(t.instances.get(t.conductorId).playbookEnforcement, 'enforce');
    assert.equal(t.instances.get(t.conductorId).summary().playbookEnforcement, 'enforce');

    // Same call, now refused — the flip is live without a respawn.
    refused(await t.call('spawn_instance', { project: 'demo', mode: 'plan' }), 'PLAYBOOK_UNKNOWN');

    // Two events: the birth at `warn`, then the change.
    const toggles = await expectEnforcementEvents(t, 2);
    assert.equal(toggles[1].from, 'warn', 'the change is recorded so backtracking can explain it');
    assert.equal(toggles[1].to, 'enforce');
    assert.equal(toggles[1].conductorSessionId, t.instances.get(t.conductorId).sessionId);

    // A no-op re-set writes nothing more.
    await t.setEnforcement('enforce');
    await expectNoMoreEnforcement(t, 2);

    // An unknown mode is refused at the ingress boundary.
    const bad = await t.setEnforcement('sometimes');
    assert.equal(bad.ok, false);
    assert.match(bad.error, /warn \| enforce/);
    assert.equal(t.instances.get(t.conductorId).playbookEnforcement, 'enforce');
  } finally { await t.close(); }
});

test('a conductor born at enforce records a birth event with from:null, not from:warn', async () => {
  const t = await setup({ enforcement: 'enforce' });
  try {
    const birth = (await expectEnforcementEvents(t, 1))[0];
    assert.equal(birth.to, 'enforce');
    // The whole point: `null` says "born this way". Naming the other level would
    // assert a past the conductor never had.
    assert.equal(birth.from, null);
    assert.equal('from' in birth, true, 'the key is present-and-null, so a reader can tell a birth from a missing field');
    assert.equal(birth.conductorSessionId, t.instances.get(t.conductorId).sessionId);

    // A later change is a change: its `from` is the mode that actually held.
    await t.setEnforcement('warn');
    const all = await expectEnforcementEvents(t, 2);
    assert.deepEqual({ from: all[1].from, to: all[1].to }, { from: 'enforce', to: 'warn' });

    // Folding treats the birth as setting the initial mode, so the projection
    // agrees with the live instance either way.
    assert.equal(foldProjection(await t.events()).enforcement.get(birth.conductorSessionId), 'warn');
  } finally { await t.close(); }
});

test('a conductor born at warn records its birth and materialises the ledger', async () => {
  const t = await setup({ enforcement: 'warn' });
  try {
    // No level is inert, so the permissive one is audited too — a `warn` session
    // that is never flipped must still be explicable from the ledger alone.
    const [birth] = await expectEnforcementEvents(t, 1);
    assert.deepEqual({ from: birth.from, to: birth.to }, { from: null, to: 'warn' });
    assert.equal(await t.ledgerExists(), true);
  } finally { await t.close(); }
});

test('a conductor spawned with no playbookEnforcement defaults to enforce', async () => {
  const t = await setup();
  try {
    // The flipped default, read at the real ingress rather than off the class
    // field: playbooks are on unless someone turns them off.
    assert.equal(t.instances.get(t.conductorId).playbookEnforcement, 'enforce');
    assert.equal(t.instances.get(t.conductorId).summary().playbookEnforcement, 'enforce',
      'and it rides the summary, which is what every frame and REST reply carries');
  } finally { await t.close(); }
});

test('the spawn route validates playbookEnforcement and rejects an unknown mode', async () => {
  const t = await setup();
  try {
    const bad = await api(t.baseUrl, 'POST', '/api/instances', {
      project: '.conduct', mode: 'bypassPermissions', temp: true, playbookEnforcement: 'always',
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /warn \| enforce/);
  } finally { await t.close(); }
});

test('the retired `off` level is refused at both ingress boundaries', async () => {
  const t = await setup();
  try {
    // 'off' is gone from the allow-list, so it must be REFUSED rather than
    // silently coerced — a caller asking for inert behaviour that no longer
    // exists deserves to hear that, not to get `warn` without being told.
    const bad = await api(t.baseUrl, 'POST', '/api/instances', {
      project: '.conduct', mode: 'bypassPermissions', temp: true, playbookEnforcement: 'off',
    });
    assert.equal(bad.status, 400);

    const ack = await t.setEnforcement('off');
    assert.equal(ack.ok, false, 'the WS toggle must reject it too');
    assert.equal(t.instances.get(t.conductorId).playbookEnforcement, 'enforce',
      'and the level must not have moved');
  } finally { await t.close(); }
});
