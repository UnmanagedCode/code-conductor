// The relaunch window rewind and prune share with the restart model switch
// (Instance._beginRelaunch → _awaitRelaunchConfirmed → _endRelaunch): from the
// kill until the relaunched CLI is confirmed, an exit neither archives a temp
// session nor drops it from the manager, and a relaunch that is never confirmed
// reaches the caller as an error with nothing left running. Also pins the route
// error handler's logging.
//
// Every session is a temp or persistent NON-conducted REST session, so its
// launch() runs _hydrateAwaitingUser — the status emit that dropped a temp
// session mid-relaunch.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf, seedSessionJsonl } from './helpers.mjs';
import { SwitchLauncher } from './switchLauncher.mjs';
import { isTemp, isArchived, settleSessionWrites } from '../src/sessionStore.ts';
import { localPlace } from '../src/projects.ts';
import { RELAUNCH_FAILED } from '../src/instances.ts';
import { ROUTE_ERROR_LOG_MAX } from '../src/routes.ts';
import { httpError } from '../src/httpError.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-resume-strict.json');

let ctx, baseUrl, instances, launcher, home, projectsRoot;

before(async () => {
  launcher = new SwitchLauncher();
  ctx = await bootServer({ scenarioPath: SCENARIO, claudeLauncher: launcher });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => {
  ({ home, projectsRoot } = await freshProjectsRoot());
  launcher.plan = [];
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
});
afterEach(async () => { await instances.shutdown(); await settleSessionWrites(); await rmrf(home); });

const HEAD = [
  { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-03T00:00:00.000Z', content: 'queued' },
  { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-10-03T00:00:00.010Z' },
];
const prompt = (uuid, text) => ({ type: 'user', uuid, message: { role: 'user', content: text } });
const reply = (uuid, blocks, stop) => ({ type: 'assistant', uuid, message: { id: `m-${uuid}`, role: 'assistant', content: blocks, stop_reason: stop } });
const text = (t) => ({ type: 'text', text: t });
const askTool = (id) => ({ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question: 'q' }] } });

// Two finished turns; rewinding to p2 leaves a resumable p1 turn.
const TWO_TURNS = [...HEAD, prompt('u1', 'p1'), reply('a1', [text('one')], 'end_turn'), prompt('u2', 'p2'), reply('a2', [text('done')], 'end_turn')];

let n = 0;
const newSid = () => `ee11ff22-0000-4000-8000-${String(++n).padStart(12, '0')}`;

// Seed `records` and resume them as a REST (non-conducted) session.
async function resumeSeeded(records, { temp = false } = {}) {
  const sid = newSid();
  await seedSessionJsonl(localPlace(path.join(projectsRoot, 'p')), sid, records);
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', resume: sid, ...(temp ? { temp: true } : {}) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle' && inst.proc);
  assert.equal(inst.conducted, false, 'a non-conducted session, so launch() hydrates awaitingUser');
  assert.equal(inst.temp, temp);
  inst._relaunchGraceMs = 50;
  return { inst, sid };
}

// Records, at every manager list change, whether `inst` is still the
// registered instance for its id.
function watchRegistration(inst) {
  const seen = [];
  const onList = () => seen.push(instances.get(inst.id) === inst);
  instances.on('list_changed', onList);
  return { seen, stop: () => instances.off('list_changed', onList) };
}

const rewind = (inst, userMessageIndex, t) =>
  api(baseUrl, 'POST', `/api/instances/${inst.id}/rewind`, { userMessageIndex, text: t });

// Collects console[method] lines for the duration of `fn`.
async function capture(method, fn) {
  const lines = [];
  const orig = console[method];
  console[method] = (...args) => { lines.push(args.map(a => (typeof a === 'string' ? a : String(a?.message ?? a))).join(' ')); };
  try { await fn(); } finally { console[method] = orig; }
  return lines;
}

test('a temp rewind whose awaiting-user state flips stays registered across the relaunch', async () => {
  // Live state null (the newest turn answered); the rewound transcript ends on
  // an AskUserQuestion, so the relaunch's hydrate flips it and emits status.
  const { inst, sid } = await resumeSeeded([
    ...HEAD, prompt('u1', 'p1'), reply('a1', [askTool('tq')], 'tool_use'),
    prompt('u2', 'p2'), reply('a2', [text('done')], 'end_turn'),
  ], { temp: true });
  assert.equal(inst.summary().awaitingUser, null, 'live state before the rewind');
  const watch = watchRegistration(inst);
  const launches = launcher.count;
  try {
    const rew = await rewind(inst, 1, 'p2');
    assert.equal(rew.status, 200, JSON.stringify(rew.body));
    await waitFor(() => inst.status === 'idle');
  } finally { watch.stop(); }
  assert.ok(watch.seen.every(Boolean), `never dropped from the manager: ${JSON.stringify(watch.seen)}`);
  assert.equal(instances.get(inst.id), inst, 'still the registered instance');
  assert.ok(inst.proc, 'the relaunched CLI is up');
  assert.equal(launcher.count, launches + 1, 'exactly one relaunch');
  assert.equal(inst.summary().awaitingUser, 'question', 'the hydrate did flip the state');
  assert.equal(await isTemp(sid), true);
  assert.equal(await isArchived(sid), false);
});

