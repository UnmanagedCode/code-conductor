import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { encodeCwd } from '../src/projects.js';
import { isArchived } from '../src/archivedSessions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');
const SCENARIO_RESUME = path.join(__dirname, 'fixtures', 'scenario-resume.json');
const SCENARIO_BACKGROUND_TASK = path.join(__dirname, 'fixtures', 'scenario-background-task.json');

let ctx, baseUrl, instances, home;
// Handlers registered by collectEvents/direct instances.on() are gathered here
// and removed in afterEach so stale listeners don't accumulate on the shared emitter.
const cleanupListeners = [];

before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
});
afterEach(async () => {
  await instances.shutdown();
  for (const fn of cleanupListeners.splice(0)) fn();
  await rmrf(home);
});

function collectEvents(instances) {
  const events = [];
  const handler = ({ id, ev }) => events.push({ id, ev });
  instances.on('event', handler);
  cleanupListeners.push(() => instances.off('event', handler));
  return events;
}

async function setupWithProject(name = 'demo') {
  const created = await api(baseUrl, 'POST', '/api/projects', { name });
  assert.equal(created.status, 201);
}

test('instance reaches idle immediately after spawn (before any output from claude)', async () => {
  // Regression: real claude is silent on stdout until the first user message
  // is sent — `init` does NOT arrive at startup. The orchestrator must flip
  // to `idle` as soon as the subprocess is alive, otherwise prompts can never
  // be sent and the instance stays stuck in `spawning` forever.
  await setupWithProject();
  const events = collectEvents(instances);
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo',
    mode: 'bypassPermissions',
  });
  assert.equal(r.status, 201);
  const id = r.body.id;

  await waitFor(() => instances.get(id).status === 'idle');

  // Pre-generated sessionId is present even though init hasn't arrived.
  const inst = instances.get(id);
  assert.ok(inst.sessionId, 'sessionId set via --session-id at spawn time');
  assert.equal(inst.mode, 'bypassPermissions');

  // No init event yet — it should be silent.
  const initEvents = events.filter(e => e.id === id && e.ev.kind === 'system' && e.ev.subtype === 'init');
  assert.equal(initEvents.length, 0, 'init has not arrived yet (claude is silent until first prompt)');

  const list = await api(baseUrl, 'GET', '/api/instances');
  assert.equal(list.body[0].status, 'idle');
});

test('init event arrives bundled with first turn response', async () => {
  await setupWithProject();
  const events = collectEvents(instances);
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
  const id = r.body.id;
  await waitFor(() => instances.get(id).status === 'idle');

  instances.get(id).prompt('hello');
  await waitFor(() => events.some(e => e.id === id && e.ev.kind === 'system' && e.ev.subtype === 'init'));

  const seq = events.filter(e => e.id === id).map(e => e.ev.kind);
  const initIdx = seq.findIndex(k => k === 'system');
  const userIdx = seq.findIndex(k => k === 'user_echo');
  assert.ok(userIdx < initIdx, 'user_echo emitted by orchestrator before init arrives from claude');
});

test('prompt round-trip emits ordered ui events and returns to idle', async () => {
  await setupWithProject();
  const events = collectEvents(instances);
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
  const id = r.body.id;
  await waitFor(() => instances.get(id).status === 'idle' && instances.get(id).sessionId);

  instances.get(id).prompt('hello there');
  assert.equal(instances.get(id).status, 'turn');

  await waitFor(() => events.some(e => e.id === id && e.ev.kind === 'turn_end'));

  const mine = events.filter(e => e.id === id).map(e => e.ev);
  const kinds = mine.map(e => e.kind);

  const firstTextDelta = kinds.indexOf('text_delta');
  const firstToolUseStart = kinds.indexOf('tool_use_start');
  const firstToolUse = kinds.indexOf('tool_use');
  const firstToolResult = kinds.indexOf('tool_result');
  const turnEnd = kinds.indexOf('turn_end');

  assert.ok(firstTextDelta >= 0, 'has text_delta');
  assert.ok(firstToolUseStart >= 0, 'has tool_use_start');
  assert.ok(firstToolUse > firstToolUseStart, 'tool_use comes after tool_use_start');
  assert.ok(firstToolResult > firstToolUse, 'tool_result after tool_use');
  assert.ok(turnEnd > firstToolResult, 'turn_end last');

  const finalToolUse = mine.find(e => e.kind === 'tool_use');
  assert.deepEqual(finalToolUse.input, { command: 'ls' });

  const result = mine.find(e => e.kind === 'turn_end');
  assert.equal(result.subtype, 'success');
  assert.equal(result.isError, false);

  assert.equal(instances.get(id).status, 'idle');
});

test('setMode writes control_request and resolves on control_response', async () => {
  await setupWithProject();
  const transcriptPath = path.join(home, 'transcript.log');
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
    const id = r.body.id;
    const inst = instances.get(id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);

    await inst.setMode('plan');
    assert.equal(inst.mode, 'plan');

    const lines = (await fs.readFile(transcriptPath, 'utf8')).trim().split('\n').filter(Boolean);
    const parsed = lines.map(l => JSON.parse(l));
    const modeReq = parsed.find(p => p.type === 'control_request' && p.request?.subtype === 'set_permission_mode');
    assert.ok(modeReq, 'control_request written to fake-claude stdin');
    assert.equal(modeReq.request.mode, 'plan');
    assert.ok(modeReq.request_id, 'request_id present');
  } finally {
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
  }
});

test('setModel writes control_request and resolves on control_response', async () => {
  await setupWithProject();
  const transcriptPath = path.join(home, 'transcript.log');
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
    const id = r.body.id;
    const inst = instances.get(id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);

    await inst.setModel('claude-opus-4-8');
    assert.equal(inst.model, 'claude-opus-4-8');

    const lines = (await fs.readFile(transcriptPath, 'utf8')).trim().split('\n').filter(Boolean);
    const parsed = lines.map(l => JSON.parse(l));
    const modelReq = parsed.find(p => p.type === 'control_request' && p.request?.subtype === 'set_model');
    assert.ok(modelReq, 'control_request written to fake-claude stdin');
    assert.equal(modelReq.request.model, 'claude-opus-4-8');
    assert.ok(modelReq.request_id, 'request_id present');
  } finally {
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
  }
});

test('setModel rejects an unknown model without contacting the CLI', async () => {
  await setupWithProject();
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
  const id = r.body.id;
  const inst = instances.get(id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);

  await assert.rejects(() => inst.setModel('not-a-model'), /invalid model/);
});

test('forced interrupt (force:true) mid-turn emits turn_end and returns to idle', async () => {
  await setupWithProject();
  const events = collectEvents(instances);
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
  const id = r.body.id;
  const inst = instances.get(id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);

  inst.prompt('first turn');
  await waitFor(() => events.some(e => e.id === id && e.ev.kind === 'turn_end'));
  const beforeInterrupt = events.length;

  inst.prompt('second turn please be slow');
  assert.equal(inst.status, 'turn');
  // The "slow" scenario turn waits 80ms per event; interrupt before it finishes.
  await waitFor(() => events.slice(beforeInterrupt).some(e => e.id === id && e.ev.kind === 'text_delta'));
  await inst.interrupt({ force: true }); // hard abort — control_request

  await waitFor(() => inst.status === 'idle');
  const last = events.filter(e => e.id === id && e.ev.kind === 'turn_end').slice(-1)[0];
  assert.equal(last.ev.subtype, 'error_during_execution');
  assert.equal(last.ev.stopReason, 'interrupted');
  assert.equal(inst.interrupting, false, 'interrupting flag cleared on turn exit');
});

