// send_prompt({forward:{sessionId}}) — inject another worker's recent output
// into a prompt server-side, verbatim, without the text ever passing through
// the conductor's own context. See docs/protocol.md → "send_prompt({forward})"
// for the mechanism; this file pins the worker-visible contract (§1 of the
// design) and the refusal table (§3).
//
// Sources are populated directly via inst._emitUi(...) rather than driving a
// real turn through the fake CLI — cheap, deterministic, and it lets a test
// build the exact ring shape (a bonded plan+prose turn, a huge prose message,
// a tool-only turn) without a bespoke scenario fixture per case.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  bootServer, api, waitFor, instForSession, freshProjectsRoot, rmrf, stripMessageBoundaryHeader,
  seedSessionJsonl, driveTurn,
} from './helpers.mjs';
import { localPlace } from '../src/projects.ts';
import { parseForwardFrame, splitForwardedMessages } from '../public/forwardFrame.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');
const SCENARIO_SLOW = path.join(__dirname, 'fixtures', 'scenario-slow-turn.json');
const SCENARIO_PLAN_FILE = path.join(__dirname, 'fixtures', 'scenario-exit-plan-file.json');

const FRAME_HEADER = '--- FORWARDED WORKER OUTPUT (verbatim · context only) ---';
// The header's own last sentence — used only to pin the header→payload JOIN
// seam (after the header's fixed text ends), which is distinct from the
// header's internal title-line break above and must not be confused with it.
const FRAME_HEADER_TAIL = 'Your own instruction follows the END marker below.';
const FRAME_FOOTER = '--- END FORWARDED WORKER OUTPUT ---';

let ctx, baseUrl, instances, home, roots;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO_WS }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { roots = await freshProjectsRoot(); ({ home } = roots); });
afterEach(async () => {
  await instances.shutdown();
  instances._idleSubscribers?.clear();
  instances._idleHub?._owners.clear();
  await rmrf(home);
  delete process.env.FAKE_PLAN_FILE;
});

let nextRpcId = 1;
async function rpc(method, params, { caller } = {}) {
  const id = nextRpcId++;
  const handle = caller ? (instForSession(instances, caller)?.id ?? caller) : null;
  const url = baseUrl + '/mcp' + (handle ? `?caller=${encodeURIComponent(handle)}` : '');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (res.status === 202) return { status: 202, body: null };
  return { status: res.status, body: await res.json() };
}
async function callTool(name, args, opts) {
  const { body } = await rpc('tools/call', { name, arguments: args }, opts);
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}
function unwrap(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  return JSON.parse(result.content[0].text);
}
function metaBodies(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  return { meta: JSON.parse(result.content[0].text), bodies: result.content.slice(1).map(c => c.text) };
}

async function spawnReady(project) {
  const spawn = unwrap(await callTool('spawn_instance', { project, mode: 'bypassPermissions' }));
  await waitFor(() => instForSession(instances, spawn.sessionId)?.status === 'idle');
  return spawn.sessionId;
}

async function spawnReadyWithScenario(project, scenarioPath, extraArgs) {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = scenarioPath;
  try {
    const spawn = unwrap(await callTool('spawn_instance', { project, mode: 'bypassPermissions', ...extraArgs }));
    await waitFor(() => instForSession(instances, spawn.sessionId)?.status === 'idle');
    return spawn.sessionId;
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
}

// Wraps inst.prompt so a test can assert on the EXACT string sendPrompt
// composed — the unit under test — without a real LLM reading it.
function recordPrompt(inst) {
  const calls = [];
  const orig = inst.prompt.bind(inst);
  inst.prompt = async (...a) => { calls.push(a); return orig(...a); };
  return calls;
}

async function seedPlanFile(content) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fwdplan-'));
  const planDir = path.join(tmpDir, '.claude', 'plans');
  await fs.mkdir(planDir, { recursive: true });
  const planFile = path.join(planDir, 'the-plan.md');
  await fs.writeFile(planFile, content);
  process.env.FAKE_PLAN_FILE = planFile;
  return { planFile, cleanup: () => fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}) };
}

// A negative wait: give an async effect real chances to land, then require it
// hasn't. Mirrors playbook-enforce.test.mjs's expectNoMoreEnforcement.
async function assertNever(predicate, message) {
  await assert.rejects(
    () => waitFor(predicate, { timeout: 800, interval: 20 }),
    /timeout/,
    message,
  );
}