test('a temp prune whose awaiting-user state flips stays registered across the relaunch', async () => {
  const { inst, sid } = await resumeSeeded([
    ...HEAD, prompt('u1', 'p1'), reply('a1', [text('one')], 'end_turn'),
    prompt('u2', 'p2'), reply('a2', [askTool('tq')], 'tool_use'),
  ], { temp: true });
  // Disk says "question"; make the live state differ so the relaunch flips it.
  inst._setAwaitingUser(null);
  const watch = watchRegistration(inst);
  const launches = launcher.count;
  try {
    const pr = await api(baseUrl, 'POST', `/api/instances/${inst.id}/prune`, { cutTurnIndex: 1 });
    assert.equal(pr.status, 200, JSON.stringify(pr.body));
    await waitFor(() => inst.status === 'idle');
  } finally { watch.stop(); }
  assert.ok(watch.seen.every(Boolean), `never dropped from the manager: ${JSON.stringify(watch.seen)}`);
  assert.equal(instances.get(inst.id), inst, 'still the registered instance');
  assert.ok(inst.proc, 'the relaunched CLI is up');
  assert.equal(launcher.count, launches + 1, 'exactly one relaunch');
  assert.equal(inst.summary().awaitingUser, 'question', 'the hydrate did flip the state');
  assert.equal(await isTemp(inst.backingSessionId), true);
  assert.equal(await isArchived(inst.backingSessionId), false);
  assert.notEqual(inst.backingSessionId, sid, 'running on the pruned copy');
});

test('a temp rewind whose relaunch dies at startup errors and drops the session', async () => {
  const { inst, sid } = await resumeSeeded(TWO_TURNS, { temp: true });
  launcher.plan.push({ crash: 'No conversation found with session ID: x' });
  const rew = await rewind(inst, 1, 'p2');
  assert.ok(rew.status >= 400, `non-2xx: ${rew.status}`);
  assert.equal(rew.body.code, RELAUNCH_FAILED);
  assert.match(rew.body.error, /rewound/);
  assert.match(rew.body.error, /No conversation found with session ID: x/);
  assert.equal(instances.get(inst.id), undefined, 'dropped from the manager');
  assert.equal(inst.proc, null, 'nothing left running');
  assert.equal(instances.isSessionLive(sid), false);
  await waitFor(() => isArchived(sid));
});

test('a persistent rewind whose relaunch dies at startup errors and leaves a resumable dead row', async () => {
  const { inst, sid } = await resumeSeeded(TWO_TURNS);
  launcher.plan.push({ crash: 'No conversation found with session ID: x' });
  const rew = await rewind(inst, 1, 'p2');
  assert.ok(rew.status >= 400, `non-2xx: ${rew.status}`);
  assert.equal(rew.body.code, RELAUNCH_FAILED);
  assert.equal(instances.get(inst.id), inst, 'still registered');
  assert.ok(['exited', 'crashed'].includes(inst.status), inst.status);
  assert.equal(inst.proc, null);
  assert.equal(inst.relaunching, false, 'the window is closed');
  assert.equal(instances.isSessionLive(sid), false);
  const rs = await api(baseUrl, 'POST', `/api/instances/${inst.id}/respawn`);
  assert.equal(rs.status, 200, JSON.stringify(rs.body));
  await waitFor(() => inst.status === 'idle' && inst.proc);
});

test('a rewind whose relaunch never comes up idle is killed', async () => {
  const { inst } = await resumeSeeded(TWO_TURNS);
  inst._relaunchIdleDeadlineMs = 150;
  launcher.plan.push({ deaf: true });
  const rew = await rewind(inst, 1, 'p2');
  assert.ok(rew.status >= 400, `non-2xx: ${rew.status}`);
  assert.equal(rew.body.code, RELAUNCH_FAILED);
  assert.match(rew.body.error, /did not come up idle/);
  assert.equal(inst.proc, null, 'the hung child was killed');
  assert.equal(launcher.ctl.last._exited, true, 'and has exited');
});

