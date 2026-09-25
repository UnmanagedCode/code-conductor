// The `permission-mode` marker in the CLI's own session jsonl and the live
// permission mode handed to the subprocess (`--permission-mode` at spawn,
// `set_permission_mode` on a runtime switch) carry the same value: the
// instance's own `inst.mode`. Every call site that writes a marker — spawn,
// setMode, fork, rewind, prune — must pass the session's mode rather than a
// hard-coded one, and writeSessionMetadata refuses a value outside MODES.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { encodeCwd, localPlace} from '../src/projects.ts';
import { MODES } from '../src/sessionModes.ts';
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
  const file = path.join(ctx.claudeProjectsRoot, encodeCwd(inst.cwd), `${inst.backingSessionId}.jsonl`);
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

// Pins that the marker and the launch argv are both the session's own mode,
// for every mode in the vocabulary. The MODES check makes a mode added
// without a decision here fail on the sorted list.
test('MODES is exactly plan and bypassPermissions', () => {
  assert.deepEqual([...MODES].sort(), ['bypassPermissions', 'plan']);
});

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

// The fork, rewind and prune call sites each pass an instance's own mode down
// to writeSessionMetadata. Every other fork/prune test in the suite drives
// `bypassPermissions`, which is also DEFAULT_RESUME_MODE, so a hard-coded
// value there is indistinguishable from `inst.mode`. Driving `plan` through
// them makes the difference observable.

// Pins the REST fork call site (routes.ts).
test('forking a `plan` session records `plan` in the fork transcript', async () => {
  const { id, dir, restore } = await resumeSeeded('forkplan', 'aaaaaaa1-2222-3333-4444-555555555555', 'plan');
  try {
    const r = await api(baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: 1 });
    assert.equal(r.status, 201);
    const markers = await markersIn(dir, r.body.newSessionId);
    assert.ok(markers.length > 0, 'the fork carries a permission-mode marker');
    assert.equal(markers[0].permissionMode, 'plan');
    assert.ok(!markers.some(m => m.permissionMode === 'bypassPermissions'),
      'no marker on the fork of a plan session may say bypassPermissions');
  } finally { restore(); }
});

// Pins the rewind call site (Instance.rewindToUserMessage, instances.ts).
// Rewind rewrites the session in place, so a wrong marker mislabels the
// session the user is still sitting in.
test('rewinding a `plan` session records `plan` in the truncated transcript', async () => {
  const sid = 'aaaaaaa3-2222-3333-4444-555555555555';
  const { id, dir, restore } = await resumeSeeded('rewindplan', sid, 'plan');
  try {
    const r = await api(baseUrl, 'POST', `/api/instances/${id}/rewind`, { userMessageIndex: 1 });
    assert.equal(r.status, 200);
    await waitFor(() => instances.get(id).status === 'idle');
    const markers = await markersIn(dir, sid);
    assert.ok(markers.length > 0, 'the truncated session carries a permission-mode marker');
    assert.equal(markers[0].permissionMode, 'plan');
    assert.ok(!markers.some(m => m.permissionMode === 'bypassPermissions'),
      'no marker on a rewound plan session may say bypassPermissions');
  } finally { restore(); }
});

// Pins the prune call site (Instance.pruneSession, instances.ts).
test('pruning a `plan` session records `plan` in the pruned transcript', async () => {
  const { id, dir, restore } = await resumeSeeded('pruneplan', 'aaaaaaa2-2222-3333-4444-555555555555', 'plan');
  try {
    const r = await api(baseUrl, 'POST', `/api/instances/${id}/prune`, {
      cutTurnIndex: 1, pruneThinking: true, inputMode: 'truncate',
    });
    assert.equal(r.status, 200);
    const markers = await markersIn(dir, r.body.newSessionId);
    assert.ok(markers.length > 0, 'the pruned copy carries a permission-mode marker');
    assert.equal(markers[0].permissionMode, 'plan');
    assert.ok(!markers.some(m => m.permissionMode === 'bypassPermissions'),
      'no marker on the pruned copy of a plan session may say bypassPermissions');
  } finally { restore(); }
});

// Pins that setMode's live control request and the marker it writes share one
// value: the mode switched to.
test("setMode('plan') sends plan on the wire and records plan", async () => {
  const { inst, restore } = await spawnAndRunTurn('bypassPermissions');
  try {
    const sent = [];
    const realWrite = inst.proc.stdin.write.bind(inst.proc.stdin);
    inst.proc.stdin.write = (chunk, ...rest) => { sent.push(String(chunk)); return realWrite(chunk, ...rest); };

    await inst.setMode('plan');

    const req = sent.join('').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .find(o => o?.request?.subtype === 'set_permission_mode');
    assert.ok(req, 'a set_permission_mode control request was sent');
    assert.equal(req.request.mode, 'plan');

    await waitFor(async () => (await markerLines(inst)).at(-1).permissionMode === 'plan');
    assert.equal((await markerLines(inst)).at(-1).permissionMode, 'plan',
      'the record written by the same setMode call carries the same value');
  } finally { restore(); }
});

// Pins the runtime floor. A value outside MODES must FAIL rather than write a
// marker — an omitted or unknown value is invisible at write time.
test('writeSessionMetadata refuses a value outside the vocabulary and writes no marker', async () => {
  const prev = process.env.CLAUDE_PROJECTS_ROOT;
  const root = path.join(home, 'claude-projects-refuse');
  process.env.CLAUDE_PROJECTS_ROOT = root;
  try {
    const cwd = path.join(home, 'proj');
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000bad';
    for (const bad of [undefined, null, '', 'ask', 'default', 'acceptEdits', 'nonsense']) {
      await assert.rejects(
        writeSessionMetadata({ place: localPlace(cwd), sessionId: sid, leafUuid: 'leaf-1', mode: bad }),
        /writeSessionMetadata: unknown mode/,
        `must refuse ${JSON.stringify(bad)}`);
    }
    await assert.rejects(fs.access(path.join(root, encodeCwd(cwd), `${sid}.jsonl`)),
      { code: 'ENOENT' }, 'no marker file is written for a refused mode');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
    else process.env.CLAUDE_PROJECTS_ROOT = prev;
  }
});

// Pins that writeSessionMetadata writes each mode as itself.
test('writeSessionMetadata records the mode it is given', async () => {
  const prev = process.env.CLAUDE_PROJECTS_ROOT;
  const root = path.join(home, 'claude-projects-marker');
  process.env.CLAUDE_PROJECTS_ROOT = root;
  try {
    const cwd = path.join(home, 'proj');
    for (const mode of MODES) {
      const sid = `aaaaaaaa-bbbb-4ccc-8ddd-${mode.slice(0, 12).padEnd(12, '0')}`;
      await writeSessionMetadata({ place: localPlace(cwd), sessionId: sid, leafUuid: 'leaf-1', mode });
      const text = await fs.readFile(path.join(root, encodeCwd(cwd), `${sid}.jsonl`), 'utf8');
      const marker = text.split('\n').filter(Boolean).map(l => JSON.parse(l))
        .find(o => o.type === 'permission-mode');
      assert.equal(marker.permissionMode, mode, `mode ${mode}`);
      assert.ok('permissionMode' in marker, 'the marker must carry a value, not omit the field');
    }
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
    else process.env.CLAUDE_PROJECTS_ROOT = prev;
  }
});