test('forward: data-dependent, byte-identical to get_recent_messages, correctly ordered, no telemetry', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const sourceSid = await spawnReady('p');
  const targetSid = await spawnReady('p');
  const targetInst = instForSession(instances, targetSid);
  const calls = recordPrompt(targetInst);

  const NONCE = 'FORWARD_NONCE_7f3a9c21';
  instForSession(instances, sourceSid)._emitUi({ kind: 'text_delta', msgId: 'm-nonce', blockIdx: 0, text: `Findings: ${NONCE}` });

  const GUIDING = 'Implement the findings above.';
  const res = unwrap(await callTool('send_prompt', {
    sessionId: targetSid, forward: { sessionId: sourceSid }, text: GUIDING,
  }));
  assert.equal(res.forwarded, 1);
  assert.equal(calls.length, 1, 'inst.prompt was called exactly once');
  const composed = calls[0][0];

  // 1. Data-dependence: the nonce is real data, not baked into a constant frame.
  assert.ok(composed.includes(NONCE), 'the composed prompt carries the source\'s actual text');
  const target2Sid = await spawnReady('p'); // fresh instance — no coupling to the call above
  const plainCalls = recordPrompt(instForSession(instances, target2Sid));
  await callTool('send_prompt', { sessionId: target2Sid, text: GUIDING });
  assert.ok(!plainCalls[0][0].includes(NONCE), 'an ordinary send (no forward) never carries the source\'s text');

  // 2. Byte-identity with get_recent_messages' own rendering of the same selection.
  const grm = metaBodies(await callTool('get_recent_messages', { sessionId: sourceSid }));
  for (const body of grm.bodies) {
    assert.ok(composed.includes(stripMessageBoundaryHeader(body)),
      'every body get_recent_messages would render appears verbatim inside the forward frame');
  }

  // 3. Ordering + single occurrence: header < payload < footer < guiding text, once.
  const iHeader = composed.indexOf(FRAME_HEADER);
  const iNonce = composed.indexOf(NONCE);
  const iFooter = composed.indexOf(FRAME_FOOTER);
  const iGuiding = composed.indexOf(GUIDING);
  assert.ok(iHeader >= 0 && iHeader < iNonce && iNonce < iFooter && iFooter < iGuiding,
    `expected header < payload < footer < guiding text, got ${JSON.stringify({ iHeader, iNonce, iFooter, iGuiding })}`);
  assert.equal(composed.split(GUIDING).length, 2, 'the guiding message appears exactly once');

  // 4. Negative telemetry: no orchestrator bookkeeping reaches the worker.
  assert.ok(!composed.includes(sourceSid), 'the source sessionId (a live handle) never appears');
  assert.ok(!composed.includes(sourceSid.slice(0, 8)), 'nor its 8-char prefix');
  for (const m of grm.meta.messages) assert.ok(!composed.includes(m.msgId), `msgId ${m.msgId} must not leak`);
  for (const marker of ['chars ---', '"source"', '"retained"', 'omittedToolOnly', 'textTruncated']) {
    assert.ok(!composed.includes(marker), `telemetry marker "${marker}" must not leak into the forward frame`);
  }

  // 5. Seam integrity: the frame's job is delimitation — marking where quoted
  // material ends and the worker's own instruction begins — so the boundary
  // seams must be blank-line (exact double-newline), not merely present, or
  // the footer runs flush against the guiding text and stops reading as a
  // delimiter. A single-newline join must fail these.
  assert.ok(composed.includes(`${FRAME_HEADER_TAIL}\n\n`), 'header→payload seam is a blank line, not a bare newline');
  assert.ok(composed.endsWith(`${FRAME_FOOTER}\n\n${GUIDING}`), 'footer→guiding-text seam is a blank line, not a bare newline');
});