test('soft interrupt (default) injects a hidden steer, sets interrupting, shows a visible annotation without shifting the user-prompt index', async () => {
  await setupWithProject();
  const transcriptPath = path.join(home, 'soft-stdin.log');
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;
  const statuses = [];
  const statusHandler = (s) => statuses.push(s);
  instances.on('status', statusHandler);
  cleanupListeners.push(() => instances.off('status', statusHandler));
  try {
    const events = collectEvents(instances);
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
    const id = r.body.id;
    const inst = instances.get(id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);

    inst.prompt('first turn');
    await waitFor(() => events.some(e => e.id === id && e.ev.kind === 'turn_end'));
    const beforeSecond = events.length;

    // Second (slow) turn never completes on its own — instance stays in `turn`.
    inst.prompt('second turn please be slow');
    assert.equal(inst.status, 'turn');
    await waitFor(() => events.slice(beforeSecond).some(e => e.id === id && e.ev.kind === 'text_delta'));
    const ringBefore = inst.ring.toArray().length;
    const userEchoCountBefore = inst._userEchoCount;

    await inst.interrupt(); // SOFT (no force)
    assert.equal(inst.status, 'turn', 'soft interrupt does NOT change status');
    assert.equal(inst.interrupting, true, 'interrupting flag set');
    assert.equal(inst.summary().interrupting, true, 'summary carries interrupting');
    assert.ok(statuses.some(s => s.id === id && s.interrupting === true),
      'a status event was broadcast with interrupting:true');

    // No new user_echo bubble entered the ring for the steer — a system
    // annotation is used instead so the live userIndex counter (which
    // rewind/fork key off of) isn't shifted out of sync with the
    // JSONL-derived count (which deliberately excludes the steer).
    const newEvents = inst.ring.toArray().slice(ringBefore);
    const newEchoes = newEvents.filter(e => e.kind === 'user_echo');
    assert.equal(newEchoes.length, 0, 'soft steer emits no user_echo');
    assert.equal(inst._userEchoCount, userEchoCountBefore, 'soft steer does not shift the user-echo index');

    // A visible system/soft_interrupted annotation carries the steer text.
    const STEER_TEXT = 'Stop now. Do not make any more tool calls or start any new work. Reply with one short line acknowledging you have stopped, then end your turn.';
    const annotations = newEvents.filter(e => e.kind === 'system' && e.subtype === 'soft_interrupted');
    assert.equal(annotations.length, 1, 'exactly one soft_interrupted annotation is emitted live');
    assert.equal(annotations[0].data?.text, STEER_TEXT, 'annotation carries the steer text');

    // The hidden steer WAS written to the subprocess stdin (with marker).
    // fake-claude appends stdin to the transcript asynchronously, so poll.
    const steerLines = async () => (await fs.readFile(transcriptPath, 'utf8').catch(() => ''))
      .split('\n').filter(l => l.includes('[[cc:soft-interrupt]]'));
    await waitFor(async () => (await steerLines()).length === 1);
    const parsed = JSON.parse((await steerLines())[0]);
    assert.equal(parsed.type, 'user');

    // Idempotent: a second soft while already interrupting writes nothing more.
    // (The ring's overall length isn't a stable baseline here — the slow
    // second turn keeps streaming text_delta events in the background — so
    // check specifically for a second soft_interrupted annotation instead.)
    const ringBeforeSecond = inst.ring.toArray().length;
    await inst.interrupt();
    await new Promise(r => setTimeout(r, 60));
    assert.equal((await steerLines()).length, 1, 'second soft is a no-op (idempotent)');
    const secondAnnotations = inst.ring.toArray().slice(ringBeforeSecond)
      .filter(e => e.kind === 'system' && e.subtype === 'soft_interrupted');
    assert.equal(secondAnnotations.length, 0, 'second soft emits no additional annotation');

    // Escalate to forced — turn ends, interrupting clears.
    await inst.interrupt({ force: true });
    await waitFor(() => inst.status === 'idle');
    assert.equal(inst.interrupting, false, 'interrupting cleared after turn_end');
  } finally {
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
  }
});

