// The `permission-mode` marker in the CLI's own session jsonl vs. the live
// permission mode handed to the subprocess. These are DIFFERENT questions and
// the whole defect was conflating them:
//
//   live wire   — cliPermissionMode (instances.ts): `ask` -> `bypassPermissions`,
//                 because the CLI must stop prompting so the orchestrator's
//                 PreToolUse hook can prompt instead. Load-bearing.
//   durable record — markerPermissionMode (sessionModes.ts): `ask` -> `default`,
//                 the CLI mode that prompts. The CLI reads this record back
//                 (it both writes and reads `type:"permission-mode"`), so
//                 recording `bypassPermissions` told an interactive
//                 `claude --resume` that a gated session had run hot.
//
// Every test here asserts BOTH halves on the same instance, so a "fix" that
// changes cliPermissionMode instead fails rather than passes.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { encodeCwd } from '../src/projects.ts';
import { markerPermissionMode, MODES } from '../src/sessionModes.ts';
import { writeSessionMetadata } from '../src/transcript.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');
const SCENARIO_RESUME = path.join(__dirname, 'fixtures', 'scenario-resume.json');

let ctx, baseUrl, instances, home;

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
  await rmrf(home);
});

// The marker records appended to a session's jsonl, newest last.
async function markerLines(inst) {
  const file = path.join(ctx.claudeProjectsRoot, encodeCwd(inst.cwd), `${inst.sessionId}.jsonl`);
  await waitFor(async () => {
    try { return (await fs.readFile(file, 'utf8')).includes('"type":"permission-mode"'); }
    catch { return false; }
  });
  return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(o => o && o.type === 'permission-mode');
}

async function spawnAndRunTurn(mode) {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_RESUME;
  await api(baseUrl, 'POST', '/api/projects', { name: 'r' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'r', mode });
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  inst.prompt('hi');
  await waitFor(() => inst.status === 'idle' && !!inst.sessionId);
  return { inst, restore: () => { process.env.FAKE_CLAUDE_SCENARIO = prev; } };
}

// A resumable two-turn transcript. Fork and prune both need real turn
// structure on disk, which the fake CLI's own session has none of until it
// takes turns.
const SEEDED_LINES = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
  { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [
    { type: 'text', text: 'first reply' },
  ] } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
  { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [
    { type: 'text', text: 'second reply' },
  ] } },
];

// Seed that transcript and bring an instance up on it in `mode`.
async function resumeSeeded(project, sid, mode) {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_RESUME;
  await api(baseUrl, 'POST', '/api/projects', { name: project });
  const dir = path.join(ctx.claudeProjectsRoot, encodeCwd(path.join(ctx.projectsRoot, project)));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${sid}.jsonl`),
    SEEDED_LINES.map(l => JSON.stringify(l)).join('\n') + '\n');
  const r = await api(baseUrl, 'POST', '/api/instances', { project, mode, resume: sid });
  const id = r.body.id;
  await waitFor(() => instances.get(id).status === 'idle');
  return { id, dir, restore: () => { process.env.FAKE_CLAUDE_SCENARIO = prev; } };
}

// The permission-mode markers in an arbitrary session file, in file order.
async function markersIn(dir, sid) {
  return (await fs.readFile(path.join(dir, `${sid}.jsonl`), 'utf8'))
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(o => o && o.type === 'permission-mode');
}

// Pins the defect: the record must not claim a gated session ran hot, while
// the live subprocess must still be launched ungated so the hook can gate it.
test('an `ask` session records `default` while the CLI is still launched bypassPermissions', async () => {
  const { inst, restore } = await spawnAndRunTurn('ask');
  try {
    const markers = await markerLines(inst);
    assert.ok(markers.length > 0, 'a permission-mode marker was written');
    for (const m of markers) {
      assert.equal(m.permissionMode, 'default',
        'orchestrator `ask` must be recorded as the CLI mode that PROMPTS');
      assert.notEqual(m.permissionMode, 'bypassPermissions',
        'recording bypassPermissions would tell `claude --resume` a gated session ran hot');
    }

    // Same instance, live wire: the collapse must still be in place.
    const argv = inst._spawnArgv;
    const i = argv.indexOf('--permission-mode');
    assert.ok(i >= 0, '--permission-mode is on the launch argv');
    assert.equal(argv[i + 1], 'bypassPermissions',
      'the CLI must still run ungated so the PreToolUse hook does the asking');
  } finally { restore(); }
});

// Pins that the mapping does not over-reach: only `ask` differs between the
// two paths, so a mapping that touched anything else fails here.
for (const mode of ['plan', 'bypassPermissions']) {
  test(`a \`${mode}\` session records and launches as \`${mode}\``, async () => {
    const { inst, restore } = await spawnAndRunTurn(mode);
    try {
      for (const m of await markerLines(inst)) assert.equal(m.permissionMode, mode);
      const argv = inst._spawnArgv;
      assert.equal(argv[argv.indexOf('--permission-mode') + 1], mode);
    } finally { restore(); }
  });
}