test('forward: multi-message payload uses bare boundaries, not get_recent_messages\' telemetry-carrying ones', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const sourceSid = await spawnReady('p');
  const targetSid = await spawnReady('p');
  const targetInst = instForSession(instances, targetSid);
  const calls = recordPrompt(targetInst);

  const src = instForSession(instances, sourceSid);
  // A plan (inline, no path) bonded with its turn's trailing prose — the
  // default-selection bonding get_recent_messages itself performs — so the
  // default forward selection returns TWO messages.
  src._emitUi({ kind: 'tool_use', msgId: 'm-plan', blockIdx: 0, toolUseId: 'tu-plan', name: 'ExitPlanMode', input: { plan: 'Step 1\nStep 2' } });
  src._emitUi({ kind: 'text_delta', msgId: 'm-prose', blockIdx: 0, text: 'Standing by.' });
  src._emitUi({ kind: 'turn_end' });

  const res = unwrap(await callTool('send_prompt', {
    sessionId: targetSid, forward: { sessionId: sourceSid }, text: 'go',
  }));
  assert.equal(res.forwarded, 2);
  const composed = calls[0][0];
  assert.ok(composed.includes('--- message 1/2 ---\n'), 'bare boundary — no msgId, no char count');
  assert.ok(composed.includes('--- message 2/2 ---\n'), 'bare boundary — no msgId, no char count');
  assert.doesNotMatch(composed, /--- message \d+\/\d+ · .* chars ---/,
    'must never use get_recent_messages\' telemetry-carrying boundary variant');
  assert.ok(composed.includes('--- plan ---\nStep 1\nStep 2'), 'the inline plan body rides along in full');
  // Inter-message seam: a blank line between message 1's body and message 2's
  // boundary, not a bare newline — the second mutation site (buildForwardFrame's
  // payload join in public/forwardFrame.js), distinct from the header/payload/footer assembly
  // join pinned in the test above.
  assert.ok(composed.includes('Step 2\n\n--- message 2/2 ---'),
    'the inter-message seam is a blank line, not a bare newline');
});

test('forward: the composed prompt round-trips through parseForwardFrame/splitForwardedMessages', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const sourceSid = await spawnReady('p');
  const targetSid = await spawnReady('p');
  const targetInst = instForSession(instances, targetSid);
  const calls = recordPrompt(targetInst);

  const src = instForSession(instances, sourceSid);
  src._emitUi({ kind: 'tool_use', msgId: 'm-plan', blockIdx: 0, toolUseId: 'tu-plan', name: 'ExitPlanMode', input: { plan: 'Step 1\nStep 2' } });
  src._emitUi({ kind: 'text_delta', msgId: 'm-prose', blockIdx: 0, text: 'Standing by.' });
  src._emitUi({ kind: 'turn_end' });

  const res = unwrap(await callTool('send_prompt', {
    sessionId: targetSid, forward: { sessionId: sourceSid }, text: 'go',
  }));
  // The conversation view's parser reads back exactly what the real
  // send_prompt builder wrote, so the two cannot drift apart.
  const parsed = parseForwardFrame(calls[0][0]);
  assert.ok(parsed, 'the real composed prompt is recognised as a forward frame');
  assert.equal(parsed.instruction, 'go');
  const bodies = splitForwardedMessages(parsed.payload);
  assert.deepEqual(bodies, ['--- plan ---\nStep 1\nStep 2', 'Standing by.']);
  assert.equal(bodies.length, res.forwarded);
});

test('forward: a plan backed by a file carries the saved path and the full body inline', async () => {
  const { planFile, cleanup } = await seedPlanFile('# Plan\n- Make X\n');
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const sourceSid = await spawnReadyWithScenario('p', SCENARIO_PLAN_FILE);
    await driveTurn(instances, sourceSid, () => callTool('send_prompt', { sessionId: sourceSid, text: 'plan this' }));
    const targetSid = await spawnReady('p');
    const calls = recordPrompt(instForSession(instances, targetSid));

    const res = unwrap(await callTool('send_prompt', {
      sessionId: targetSid, forward: { sessionId: sourceSid }, text: 'implement it',
    }));
    assert.equal(res.forwarded, 2, 'the plan message bonds with its trailing prose, same as get_recent_messages');
    const composed = calls[0][0];
    assert.ok(composed.includes(`--- plan · saved to ${planFile} ---\n# Plan\n- Make X\n`),
      'the path line and the full file contents both ride along');
  } finally { await cleanup(); }
});