test('soft interrupt is a no-op when not in a turn', async () => {
  await setupWithProject();
  const transcriptPath = path.join(home, 'soft-noop-stdin.log');
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;
  try {
    const events = collectEvents(instances);
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
    const id = r.body.id;
    const inst = instances.get(id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    inst.prompt('first turn');
    await waitFor(() => events.some(e => e.id === id && e.ev.kind === 'turn_end'));
    assert.equal(inst.status, 'idle');

    await inst.interrupt(); // idle — guard returns
    assert.equal(inst.interrupting, false);
    const stdin = await fs.readFile(transcriptPath, 'utf8');
    assert.ok(!stdin.includes('[[cc:soft-interrupt]]'), 'no steer written when idle');
  } finally {
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
  }
});

test('crash + respawn preserves sessionId, ring buffer, and uses --resume', async () => {
  // REAL OS PROCESS required: this test SIGKILLs the subprocess via
  // process.kill(pid) to simulate an external crash, so it boots a dedicated
  // realProcess server instead of the file's default in-process launcher (which
  // has pid=null and no OS process to signal). Only this test opts in — the rest
  // of the file stays in-process.
  const rp = await bootServer({ scenarioPath: SCENARIO, realProcess: true });
  const transcriptPath = path.join(rp.tmpHome, 'transcript.log');
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;
  try {
    await api(rp.baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const r = await api(rp.baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
    const id = r.body.id;
    const inst = rp.instances.get(id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    const sid = inst.sessionId;
    const originalPid = inst.pid;
    inst.prompt('initial');
    await waitFor(() => inst.status === 'idle' && inst.ring.toArray().some(e => e.kind === 'turn_end'));
    const ringBefore = inst.ring.toArray().length;

    process.kill(originalPid, 'SIGKILL');
    await waitFor(() => inst.status === 'crashed');
    assert.equal(inst.pid, null);
    assert.equal(inst.ring.toArray().length >= ringBefore, true, 'ring preserved across crash');

    // Respawn — uses scenario again (fresh fake-claude reads the same scenario file).
    const resp = await api(rp.baseUrl, 'POST', `/api/instances/${id}/respawn`);
    assert.equal(resp.status, 200);
    await waitFor(() => inst.status === 'idle' && inst.pid && inst.sessionId === sid);
    assert.notEqual(inst.pid, originalPid);

    // Inspect fake-claude transcripts to confirm the respawn used --resume.
    // The transcript only captures stdin from instance → fake-claude; argv is verified by
    // checking process.argv in fake-claude... but we don't capture argv. Instead, assert
    // that sessionId is unchanged after respawn (only --resume preserves it across the
    // restart; --session-id would have rolled a fresh one).
    assert.equal(inst.sessionId, sid, 'sessionId unchanged after respawn');
  } finally {
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    await rp.close();
  }
});

test('respawn wipes the ring so loadHistory does not pile on top of the prior run', async () => {
  // Regression: a respawn into an instance whose ring still holds the prior
  // run's events would replay the persisted transcript on top, doubling
  // every message in the UI. The wipe lives in InstanceManager.respawn() and
  // mirrors what the rewind path does.
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_RESUME;
  try {
    const sid = 'cccc1234-2222-3333-4444-555555555555';
    await api(baseUrl, 'POST', '/api/projects', { name: 'respawnproj' });
    const projectPath = path.join(ctx.projectsRoot, 'respawnproj');
    const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(projectPath));
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, `${sid}.jsonl`),
      [
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first prompt' } },
        { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [
          { type: 'text', text: 'first reply' },
        ] } },
        { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second prompt' } },
        { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [
          { type: 'text', text: 'second reply' },
        ] } },
      ].map(l => JSON.stringify(l)).join('\n') + '\n',
    );

    const r = await api(baseUrl, 'POST', '/api/instances', {
      project: 'respawnproj', mode: 'bypassPermissions', resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    assert.equal(
      instances.get(id).ringSnapshot().filter(e => e.kind === 'user_echo').length,
      2,
    );

    await instances.get(id).kill({ graceMs: 50 });
    await waitFor(() => {
      const s = instances.get(id).status;
      return s === 'exited' || s === 'crashed';
    });

    let resetSeen = 0;
    const snapshotHandler = (snap) => { if (snap.id === id) resetSeen++; };
    instances.on('snapshot_reset', snapshotHandler);
    cleanupListeners.push(() => instances.off('snapshot_reset', snapshotHandler));

    const rs = await api(baseUrl, 'POST', `/api/instances/${id}/respawn`);
    assert.equal(rs.status, 200);
    await waitFor(() => instances.get(id).status === 'idle');

    assert.equal(resetSeen, 1, 'respawn broadcasts snapshot_reset so subscribers clear their view');

    const echoes = instances.get(id).ringSnapshot()
      .filter(e => e.kind === 'user_echo')
      .map(e => e.text);
    assert.deepEqual(
      echoes, ['first prompt', 'second prompt'],
      'history replayed exactly once after respawn',
    );
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});

test('DELETE /api/instances/:id kills subprocess and removes it', async () => {
  await setupWithProject();
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
  const id = r.body.id;
  await waitFor(() => instances.get(id)?.sessionId);

  const del = await api(baseUrl, 'DELETE', `/api/instances/${id}`);
  assert.equal(del.status, 200);
  assert.equal(instances.get(id), undefined);
});

test('rejects invalid mode and unknown project', async () => {
  await setupWithProject();
  const r1 = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'wat' });
  assert.equal(r1.status, 400);
  const r2 = await api(baseUrl, 'POST', '/api/instances', { project: 'missing', mode: 'bypassPermissions' });
  assert.equal(r2.status, 404);
  const r3 = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', effort: 'bogus' });
  assert.equal(r3.status, 400);
});

test('default spawn passes --permission-mode plan, --effort high, --thinking adaptive', async () => {
  await setupWithProject();
  const fsp = (await import('node:fs')).promises;
  const argvPath = `${home}/argv.txt`;
  process.env.FAKE_CLAUDE_ARGV_DUMP = argvPath;
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo' }); // no mode / effort / thinking
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    assert.equal(instances.get(id).mode, 'plan', 'default mode defaults to plan');
    assert.equal(instances.get(id).effort, 'high', 'default effort defaults to high');
    assert.equal(instances.get(id).thinking, 'adaptive', 'default thinking defaults to adaptive');

    await waitFor(async () => { try { await fsp.stat(argvPath); return true; } catch { return false; } });
    const argv = (await fsp.readFile(argvPath, 'utf8')).split('\n').filter(Boolean);

    const pm = argv.indexOf('--permission-mode');
    assert.ok(pm >= 0, `--permission-mode not passed; argv was: ${argv.join(' ')}`);
    assert.equal(argv[pm + 1], 'plan');

    const e = argv.indexOf('--effort');
    assert.ok(e >= 0, `--effort not passed; argv was: ${argv.join(' ')}`);
    assert.equal(argv[e + 1], 'high');

    const t = argv.indexOf('--thinking');
    assert.ok(t >= 0, `--thinking not passed; argv was: ${argv.join(' ')}`);
    assert.equal(argv[t + 1], 'adaptive');

    // Required so the plan-approve flow's mid-session `set_permission_mode
    // bypassPermissions` is accepted at runtime. Without this flag the CLI
    // rejects the switch with "session was not launched with
    // --dangerously-skip-permissions" and the instance stays stuck in plan.
    assert.ok(
      argv.includes('--allow-dangerously-skip-permissions'),
      `--allow-dangerously-skip-permissions missing; argv was: ${argv.join(' ')}`,
    );

    // The interactive tools (ExitPlanMode / EnterPlanMode / AskUserQuestion)
    // are enabled via `--permission-prompt-tool stdio` (routes their permission
    // prompts to us as `can_use_tool` control_requests) and gated at that layer
    // by a deny control_response — NOT by a PreToolUse command hook anymore.
    assert.ok(
      argv.includes('--permission-prompt-tool') &&
        argv[argv.indexOf('--permission-prompt-tool') + 1] === 'stdio',
      `--permission-prompt-tool stdio missing; argv was: ${argv.join(' ')}`,
    );

    const s = argv.indexOf('--settings');
    assert.ok(s >= 0, `--settings not passed; argv was: ${argv.join(' ')}`);
    const settings = JSON.parse(argv[s + 1]);
    const preToolUse = settings.hooks?.PreToolUse;
    assert.ok(Array.isArray(preToolUse), 'settings.hooks.PreToolUse is an array');
    // The old static AskUserQuestion|ExitPlanMode command-deny hook is gone.
    const cmdDenyRow = preToolUse.find(h => /AskUserQuestion|ExitPlanMode/.test(h.matcher || ''));
    assert.ok(!cmdDenyRow, 'no PreToolUse command-deny hook for the interactive tools anymore');

    // The interactive PreToolUse http hook is still registered so that a
    // plan→ask runtime switch starts gating destructive tools without
    // requiring a respawn. The hook targets the orchestrator's REST
    // callback for this specific instance.
    const httpRow = preToolUse.find(h => /Edit/.test(h.matcher) && /Write/.test(h.matcher) && /Bash/.test(h.matcher));
    assert.ok(httpRow, 'PreToolUse matcher covers destructive tools (Edit|Write|NotebookEdit|Bash)');
    const httpHook = httpRow.hooks?.[0];
    assert.equal(httpHook.type, 'http');
    assert.match(httpHook.url, /^http:\/\/127\.0\.0\.1:\d+\/api\/instances\/[^/]+\/hook-callback$/,
      `http hook url should target the orchestrator endpoint, got: ${httpHook.url}`);
    assert.ok(httpHook.url.includes(`/api/instances/${id}/hook-callback`),
      `http hook url should embed the instance id`);
    assert.ok(typeof httpHook.timeout === 'number' && httpHook.timeout >= 60,
      `http hook timeout should leave room for a human (>= 60s), got ${httpHook.timeout}`);

    // The orchestrator auto-registers its own MCP server on every spawn
    // so the session can drive `mcp__code-conductor__*` tools without a
    // prior `claude mcp add` step. Server name must stay `code-conductor`
    // — the tool-name prefix is bound to it.
    const mcp = argv.indexOf('--mcp-config');
    assert.ok(mcp >= 0, `--mcp-config not passed; argv was: ${argv.join(' ')}`);
    const mcpCfg = JSON.parse(argv[mcp + 1]);
    assert.ok(mcpCfg.mcpServers?.['code-conductor'], 'mcp-config registers a `code-conductor` server');
    assert.equal(mcpCfg.mcpServers['code-conductor'].type, 'http');
    // The URL embeds the spawning instance's id as `?caller=<id>` so the
    // MCP server can identify the caller (used by subscribe_to_idle).
    assert.match(
      mcpCfg.mcpServers['code-conductor'].url,
      /^http:\/\/127\.0\.0\.1:\d+\/mcp\?caller=[0-9a-f-]{36}$/,
    );
  } finally {
    delete process.env.FAKE_CLAUDE_ARGV_DUMP;
  }
});

test('ORCH_DISABLE_MCP_AUTOREGISTER=1 omits --mcp-config from spawn argv', async () => {
  await setupWithProject();
  const fsp = (await import('node:fs')).promises;
  const argvPath = `${home}/argv.txt`;
  process.env.FAKE_CLAUDE_ARGV_DUMP = argvPath;
  process.env.ORCH_DISABLE_MCP_AUTOREGISTER = '1';
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');

    await waitFor(async () => { try { await fsp.stat(argvPath); return true; } catch { return false; } });
    const argv = (await fsp.readFile(argvPath, 'utf8')).split('\n').filter(Boolean);
    assert.equal(argv.indexOf('--mcp-config'), -1,
      `--mcp-config should be absent when ORCH_DISABLE_MCP_AUTOREGISTER=1; argv was: ${argv.join(' ')}`);
  } finally {
    delete process.env.FAKE_CLAUDE_ARGV_DUMP;
    delete process.env.ORCH_DISABLE_MCP_AUTOREGISTER;
  }
});

test('ask mode: --permission-mode is bypassPermissions at the CLI level, orchestrator-tracked mode stays "ask"', async () => {
  await setupWithProject();
  const fsp = (await import('node:fs')).promises;
  const argvPath = `${home}/argv.txt`;
  process.env.FAKE_CLAUDE_ARGV_DUMP = argvPath;
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'ask' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    assert.equal(instances.get(id).mode, 'ask', 'orchestrator tracks ask separately from the CLI mode');

    await waitFor(async () => { try { await fsp.stat(argvPath); return true; } catch { return false; } });
    const argv = (await fsp.readFile(argvPath, 'utf8')).split('\n').filter(Boolean);
    const pm = argv.indexOf('--permission-mode');
    assert.equal(argv[pm + 1], 'bypassPermissions',
      `ask maps to CLI bypassPermissions (CLI doesn't know about ask); argv was: ${argv.join(' ')}`);
  } finally {
    delete process.env.FAKE_CLAUDE_ARGV_DUMP;
  }
});

