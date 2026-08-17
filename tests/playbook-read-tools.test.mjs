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
    // The recon read tools and describe_playbook's success path return a
    // plain-text rendering, not JSON.
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
    assert.deepEqual(Object.keys(byId).sort(), ['freeform', 'relay', 'solo']);
    for (const p of res.playbooks) {
      assert.ok(p.name.length > 0, `${p.id} has no name`);
      assert.ok(p.description.length > 0, `${p.id} has no description`);
    }
    assert.deepEqual(byId.solo.entryStages, ['plan']);
    // spawn_instance fails closed, so `plan` is the only stage of solo a
    // worker can be created in — implement/refine are transition-only, and
    // `review` is spawnable but not an entry stage.
    assert.deepEqual(byId.solo.spawnableStages.sort(), ['plan', 'review']);
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

// `on` is the AUTHORING key in playbooks/*.json. No read surface emits it —
// describe_playbook and playbook_state both report `via` — so a conductor told
// to look for an edge that "declares an `on` tool" is being pointed at a field
// it can never see. The vocabulary the caller is given has to be the one the
// caller is shown.
test('send_prompt\'s stage description names `via`, never the authoring key `on`', async () => {
  const { buildTools } = await import('../src/mcp/tools.ts');
  const sendPrompt = buildTools().find(t => t.name === 'send_prompt');
  const stageDesc = sendPrompt.inputSchema.properties.stage.description;
  assert.match(stageDesc, /`via`/, 'the reader-facing field must be named');
  assert.doesNotMatch(stageDesc, /`on`/, 'the authoring-only key must not appear on a read surface');
});

// describe_playbook's success path is a plain-text rendering (renderPlaybook,
// src/mcp/readRenderers.ts), pinned exactly in tests/mcp-text-render.test.mjs
// against hand-built payloads. This is the WIRE half: it asserts the real
// `solo` definition reaches that rendering with the derivations intact —
// which a pure suite cannot see, since `spawnable` and `via` are computed in the
// handler.
test('describe_playbook returns the graph the enforcement actually uses', async () => {
  const t = await setup();
  try {
    const pb = await t.callText('describe_playbook', { id: 'solo' });
    assert.match(pb, /^PLAYBOOK solo$/m);
    assert.match(pb, /^entry plan$/m);

    // `pin` — enforced argument values, reported verbatim so a caller knows
    // what will be filled in or refused.
    assert.match(pb, /^ {6}spawn_instance pin \{"mode":"plan","createWorktree":true\}$/m);
    assert.match(pb, /^ {6}set_mode deny$/m);

    // `needs` — worker provenance, not argument values. Read off `review`'s
    // block, so a renderer that hung it on the wrong stage fails.
    const stageBlock = (name) => {
      const at = pb.indexOf(`▸ ${name} `);
      assert.ok(at >= 0, `stage ${name} missing from:\n${pb}`);
      const rest = pb.slice(at + 1);
      const end = rest.indexOf('\n▸ ');
      return rest.slice(0, end === -1 ? rest.indexOf('\nTRANSITIONS') : end);
    };
    // Both axes reach the text: the anchor stage with its liveness, and the
    // position list. A renderer that dropped either would still print a cell.
    assert.match(stageBlock('review'), /^ {4}needs implement@live in implement\|refine$/m);
    assert.match(stageBlock('refine'), /^ {4}needs review@live in review$/m);
    assert.match(stageBlock('plan'), /workers one/);

    // `spawnable` is derived from the fail-closed rule, so the caller does not
    // have to know that a "*" wildcard confers nothing. Both answers are
    // asserted: a rendering that always said yes would satisfy half of this.
    for (const name of ['plan', 'review']) assert.match(stageBlock(name), /spawnable yes/);
    for (const name of ['implement', 'refine']) assert.match(stageBlock(name), /spawnable no/);

    // `via` names the ONE tool that drives each edge — both the declared `on`
    // and the send_prompt default.
    assert.match(pb, /^ {2}plan → implement {2,}via approve_plan$/m);
    assert.match(pb, /^ {2}implement → refine {2,}via send_prompt$/m);
    // The declared self-loops: ordinary send_prompt edges, and the reason a
    // repeated round is countable at all.
    assert.match(pb, /^ {2}refine → refine {2,}via send_prompt$/m);
    assert.match(pb, /^ {2}review → review {2,}via send_prompt$/m);
  } finally { await t.close(); }
});