test('forward: a questions section survives intact', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const sourceSid = await spawnReady('p');
  const targetSid = await spawnReady('p');
  const calls = recordPrompt(instForSession(instances, targetSid));

  instForSession(instances, sourceSid)._emitUi({
    kind: 'tool_use', msgId: 'm-q', blockIdx: 0, toolUseId: 'tu-q', name: 'AskUserQuestion',
    input: { questions: [{ question: 'Pick one', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }] },
  });

  const res = unwrap(await callTool('send_prompt', {
    sessionId: targetSid, forward: { sessionId: sourceSid }, text: 'answer for me',
  }));
  assert.equal(res.forwarded, 1);
  const composed = calls[0][0];
  assert.ok(composed.includes('--- questions ---'));
  assert.ok(composed.includes('1. Pick one (multiSelect: false)'));
  assert.ok(composed.includes('   - A') && composed.includes('   - B'));
});

test('forward: an empty source soft-refuses NOTHING_TO_FORWARD before any prompt is sent', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const sourceSid = await spawnReady('p'); // fresh — no output at all
  const targetSid = await spawnReady('p');
  const targetInst = instForSession(instances, targetSid);
  const calls = recordPrompt(targetInst);

  const res = unwrap(await callTool('send_prompt', {
    sessionId: targetSid, forward: { sessionId: sourceSid }, text: 'go',
  }, { caller: callerId }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NOTHING_TO_FORWARD');
  assert.equal(res.forwardSessionId, sourceSid);
  assert.equal(res.sessionId, undefined, 'a forward refusal never carries a bare sessionId field');
  assert.equal(calls.length, 0, 'no turn was started');
  // The refusal must not have armed a wake either: even if the target later
  // reaches turn_end, the caller gets no wake stub from THIS call.
  targetInst._emitUi({ kind: 'turn_end' });
  const callerInst = instForSession(instances, callerId);
  await assertNever(
    () => callerInst.ringSnapshot().some(ev => ev.kind === 'user_echo' && typeof ev.text === 'string' && ev.text.includes('get_recent_messages')),
    'a refused forward starts no turn, so it can arm no wake',
  );
});

test('forward: a tool-only source soft-refuses NOTHING_TO_FORWARD naming the tool-only count', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const sourceSid = await spawnReady('p');
  const targetSid = await spawnReady('p');
  instForSession(instances, sourceSid)._emitUi({
    kind: 'tool_use', msgId: 'm-bash', blockIdx: 0, toolUseId: 'tu-bash', name: 'Bash', input: { command: 'ls' },
  });

  const res = unwrap(await callTool('send_prompt', {
    sessionId: targetSid, forward: { sessionId: sourceSid }, text: 'go',
  }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NOTHING_TO_FORWARD');
  assert.match(res.reason, /tool call/);
  assert.match(res.reason, /\b1\b/, 'names the omitted tool-only count');
});

test('forward: two-session distinguishability — an unknown source names forwardSessionId, an unknown target names sessionId', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const liveSid = await spawnReady('p');
  const bogus = '00000000-dead-dead-dead-000000000000';

  const badSource = unwrap(await callTool('send_prompt', {
    sessionId: liveSid, forward: { sessionId: bogus }, text: 'go',
  }));
  assert.equal(badSource.ok, false);
  assert.equal(badSource.code, 'FORWARD_SESSION_UNKNOWN');
  assert.equal(badSource.forwardSessionId, bogus);
  assert.equal(badSource.sessionId, undefined);

  const badTarget = unwrap(await callTool('send_prompt', {
    sessionId: bogus, forward: { sessionId: liveSid }, text: 'go',
  }));
  assert.equal(badTarget.ok, false);
  assert.equal(badTarget.code, 'SESSION_UNKNOWN');
  assert.equal(badTarget.sessionId, bogus);

  assert.notEqual(badSource.code, badTarget.code, 'the two failure sides are distinguishable by code alone');
});

test('forward: a killed-but-known source with nothing on disk soft-refuses NOTHING_TO_FORWARD', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const spawn = unwrap(await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions' }));
  const sourceSid = spawn.sessionId;
  await waitFor(() => instForSession(instances, sourceSid)?.status === 'idle');
  await instForSession(instances, sourceSid).promoteToNormal();
  const targetSid = await spawnReady('p');

  // Kill the subprocess directly (NOT instances.remove) so the non-temp
  // instance stays known but loses its proc (see tests/mcp.test.mjs). The fake
  // engine wrote no jsonl, so there is nothing to serve the forward from —
  // liveness is no longer what decides, READABILITY is.
  await instForSession(instances, sourceSid).kill({ graceMs: 200 });
  await waitFor(() => !instForSession(instances, sourceSid)?.proc);

  const res = unwrap(await callTool('send_prompt', {
    sessionId: targetSid, forward: { sessionId: sourceSid }, text: 'go',
  }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NOTHING_TO_FORWARD');
  assert.equal(res.forwardSessionId, sourceSid);
});

// FORWARD_SESSION_NOT_LIVE narrowed rather than disappeared: a non-live source
// is now forwarded from its transcript, so the code survives only for a source
// whose transcript cannot be REACHED — one under an encoded-cwd directory no
// registered project or worktree owns (encodeCwd is one-way, so the path cannot
// be turned back into a cwd).
test('forward: an unreachable (orphaned-transcript) source still soft-refuses FORWARD_SESSION_NOT_LIVE', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const targetSid = await spawnReady('p');
  const orphanSid = '22222222-3333-4444-5555-666666666666';
  await seedSessionJsonl(localPlace(path.join(home, 'never-registered')), orphanSid);

  const res = unwrap(await callTool('send_prompt', {
    sessionId: targetSid, forward: { sessionId: orphanSid }, text: 'go',
  }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'FORWARD_SESSION_NOT_LIVE');
  assert.equal(res.forwardSessionId, orphanSid);
  assert.match(res.reason, /no registered project or worktree owns/, 'the refusal names why it is unreadable');
  // The remedy is RE-REGISTERING the worktree, not resurrection: spawn_instance
  // ({resume}) cannot locate a session under an unregistered directory either.
  assert.match(res.reason, /[Rr]e-register that worktree/);
  assert.doesNotMatch(res.reason, /spawn_instance/);
});

test('forward: a malformed forward:{} soft-refuses FORWARD_SESSION_UNKNOWN (validateArgs does no nested validation)', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const targetSid = await spawnReady('p');
  const res = unwrap(await callTool('send_prompt', { sessionId: targetSid, forward: {}, text: 'go' }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'FORWARD_SESSION_UNKNOWN');
  assert.match(res.reason, /forward requires/);
});

test('forward: an unambiguous sessionId prefix resolves before the handler runs', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const sourceSid = await spawnReady('p');
  const targetSid = await spawnReady('p');
  instForSession(instances, sourceSid)._emitUi({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'hello there' });

  const res = unwrap(await callTool('send_prompt', {
    sessionId: targetSid, forward: { sessionId: sourceSid.slice(0, 8) }, text: 'go',
  }));
  assert.equal(res.forwarded, 1, 'the prefix resolved to the live source and forwarded its output');
});

test('forward: an ambiguous sessionId prefix soft-refuses SESSION_AMBIGUOUS naming forward.sessionId', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const sourceSid = await spawnReady('p');
  const targetSid = await spawnReady('p');
  const prefix = sourceSid.slice(0, 5);
  const fakeSid = prefix + 'ffffffff-ffff-ffff-ffff-ffffffffffff'.slice(prefix.length);
  instances.byId.set('fake-ambig-fwd', { id: 'fake-ambig-fwd', sessionId: fakeSid, kill: async () => {} });
  try {
    const res = unwrap(await callTool('send_prompt', {
      sessionId: targetSid, forward: { sessionId: prefix }, text: 'go',
    }));
    assert.equal(res.ok, false);
    assert.equal(res.code, 'SESSION_AMBIGUOUS');
    assert.match(res.reason, /forward\.sessionId/, 'names the nested argument, not a bare "sessionId"');
    assert.ok(Array.isArray(res.matches) && res.matches.length === 2);
  } finally {
    instances.byId.delete('fake-ambig-fwd');
  }
});

test('forward: a truncated message with no planPath is honest that the cut prose is not recoverable', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const sourceSid = await spawnReady('p');
  const targetSid = await spawnReady('p');
  const calls = recordPrompt(instForSession(instances, targetSid));
  const HUGE = 'a'.repeat(32 * 1024 + 1000);
  instForSession(instances, sourceSid)._emitUi({ kind: 'text_delta', msgId: 'm-huge', blockIdx: 0, text: HUGE });

  await callTool('send_prompt', { sessionId: targetSid, forward: { sessionId: sourceSid }, text: 'go' });
  const composed = calls[0][0];
  assert.ok(composed.includes('exceeded the forward size cap'));
  assert.ok(composed.includes('not recoverable from your side — ask the orchestrator rather than inferring it'));
  assert.ok(!composed.includes('The plan'), 'no planPath — must not claim a recovery route that does not exist');
});