test('setMode("ask") flips orchestrator mode to ask while sending bypassPermissions to the CLI', async () => {
  await setupWithProject();
  const transcriptPath = `${home}/transcript.log`;
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'plan' });
    const id = r.body.id;
    const inst = instances.get(id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);

    await inst.setMode('ask');
    assert.equal(inst.mode, 'ask', 'orchestrator-tracked mode is ask');

    const fsp = (await import('node:fs')).promises;
    const lines = (await fsp.readFile(transcriptPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    const modeReq = lines.find(p => p.type === 'control_request' && p.request?.subtype === 'set_permission_mode');
    assert.ok(modeReq, 'set_permission_mode control_request was written');
    assert.equal(modeReq.request.mode, 'bypassPermissions',
      'CLI receives the bypassPermissions equivalent — it doesn\'t know about ask');
  } finally {
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
  }
});

test('resuming an existing session replays the persisted transcript into the ring buffer', async () => {
  // Write a synthetic session jsonl in the place real claude would, then
  // spawn an instance with resume=<sid> and assert the orchestrator
  // populates its ring buffer with UI events derived from those persisted
  // user/assistant lines (text, thinking, tool_use, tool_result).
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_RESUME;
  const fsp = (await import('node:fs')).promises;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'resume-me' });
    const projectPath = path.join(ctx.projectsRoot, 'resume-me');
    const sid = '11111111-2222-3333-4444-555555555555';
    const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(projectPath));
    await fsp.mkdir(sessionDir, { recursive: true });

    const lines = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first user prompt' } },
      { type: 'assistant', uuid: 'a1', message: { id: 'm_a1', role: 'assistant', content: [
        { type: 'thinking', thinking: 'reasoning here' },
        { type: 'text', text: 'first assistant reply' },
        { type: 'tool_use', id: 'tu_persisted', name: 'Bash', input: { command: 'ls -la' } },
      ] } },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_persisted', content: 'file1.txt\nfile2.txt\n', is_error: false },
      ] } },
      { type: 'assistant', uuid: 'a2', message: { id: 'm_a2', role: 'assistant', content: [
        { type: 'text', text: 'two files listed' },
      ] } },
      // Pre-existing metadata that the orchestrator/CLI write
      { type: 'last-prompt', leafUuid: 'a2', sessionId: sid },
      { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: sid },
    ];
    await fsp.writeFile(
      path.join(sessionDir, `${sid}.jsonl`),
      lines.map(l => JSON.stringify(l)).join('\n') + '\n',
    );

    const events = collectEvents(instances);
    const r = await api(baseUrl, 'POST', '/api/instances', {
      project: 'resume-me', mode: 'bypassPermissions', resume: sid,
    });
    const id = r.body.id;
    const inst = instances.get(id);
    await waitFor(() => inst.status === 'idle');

    const mine = events.filter(e => e.id === id).map(e => e.ev);
    const kinds = mine.map(e => e.kind);

    // History was replayed before status became idle.
    assert.ok(kinds.includes('user_echo'), 'user_echo from first prompt replayed');
    assert.ok(kinds.includes('thinking_delta'), 'thinking_delta replayed');
    assert.ok(kinds.includes('text_delta'), 'text_delta replayed');
    assert.ok(kinds.includes('text_end'), 'text_end replayed');
    assert.ok(kinds.includes('tool_use_start'), 'tool_use_start replayed');
    assert.ok(kinds.includes('tool_use'), 'tool_use replayed');
    assert.ok(kinds.includes('tool_result'), 'tool_result replayed');
    const userEchoes = mine.filter(e => e.kind === 'user_echo').map(e => e.text);
    assert.deepEqual(userEchoes, ['first user prompt']);
    const finalToolUse = mine.find(e => e.kind === 'tool_use');
    assert.deepEqual(finalToolUse.input, { command: 'ls -la' });
    const toolResult = mine.find(e => e.kind === 'tool_result');
    assert.equal(toolResult.toolUseId, 'tu_persisted');

    // A history_replayed marker is emitted so the UI can show a divider.
    const marker = mine.find(e => e.kind === 'system' && e.subtype === 'history_replayed');
    assert.ok(marker, 'history_replayed marker emitted');
    assert.ok(marker.data.count >= 4, `expected ≥4 replayed lines, got ${marker.data.count}`);
    assert.equal(marker.data.sessionId, sid);

    // sessionId on the instance equals the resume sid.
    assert.equal(inst.sessionId, sid);
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});

test('two concurrent resumes of one session coalesce to a single instance (no duplicate --resume)', async () => {
  // Regression: on a resume-restart the boot-time manifest restore and the
  // reloaded frontend's anchor auto-resume both call create({resume:<sid>}).
  // The old i.proc-only guard sat AFTER create()'s awaits, so both slipped
  // past and spawned colliding subprocesses → "already attached" exception.
  // The synchronous in-flight guard now coalesces them onto one instance.
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_RESUME;
  const fsp = (await import('node:fs')).promises;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'resume-me' });
    const projectPath = path.join(ctx.projectsRoot, 'resume-me');
    const sid = '33333333-4444-5555-6666-777777777777';
    const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(projectPath));
    await fsp.mkdir(sessionDir, { recursive: true });
    await fsp.writeFile(
      path.join(sessionDir, `${sid}.jsonl`),
      JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }) + '\n',
    );

    // Fire both in the same tick so the second reaches create() before the
    // first has spawned (the exact race the guard closes).
    const [a, b] = await Promise.all([
      instances.create({ project: 'resume-me', mode: 'bypassPermissions', resume: sid }),
      instances.create({ project: 'resume-me', mode: 'bypassPermissions', resume: sid }),
    ]);
    assert.equal(a.id, b.id, 'concurrent resumes returned the same instance');

    const forSid = [...instances.byId.values()].filter(i => i.sessionId === sid);
    assert.equal(forSid.length, 1, 'exactly one instance exists for the session');
    await waitFor(() => instances.get(a.id).status === 'idle');
    // In-flight reservation released once .proc is set (live-guard now covers it).
    assert.equal(instances._resuming.has(sid), false, 'reservation released after settle');
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});

test('resuming a session that is already live returns a clean 409, not a crash', async () => {
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_RESUME;
  const fsp = (await import('node:fs')).promises;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'resume-me' });
    const projectPath = path.join(ctx.projectsRoot, 'resume-me');
    const sid = '44444444-5555-6666-7777-888888888888';
    const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(projectPath));
    await fsp.mkdir(sessionDir, { recursive: true });
    await fsp.writeFile(
      path.join(sessionDir, `${sid}.jsonl`),
      JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }) + '\n',
    );

    const r1 = await api(baseUrl, 'POST', '/api/instances', {
      project: 'resume-me', mode: 'bypassPermissions', resume: sid,
    });
    assert.equal(r1.status, 201);
    await waitFor(() => instances.get(r1.body.id)?.status === 'idle');

    // Sequential resume while the first is fully live → 409, not the old
    // uncaught "can't be resumed twice" exception.
    const r2 = await api(baseUrl, 'POST', '/api/instances', {
      project: 'resume-me', mode: 'bypassPermissions', resume: sid,
    });
    assert.equal(r2.status, 409);
    assert.match(r2.body.error, /already attached to a running instance/);
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});

test('resume without explicit model passes --model from the session jsonl (preserves Sonnet across server restart)', async () => {
  // Regression: spawning with model=claude-sonnet-4-6, restarting the server,
  // then auto-resuming via the URL anchor used to silently flip the session
  // to the account default (Opus) because the resume call doesn't carry the
  // model and `claude --resume <sid>` falls back to the default. Fix reads
  // the most-recent assistant.message.model from the jsonl on resume and
  // re-passes it via --model — canonicalised to the family's fixed window
  // (Sonnet → 1M via the CLI-native [1m] suffix).
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_RESUME;
  const fsp = (await import('node:fs')).promises;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'resume-model' });
    const projectPath = path.join(ctx.projectsRoot, 'resume-model');
    const sid = '99999999-aaaa-bbbb-cccc-dddddddddddd';
    const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(projectPath));
    await fsp.mkdir(sessionDir, { recursive: true });
    const lines = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', uuid: 'a1', message: {
        id: 'm1', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'hello' }],
      } },
    ];
    await fsp.writeFile(
      path.join(sessionDir, `${sid}.jsonl`),
      lines.map(l => JSON.stringify(l)).join('\n') + '\n',
    );

    const argvPath = `${home}/argv-resume.txt`;
    process.env.FAKE_CLAUDE_ARGV_DUMP = argvPath;
    try {
      const r = await api(baseUrl, 'POST', '/api/instances', {
        project: 'resume-model', resume: sid,
        // intentionally no `model` — mirrors the auto-resume flow
      });
      const id = r.body.id;
      await waitFor(() => instances.get(id)?.status === 'idle');
      await waitFor(async () => { try { await fsp.stat(argvPath); return true; } catch { return false; } });
      const argv = (await fsp.readFile(argvPath, 'utf8')).split('\n').filter(Boolean);
      const m = argv.indexOf('--model');
      assert.ok(m >= 0, `--model should be passed on resume; argv was: ${argv.join(' ')}`);
      assert.equal(argv[m + 1], 'claude-sonnet-4-6[1m]');
      assert.equal(instances.get(id).model, 'claude-sonnet-4-6[1m]');
    } finally {
      delete process.env.FAKE_CLAUDE_ARGV_DUMP;
    }
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});