// The per-stage `description` is where playbook-specific conductor orchestration
// lives, so `describe_playbook` is the surface that has to carry it. Authored on
// a USER-OVERLAY definition, not a built-in: the built-ins' own descriptions are
// a separate editorial card, and a test that depended on their content would
// fail the moment they are written.
test('describe_playbook carries stage/transition descriptions, and omits them when unauthored', async () => {
  const t = await setup();
  try {
    const stageText = 'Ground yourself, then hand off.';
    const edgeText = 'Fresh worker on this edge, not an in-place send.';
    await t.writeUserPlaybook('described', {
      id: 'described', name: 'Described', description: 'top-level catalog line',
      entryStages: ['a'],
      stages: {
        a: { description: stageText, tools: { spawn_instance: 'allow' } },
        b: {},
        c: {},
      },
      transitions: [{ from: 'a', to: 'b', description: edgeText }, { from: 'a', to: 'c' }],
    });

    const pb = await t.callText('describe_playbook', { id: 'described' });
    // Verbatim, under its own label — authored prose is the one text a playbook
    // author owns, so the rendering may not reflow or truncate it.
    assert.match(pb, new RegExp(`^ {6}${stageText}$`, 'm'));
    assert.match(pb, new RegExp(`^ {6}${edgeText}$`, 'm'));

    // An unauthored description emits NO line — not a —, not an empty label.
    // Each chunk is one item plus everything indented under it: a stage line
    // starts at column 0 with ▸, an edge line at exactly two spaces, and both
    // their description labels and bodies are indented deeper. Splitting on the
    // OWNER's indent (rather than scanning for the next line at any indent) is
    // what makes the negative assertions below able to fail at all — an end
    // marker that a description line also matches truncates the chunk before
    // the very text it is looking for.
    const chunkFor = (section, ownerPattern, label) => {
      const body = pb.slice(pb.indexOf(section));
      const found = body.split(ownerPattern).filter(c => c.includes(label));
      assert.equal(found.length, 1,
        `expected exactly one ${label} chunk under ${section} in:\n${body}`);
      return found[0];
    };
    const stageChunk = (name) => chunkFor('STAGES (', /\n(?=▸ )/, `▸ ${name} `);
    const edgeChunk = (edge) => chunkFor('TRANSITIONS (', /\n(?= {2}\S)/, edge);

    // Positive control first: the chunker really does capture a description that
    // IS there, so a false negative below cannot be mistaken for a pass.
    assert.match(stageChunk('a'), /^ {4}description$/m);
    assert.match(edgeChunk('a → b'), /^ {4}description$/m);
    assert.match(edgeChunk('a → b'), new RegExp(`^ {6}${edgeText}$`, 'm'));

    assert.equal(/description/.test(stageChunk('b')), false,
      'an unauthored stage description must render no line');
    assert.equal(/description/.test(edgeChunk('a → c')), false,
      'an unauthored transition description must render no line');
  } finally { await t.close(); }
});

// Two facts the `solo` wire test above cannot reach: every one of its stages
// is `workers: "one"`, so a handler that hardcoded that value would report a
// fan-out stage as single-worker (a conductor then never fans out) with the whole
// suite green; and nothing asserted the GRAPH-level description survives the
// payload at all, though docs/protocol.md says the header carries it. Both are
// pinned on an overlay definition rather than a built-in, so neither depends on
// the built-ins' editorial content.
test('describe_playbook renders the graph description and both `workers` values', async () => {
  const t = await setup();
  try {
    const graphText = 'What this graph is for, in one line.';
    await t.writeUserPlaybook('fanned', {
      id: 'fanned', name: 'Fanned', description: graphText,
      entryStages: ['lead'],
      stages: {
        lead: { workers: 'one', tools: { spawn_instance: 'allow' } },
        crowd: { workers: 'many' },
      },
      transitions: [{ from: 'lead', to: 'crowd' }],
    });

    const pb = await t.callText('describe_playbook', { id: 'fanned' });
    assert.match(pb, new RegExp(`^DESCRIPTION\\n {2}${graphText}$`, 'm'),
      'the graph-level description must reach the header');
    assert.match(pb, /^▸ lead .*workers one/m);
    assert.match(pb, /^▸ crowd .*workers many/m,
      'a fan-out stage must not be reported as single-worker');
  } finally { await t.close(); }
});