test('forward: a truncated message WITH a planPath points at the complete plan document', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const sourceSid = await spawnReady('p');
  const targetSid = await spawnReady('p');
  const calls = recordPrompt(instForSession(instances, targetSid));
  const HUGE = 'b'.repeat(32 * 1024 + 1000);
  const FAKE_PATH = '/fake/plans/the-plan.md';
  const src = instForSession(instances, sourceSid);
  src._emitUi({ kind: 'plan_request', toolUseId: 'tu-huge', planPath: FAKE_PATH });
  src._emitUi({ kind: 'text_delta', msgId: 'm-huge2', blockIdx: 0, text: HUGE });
  src._emitUi({ kind: 'tool_use', msgId: 'm-huge2', blockIdx: 1, toolUseId: 'tu-huge', name: 'ExitPlanMode', input: {} });

  await callTool('send_prompt', { sessionId: targetSid, forward: { sessionId: sourceSid }, text: 'go' });
  const composed = calls[0][0];
  assert.ok(composed.includes(`document at ${FAKE_PATH} is complete`), 'names the recovery route');
  assert.ok(composed.includes('The cut prose itself is not recoverable from your'), 'still honest that the PROSE is gone');
  assert.ok(composed.includes(`--- plan · saved to ${FAKE_PATH} ---`), 'the planPath header itself still renders');
});