test('a temp rewind whose relaunch fails to spawn errors and drops the session', async () => {
  const { inst, sid } = await resumeSeeded(TWO_TURNS, { temp: true });
  launcher.plan.push({ failSpawn: 'boom' });
  const rew = await rewind(inst, 1, 'p2');
  assert.ok(rew.status >= 400, `non-2xx: ${rew.status}`);
  assert.match(rew.body.error, /boom/);
  assert.equal(instances.get(inst.id), undefined, 'dropped from the manager');
  assert.equal(inst.proc, null);
  await waitFor(() => isArchived(sid));
});

test('a prune whose relaunch dies falls back to the original session', async () => {
  const { inst, sid } = await resumeSeeded(TWO_TURNS, { temp: true });
  launcher.plan.push({ crash: 'boom at startup' });
  const launches = launcher.count;
  const pr = await api(baseUrl, 'POST', `/api/instances/${inst.id}/prune`, { cutTurnIndex: 1 });
  assert.ok(pr.status >= 400, `non-2xx: ${pr.status}`);
  assert.match(pr.body.error, /boom at startup/);
  assert.equal(instances.get(inst.id), inst, 'still registered');
  await waitFor(() => inst.status === 'idle');
  assert.ok(inst.proc);
  assert.equal(inst.backingSessionId, sid, 'running on the unpruned original');
  assert.equal(launcher.count, launches + 2, 'the attempt and the fail-safe');
  assert.equal(await isTemp(sid), true);
  assert.equal(await isArchived(sid), false);
});

test('a prune whose relaunch and fail-safe both die errors and drops the temp session', async () => {
  const { inst, sid } = await resumeSeeded(TWO_TURNS, { temp: true });
  launcher.plan.push({ crash: 'boom at startup' }, { crash: 'boom again' });
  const pr = await api(baseUrl, 'POST', `/api/instances/${inst.id}/prune`, { cutTurnIndex: 1 });
  assert.ok(pr.status >= 400, `non-2xx: ${pr.status}`);
  assert.match(pr.body.error, /boom at startup/);
  assert.equal(instances.get(inst.id), undefined, 'dropped from the manager');
  assert.equal(inst.proc, null);
  await waitFor(() => isArchived(sid));
});

test('a failing rewind is logged by the route error handler', async () => {
  const { inst } = await resumeSeeded(TWO_TURNS);
  launcher.plan.push({ crash: 'No conversation found with session ID: x' });
  let rew;
  const lines = await capture('error', async () => { rew = await rewind(inst, 1, 'p2'); });
  assert.equal(rew.status, 500);
  const logged = lines.filter(l => l.startsWith('routes:'));
  assert.equal(logged.length, 1, JSON.stringify(lines));
  assert.match(logged[0], /POST/);
  assert.match(logged[0], /\/rewind/);
  assert.match(logged[0], /500/);
});

test('a 4xx route error is logged as a warning', async () => {
  let res;
  const lines = await capture('warn', async () => {
    res = await api(baseUrl, 'POST', '/api/instances/nope/rewind', { userMessageIndex: 0, text: 'x' });
  });
  assert.equal(res.status, 404);
  const logged = lines.filter(l => l.startsWith('routes:'));
  assert.equal(logged.length, 1, JSON.stringify(lines));
  assert.match(logged[0], /POST \/api\/instances\/nope\/rewind/);
  assert.match(logged[0], /404/);
});

test('a route error with a multi-MB message logs at most ROUTE_ERROR_LOG_MAX, 5xx and 4xx alike', async (t) => {
  const huge = 'x'.repeat(3_000_000);
  const rows = [
    ['5xx', 'error', 500, () => new Error(huge)],
    ['4xx', 'warn', 409, () => httpError(409, huge)],
  ];
  for (const [name, method, status, make] of rows) {
    // The file's beforeEach/afterEach hooks run around each subtest too.
    await t.test(name, async () => {
      const { inst } = await resumeSeeded(TWO_TURNS);
      inst.rewindToUserMessage = async () => { throw make(); };
      let res;
      const lines = await capture(method, async () => { res = await rewind(inst, 0, 'x'); });
      assert.equal(res.status, status);
      const logged = lines.filter(l => l.startsWith('routes:'));
      assert.equal(logged.length, 1, `one entry, got ${lines.length} console.${method} calls`);
      assert.ok(lines.join('').length <= ROUTE_ERROR_LOG_MAX, `logged ${lines.join('').length} chars`);
      assert.match(logged[0], new RegExp(`^routes: POST /api/instances/${inst.id}/rewind → ${status}: x+…`));
      if (status >= 500) assert.match(logged[0], /\n\s+at /, 'the 5xx entry keeps its stack frames');
      else assert.doesNotMatch(logged[0], /\n\s+at /, 'a 4xx entry is one line');
    });
  }
});