test('resume with explicit model overrides the model recorded in the jsonl', async () => {
  // Caller can still force a different model on resume — the jsonl-derived
  // model is only a fallback when the caller didn't pass one.
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_RESUME;
  const fsp = (await import('node:fs')).promises;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'resume-model-override' });
    const projectPath = path.join(ctx.projectsRoot, 'resume-model-override');
    const sid = '88888888-aaaa-bbbb-cccc-dddddddddddd';
    const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(projectPath));
    await fsp.mkdir(sessionDir, { recursive: true });
    const lines = [
      { type: 'assistant', uuid: 'a1', message: {
        id: 'm1', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'x' }],
      } },
    ];
    await fsp.writeFile(
      path.join(sessionDir, `${sid}.jsonl`),
      lines.map(l => JSON.stringify(l)).join('\n') + '\n',
    );

    const argvPath = `${home}/argv-override.txt`;
    process.env.FAKE_CLAUDE_ARGV_DUMP = argvPath;
    try {
      const r = await api(baseUrl, 'POST', '/api/instances', {
        project: 'resume-model-override', resume: sid,
        model: 'claude-haiku-4-5',
      });
      const id = r.body.id;
      await waitFor(() => instances.get(id)?.status === 'idle');
      await waitFor(async () => { try { await fsp.stat(argvPath); return true; } catch { return false; } });
      const argv = (await fsp.readFile(argvPath, 'utf8')).split('\n').filter(Boolean);
      const m = argv.indexOf('--model');
      assert.equal(argv[m + 1], 'claude-haiku-4-5');
    } finally {
      delete process.env.FAKE_CLAUDE_ARGV_DUMP;
    }
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});


test('resume: AskUserQuestion and ExitPlanMode tool calls from history replay as their structured cards', async () => {
  // Regression: the live parser emits `user_question` (and `plan_request`)
  // alongside the tool_use for AskUserQuestion / ExitPlanMode at
  // content_block_stop time. The replay path only re-emitted
  // tool_use_start + tool_use, so resumed sessions showed those tool
  // calls as plain collapsed tool blocks — no question card, no
  // plan-approval card.
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_RESUME;
  const fsp = (await import('node:fs')).promises;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'with-cards' });
    const projectPath = path.join(ctx.projectsRoot, 'with-cards');
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(projectPath));
    await fsp.mkdir(sessionDir, { recursive: true });

    const lines = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'plan something then ask me' } },
      { type: 'assistant', uuid: 'a1', message: { id: 'm_a1', role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_q_replay', name: 'AskUserQuestion', input: {
          questions: [{
            question: 'What colour?',
            header: 'Color',
            multiSelect: false,
            options: [{ label: 'Red' }, { label: 'Blue' }],
          }],
        } },
      ] } },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: 'Answer to "What colour?": Red' } },
      { type: 'assistant', uuid: 'a2', message: { id: 'm_a2', role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_plan_replay', name: 'ExitPlanMode', input: {
          plan: '# Plan\n- Step 1\n- Step 2',
        } },
      ] } },
    ];
    await fsp.writeFile(
      path.join(sessionDir, `${sid}.jsonl`),
      lines.map(l => JSON.stringify(l)).join('\n') + '\n',
    );

    const events = collectEvents(instances);
    const r = await api(baseUrl, 'POST', '/api/instances', {
      project: 'with-cards', mode: 'plan', resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');

    const mine = events.filter(e => e.id === id).map(e => e.ev);

    // AskUserQuestion: both the generic tool_use and the structured
    // user_question should be replayed.
    const uq = mine.find(e => e.kind === 'user_question' && e.toolUseId === 'tu_q_replay');
    assert.ok(uq, `user_question for replayed AskUserQuestion missing — kinds: ${mine.map(e=>e.kind).join(',')}`);
    assert.equal(uq.questions[0].question, 'What colour?');
    assert.deepEqual(uq.questions[0].options.map(o => o.label), ['Red', 'Blue']);

    // ExitPlanMode: same — should emit plan_request with the plan text.
    const pr = mine.find(e => e.kind === 'plan_request' && e.toolUseId === 'tu_plan_replay');
    assert.ok(pr, 'plan_request for replayed ExitPlanMode missing');
    assert.match(pr.plan, /Step 1/);
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});

test('resume: an Agent tool_use replays its sub-agent transcript from subagents/agent-<id>.jsonl, tagged with parent_tool_use_id', async () => {
  // Real-CLI shape (validated against session ea7b99b2 + CLI 2.1.143): the
  // parent jsonl contains only the outer Agent tool_use + its tool_result;
  // the user line that holds that tool_result carries a `toolUseResult`
  // envelope with `agentId`. The sub-agent's own assistant/user transcript
  // lives in <sid>/subagents/agent-<agentId>.jsonl with isSidechain:true and
  // parent_tool_use_id:null. Live streams those events over stdout with
  // parent_tool_use_id set (parser tags them, conversation nests them under
  // the Agent block) — replay needs to load + tag them explicitly.
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_RESUME;
  const fsp = (await import('node:fs')).promises;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'agent-replay' });
    const projectPath = path.join(ctx.projectsRoot, 'agent-replay');
    const sid = 'cccccccc-1111-2222-3333-444444444444';
    const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(projectPath));
    await fsp.mkdir(sessionDir, { recursive: true });

    const agentToolUseId = 'toolu_agent_outer';
    const agentId = 'af3e0c57b12f03981';

    const parentLines = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'investigate the project' } },
      { type: 'assistant', uuid: 'a1', message: { id: 'm_a1', role: 'assistant', content: [
        { type: 'tool_use', id: agentToolUseId, name: 'Agent', input: { description: 'Investigate', subagent_type: 'Explore', prompt: 'go look at things' } },
      ] } },
      // The user line that closes the Agent call: tool_result block PLUS
      // the toolUseResult envelope carrying agentId — the link to subagents/.
      {
        type: 'user', uuid: 'u2',
        toolUseResult: { agentId, agentType: 'Explore', status: 'completed' },
        message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: agentToolUseId, content: 'all done', is_error: false },
        ] },
      },
    ];
    await fsp.writeFile(
      path.join(sessionDir, `${sid}.jsonl`),
      parentLines.map(l => JSON.stringify(l)).join('\n') + '\n',
    );

    // Sub-agent file lives at <sid>/subagents/agent-<agentId>.jsonl. Mirror
    // the real shape: isSidechain:true, parent_tool_use_id absent, a few
    // assistant tool_uses interleaved with their user tool_results.
    const subDir = path.join(sessionDir, sid, 'subagents');
    await fsp.mkdir(subDir, { recursive: true });
    const subLines = [
      { type: 'user', isSidechain: true, message: { role: 'user', content: 'go look at things' } },
      { type: 'assistant', isSidechain: true, uuid: 'sa1', message: { id: 'm_sub_1', role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_sub_bash', name: 'Bash', input: { command: 'ls -la' } },
      ] } },
      { type: 'user', isSidechain: true, message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_sub_bash', content: 'total 0\n', is_error: false },
      ] } },
      { type: 'assistant', isSidechain: true, uuid: 'sa2', message: { id: 'm_sub_2', role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_sub_read', name: 'Read', input: { file_path: '/x' } },
      ] } },
      { type: 'user', isSidechain: true, message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_sub_read', content: 'file body', is_error: false },
      ] } },
    ];
    await fsp.writeFile(
      path.join(subDir, `agent-${agentId}.jsonl`),
      subLines.map(l => JSON.stringify(l)).join('\n') + '\n',
    );

    const events = collectEvents(instances);
    const r = await api(baseUrl, 'POST', '/api/instances', {
      project: 'agent-replay', mode: 'bypassPermissions', resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');

    const mine = events.filter(e => e.id === id).map(e => e.ev);

    // Outer Agent tool_use must replay at the top level (no parent).
    const outerAgent = mine.find(e => e.kind === 'tool_use' && e.toolUseId === agentToolUseId);
    assert.ok(outerAgent, 'outer Agent tool_use replayed');
    assert.equal(outerAgent.parentToolUseId, null, 'outer Agent tool_use has no parent');
    assert.equal(outerAgent.name, 'Agent');

    // Sub-agent tool_uses must replay and carry parentToolUseId = agentToolUseId
    // so the conversation view nests them under the Agent block.
    const subBash = mine.find(e => e.kind === 'tool_use' && e.toolUseId === 'tu_sub_bash');
    const subRead = mine.find(e => e.kind === 'tool_use' && e.toolUseId === 'tu_sub_read');
    assert.ok(subBash, 'sub-agent Bash tool_use replayed');
    assert.ok(subRead, 'sub-agent Read tool_use replayed');
    assert.equal(subBash.parentToolUseId, agentToolUseId, 'sub Bash carries parentToolUseId');
    assert.equal(subRead.parentToolUseId, agentToolUseId, 'sub Read carries parentToolUseId');

    // Sub-agent tool_results must replay and carry the same parentToolUseId.
    const subResults = mine.filter(e => e.kind === 'tool_result' && (e.toolUseId === 'tu_sub_bash' || e.toolUseId === 'tu_sub_read'));
    assert.equal(subResults.length, 2, 'both sub-agent tool_results replayed');
    for (const r of subResults) {
      assert.equal(r.parentToolUseId, agentToolUseId, `${r.toolUseId} result must be tagged with the Agent's tool_use_id`);
    }

    // Outer Agent's own tool_result must NOT be tagged (it attaches to the
    // outer-level Agent block, not the nested sub-conversation).
    const outerResult = mine.find(e => e.kind === 'tool_result' && e.toolUseId === agentToolUseId);
    assert.ok(outerResult, 'outer Agent tool_result replayed');
    assert.equal(outerResult.parentToolUseId, null, 'outer Agent tool_result has no parent');

    // Ordering: sub-agent events must come BEFORE the outer Agent's
    // tool_result (mirrors the live wire ordering).
    const idxSubBash = mine.indexOf(subBash);
    const idxOuterResult = mine.indexOf(outerResult);
    assert.ok(idxSubBash < idxOuterResult, 'sub-agent events come before the outer Agent tool_result');
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});