test('forward: mid-turn is delivered live (steering), not queued', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const sourceSid = await spawnReady('p');
  const targetSid = await spawnReadyWithScenario('p', SCENARIO_SLOW);
  const targetInst = instForSession(instances, targetSid);
  instForSession(instances, sourceSid)._emitUi({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'steer payload' });

  // Put the target mid-turn. SCENARIO_SLOW's delay_ms is 300, and the engine
  // sleeps it after EVERY event (emitMany in tests/fake-claude-engine.mjs), so its
  // 6 events occupy the turn for ~1.8s — ample for the one in-process round-trip
  // between here and the delivery capture below. The scenario was baked into the
  // subprocess's env at spawn time above, so it applies to every turn this
  // instance runs from here on.
  await callTool('send_prompt', { sessionId: targetSid, text: 'start' });
  await waitFor(() => targetInst.status !== 'idle');

  const calls = recordPrompt(targetInst);
  const res = unwrap(await callTool('send_prompt', {
    sessionId: targetSid, forward: { sessionId: sourceSid }, text: 'steer now',
  }));
  // Delivered immediately — not deferred until the running turn ends.
  assert.equal(calls.length, 1, 'the forward was delivered live into the running turn');
  assert.equal(res.forwarded, 1);
});


test('forward: a successful forward still arms the caller\'s wake', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const sourceSid = await spawnReady('p');
  const targetSid = await spawnReady('p');
  instForSession(instances, sourceSid)._emitUi({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'payload' });

  await callTool('send_prompt', {
    sessionId: targetSid, forward: { sessionId: sourceSid }, text: 'go',
  }, { caller: callerId });
  // No result field says so any more — the wake is not a thing you opt into, so
  // the observables are the ownership edge the send recorded and the stub it
  // eventually delivers.
  const target = instForSession(instances, targetSid);
  assert.deepEqual(instances._idleHub.ownersOf(target.id),
    [instForSession(instances, callerId).id], 'the forward recorded the caller as owner');
  const caller = instForSession(instances, callerId);
  await waitFor(() => caller.ringSnapshot().some(ev => ev.kind === 'user_echo'
    && typeof ev.text === 'string' && ev.text.includes('get_recent_messages')));
});

test('forward: a successful result keeps today\'s shape plus forwarded — nothing else', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const sourceSid = await spawnReady('p');
  const targetSid = await spawnReady('p');
  instForSession(instances, sourceSid)._emitUi({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'payload' });

  const res = unwrap(await callTool('send_prompt', {
    sessionId: targetSid, forward: { sessionId: sourceSid }, text: 'go',
  }));
  assert.deepEqual(Object.keys(res).sort(), ['forwarded', 'sessionId', 'status'].sort(),
    'no truncation flag, payload size, or source id — the conductor has no lever for any of them');
});

