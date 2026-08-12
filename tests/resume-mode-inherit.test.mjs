// `spawn_instance({resume})` inherits the mode the session was recorded in.
//
// Before this, every resume came up in bypassPermissions regardless of what the
// session had been doing, so bringing a planning session back silently handed
// it ungated tool use — and the conductor role prompt carried a standing
// "always pass mode when resuming" warning to compensate.
//
// The two properties worth breaking a build over: a recorded cold mode is
// actually honoured (not merely stored), and an explicit `mode` argument still
// beats the record. A test that passes whether or not inheritance happens
// proves nothing, so each one below pins a mode that DIFFERS from the
// unrecorded default — a resume that ignored the record would come up
// bypassPermissions and fail.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { encodeCwd } from '../src/projects.ts';
import { getSessionMode, markSessionMode } from '../src/sessionModes.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_RESUME = path.join(__dirname, 'fixtures', 'scenario-resume.json');

let ctx, baseUrl, instances, home, projectsRoot, claudeProjectsRoot;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO_RESUME }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot, claudeProjectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

// A resumable session on disk: the CLI's own criterion is ≥1 user/assistant
// record, so a marker-only stub would be refused before mode ever mattered.
async function seedSession(project, sid) {
  await api(baseUrl, 'POST', '/api/projects', { name: project });
  const projectPath = path.join(projectsRoot, project);
  const dir = path.join(claudeProjectsRoot, encodeCwd(projectPath));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${sid}.jsonl`), [
    JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', message: { id: 'm_a1', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
  ].join('\n') + '\n');
  return projectPath;
}

async function resume(project, body) {
  const res = await api(baseUrl, 'POST', '/api/instances', { project, ...body });
  assert.equal(res.status, 201, `resume failed: ${JSON.stringify(res.body)}`);
  const inst = instances.get(res.body.id);
  await waitFor(() => inst.status === 'idle');
  return inst;
}

test('a recorded plan session resumes in plan, not bypassPermissions', async () => {
  const sid = '11111111-1111-4111-8111-111111111111';
  await seedSession('inherit-plan', sid);
  await markSessionMode(sid, 'plan');

  const inst = await resume('inherit-plan', { resume: sid });
  assert.equal(inst.mode, 'plan',
    'the recorded mode must govern the resume — bypassPermissions here means the record was ignored');
});

test('a recorded ask session resumes in ask', async () => {
  // `ask` is orchestrator-only: the CLI is told bypassPermissions and the
  // distinction lives in our own gating, so this also proves the value round
  // -trips through our store rather than being read back off the subprocess.
  const sid = '22222222-2222-4222-8222-222222222222';
  await seedSession('inherit-ask', sid);
  await markSessionMode(sid, 'ask');

  const inst = await resume('inherit-ask', { resume: sid });
  assert.equal(inst.mode, 'ask');
});

test('an explicit mode beats the recorded one', async () => {
  // Both directions, because a one-way test passes on an implementation that
  // just ignores one of the two inputs.
  const cold = '33333333-3333-4333-8333-333333333333';
  await seedSession('inherit-explicit', cold);
  await markSessionMode(cold, 'plan');
  const hot = await resume('inherit-explicit', { resume: cold, mode: 'bypassPermissions' });
  assert.equal(hot.mode, 'bypassPermissions', 'an explicit mode must override a recorded plan');

  const hotSid = '44444444-4444-4444-8444-444444444444';
  await seedSession('inherit-explicit', hotSid);
  await markSessionMode(hotSid, 'bypassPermissions');
  const cooled = await resume('inherit-explicit', { resume: hotSid, mode: 'plan' });
  assert.equal(cooled.mode, 'plan', 'an explicit mode must override a recorded bypassPermissions');
});

test('an unrecorded session still resumes bypassPermissions', async () => {
  // No backfill: every pre-existing session is unrecorded and must behave
  // exactly as it did before the store existed.
  const sid = '55555555-5555-4555-8555-555555555555';
  await seedSession('inherit-none', sid);
  assert.equal(await getSessionMode(sid), null, 'fixture must genuinely have no record');

  const inst = await resume('inherit-none', { resume: sid });
  assert.equal(inst.mode, 'bypassPermissions');
});

test('a spawn records its mode, so the next resume can inherit it', async () => {
  // The end-to-end loop: nothing seeds the store by hand here.
  await api(baseUrl, 'POST', '/api/projects', { name: 'record-spawn' });
  const first = await api(baseUrl, 'POST', '/api/instances', { project: 'record-spawn', mode: 'plan' });
  assert.equal(first.status, 201);
  const inst = instances.get(first.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  const sid = inst.backingSessionId;

  await waitFor(async () => (await getSessionMode(sid)) === 'plan');
  assert.equal(await getSessionMode(sid), 'plan', 'a spawn must record the mode it launched in');
});

test('set_mode updates the record, so a resume follows the latest mode', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'record-setmode' });
  const res = await api(baseUrl, 'POST', '/api/instances', { project: 'record-setmode', mode: 'plan' });
  const inst = instances.get(res.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  const sid = inst.backingSessionId;
  await waitFor(async () => (await getSessionMode(sid)) === 'plan');

  await inst.setMode('bypassPermissions');
  await waitFor(async () => (await getSessionMode(sid)) === 'bypassPermissions');
  assert.equal(await getSessionMode(sid), 'bypassPermissions',
    'a mid-session mode change must be what a later resume inherits');
});

test('the CLI-reported mode at system/init is recorded, not just the launched one', async () => {
  // The third write site. The subprocess is authoritative about the mode it
  // actually came up in, and `_doCreate`'s value is only a request — a resumed
  // CLI can report something else. Recording only at spawn would leave the
  // store disagreeing with the live session, so the next resume would inherit
  // a mode the session was never in.
  //
  // This scenario's init hardcodes permissionMode:"plan" while the spawn asks
  // for bypassPermissions, so the two write sites are distinguishable: the
  // spawn-time record says bypassPermissions, and only the init sync corrects
  // it to plan. (The fake CLI holds its startup events until the first stdin
  // line, so the prompt below is what makes init fire at all.)
  const srv = await bootServer({
    scenarioPath: path.join(__dirname, 'fixtures', 'scenario-init-mode-plan.json'),
  });
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'init-sync' });
    const res = await api(srv.baseUrl, 'POST', '/api/instances', {
      project: 'init-sync', mode: 'bypassPermissions',
    });
    assert.equal(res.status, 201);
    const inst = srv.instances.get(res.body.id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    // The spawn-time record is written fire-and-forget, so wait for it.
    await waitFor(async () => (await getSessionMode(inst.backingSessionId)) === 'bypassPermissions');

    inst.prompt('go');
    await waitFor(() => inst.mode === 'plan');
    assert.equal(inst.mode, 'plan', 'the CLI reported plan, so the instance is in plan');

    await waitFor(async () => (await getSessionMode(inst.backingSessionId)) === 'plan');
    assert.equal(await getSessionMode(inst.backingSessionId), 'plan',
      'the record must follow the CLI-reported mode, not the mode we asked for');
  } finally {
    await srv.instances.shutdown();
    await srv.close();
  }
});