test('turn_end while a backgrounded Agent task is still running: status stays idle but displayStatus/activeAgentTasks report it as busy, then clears on task_updated', async () => {
  // Reproduces the reported bug: a backgrounded Agent tool_use resolves its
  // tool_result immediately (isAsync:true), so the outer turn reaches
  // `result` (turn_end → status:'idle') while the CLI's own task-tracking
  // (`system/task_started` ... `system/task_updated`) is still open. The raw
  // `status` field must stay the true process lifecycle value (idle) — only
  // the additive `displayStatus`/`activeAgentTasks` summary fields should
  // reflect the still-running background task.
  await setupWithProject();
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_BACKGROUND_TASK;
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');

    instances.get(id).prompt('kick off a background agent');
    // The scenario's `result` event (turn_end) lands before its trailing
    // `task_updated` (both in the same `emit` array, spaced by delay_ms) —
    // waitFor here catches the window where turn_end already fired but the
    // background task hasn't been marked done yet.
    await waitFor(() => instances.get(id).status === 'idle' && instances.get(id).summary().activeAgentTasks === 1);

    const inst = instances.get(id);
    assert.equal(inst.status, 'idle', 'raw status is the true process lifecycle value');
    const summary = inst.summary();
    assert.equal(summary.activeAgentTasks, 1, 'task_started was tracked');
    assert.equal(summary.displayStatus, 'running', 'displayStatus overlays running while a background task is active');

    // list_instances / GET /api/instances must carry the same overlay.
    const list = await api(baseUrl, 'GET', '/api/instances');
    const row = list.body.find(i => i.id === id);
    assert.equal(row.status, 'idle');
    assert.equal(row.displayStatus, 'running');

    // The scenario's task_updated (patch.status:"completed") arrives after
    // turn_end — once processed, the overlay clears back to plain idle.
    await waitFor(() => instances.get(id).summary().activeAgentTasks === 0);
    assert.equal(instances.get(id).summary().displayStatus, 'idle', 'displayStatus reverts once the task completes');
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});

test('resuming a session with no jsonl is refused (404), never spawns a doomed --resume', async () => {
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_RESUME;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'nope' });
    const sid = 'deadbeef-0000-0000-0000-000000000000';
    // No jsonl exists for `sid`. The real CLI would exit 1 "No conversation
    // found" and crash-loop; the resume pre-flight refuses it up front instead.
    const r = await api(baseUrl, 'POST', '/api/instances', {
      project: 'nope', mode: 'bypassPermissions', resume: sid,
    });
    assert.equal(r.status, 404, 'a resume id with no resumable conversation is refused');
    assert.match(r.body.error, /no resumable conversation/);
    assert.equal(instances.anyForSession(sid), null, 'no phantom Instance is registered');
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});

test('writes last-prompt + permission-mode jsonl markers after each turn (so claude --resume sees the session)', async () => {
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_RESUME;
  const fsp = (await import('node:fs')).promises;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'r' });
    const events = collectEvents(instances);
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'r', mode: 'bypassPermissions' });
    const id = r.body.id;
    const inst = instances.get(id);
    await waitFor(() => inst.status === 'idle');
    inst.prompt('hi');
    await waitFor(() => events.some(e => e.id === id && e.ev.kind === 'turn_end'));
    // give the appendFile a tick to settle
    await waitFor(async () => {
      const dir = path.join(ctx.claudeProjectsRoot, encodeCwd(inst.cwd));
      const file = path.join(dir, `${inst.sessionId}.jsonl`);
      try { const txt = await fsp.readFile(file, 'utf8'); return txt.includes('"type":"last-prompt"'); }
      catch { return false; }
    });
    const dir = path.join(ctx.claudeProjectsRoot, encodeCwd(inst.cwd));
    const file = path.join(dir, `${inst.sessionId}.jsonl`);
    const lines = (await fsp.readFile(file, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
    const last = lines.find(l => l.type === 'last-prompt');
    const mode = lines.find(l => l.type === 'permission-mode');
    assert.ok(last, 'last-prompt line was appended');
    assert.equal(last.sessionId, inst.sessionId);
    assert.ok(last.leafUuid, 'leafUuid present');
    assert.ok(mode, 'permission-mode line was appended');
    assert.equal(mode.permissionMode, 'bypassPermissions');
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});

test('rejects invalid thinking mode', async () => {
  await setupWithProject();
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', thinking: 'wrong' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /thinking/);
});

test('sending a prompt emits exactly one user_echo (no duplicate from --replay)', async () => {
  // Regression: when --replay-user-messages was passed, claude echoed the user
  // message back as a `type:"user"` event on stdout, which the parser turned
  // into a second user_echo on top of the orchestrator's optimistic one.
  // The fix was dropping --replay-user-messages from the spawn args.
  await setupWithProject();
  const fsp = (await import('node:fs')).promises;
  const argvPath = `${home}/argv.txt`;
  process.env.FAKE_CLAUDE_ARGV_DUMP = argvPath;
  try {
    const events = collectEvents(instances);
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');

    instances.get(id).prompt('hello there');
    await waitFor(() => events.some(e => e.id === id && e.ev.kind === 'turn_end'));

    const echoes = events.filter(e => e.id === id && e.ev.kind === 'user_echo');
    assert.equal(echoes.length, 1, `expected 1 user_echo, got ${echoes.length}`);
    assert.equal(echoes[0].ev.text, 'hello there');

    // And confirm --replay-user-messages is NOT in argv.
    await waitFor(async () => { try { await fsp.stat(argvPath); return true; } catch { return false; } });
    const argv = (await fsp.readFile(argvPath, 'utf8')).split('\n').filter(Boolean);
    assert.ok(!argv.includes('--replay-user-messages'), `--replay-user-messages must not be passed; argv was: ${argv.join(' ')}`);
  } finally {
    delete process.env.FAKE_CLAUDE_ARGV_DUMP;
  }
});