// A RETIRED source is forwarded from its backing store. Liveness stopped being
// the gatekeeper here (2026-0142): what governs a forward source is the
// playbook gate, which resolves it from the liveness-agnostic ledger projection
// (checkForwardSource, src/playbooks.ts) — see tests/playbook-enforce.test.mjs
// for the retired-and-denied case.
//
// The assertion is on the composed prompt's BODY, not on `forwarded` alone: a
// wrong cwd/backingSessionId pairing reads no transcript and would look like an
// ordinary empty source, so only the seeded text proves the right session was
// read.
test('forward: a fully retired source is relayed from disk, verbatim, with its own content', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const spawn = unwrap(await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions' }));
  const sourceSid = spawn.sessionId;
  await waitFor(() => instForSession(instances, sourceSid)?.status === 'idle');
  const targetSid = await spawnReady('p');
  const calls = recordPrompt(instForSession(instances, targetSid));

  // The transcript the CLI would have written (the fake engine writes none),
  // named by the BACKING id — the id that actually names a file on disk.
  await seedSessionJsonl(localPlace(path.join(roots.projectsRoot, 'p')), instForSession(instances, sourceSid).backingSessionId, [
      { type: 'user', message: { role: 'user', content: 'review it' } },
      { type: 'assistant', message: { id: 'm_rv', role: 'assistant', content: [{ type: 'text', text: 'retired reviewer findings' }] } },
    ]);

  // A TEMP worker is DROPPED from byId on exit, so this is the fully-retired
  // case: no instance record anywhere, only the transcript.
  await instForSession(instances, sourceSid).kill({ graceMs: 200 });
  await waitFor(() => instances.idsForSession(sourceSid).length === 0);

  const res = unwrap(await callTool('send_prompt', {
    sessionId: targetSid, forward: { sessionId: sourceSid }, text: 'act on it',
  }));
  assert.equal(res.ok, undefined, `the forward must succeed: ${JSON.stringify(res)}`);
  assert.equal(res.forwarded, 1);
  const composed = calls[0][0];
  assert.ok(composed.includes('retired reviewer findings'),
    'the retired source\'s own output was relayed into the prompt');
  assert.ok(composed.includes(FRAME_HEADER) && composed.includes(FRAME_FOOTER));
  assert.ok(composed.includes('act on it'), 'the caller\'s own instruction still follows the frame');
});

// A retired session is outside the in-memory prefix universe (the transport's
// chokepoint resolves prefixes against byId), so it needs its FULL sessionId —
// which for a minted public id is short already. A genuine prefix does not
// silently fall through to some other session: it passes the chokepoint
// unrewritten and refuses distinctly.
test('forward: a PREFIX of a retired source refuses FORWARD_SESSION_UNKNOWN rather than silently missing', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const spawn = unwrap(await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions' }));
  const sourceSid = spawn.sessionId;
  await waitFor(() => instForSession(instances, sourceSid)?.status === 'idle');
  const targetSid = await spawnReady('p');
  await seedSessionJsonl(localPlace(path.join(roots.projectsRoot, 'p')), instForSession(instances, sourceSid).backingSessionId, [
      { type: 'user', message: { role: 'user', content: 'review it' } },
      { type: 'assistant', message: { id: 'm_rv', role: 'assistant', content: [{ type: 'text', text: 'retired reviewer findings' }] } },
    ]);
  await instForSession(instances, sourceSid).kill({ graceMs: 200 });
  await waitFor(() => instances.idsForSession(sourceSid).length === 0);

  const byPrefix = unwrap(await callTool('send_prompt', {
    sessionId: targetSid, forward: { sessionId: sourceSid.slice(0, -2) }, text: 'go',
  }));
  assert.equal(byPrefix.ok, false);
  assert.equal(byPrefix.code, 'FORWARD_SESSION_UNKNOWN', 'a prefix no longer addresses a retired session');

  // ...and the same call with the FULL id succeeds, so the refusal above is
  // about the prefix, not about the session being retired.
  const full = unwrap(await callTool('send_prompt', {
    sessionId: targetSid, forward: { sessionId: sourceSid }, text: 'go',
  }));
  assert.equal(full.forwarded, 1);
});