// The other two call sites the lossless-marker change touched. Both pass an
// instance's own mode down to writeSessionMetadata, and every other fork/prune
// test in the suite drives `bypassPermissions` — which maps to ITSELF, so an
// identity mapping cannot tell `inst.mode` apart from a hardcoded live-wire
// value. Driving `ask` through them is what makes the difference observable:
// if either site regressed, the CLI marker on the resulting transcript would
// claim a gated session ran hot — 2026-0101's defect, relocated.

// Pins the REST fork call site (routes.ts).
test('forking an `ask` session records `default` in the fork transcript', async () => {
  const { id, dir, restore } = await resumeSeeded('forkask', 'aaaaaaa1-2222-3333-4444-555555555555', 'ask');
  try {
    const r = await api(baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: 1 });
    assert.equal(r.status, 201);
    const markers = await markersIn(dir, r.body.newSessionId);
    assert.ok(markers.length > 0, 'the fork carries a permission-mode marker');
    assert.equal(markers[0].permissionMode, 'default',
      'the fork of a gated session is itself gated, and must be recorded that way');
    assert.ok(!markers.some(m => m.permissionMode === 'bypassPermissions'),
      'no marker on the fork may claim it ran hot');
  } finally { restore(); }
});

// Pins the rewind call site (Instance.rewindToUserMessage, instances.ts) — the
// third site of the same shape. Not on the review's list, but hardcoding it
// passes the whole suite too, and rewind rewrites the session IN PLACE, so a
// regression there mislabels the session the user is still sitting in.
test('rewinding an `ask` session records `default` in the truncated transcript', async () => {
  const sid = 'aaaaaaa3-2222-3333-4444-555555555555';
  const { id, dir, restore } = await resumeSeeded('rewindask', sid, 'ask');
  try {
    const r = await api(baseUrl, 'POST', `/api/instances/${id}/rewind`, { userMessageIndex: 1 });
    assert.equal(r.status, 200);
    await waitFor(() => instances.get(id).status === 'idle');
    const markers = await markersIn(dir, sid);
    assert.ok(markers.length > 0, 'the truncated session carries a permission-mode marker');
    assert.equal(markers[0].permissionMode, 'default');
    assert.ok(!markers.some(m => m.permissionMode === 'bypassPermissions'),
      'no marker may claim the still-gated session ran hot');
  } finally { restore(); }
});

// Pins the prune call site (Instance.pruneSession, instances.ts).
test('pruning an `ask` session records `default` in the pruned transcript', async () => {
  const { id, dir, restore } = await resumeSeeded('pruneask', 'aaaaaaa2-2222-3333-4444-555555555555', 'ask');
  try {
    const r = await api(baseUrl, 'POST', `/api/instances/${id}/prune`, {
      cutTurnIndex: 1, pruneThinking: true, inputMode: 'truncate',
    });
    assert.equal(r.status, 200);
    const markers = await markersIn(dir, r.body.newSessionId);
    assert.ok(markers.length > 0, 'the pruned copy carries a permission-mode marker');
    assert.equal(markers[0].permissionMode, 'default',
      'a prune preserves the mode, so the record must preserve it losslessly too');
    assert.ok(!markers.some(m => m.permissionMode === 'bypassPermissions'),
      'no marker on the pruned copy may claim it ran hot');
  } finally { restore(); }
});

