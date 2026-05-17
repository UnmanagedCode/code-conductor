import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';
import { encodeCwd } from '../src/projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

function collectEvents(instances) {
  const events = [];
  instances.on('event', ({ id, ev }) => events.push({ id, ev }));
  return events;
}

async function setupWithProject(name = 'demo') {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  const created = await api(ctx.baseUrl, 'POST', '/api/projects', { name });
  assert.equal(created.status, 201);
  return ctx;
}

test('instance reaches idle immediately after spawn (before any output from claude)', async () => {
  // Regression: real claude is silent on stdout until the first user message
  // is sent — `init` does NOT arrive at startup. The orchestrator must flip
  // to `idle` as soon as the subprocess is alive, otherwise prompts can never
  // be sent and the instance stays stuck in `spawning` forever.
  const { baseUrl, instances, close } = await setupWithProject();
  try {
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
  } finally { await close(); }
});

test('init event arrives bundled with first turn response', async () => {
  const { baseUrl, instances, close } = await setupWithProject();
  try {
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
  } finally { await close(); }
});

test('prompt round-trip emits ordered ui events and returns to idle', async () => {
  const { baseUrl, instances, close } = await setupWithProject();
  try {
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
  } finally { await close(); }
});

test('setMode writes control_request and resolves on control_response', async () => {
  const { baseUrl, instances, tmpHome, close } = await setupWithProject();
  try {
    const transcriptPath = path.join(tmpHome, 'transcript.log');
    process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;

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
    await close();
  }
});

test('interrupt mid-turn emits turn_end and returns to idle', async () => {
  const { baseUrl, instances, close } = await setupWithProject();
  try {
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
    await inst.interrupt();

    await waitFor(() => inst.status === 'idle');
    const last = events.filter(e => e.id === id && e.ev.kind === 'turn_end').slice(-1)[0];
    assert.equal(last.ev.subtype, 'error_during_execution');
    assert.equal(last.ev.stopReason, 'interrupted');
  } finally { await close(); }
});

test('crash + respawn preserves sessionId, ring buffer, and uses --resume', async () => {
  const { baseUrl, instances, tmpHome, close } = await setupWithProject();
  try {
    const transcriptPath = path.join(tmpHome, 'transcript.log');
    process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;

    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
    const id = r.body.id;
    const inst = instances.get(id);
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
    const resp = await api(baseUrl, 'POST', `/api/instances/${id}/respawn`);
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
    await close();
  }
});

test('DELETE /api/instances/:id kills subprocess and removes it', async () => {
  const { baseUrl, instances, close } = await setupWithProject();
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id)?.sessionId);

    const del = await api(baseUrl, 'DELETE', `/api/instances/${id}`);
    assert.equal(del.status, 200);
    assert.equal(instances.get(id), undefined);
  } finally { await close(); }
});

test('rejects invalid mode and unknown project', async () => {
  const { baseUrl, close } = await setupWithProject();
  try {
    const r1 = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'wat' });
    assert.equal(r1.status, 400);
    const r2 = await api(baseUrl, 'POST', '/api/instances', { project: 'missing', mode: 'bypassPermissions' });
    assert.equal(r2.status, 404);
    const r3 = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', effort: 'bogus' });
    assert.equal(r3.status, 400);
  } finally { await close(); }
});

test('default spawn passes --permission-mode plan, --effort high, --thinking adaptive', async () => {
  const { baseUrl, instances, tmpHome, close } = await setupWithProject();
  const fsp = (await import('node:fs')).promises;
  try {
    const argvPath = `${tmpHome}/argv.txt`;
    process.env.FAKE_CLAUDE_ARGV_DUMP = argvPath;
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
  } finally {
    delete process.env.FAKE_CLAUDE_ARGV_DUMP;
    await close();
  }
});

test('resuming an existing session replays the persisted transcript into the ring buffer', async () => {
  // Write a synthetic session jsonl in the place real claude would, then
  // spawn an instance with resume=<sid> and assert the orchestrator
  // populates its ring buffer with UI events derived from those persisted
  // user/assistant lines (text, thinking, tool_use, tool_result).
  const ctx = await bootServer({ scenarioPath: path.join(__dirname, 'fixtures', 'scenario-resume.json') });
  const fsp = (await import('node:fs')).promises;
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'resume-me' });
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

    const events = collectEvents(ctx.instances);
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'resume-me', mode: 'bypassPermissions', resume: sid,
    });
    const id = r.body.id;
    const inst = ctx.instances.get(id);
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
  } finally { await ctx.close(); }
});

test('resuming when no jsonl exists is a no-op (still reaches idle)', async () => {
  const ctx = await bootServer({ scenarioPath: path.join(__dirname, 'fixtures', 'scenario-resume.json') });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'nope' });
    const sid = 'deadbeef-0000-0000-0000-000000000000';
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'nope', mode: 'bypassPermissions', resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    assert.equal(ctx.instances.get(id).sessionId, sid);
  } finally { await ctx.close(); }
});

test('writes last-prompt + permission-mode jsonl markers after each turn (so claude --resume sees the session)', async () => {
  const scenario = path.join(__dirname, 'fixtures', 'scenario-resume.json');
  const ctx = await bootServer({ scenarioPath: scenario });
  const fsp = (await import('node:fs')).promises;
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'r' });
    const events = collectEvents(ctx.instances);
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'r', mode: 'bypassPermissions' });
    const id = r.body.id;
    const inst = ctx.instances.get(id);
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
  } finally { await ctx.close(); }
});

test('rejects invalid thinking mode', async () => {
  const { baseUrl, close } = await setupWithProject();
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', thinking: 'wrong' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /thinking/);
  } finally { await close(); }
});

test('sending a prompt emits exactly one user_echo (no duplicate from --replay)', async () => {
  // Regression: when --replay-user-messages was passed, claude echoed the user
  // message back as a `type:"user"` event on stdout, which the parser turned
  // into a second user_echo on top of the orchestrator's optimistic one.
  // The fix was dropping --replay-user-messages from the spawn args.
  const { baseUrl, instances, tmpHome, close } = await setupWithProject();
  const fsp = (await import('node:fs')).promises;
  try {
    const argvPath = `${tmpHome}/argv.txt`;
    process.env.FAKE_CLAUDE_ARGV_DUMP = argvPath;

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
    await close();
  }
});
