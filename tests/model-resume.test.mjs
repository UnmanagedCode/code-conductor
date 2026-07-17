// Tests for model recovery across resume. The window is no longer
// persisted — it's a pure function of the family (see canonicalizeModel in
// src/modelVersions.js) — so resume recovers only the bare model id the CLI
// recorded in the session jsonl and re-derives the window from it. No
// `orchestrator-model` marker is written to Claude's jsonl anymore.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';
import { encodeCwd } from '../src/projects.js';
import { readLastSessionModel, writeSessionMetadata } from '../src/transcript.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-resume.json');

// Helper: create a temp dir with a fake CLAUDE_PROJECTS_ROOT and clean up after.
async function withTmpClaudeRoot(fn) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-resume-'));
  const claudeProjects = path.join(tmpDir, '.claude', 'projects');
  const prev = process.env.CLAUDE_PROJECTS_ROOT;
  process.env.CLAUDE_PROJECTS_ROOT = claudeProjects;
  try {
    await fn({ tmpDir, claudeProjects });
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
    else process.env.CLAUDE_PROJECTS_ROOT = prev;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// --- Unit tests: transcript module ---

test('writeSessionMetadata writes only last-prompt + permission-mode (no orchestrator-model)', async () => {
  await withTmpClaudeRoot(async ({ tmpDir, claudeProjects }) => {
    const cwd = path.join(tmpDir, 'proj');
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await writeSessionMetadata({
      cwd, sessionId, leafUuid: 'leaf-1', permissionMode: 'bypassPermissions',
    });
    const sessionDir = path.join(claudeProjects, encodeCwd(cwd));
    const text = await fs.readFile(path.join(sessionDir, `${sessionId}.jsonl`), 'utf8');
    const lines = text.trim().split('\n').map(l => JSON.parse(l));
    const types = lines.map(l => l.type).sort();
    assert.deepEqual(types, ['last-prompt', 'permission-mode']);
    assert.ok(!lines.some(l => l.type === 'orchestrator-model'),
      'the orchestrator no longer writes a custom marker into Claude\'s jsonl');
  });
});

test('readLastSessionModel returns the bare assistant message model', async () => {
  await withTmpClaudeRoot(async ({ tmpDir, claudeProjects }) => {
    const cwd = path.join(tmpDir, 'proj');
    const sessionId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const sessionDir = path.join(claudeProjects, encodeCwd(cwd));
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6' } }) + '\n',
    );
    const result = await readLastSessionModel({ cwd, sessionId });
    assert.equal(result, 'claude-sonnet-4-6');
  });
});

test('readLastSessionModel returns null when no assistant line is present', async () => {
  await withTmpClaudeRoot(async ({ tmpDir }) => {
    const cwd = path.join(tmpDir, 'proj');
    const sessionId = 'cccccccc-dddd-eeee-ffff-000000000000';
    await writeSessionMetadata({
      cwd, sessionId, leafUuid: 'leaf-2', permissionMode: 'bypassPermissions',
    });
    const result = await readLastSessionModel({ cwd, sessionId });
    assert.equal(result, null);
  });
});

test('readLastSessionModel skips <synthetic> entries and returns the preceding real model', async () => {
  await withTmpClaudeRoot(async ({ tmpDir, claudeProjects }) => {
    const cwd = path.join(tmpDir, 'proj');
    const sessionId = 'dddddddd-eeee-ffff-0000-111111111111';
    const sessionDir = path.join(claudeProjects, encodeCwd(cwd));
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6' } }),
        JSON.stringify({ type: 'assistant', message: { model: '<synthetic>' } }),
      ].join('\n') + '\n',
    );
    const result = await readLastSessionModel({ cwd, sessionId });
    assert.equal(result, 'claude-sonnet-4-6');
  });
});

test('readLastSessionModel returns null when all assistant lines are <synthetic>', async () => {
  await withTmpClaudeRoot(async ({ tmpDir, claudeProjects }) => {
    const cwd = path.join(tmpDir, 'proj');
    const sessionId = 'eeeeeeee-ffff-0000-1111-222222222222';
    const sessionDir = path.join(claudeProjects, encodeCwd(cwd));
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { model: '<synthetic>' } }) + '\n',
    );
    const result = await readLastSessionModel({ cwd, sessionId });
    assert.equal(result, null);
  });
});