// Pins that setMode's live control request keeps the collapse — the second
// cliPermissionMode call site, which the marker change must not touch.
test('setMode("ask") sends bypassPermissions on the wire and records default', async () => {
  const { inst, restore } = await spawnAndRunTurn('bypassPermissions');
  try {
    const sent = [];
    const realWrite = inst.proc.stdin.write.bind(inst.proc.stdin);
    inst.proc.stdin.write = (chunk, ...rest) => { sent.push(String(chunk)); return realWrite(chunk, ...rest); };

    await inst.setMode('ask');

    const req = sent.join('').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .find(o => o?.request?.subtype === 'set_permission_mode');
    assert.ok(req, 'a set_permission_mode control request was sent');
    assert.equal(req.request.mode, 'bypassPermissions',
      'the live wire keeps the ask -> bypassPermissions collapse');

    const markers = await markerLines(inst);
    assert.equal(markers.at(-1).permissionMode, 'default',
      'the record written by the same setMode call is the lossless one');
  } finally { restore(); }
});

// What each orchestrator mode must be RECORDED as, written out rather than
// derived from the implementation's `ask ? 'default' : mode` rule — a
// derived expectation is satisfied by whatever the code does, so a fourth mode
// would record itself raw and still pass.
const EXPECTED_RECORDING = { plan: 'plan', ask: 'default', bypassPermissions: 'bypassPermissions' };

// Pins the mapping at the unit level, and pins it as TOTAL: the exhaustiveness
// check is what makes a mode added to the vocabulary without a decision about
// how it is recorded fail here, on the missing entry.
test('markerPermissionMode is total over MODES, mapping only ask', () => {
  assert.deepEqual([...MODES].sort(), Object.keys(EXPECTED_RECORDING).sort(),
    'a new mode needs an explicit decision here about how it is RECORDED');
  for (const mode of MODES) {
    assert.equal(markerPermissionMode(mode), EXPECTED_RECORDING[mode], `mode ${mode}`);
  }
  assert.equal(markerPermissionMode('ask'), 'default', 'the one mode that must differ');
});

// Pins the runtime floor. A value outside MODES must FAIL rather than write a
// marker with its `permissionMode` field silently absent — an omitted value is
// the same defect class as a wrong one, and both are invisible at write time.
test('markerPermissionMode refuses a value outside the vocabulary', () => {
  for (const bad of [undefined, null, '', 'default', 'acceptEdits', 'nonsense']) {
    assert.throws(() => markerPermissionMode(bad), /unknown orchestrator mode/,
      `must refuse ${JSON.stringify(bad)}`);
  }
});

// Pins that the mapping lives INSIDE writeSessionMetadata, so the rewind /
// fork / prune call sites cannot record a live-wire value even if they wanted
// to — they pass an orchestrator mode and get the record's vocabulary.
test('writeSessionMetadata maps the orchestrator mode itself', async () => {
  const prev = process.env.CLAUDE_PROJECTS_ROOT;
  const root = path.join(home, 'claude-projects-marker');
  process.env.CLAUDE_PROJECTS_ROOT = root;
  try {
    const cwd = path.join(home, 'proj');
    for (const mode of MODES) {
      const sid = `aaaaaaaa-bbbb-4ccc-8ddd-${mode.slice(0, 12).padEnd(12, '0')}`;
      await writeSessionMetadata({ cwd, sessionId: sid, leafUuid: 'leaf-1', mode });
      const text = await fs.readFile(path.join(root, encodeCwd(cwd), `${sid}.jsonl`), 'utf8');
      const marker = text.split('\n').filter(Boolean).map(l => JSON.parse(l))
        .find(o => o.type === 'permission-mode');
      // Literal, not markerPermissionMode(mode): asserting against the
      // implementation would make this pass for whatever the mapping does.
      assert.equal(marker.permissionMode, EXPECTED_RECORDING[mode], `mode ${mode}`);
      assert.ok('permissionMode' in marker, 'the marker must carry a value, not omit the field');
    }
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
    else process.env.CLAUDE_PROJECTS_ROOT = prev;
  }
});