test('resume defaults to bypassPermissions (code) mode; fresh spawn still defaults to plan', async () => {
  // A resume is almost always continuing real work, so plan mode would be
  // the wrong starting point. Fresh spawns keep plan as the safer default.
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_RESUME;
  const fsp = (await import('node:fs')).promises;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'resume-default' });
    const projectPath = path.join(ctx.projectsRoot, 'resume-default');
    const sid = '99999999-8888-7777-6666-555555555555';
    const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(projectPath));
    await fsp.mkdir(sessionDir, { recursive: true });
    const lines = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', uuid: 'a1', message: { id: 'm_a1', role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
    ];
    await fsp.writeFile(
      path.join(sessionDir, `${sid}.jsonl`),
      lines.map(l => JSON.stringify(l)).join('\n') + '\n',
    );

    const resumed = await api(baseUrl, 'POST', '/api/instances', {
      project: 'resume-default', resume: sid,
    });
    assert.equal(resumed.status, 201);
    const resumedInst = instances.get(resumed.body.id);
    await waitFor(() => resumedInst.status === 'idle');
    assert.equal(resumedInst.mode, 'bypassPermissions', 'resume default is code mode, not plan');

    const fresh = await api(baseUrl, 'POST', '/api/instances', {
      project: 'resume-default',
    });
    assert.equal(fresh.status, 201);
    const freshInst = instances.get(fresh.body.id);
    await waitFor(() => freshInst.status === 'idle');
    assert.equal(freshInst.mode, 'plan', 'fresh spawn default is still plan mode');
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});

test('temp: spawn defaults mode to bypassPermissions but explicit mode wins', async () => {
  await setupWithProject();
  const r1 = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', temp: true });
  assert.equal(r1.status, 201);
  const inst1 = instances.get(r1.body.id);
  assert.equal(inst1.mode, 'bypassPermissions', 'temp default is code mode');
  assert.equal(inst1.temp, true);
  assert.equal(r1.body.temp, true, 'summary.temp round-trips through REST');

  const r2 = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', temp: true, mode: 'plan' });
  assert.equal(r2.status, 201);
  const inst2 = instances.get(r2.body.id);
  assert.equal(inst2.mode, 'plan', 'explicit mode overrides the temp default');
  assert.equal(inst2.temp, true);
});

test('temp: skips last-prompt / permission-mode metadata writes after a turn', async () => {
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_RESUME;
  const fsp = (await import('node:fs')).promises;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'tmp' });
    const events = collectEvents(instances);
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'tmp', temp: true });
    const id = r.body.id;
    const inst = instances.get(id);
    await waitFor(() => inst.status === 'idle');
    inst.prompt('hi');
    await waitFor(() => events.some(e => e.id === id && e.ev.kind === 'turn_end'));

    // Wait a tick to let any (unwanted) appendFile settle, then assert nothing was written.
    await new Promise(r => setTimeout(r, 50));
    const dir = path.join(ctx.claudeProjectsRoot, encodeCwd(inst.cwd));
    const file = path.join(dir, `${inst.sessionId}.jsonl`);
    let exists = true;
    try { await fsp.access(file); } catch { exists = false; }
    if (exists) {
      const txt = await fsp.readFile(file, 'utf8');
      assert.equal(txt.includes('"type":"last-prompt"'), false, 'no last-prompt for temp');
      assert.equal(txt.includes('"type":"permission-mode"'), false, 'no permission-mode for temp');
    }
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});

test('temp: archives session jsonl + removes subagents dir on subprocess exit', async () => {
  await setupWithProject();
  const fsp = (await import('node:fs')).promises;
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', temp: true });
  const id = r.body.id;
  const inst = instances.get(id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);

  // Simulate the CLI having written its transcript + a sub-agent dir.
  const dir = path.join(ctx.claudeProjectsRoot, encodeCwd(inst.cwd));
  const file = path.join(dir, `${inst.sessionId}.jsonl`);
  const subDir = path.join(dir, inst.sessionId, 'subagents');
  await fsp.mkdir(subDir, { recursive: true });
  await fsp.writeFile(file, '{"type":"user","uuid":"u1"}\n');
  await fsp.writeFile(path.join(subDir, 'agent-x.jsonl'), '{}\n');

  const del = await api(baseUrl, 'DELETE', `/api/instances/${id}`);
  assert.equal(del.status, 200);
  // Wait for _archiveTempSession to complete — markArchived is the last write.
  await waitFor(() => isArchived(inst.sessionId));
  // .jsonl is retained for resumability — must still be on disk.
  await fsp.access(file);
  // Sub-agent dir is ephemeral and must be cleaned up.
  let subStillThere = true;
  try { await fsp.access(path.join(dir, inst.sessionId)); } catch { subStillThere = false; }
  assert.equal(subStillThere, false, 'sub-agent dir for the session was removed');
});

test('temp: instance is auto-removed from byId on subprocess exit (no ghost row)', async () => {
  // The composer's Kill button takes the WS-`kill` path (`inst.kill()`), not
  // DELETE /api/instances/:id. Without auto-removal the temp Instance would
  // sit in byId with status='exited' forever — the sidebar's Temp Sessions
  // subnode would keep a dim ghost row that the user had to delete by hand.
  await setupWithProject();
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', temp: true });
  const id = r.body.id;
  const inst = instances.get(id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);

  let listChangedSeen = 0;
  const listChangedHandler = () => { listChangedSeen++; };
  instances.on('list_changed', listChangedHandler);
  cleanupListeners.push(() => instances.off('list_changed', listChangedHandler));

  await inst.kill({ graceMs: 50 });
  await waitFor(() => instances.get(id) === undefined);

  assert.equal(instances.get(id), undefined, 'temp instance removed from byId after exit');
  assert.ok(!instances.list().some(s => s.id === id), 'temp instance no longer in list()');
  assert.ok(listChangedSeen >= 1, 'list_changed fired so wsHub can broadcast {t:"instances"}');
});

test('non-temp: instance survives in byId after kill (Resume from the sidebar still works)', async () => {
  // Guard the temp-only gate. Normal sessions need to stay in byId after their
  // subprocess dies so the sidebar's Resume button has something to call
  // `/api/instances/:id/respawn` against.
  await setupWithProject();
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
  const id = r.body.id;
  const inst = instances.get(id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);

  await inst.kill({ graceMs: 50 });
  await waitFor(() => inst.status === 'exited' || inst.status === 'crashed');

  assert.ok(instances.get(id), 'non-temp instance stays in byId after exit');
  assert.equal(instances.get(id).temp, false);
});

test('promoted temp: instance survives in byId after kill (promote disables the auto-removal)', async () => {
  // After `/api/instances/:id/promote` flips temp=false the row migrates out
  // of the Temp Sessions subnode into the regular Sessions list. Killing
  // it should now behave like any other session — stays in byId so Resume
  // is offered.
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_RESUME;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'promo-kill' });
    const events = collectEvents(instances);
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'promo-kill', temp: true });
    const id = r.body.id;
    const inst = instances.get(id);
    await waitFor(() => inst.status === 'idle');
    inst.prompt('hi');
    await waitFor(() => events.some(e => e.id === id && e.ev.kind === 'turn_end'));

    const promote = await api(baseUrl, 'POST', `/api/instances/${id}/promote`);
    assert.equal(promote.status, 200);
    assert.equal(inst.temp, false);

    await inst.kill({ graceMs: 50 });
    await waitFor(() => inst.status === 'exited' || inst.status === 'crashed');

    assert.ok(instances.get(id), 'promoted-then-killed instance stays in byId');
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});