// --- Integration test: full server path ---

test('resume recovers the bare model and re-derives the window (Sonnet → [1m]), no marker, no disable flag', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  const argvDumpFile = path.join(os.tmpdir(), `model-resume-argv-${process.pid}.txt`);
  const envDumpFile = path.join(os.tmpdir(), `model-resume-env-${process.pid}.txt`);
  const prevArgvDump = process.env.FAKE_CLAUDE_ARGV_DUMP;
  const prevEnvDump = process.env.FAKE_CLAUDE_ENV_DUMP;

  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });

    // Spawn with a Sonnet family model — canonicalised to [1m] at spawn.
    const r1 = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo',
      mode: 'bypassPermissions',
      model: 'claude-sonnet-4-6',
    });
    assert.equal(r1.status, 201);
    const id1 = r1.body.id;
    await waitFor(() => ctx.instances.get(id1).status === 'idle');

    const inst1 = ctx.instances.get(id1);
    const sessionId = inst1.sessionId;
    assert.equal(inst1.model, 'claude-sonnet-4-6[1m]', 'spawn canonicalises Sonnet to [1m]');

    // Run a turn so _writeSessionMetadata appends last-prompt/permission-mode.
    inst1.prompt('hello');
    await waitFor(() => ctx.instances.get(id1).status === 'idle');

    const projectPath = path.join(ctx.projectsRoot, 'demo');
    const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(projectPath));
    const jsonlPath = path.join(sessionDir, `${sessionId}.jsonl`);

    // The CLI records a BARE model id in its assistant lines; fake-claude
    // doesn't write the jsonl, so seed that line to mirror the real CLI.
    await fs.appendFile(jsonlPath,
      JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6' } }) + '\n');

    // No orchestrator-model marker should ever have been written.
    const jsonlLines = (await fs.readFile(jsonlPath, 'utf8')).trim().split('\n')
      .filter(Boolean).map(l => JSON.parse(l));
    assert.ok(!jsonlLines.some(l => l.type === 'orchestrator-model'),
      'no orchestrator-model marker is written to the session jsonl');

    // Kill the first instance (create() refuses to resume a live session).
    await api(ctx.baseUrl, 'DELETE', `/api/instances/${id1}`);

    // Resume with no explicit model — must recover bare then canonicalise.
    process.env.FAKE_CLAUDE_ARGV_DUMP = argvDumpFile;
    process.env.FAKE_CLAUDE_ENV_DUMP = envDumpFile;
    const r2 = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo',
      mode: 'bypassPermissions',
      resume: sessionId,
    });
    assert.equal(r2.status, 201);
    const id2 = r2.body.id;
    await waitFor(() => ctx.instances.get(id2).status === 'idle');

    assert.equal(ctx.instances.get(id2).model, 'claude-sonnet-4-6[1m]',
      'resumed instance re-derives the 1M window from the recovered family');

    // The resumed subprocess must launch with the canonical [1m] model and
    // must NOT carry the (now-removed) disable flag.
    await waitFor(async () => { try { await fs.stat(argvDumpFile); return true; } catch { return false; } });
    const argv = (await fs.readFile(argvDumpFile, 'utf8')).split('\n').filter(Boolean);
    const mi = argv.indexOf('--model');
    assert.ok(mi >= 0 && argv[mi + 1] === 'claude-sonnet-4-6[1m]',
      'resumed subprocess is launched with --model claude-sonnet-4-6[1m]');

    const envDump = await fs.readFile(envDumpFile, 'utf8');
    assert.ok(!envDump.split('\n').some(l => l.startsWith('CLAUDE_CODE_DISABLE_1M_CONTEXT=')),
      'CLAUDE_CODE_DISABLE_1M_CONTEXT must never be set');
  } finally {
    if (prevArgvDump === undefined) delete process.env.FAKE_CLAUDE_ARGV_DUMP;
    else process.env.FAKE_CLAUDE_ARGV_DUMP = prevArgvDump;
    if (prevEnvDump === undefined) delete process.env.FAKE_CLAUDE_ENV_DUMP;
    else process.env.FAKE_CLAUDE_ENV_DUMP = prevEnvDump;
    try { await fs.rm(argvDumpFile, { force: true }); } catch { /* best-effort */ }
    try { await fs.rm(envDumpFile, { force: true }); } catch { /* best-effort */ }
    await ctx.close();
  }
});