// `list_playbooks` is the CATALOG: id + the top-level one-liner. Per-stage
// descriptions belong to `describe_playbook` and (later) the selected default
// playbook's convention — leaking them here would put every stage of every
// playbook in front of every caller.
test('list_playbooks stays a catalog — no per-stage descriptions leak into it', async () => {
  const t = await setup();
  try {
    await t.writeUserPlaybook('described', {
      id: 'described', name: 'Described', description: 'top-level catalog line',
      entryStages: ['a'],
      stages: { a: { description: 'a per-stage line', tools: { spawn_instance: 'allow' } } },
      transitions: [],
    });
    const res = await t.call('list_playbooks', {});
    const entry = res.playbooks.find(p => p.id === 'described');
    assert.ok(entry, `'described' must load: ${JSON.stringify(res.errors)}`);
    assert.deepEqual(Object.keys(entry).sort(),
      ['description', 'entryStages', 'id', 'name', 'spawnableStages'],
      'the catalog shape is fixed — a new key here is a leak, not a feature');
    assert.equal(entry.description, 'top-level catalog line');
    assert.equal(JSON.stringify(res).includes('a per-stage line'), false,
      'no per-stage description may appear anywhere in the catalog payload');
  } finally { await t.close(); }
});

// Only the SUCCESS path is text: a refusal stays a JSON `{ok:false, code}` like
// every other soft refusal on the toolbelt, because branching on `code` is the
// toolbelt-wide convention. `t.call` parses, so this test fails if the refusal
// ever follows the success path into prose.
test('describe_playbook soft-refuses an unknown id and lists the known ones', async () => {
  const t = await setup();
  try {
    const res = refused(await t.call('describe_playbook', { id: 'nope' }), 'PLAYBOOK_UNKNOWN');
    assert.deepEqual(res.known, ['freeform', 'relay', 'solo']);
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
    const rawCall = async (name, args) => {
      const res = await fetch(ctx.baseUrl + '/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
      });
      const body = await res.json();
      return body.result.content[0].text;
    };
    const call = async (name, args) => JSON.parse(await rawCall(name, args));
    assert.equal((await call('list_playbooks', {})).playbooks.length, 3);
    // describe_playbook renders text, so it is read raw rather than parsed.
    assert.match(await rawCall('describe_playbook', { id: 'solo' }), /^PLAYBOOK solo$/m);
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

    assert.equal((await t.call('list_playbooks', {})).playbooks.length, 3);
    assert.match(await t.callText('describe_playbook', { id: 'solo' }), /^PLAYBOOK solo$/m);
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
// solo run and, at every step, PERFORMS what nextMoves advertises and compares
// the outcome. Predictions are re-derived after each performed move, because each
// move changes what is legal next — comparing a stale prediction would degrade
// this into "the first move matched".
test('every move playbook_state advertises behaves exactly as advertised when performed', async () => {
  const t = await setup({ enforcement: 'enforce' });
  try {
    const impl = await t.spawnWorker({ project: 'demo', playbook: 'solo', stage: 'plan' });
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
    // NEEDS_UNSATISFIED. `provenance` is a caller-supplied argument, not an ambient
    // fact, so the dry run describes the bare call: "call this with no `provenance`
    // and you get this". Inferring which worker the caller meant would be a second
    // reading of the rules, and a wrong guess would advertise a move that then
    // fails. What the prediction owes the caller is an actionable recipe, and its
    // `reason` is one.
    const rev = await t.spawnWorker({
      project: 'demo', playbook: 'solo', stage: 'review', worktree: wtName,
      provenance: { implement: impl.sessionId },
    });
    moves = await movesNow();
    assert.equal(moves[0].ok, false, 'the bare call is still blocked — provenance is an argument, not a fact');
    assert.match(moves[0].reason, /pass provenance: \{ "review": "<sessionId>" \}/,
      'and the reason names exactly what to pass');

    // Following that recipe succeeds.
    const ok = await t.call('send_prompt', {
      sessionId: impl.sessionId, text: 'refine', stage: 'refine', subscribe: false,
      provenance: { review: rev.sessionId },
    });
    assert.equal(ok.ok, undefined, 'supplying what the reason asked for makes the move legal');

    // Step 4 — `refine`'s only outgoing edge is its own self-loop, which is
    // always legal (a self-edge is never gated) and is what makes each further
    // round a ledgered event rather than an invisible re-prompt.
    assert.deepEqual(await movesNow(), [{ to: 'refine', via: 'send_prompt', ok: true }]);
  } finally { await t.close(); }
});

test('playbook_state derives the run graph and its history, keeping concurrent runs separate', async () => {
  const t = await setup({ enforcement: 'enforce' });
  try {
    const a = await t.spawnWorker({ project: 'demo', playbook: 'solo', stage: 'plan' });
    await t.call('approve_plan', { sessionId: a.sessionId, subscribe: false });
    const aRev = await t.spawnWorker({
      project: 'demo', playbook: 'solo', stage: 'review',
      worktree: a.worktree.worktreeName, provenance: { implement: a.sessionId },
    });
    // A second, independent run of the same playbook.
    const b = await t.spawnWorker({ project: 'demo', playbook: 'solo', stage: 'plan' });

    const stateA = await t.call('playbook_state', { sessionId: a.sessionId });
    assert.deepEqual(stateA.worker.stageHistory, ['plan', 'implement']);
    assert.equal(stateA.worker.playbook, 'solo');
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

test('playbook_state\'s `live` flips to false once the worker is actually killed', async () => {
  // The other direction of the assertion above: `live` is read from the
  // instance manager, not a ledger fold, so it must track a REAL kill —
  // not merely start true and never move.
  const t = await setup({ enforcement: 'enforce' });
  try {
    const w = await t.spawnWorker({ project: 'demo', playbook: 'solo', stage: 'plan' });
    assert.equal((await t.call('playbook_state', { sessionId: w.sessionId })).worker.live, true);
    await t.call('kill_instance', { sessionId: w.sessionId });
    await waitFor(async () => (await t.call('playbook_state', { sessionId: w.sessionId })).worker.live === false);
  } finally { await t.close(); }
});

test('playbook_state reports no enforcement block for a non-conductor caller', async () => {
  const t = await setup({ enforcement: 'enforce' });
  try {
    const w = await t.spawnWorker({ project: 'demo', playbook: 'solo', stage: 'plan' });
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

// ── list_sessions join ────────────────────────────────────────────────────

test('list_sessions carries playbook/stage for a tracked worker and null for an untracked one', async () => {
  const t = await setup({ enforcement: 'enforce' });
  try {
    const tracked = await t.spawnWorker({ project: 'demo', playbook: 'solo', stage: 'plan' });
    // Spawned by a NON-conductor caller, so the gate never tracks it.
    const workerHandle = instForSession(t.instances, tracked.sessionId).id;
    const untracked = await t.callAs(workerHandle, 'spawn_instance', { project: 'demo', mode: 'plan' });
    await waitFor(() => instForSession(t.instances, untracked.sessionId)?.sessionId);

    // list_sessions renders plain text, so read the playbook line off each
    // worker's block (src/mcp/readRenderers.ts renderSessions).
    const rendered = await t.callText('list_sessions', {});
    const playbookLineFor = (sid) => {
      const lines = rendered.split('\n');
      const at = lines.findIndex(l => l.includes(sid));
      assert.ok(at >= 0, `worker ${sid} missing from:\n${rendered}`);
      const line = lines.slice(at + 1).find(l => l.trim().startsWith('playbook '));
      assert.ok(line, `no playbook line for ${sid}`);
      return line.trim();
    };
    assert.equal(playbookLineFor(tracked.sessionId), 'playbook solo / plan');
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
