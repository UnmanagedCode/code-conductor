// The playbook read surface — list_playbooks, describe_playbook, playbook_state
// — end to end through the MCP router with a real `.conduct` conductor as
// ?caller= and the fake claude engine.
//
// Two properties matter more than the shapes:
//   • READING NEVER WRITES. A read tool that appended to the ledger — or created
//     it — to answer would corrupt the audit trail with the act of inspecting it.
//   • ADVERTISED == ENFORCED. `nextMoves` is answered by dry-running the same
//     decide() the enforcement checkpoint runs, so the two cannot diverge by
//     construction; the test then performs the advertised moves and compares.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession } from './helpers.mjs';
import { ledgerFile } from '../src/playbookLedger.ts';
import { orchStoreRoot } from '../src/projects.ts';

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

  // Same call, but hands back the raw single text block instead of parsing it.
  async function callRawAs(handle, name, args) {
    const url = ctx.baseUrl + '/mcp' + (handle ? `?caller=${encodeURIComponent(handle)}` : '');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await res.json();
    assert.ok(body.result, `tools/call ${name} returned no result: ${JSON.stringify(body)}`);
    assert.equal(body.result.content.length, 1, `${name} should be a single text block`);
    return body.result.content[0].text;
  }

  return {
    ...ctx,
    conductorId,
    call: (name, args) => callAs(conductorId, name, args),
    callAs,
    // The recon read tools return a plain-text rendering, not JSON.
    callText: (name, args) => callRawAs(conductorId, name, args),
    async spawnWorker(args) {
      const out = await callAs(conductorId, 'spawn_instance', args);
      if (out.sessionId) await waitFor(() => instForSession(ctx.instances, out.sessionId)?.sessionId);
      return out;
    },
    async ledgerExists() {
      try { await fs.access(ledgerFile()); return true; } catch { return false; }
    },
    async eventCount() {
      try {
        const raw = await fs.readFile(ledgerFile(), 'utf8');
        return raw.split('\n').filter(l => l.trim()).length;
      } catch { return 0; }
    },
    // Drop a hand-authored definition into the user overlay directory, which is
    // the documented way to add a playbook without touching the repo.
    async writeUserPlaybook(id, body) {
      const dir = path.join(orchStoreRoot(), 'playbooks');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${id}.json`), typeof body === 'string' ? body : JSON.stringify(body));
    },
  };
}

const refused = (res, code) => {
  assert.equal(res.ok, false, `expected a refusal, got ${JSON.stringify(res)}`);
  assert.equal(res.code, code, `expected ${code}, got ${res.code}: ${res.reason}`);
  return res;
};

// ── list_playbooks / describe_playbook ─────────────────────────────────────

test('list_playbooks reports the built-ins with their entry and spawnable stages', async () => {
  const t = await setup();
  try {
    const res = await t.call('list_playbooks', {});
    const byId = Object.fromEntries(res.playbooks.map(p => [p.id, p]));
    assert.deepEqual(Object.keys(byId).sort(), ['classic', 'freeform', 'research', 'split']);
    for (const p of res.playbooks) {
      assert.ok(p.name.length > 0, `${p.id} has no name`);
      assert.ok(p.description.length > 0, `${p.id} has no description`);
    }
    assert.deepEqual(byId.classic.entryStages, ['plan']);
    // spawn_instance fails closed, so `plan` is the only stage of classic a
    // worker can be created in — implement/refine are transition-only, and
    // `review` is spawnable but not an entry stage.
    assert.deepEqual(byId.classic.spawnableStages.sort(), ['plan', 'review']);
    assert.deepEqual(res.errors, []);
  } finally { await t.close(); }
});

test('list_playbooks reports a rejected definition in errors instead of silently omitting it', async () => {
  const t = await setup();
  try {
    // `bogus` names a transition target that does not exist — rejected at load.
    await t.writeUserPlaybook('bogus', {
      id: 'bogus', name: 'Bogus', description: 'invalid on purpose',
      entryStages: ['a'], stages: { a: { tools: { spawn_instance: 'allow' } } },
      transitions: [{ from: 'a', to: 'nowhere' }],
    });
    const res = await t.call('list_playbooks', {});
    assert.equal(res.playbooks.some(p => p.id === 'bogus'), false, 'an invalid definition must not load');
    const mine = res.errors.filter(e => e.id === 'bogus');
    assert.equal(mine.length > 0, true, 'the reason it did not load must be reported, not swallowed');
    assert.match(mine[0].message, /nowhere/);
  } finally { await t.close(); }
});

test('describe_playbook returns the graph the enforcement actually uses', async () => {
  const t = await setup();
  try {
    const pb = await t.call('describe_playbook', { id: 'classic' });
    assert.equal(pb.id, 'classic');

    // `require` — enforced argument values, reported verbatim so a caller knows
    // what will be filled in or refused.
    assert.deepEqual(pb.stages.plan.tools.spawn_instance,
      { require: { mode: 'plan', createWorktree: true } });
    assert.equal(pb.stages.plan.tools.set_mode, 'deny');

    // `needs` — worker provenance, not argument values.
    assert.deepEqual(pb.stages.review.needs, [{ stage: 'implement', at: 'current' }]);
    assert.equal(pb.stages.plan.workers, 'one');

    // `spawnable` is derived from the fail-closed rule, so the caller does not
    // have to know that a "*" wildcard confers nothing.
    assert.equal(pb.stages.plan.spawnable, true);
    assert.equal(pb.stages.review.spawnable, true);
    assert.equal(pb.stages.implement.spawnable, false);
    assert.equal(pb.stages.refine.spawnable, false);

    // `via` names the ONE tool that drives each edge.
    const byEdge = Object.fromEntries(pb.transitions.map(x => [`${x.from}->${x.to}`, x.via]));
    assert.deepEqual(byEdge, { 'plan->implement': 'approve_plan', 'implement->refine': 'send_prompt' });
  } finally { await t.close(); }
});

test('describe_playbook soft-refuses an unknown id and lists the known ones', async () => {
  const t = await setup();
  try {
    const res = refused(await t.call('describe_playbook', { id: 'nope' }), 'PLAYBOOK_UNKNOWN');
    assert.deepEqual(res.known, ['classic', 'freeform', 'research', 'split']);
  } finally { await t.close(); }
});

// ── reading never writes ───────────────────────────────────────────────────

test('the read tools create no ledger when there is nothing to read', async () => {
  // No conductor at all, so nothing has recorded a birth: the read-only fold must
  // answer from an empty projection and leave the filesystem untouched. Built from
  // scratch rather than via setup() precisely because setup()'s conductor would
  // materialise the ledger itself — legitimately, and for reasons unrelated to reads.
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const call = async (name, args) => {
      const res = await fetch(ctx.baseUrl + '/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
      });
      const body = await res.json();
      return JSON.parse(body.result.content[0].text);
    };
    assert.equal((await call('list_playbooks', {})).playbooks.length, 4);
    assert.equal((await call('describe_playbook', { id: 'classic' })).id, 'classic');
    assert.deepEqual((await call('playbook_state', {})).runs, []);

    // Give any deferred write real chances to land rather than reading once and
    // racing it.
    await assert.rejects(
      () => waitFor(async () => {
        try { await fs.access(ledgerFile()); return true; } catch { return false; }
      }, { timeout: 1000, interval: 20 }),
      /timeout/,
      'a read tool must never materialise the ledger it reads');
  } finally { await ctx.close(); }
});

test('the read tools append no events to a ledger that already exists', async () => {
  // The other half of "reading never writes", and the half that still applies once
  // a conductor's birth event has created the file: answering must add nothing.
  const t = await setup({ enforcement: 'warn' });
  try {
    const worker = await t.spawnWorker({ project: 'demo', mode: 'plan', createWorktree: true });
    await waitFor(async () => (await t.eventCount()) > 0);
    const before = await t.eventCount();

    assert.equal((await t.call('list_playbooks', {})).playbooks.length, 4);
    assert.equal((await t.call('describe_playbook', { id: 'classic' })).id, 'classic');
    assert.deepEqual((await t.call('playbook_state', {})).runs, [],
      'the illegal spawn was refused-but-allowed, so it bound no run');
    assert.equal((await t.call('playbook_state', { sessionId: worker.sessionId })).tracked, false);

    await assert.rejects(
      () => waitFor(async () => (await t.eventCount()) > before, { timeout: 1000, interval: 20 }),
      /timeout/,
      'reading must not append');
  } finally { await t.close(); }
});

test('playbook_state for an untracked worker is a normal empty answer, not a refusal', async () => {
  // `warn` is what produces an untracked worker now: the playbook-less spawn is
  // refused-but-allowed, so it runs with no binding.
  const t = await setup({ enforcement: 'warn' });
  try {
    const worker = await t.spawnWorker({ project: 'demo', mode: 'plan', createWorktree: true });
    const res = await t.call('playbook_state', { sessionId: worker.sessionId });
    assert.equal('ok' in res, false, '"not in a playbook" is a fact about the worker, not a bad call');
    assert.equal(res.tracked, false);
    assert.equal(res.worker, null);
    assert.deepEqual(res.nextMoves, []);
    assert.match(res.reason, /not playbook-tracked/);
  } finally { await t.close(); }
});

// The diagnostic must survive the thing it diagnoses. A stage written with the
// documented allowlist idiom ({"*": "deny", …}) denies playbook_state, because
// declaring a `sessionId` puts it in the derived governable set like any other
// targeted tool. The no-argument form names no worker, so policy has no subject
// and it can never be denied — that is the escape hatch, and it is a property of
// the signature rather than a special case in the gate.
test('a stage that denies playbook_state cannot lock the conductor out of introspection', async () => {
  const t = await setup({ enforcement: 'enforce' });
  try {
    await t.writeUserPlaybook('locked', {
      id: 'locked', name: 'Locked', description: 'an allowlist stage',
      entryStages: ['work'],
      stages: { work: { tools: { '*': 'deny', spawn_instance: 'allow', send_prompt: 'allow' } } },
      transitions: [],
    });
    const w = await t.spawnWorker({ project: 'demo', playbook: 'locked', stage: 'work', mode: 'plan' });
    assert.ok(w.sessionId, 'spawn into the allowlist stage is permitted');

    refused(await t.call('playbook_state', { sessionId: w.sessionId }), 'TOOL_DENIED_IN_STAGE');

    const escape = await t.call('playbook_state', {});
    assert.equal('ok' in escape, false, 'the untargeted form is never subject to a stage policy');
    const member = escape.runs.flatMap(r => r.members).find(m => m.sessionId === w.sessionId);
    assert.deepEqual({ playbook: member.playbook, stage: member.stage },
      { playbook: 'locked', stage: 'work' },
      'and it still reports the state the targeted form was refused for');
  } finally { await t.close(); }
});

// ── advertised == enforced ─────────────────────────────────────────────────

// nextMoves is answered by dry-running the enforcing decide(), so this walks a
// classic run and, at every step, PERFORMS what nextMoves advertises and compares
// the outcome. Predictions are re-derived after each performed move, because each
// move changes what is legal next — comparing a stale prediction would degrade
// this into "the first move matched".
test('every move playbook_state advertises behaves exactly as advertised when performed', async () => {
  const t = await setup({ enforcement: 'enforce' });
  try {
    const impl = await t.spawnWorker({ project: 'demo', playbook: 'classic', stage: 'plan' });
    const wtName = impl.worktree.worktreeName;

    const movesNow = async () =>
      (await t.call('playbook_state', { sessionId: impl.sessionId })).nextMoves;

    // Step 1 — in `plan`. The only edge is approve_plan-driven, and it is legal.
    let moves = await movesNow();
    assert.deepEqual(moves, [{ to: 'implement', via: 'approve_plan', ok: true }]);
    await t.call(moves[0].via, { sessionId: impl.sessionId, subscribe: false });
    assert.equal((await t.call('playbook_state', { sessionId: impl.sessionId })).worker.stage, 'implement');

    // Step 2 — in `implement`. Re-derived, and now the prediction is a BLOCKED
    // edge: refine needs a reviewer that does not exist yet. A prediction that
    // only ever says yes would prove half the property.
    moves = await movesNow();
    assert.equal(moves.length, 1);
    assert.deepEqual({ to: moves[0].to, via: moves[0].via, ok: moves[0].ok },
      { to: 'refine', via: 'send_prompt', ok: false });
    assert.equal(moves[0].code, 'NEEDS_UNSATISFIED');
    // Performing it produces the SAME code and the same reason text.
    const attempted = await t.call('send_prompt', {
      sessionId: impl.sessionId, text: 'refine', stage: 'refine', subscribe: false,
    });
    refused(attempted, moves[0].code);
    assert.equal(attempted.reason, moves[0].reason,
      'the advertised reason is the enforced reason, verbatim');

    // Step 3 — a reviewer now exists, and the prediction DELIBERATELY still says
    // NEEDS_UNSATISFIED. `needs` is a caller-supplied argument, not an ambient
    // fact, so the dry run describes the bare call: "call this with no needs and
    // you get this". Inferring which worker the caller meant would be a second
    // reading of the rules, and a wrong guess would advertise a move that then
    // fails. What the prediction owes the caller is an actionable recipe, and its
    // `reason` is one.
    const rev = await t.spawnWorker({
      project: 'demo', playbook: 'classic', stage: 'review', worktree: wtName,
      needs: { implement: impl.sessionId },
    });
    moves = await movesNow();
    assert.equal(moves[0].ok, false, 'the bare call is still blocked — needs is an argument, not a fact');
    assert.match(moves[0].reason, /pass needs: \{ "review": "<sessionId>" \}/,
      'and the reason names exactly what to pass');

    // Following that recipe succeeds.
    const ok = await t.call('send_prompt', {
      sessionId: impl.sessionId, text: 'refine', stage: 'refine', subscribe: false,
      needs: { review: rev.sessionId },
    });
    assert.equal(ok.ok, undefined, 'supplying what the reason asked for makes the move legal');

    // Step 4 — `refine` is terminal in classic, so nothing is advertised and
    // nothing can be driven.
    assert.deepEqual(await movesNow(), []);
  } finally { await t.close(); }
});

test('playbook_state derives the run graph and its history, keeping concurrent runs separate', async () => {
  const t = await setup({ enforcement: 'enforce' });
  try {
    const a = await t.spawnWorker({ project: 'demo', playbook: 'classic', stage: 'plan' });
    await t.call('approve_plan', { sessionId: a.sessionId, subscribe: false });
    const aRev = await t.spawnWorker({
      project: 'demo', playbook: 'classic', stage: 'review',
      worktree: a.worktree.worktreeName, needs: { implement: a.sessionId },
    });
    // A second, independent run of the same playbook.
    const b = await t.spawnWorker({ project: 'demo', playbook: 'classic', stage: 'plan' });

    const stateA = await t.call('playbook_state', { sessionId: a.sessionId });
    assert.deepEqual(stateA.worker.stageHistory, ['plan', 'implement']);
    assert.equal(stateA.worker.playbook, 'classic');
    assert.equal(stateA.worker.live, true);
    assert.deepEqual(stateA.run.members.map(m => m.sessionId).sort(),
      [a.sessionId, aRev.sessionId].sort(),
      'the run is the component over `needs` edges — run B is not in it');
    assert.equal(stateA.run.members.some(m => m.sessionId === b.sessionId), false);

    // History is the backtrack surface: this run's events, oldest first.
    assert.equal(stateA.historyTruncated, false);
    assert.deepEqual(stateA.history.filter(e => e.kind !== 'enforcement').map(e => e.kind),
      ['spawn', 'transition', 'spawn']);
    assert.deepEqual(stateA.history.map(e => e.seq), [...stateA.history.map(e => e.seq)].sort((x, y) => x - y));
    assert.equal(stateA.history.some(e => e.sessionId === b.sessionId), false,
      'another run\'s events must not leak into this one\'s history');
    // The caller's own enforcement birth event rides along — it is what explains
    // why these moves were checked at all.
    const enf = stateA.history.filter(e => e.kind === 'enforcement');
    assert.equal(enf.length, 1);
    assert.equal(enf[0].conductorSessionId, t.instances.get(t.conductorId).sessionId);

    // The conductor's live level, read off the instance rather than the ledger.
    assert.deepEqual(stateA.enforcement,
      { conductorSessionId: t.instances.get(t.conductorId).sessionId, mode: 'enforce' });

    // Two distinct components, reported by the untargeted form.
    const all = await t.call('playbook_state', {});
    assert.equal(all.runs.length, 2);
  } finally { await t.close(); }
});

test('playbook_state reports no enforcement block for a non-conductor caller', async () => {
  const t = await setup({ enforcement: 'enforce' });
  try {
    const w = await t.spawnWorker({ project: 'demo', playbook: 'classic', stage: 'plan' });
    const workerHandle = instForSession(t.instances, w.sessionId).id;
    // A worker driving the MCP itself is not a conductor, so there is no
    // enforcement level of its own to publish — and nothing here may make a
    // non-conductor look like a governed actor.
    const asWorker = await t.callAs(workerHandle, 'playbook_state', {});
    assert.equal(asWorker.enforcement, null);
    const anon = await t.callAs(null, 'playbook_state', {});
    assert.equal(anon.enforcement, null);
  } finally { await t.close(); }
});

// ── list_instances join ────────────────────────────────────────────────────

test('list_instances carries playbook/stage for a tracked worker and null for an untracked one', async () => {
  const t = await setup({ enforcement: 'enforce' });
  try {
    const tracked = await t.spawnWorker({ project: 'demo', playbook: 'classic', stage: 'plan' });
    // Spawned by a NON-conductor caller, so the gate never tracks it.
    const workerHandle = instForSession(t.instances, tracked.sessionId).id;
    const untracked = await t.callAs(workerHandle, 'spawn_instance', { project: 'demo', mode: 'plan' });
    await waitFor(() => instForSession(t.instances, untracked.sessionId)?.sessionId);

    // list_instances renders plain text, so read the playbook line off each
    // worker's block (src/mcp/readRenderers.ts renderInstances).
    const rendered = await t.callText('list_instances', {});
    const playbookLineFor = (sid) => {
      const lines = rendered.split('\n');
      const at = lines.findIndex(l => l.includes(sid));
      assert.ok(at >= 0, `worker ${sid} missing from:\n${rendered}`);
      const line = lines.slice(at + 1).find(l => l.trim().startsWith('playbook '));
      assert.ok(line, `no playbook line for ${sid}`);
      return line.trim();
    };
    assert.equal(playbookLineFor(tracked.sessionId), 'playbook classic / plan');
    // A dash, not a blank — "not in a playbook" must be distinguishable from
    // "this build does not report it".
    assert.equal(playbookLineFor(untracked.sessionId), 'playbook — / —');
  } finally { await t.close(); }
});

// ── the server half of the UI mirror ──────────────────────────────────────

test('the WS snapshot and status frames carry playbookEnforcement', async () => {
  const t = await setup({ enforcement: 'warn' });
  const { WebSocket } = await import('ws');
  let ws = null;
  try {
    const frames = [];
    ws = new WebSocket(t.wsUrl);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.on('message', raw => frames.push(JSON.parse(raw.toString())));
    ws.send(JSON.stringify({ t: 'subscribe', id: t.conductorId }));

    // Each frame is located by TYPE and its field asserted separately, never
    // found by the field's value: a predicate like `f.playbookEnforcement ===
    // 'warn'` would turn a missing field into a timeout instead of an assertion
    // failure, which is the difference between a caught regression and a stalled
    // run.
    const snap = await waitFor(() => frames.find(f => f.t === 'snapshot'), { timeout: 4000 });
    assert.equal(snap.playbookEnforcement, 'warn',
      'without this the control cannot hydrate on subscribe');

    // A flip from any surface must reach the client, or the control desyncs.
    // Clearing first means the frame we then read is one this flip caused.
    frames.length = 0;
    t.instances.get(t.conductorId).setPlaybookEnforcement('enforce');
    const status = await waitFor(() => frames.find(f => f.t === 'status'), { timeout: 4000 });
    assert.equal(status.playbookEnforcement, 'enforce',
      'a flip must reach the client, or the control shows a stale level');
  } finally {
    // The socket MUST be released whether or not the assertions passed: close()
    // awaits server.close(), which waits for existing connections to end, so a
    // leaked socket turns a failing assertion into a hung suite. A hanging test
    // is worse than a failing one — it also defeats mutation testing, which reads
    // the timeout as "no verdict" rather than "caught".
    if (ws) await new Promise(resolve => { ws.once('close', resolve); ws.close(); });
    await t.close();
  }
});