// --- Live mid-session model switch (system/init reporting a different model
// than the one the instance was spawned/last known with) ---

const SWITCH_SCENARIO = path.join(__dirname, 'fixtures', 'scenario-model-switch.json');

test('mid-session system/init model flip emits model_changed once, updates inst.model, and persists across respawn', async () => {
  const ctx = await bootServer({ scenarioPath: SWITCH_SCENARIO });
  const argvDumpFile = path.join(os.tmpdir(), `model-switch-argv-${process.pid}.txt`);
  const prevArgvDump = process.env.FAKE_CLAUDE_ARGV_DUMP;

  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });

    const r1 = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo',
      mode: 'bypassPermissions',
      model: 'claude-sonnet-4-6',
    });
    assert.equal(r1.status, 201);
    const id = r1.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const inst = ctx.instances.get(id);
    assert.equal(inst.model, 'claude-sonnet-4-6[1m]', 'spawn canonicalises Sonnet to [1m]');

    const modelChangedEvents = [];
    inst.on('event', (ev) => {
      if (ev.kind === 'system' && ev.subtype === 'model_changed') modelChangedEvents.push(ev);
    });

    // Turn 1: fixture's init reports the same model the instance was spawned
    // with (bare 'claude-sonnet-4-6' canonicalises back to the same [1m] id)
    // — no switch, no event.
    inst.prompt('turn one');
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    assert.equal(modelChangedEvents.length, 0, 'no model_changed when init repeats the current model');
    assert.equal(ctx.instances.get(id).model, 'claude-sonnet-4-6[1m]');

    // Turn 2: fixture's init reports a different model — the CLI switched
    // interactively mid-session. Exactly one model_changed must fire, and
    // inst.model (the field respawn/resume-manifest/fork all read) must
    // update to the new model.
    inst.prompt('turn two');
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    assert.equal(modelChangedEvents.length, 1, 'exactly one model_changed for the actual switch');
    assert.deepEqual(modelChangedEvents[0].data, { from: 'claude-sonnet-4-6[1m]', to: 'claude-opus-4-8' });
    assert.equal(ctx.instances.get(id).model, 'claude-opus-4-8', 'inst.model tracks the live switch');

    // Kill the subprocess (simulating a crash) without removing the Instance
    // from InstanceManager.byId, then respawn — the primary bug path this
    // fix targets: respawn() reads inst.model directly with no transcript
    // re-read, so it must now launch with the SWITCHED model, not the
    // original spawn-time one.
    inst.proc.kill('SIGKILL');
    await waitFor(() => !ctx.instances.get(id).proc);

    process.env.FAKE_CLAUDE_ARGV_DUMP = argvDumpFile;
    await ctx.instances.respawn(id);
    await waitFor(async () => { try { await fs.stat(argvDumpFile); return true; } catch { return false; } });
    const argv = (await fs.readFile(argvDumpFile, 'utf8')).split('\n').filter(Boolean);
    const mi = argv.indexOf('--model');
    assert.ok(mi >= 0 && argv[mi + 1] === 'claude-opus-4-8',
      'respawn launches with the switched model, not the stale spawn-time one');
  } finally {
    if (prevArgvDump === undefined) delete process.env.FAKE_CLAUDE_ARGV_DUMP;
    else process.env.FAKE_CLAUDE_ARGV_DUMP = prevArgvDump;
    try { await fs.rm(argvDumpFile, { force: true }); } catch { /* best-effort */ }
    await ctx.close();
  }
});