test('promote: flips temp flag, writes resume-picker metadata, skips on-exit cleanup', async () => {
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_RESUME;
  const fsp = (await import('node:fs')).promises;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'promo' });
    const events = collectEvents(instances);
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'promo', temp: true });
    const id = r.body.id;
    const inst = instances.get(id);
    await waitFor(() => inst.status === 'idle');
    // Run one turn so the CLI flushes its jsonl to disk — that's the
    // file the on-exit cleanup would otherwise delete, and the file the
    // promote endpoint should keep.
    inst.prompt('hi');
    await waitFor(() => events.some(e => e.id === id && e.ev.kind === 'turn_end'));

    const dir = path.join(ctx.claudeProjectsRoot, encodeCwd(inst.cwd));
    const file = path.join(dir, `${inst.sessionId}.jsonl`);

    const promote = await api(baseUrl, 'POST', `/api/instances/${id}/promote`);
    assert.equal(promote.status, 200);
    assert.equal(promote.body.ok, true);
    assert.equal(promote.body.instance.temp, false, 'summary reflects the flag flip');
    assert.equal(inst.temp, false, 'in-memory flag is flipped too');

    // Wait for the metadata append (writeSessionMetadata is fired-and-forgotten
    // inside promoteToNormal — we awaited it via the request, but the disk
    // write itself is also a microtask away).
    await waitFor(async () => {
      try {
        const txt = await fsp.readFile(file, 'utf8');
        return txt.includes('"type":"last-prompt"');
      } catch { return false; }
    });
    const txt = await fsp.readFile(file, 'utf8');
    assert.ok(txt.includes('"type":"permission-mode"'), 'permission-mode metadata appended after promote');

    // Kill the instance and assert the jsonl SURVIVES — promote should have
    // disabled the temp on-exit cleanup.
    const del = await api(baseUrl, 'DELETE', `/api/instances/${id}`);
    assert.equal(del.status, 200);
    await new Promise(r => setTimeout(r, 50));
    await fsp.access(file); // throws if missing — must not throw
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});

test('promote: 400 when the instance is not temp', async () => {
  await setupWithProject();
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
  const id = r.body.id;
  await waitFor(() => instances.get(id).status === 'idle');
  const promote = await api(baseUrl, 'POST', `/api/instances/${id}/promote`);
  assert.equal(promote.status, 400);
  assert.match(promote.body.error, /not temp/);
});

test('promote: 404 when the instance id is unknown', async () => {
  await setupWithProject();
  const promote = await api(baseUrl, 'POST', '/api/instances/no-such-id/promote');
  assert.equal(promote.status, 404);
});

test('non-temp: jsonl is left in place on exit', async () => {
  await setupWithProject();
  const fsp = (await import('node:fs')).promises;
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
  const id = r.body.id;
  const inst = instances.get(id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);

  const dir = path.join(ctx.claudeProjectsRoot, encodeCwd(inst.cwd));
  const file = path.join(dir, `${inst.sessionId}.jsonl`);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(file, '{"type":"user","uuid":"u1"}\n');

  const del = await api(baseUrl, 'DELETE', `/api/instances/${id}`);
  assert.equal(del.status, 200);
  // Give exit handlers a tick; then assert the jsonl is still there.
  await new Promise(r => setTimeout(r, 50));
  await fsp.access(file); // throws if missing
});

test('debug: enabling debug mode writes stdin/stdout/stderr + meta.json under the central-store debug dir', async () => {
  await setupWithProject();
  const fsp = (await import('node:fs')).promises;
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo',
    mode: 'bypassPermissions',
    debug: true,
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.debug, true, 'summary echoes debug=true');
  const id = r.body.id;
  const inst = instances.get(id);
  await waitFor(() => inst.status === 'idle' && inst.debugDir);

  // The debug dir lives in the workspace-wide central store:
  // <root>/.code-conductor/projects/demo/debug/<id>/
  const debugDir = inst.debugDir;
  const expectedTail = path.join('.code-conductor', 'projects', 'demo', 'debug', id);
  assert.ok(debugDir.endsWith(expectedTail),
    `debugDir should end with ${expectedTail}, got ${debugDir}`);

  // meta.json captures the spawn shape — useful when sharing debug bundles
  // back to a maintainer who didn't observe the spawn-time options.
  const meta = JSON.parse(await fsp.readFile(path.join(debugDir, 'meta.json'), 'utf8'));
  assert.equal(meta.instanceId, id);
  assert.equal(meta.mode, 'bypassPermissions');
  assert.ok(Array.isArray(meta.cliArgs) && meta.cliArgs.length > 0);

  // Send a prompt so the fake claude produces stdout and we exercise stdin
  // capture too.
  await api(baseUrl, 'POST', `/api/instances/${id}/respawn` /* no-op route presence check */)
    .catch(() => {}); // ignore; we only care about prompt() below
  await inst.prompt('hello debug');
  await waitFor(() => inst.status === 'idle', 5000);

  // stdin contains the JSON-line user message we sent to the CLI.
  const stdinTxt = await fsp.readFile(path.join(debugDir, 'claude-stdin.jsonl'), 'utf8');
  assert.ok(stdinTxt.includes('"hello debug"'), 'stdin log captured the user message');
  assert.ok(stdinTxt.trim().split('\n').every(l => { try { JSON.parse(l); return true; } catch { return false; } }),
    'every stdin line is valid JSON');

  // stdout contains at least one line from the fake CLI's scenario.
  const stdoutTxt = await fsp.readFile(path.join(debugDir, 'claude-stdout.jsonl'), 'utf8');
  assert.ok(stdoutTxt.trim().length > 0, 'stdout log captured at least one line');

  // stderr file exists even when there's no stderr — debug mode opens
  // all three streams unconditionally so the bundle is self-describing.
  await fsp.access(path.join(debugDir, 'claude-stderr.log'));
});

test('debug: omitting the flag leaves debug=false and writes nothing', async () => {
  await setupWithProject();
  const fsp = (await import('node:fs')).promises;
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions',
  });
  const id = r.body.id;
  const inst = instances.get(id);
  await waitFor(() => inst.status === 'idle');
  assert.equal(inst.debug, false);
  assert.equal(inst.debugDir, null);
  // No debug dir created in the central store.
  const projectsRoot = process.env.PROJECTS_ROOT;
  const debugDirGuess = path.join(projectsRoot, '.code-conductor', 'projects', 'demo', 'debug');
  let exists = true;
  try { await fsp.access(debugDirGuess); } catch { exists = false; }
  assert.equal(exists, false, 'debug dir is not created when the flag is omitted');
});

test('debug: POST /api/instances/:id/debug enables capture on a running instance', async () => {
  await setupWithProject();
  const fsp = (await import('node:fs')).promises;
  // Spawn WITHOUT debug.
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: 'demo', mode: 'bypassPermissions',
  });
  const id = r.body.id;
  const inst = instances.get(id);
  await waitFor(() => inst.status === 'idle');
  assert.equal(inst.debug, false);

  // Flip debug on at runtime.
  const enable = await api(baseUrl, 'POST', `/api/instances/${id}/debug`);
  assert.equal(enable.status, 200);
  assert.equal(enable.body.ok, true);
  assert.equal(enable.body.alreadyOn, false);
  assert.ok(enable.body.debugDir.endsWith(path.join('.code-conductor', 'projects', 'demo', 'debug', id)));
  assert.equal(inst.debug, true);

  // Future prompts get mirrored even though spawn was non-debug.
  await inst.prompt('after debug enable');
  await waitFor(() => inst.status === 'idle', 5000);
  const stdinTxt = await fsp.readFile(path.join(enable.body.debugDir, 'claude-stdin.jsonl'), 'utf8');
  assert.ok(stdinTxt.includes('"after debug enable"'),
    'lines after the toggle are captured');

  // meta.json shows the spawn argv we cached.
  const meta = JSON.parse(await fsp.readFile(path.join(enable.body.debugDir, 'meta.json'), 'utf8'));
  assert.ok(Array.isArray(meta.cliArgs) && meta.cliArgs.length > 0);

  // Calling it a second time is idempotent.
  const second = await api(baseUrl, 'POST', `/api/instances/${id}/debug`);
  assert.equal(second.status, 200);
  assert.equal(second.body.alreadyOn, true);
});

test('debug: POST /api/instances/:id/debug 404s for unknown instance', async () => {
  await setupWithProject();
  const r = await api(baseUrl, 'POST', '/api/instances/does-not-exist/debug');
  assert.equal(r.status, 404);
});