test('system/init repeating the current model does not re-emit model_changed', async () => {
  const ctx = await bootServer({ scenarioPath: SWITCH_SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });

    const r1 = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo',
      mode: 'bypassPermissions',
      model: 'claude-sonnet-4-6',
    });
    assert.equal(r1.status, 201);
    const id = r1.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const inst = ctx.instances.get(id);
    const modelChangedEvents = [];
    inst.on('event', (ev) => {
      if (ev.kind === 'system' && ev.subtype === 'model_changed') modelChangedEvents.push(ev);
    });

    inst.prompt('turn one'); // sonnet, matches spawn — no event
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    inst.prompt('turn two'); // opus — the switch, one event
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    assert.equal(modelChangedEvents.length, 1);

    inst.prompt('turn three'); // opus again — repeats the now-current model
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    assert.equal(modelChangedEvents.length, 1, 'no additional model_changed for a repeated model');
  } finally {
    await ctx.close();
  }
});

// --- Ollama: the inner CLI reports its model bare, dropping the `:tag`
// suffix `ollama launch claude --model <tag>` was given. That bare report
// must not look like a model switch (see _trackModel in src/instances.js).

const OLLAMA_BARE_MODEL_SCENARIO = path.join(__dirname, 'fixtures', 'scenario-ollama-bare-model.json');

test('ollama CLI reporting the bare (tag-stripped) model does not emit model_changed and keeps the tagged model across respawn', async () => {
  const ctx = await bootServer({ scenarioPath: OLLAMA_BARE_MODEL_SCENARIO });
  const argvDumpFile = path.join(os.tmpdir(), `model-resume-ollama-argv-${process.pid}.txt`);
  const prevArgvDump = process.env.FAKE_CLAUDE_ARGV_DUMP;

  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });

    const r1 = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo',
      mode: 'bypassPermissions',
      model: 'qwen2.5-coder:32b',
      backendKind: 'ollama',
    });
    assert.equal(r1.status, 201);
    const id = r1.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const inst = ctx.instances.get(id);
    assert.equal(inst.model, 'qwen2.5-coder:32b', 'spawn-time model keeps the tag');

    const modelChangedEvents = [];
    inst.on('event', (ev) => {
      if (ev.kind === 'system' && ev.subtype === 'model_changed') modelChangedEvents.push(ev);
    });

    // The startup system/init already reports the bare model (fixture's
    // top-level `events`) — must not have registered as a switch.
    assert.equal(modelChangedEvents.length, 0, 'no model_changed from the startup init bare report');
    assert.equal(inst.model, 'qwen2.5-coder:32b', 'tag survives the startup init bare report');

    // A turn's message_start repeats the same bare report — still a no-op.
    inst.prompt('hello');
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    assert.equal(modelChangedEvents.length, 0, 'no model_changed from a mid-turn bare report');
    assert.equal(inst.model, 'qwen2.5-coder:32b', 'tag survives a mid-turn bare report');

    // Kill the subprocess and respawn — the primary bug path: respawn() reads
    // inst.model directly and requires the tag to build `ollama launch
    // --model <tag>`. If _trackModel had overwritten this.model with the
    // bare id, this respawn would throw ("ollama-backed spawn requires a
    // model (tag)").
    inst.proc.kill('SIGKILL');
    await waitFor(() => !ctx.instances.get(id).proc);

    process.env.FAKE_CLAUDE_ARGV_DUMP = argvDumpFile;
    await ctx.instances.respawn(id);
    await waitFor(async () => { try { await fs.stat(argvDumpFile); return true; } catch { return false; } });
    const argv = (await fs.readFile(argvDumpFile, 'utf8')).split('\n').filter(Boolean);
    assert.deepEqual(argv.slice(0, 4), ['launch', 'claude', '--model', 'qwen2.5-coder:32b'],
      'respawn launches ollama with the still-tagged model');
  } finally {
    if (prevArgvDump === undefined) delete process.env.FAKE_CLAUDE_ARGV_DUMP;
    else process.env.FAKE_CLAUDE_ARGV_DUMP = prevArgvDump;
    try { await fs.rm(argvDumpFile, { force: true }); } catch { /* best-effort */ }
    await ctx.close();
  }
});
