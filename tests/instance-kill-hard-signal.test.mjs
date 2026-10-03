// Instance.kill / the sync shutdown paths on a host without a soft SIGTERM
// (Platform.softSigterm false). The platform is injected, so this runs on Linux
// against the in-process fake CLI.

import { test, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { posixPlatform } from '../src/platform/posix.ts';
import { CLEAN_STOP_GRACE_MS, InstanceManager } from '../src/instances.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-deferred-interrupt.json');

function hardPlatform() {
  const kills = [];
  return { kills, p: { ...posixPlatform, softSigterm: false, killProcess: (t, s) => { kills.push([t, s]); } } };
}

let ctx, home, transcriptPath, hard;
let seq = 0;

before(async () => {
  hard = hardPlatform();
  ctx = await bootServer({ scenarioPath: SCENARIO, platform: hard.p });
});
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
  transcriptPath = path.join(home, `stdin-${++seq}.jsonl`);
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;
  hard.kills.length = 0;
});
afterEach(async () => {
  mock.timers.reset();
  await ctx.instances.shutdown();
  delete process.env.FAKE_CLAUDE_TRANSCRIPT;
  await rmrf(home);
});

async function stdinLines() {
  try {
    return (await fs.readFile(transcriptPath, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}
const interrupts = (lines) => lines.filter(l => l.type === 'control_request' && l.request?.subtype === 'interrupt');

async function busyInstance() {
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
  const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
  const inst = ctx.instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  inst.prompt('open text')?.catch?.(() => {});
  await waitFor(() => inst.status === 'turn');
  return inst;
}

test('killing a busy worker interrupts the turn, then ends stdin, with no signal sent', async () => {
  const inst = await busyInstance();
  await inst.kill({ graceMs: 200 });
  assert.equal(interrupts(await stdinLines()).length, 1);
  assert.deepEqual(hard.kills, [], 'a clean exit never signals');
});

test('the signal ladder is held back until CLEAN_STOP_GRACE_MS even when graceMs is shorter', async () => {
  const inst = await busyInstance();
  // Hold `ended` pending, as a CLI that ignores EOF would, and read the timers.
  let release;
  inst._procEnded = new Promise(r => { release = r; });
  mock.timers.enable({ apis: ['setTimeout'] });
  const killing = inst.kill({ graceMs: 200 });
  mock.timers.tick(CLEAN_STOP_GRACE_MS - 1);
  assert.deepEqual(hard.kills, []);
  mock.timers.tick(1);
  assert.deepEqual(hard.kills.map(k => k[1]), ['SIGTERM']);
  mock.timers.tick(3000);
  assert.deepEqual(hard.kills.map(k => k[1]), ['SIGTERM', 'SIGKILL']);
  mock.timers.reset();
  release();
  await killing;
  await waitFor(() => !inst.proc);
});

test('a soft-SIGTERM host sends no interrupt on kill', async () => {
  const ctx2 = await bootServer({ scenarioPath: SCENARIO });
  try {
    const r0 = await freshProjectsRoot();
    ctx2.projectsRoot = r0.projectsRoot;
    const file = path.join(r0.home, 'stdin-soft.jsonl');
    process.env.FAKE_CLAUDE_TRANSCRIPT = file;
    await api(ctx2.baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const r = await api(ctx2.baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
    const inst = ctx2.instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    inst.prompt('open text')?.catch?.(() => {});
    await waitFor(() => inst.status === 'turn');
    await inst.kill({ graceMs: 200 });
    const lines = (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(interrupts(lines).length, 0);
    await rmrf(r0.home);
  } finally {
    await ctx2.close();
  }
});

test('the interrupted turn_end of a killed worker neither wakes the conductor nor notifies', async () => {
  const instances = new InstanceManager();
  const mk = (id, sessionId) => ({
    id, sessionId, project: 'p', proc: { pid: 1 }, status: 'turn', acceptsMidTurnSteering: true,
    steerPending: false, activeAgentTaskCount: 0, taskNotificationPending: false, rotationPending: false,
    _killing: false, _emitUi() {}, ring: { trimmedBefore: 0 }, ringSnapshot() { return []; },
    async prompt() {}, async interrupt() {},
  });
  const worker = mk('w', 'ws'); const conductor = mk('c', 'cs');
  instances.byId.set('w', worker); instances.byId.set('c', conductor);
  instances.noteDispatch('cs', 'ws');
  instances._idleHub.onTurnStart('w');
  worker._killing = true;
  instances.emit('event', { id: 'w', ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn' } });
  assert.ok(instances._idleHub.subscribers.get('w')?.size, 'the armed wake is still armed');
  assert.equal(instances.shouldSuppressTurnNotification('w'), true);
  worker._killing = false;
  assert.equal(instances.shouldSuppressTurnNotification('w'), instances._idleHub.isCaller('w'));
  instances._idleHub.subscribers.clear();
  await instances.shutdown().catch(() => {});
});

function fakeLive({ ignoresEof, temp = false, pid }) {
  let ended = 0;
  return { proc: { stdin: { end() { ended++; } } }, pid, temp, get ended() { return ended; }, ignoresEof, _suppressTempDelete: false, _fuse: null };
}

test('stopLiveSync and shutdownForResumeSync tree-kill survivors; posix stopLiveSync is a no-op', () => {
  const kills = [];
  const mgr = new InstanceManager({ platform: { ...posixPlatform, softSigterm: false, killProcess: (t, s) => kills.push([t, s]) } });
  mgr._usageMonitor.stop();
  // This process's own pid is "alive" and never exits: a survivor. Use a tiny deadline by mocking Date.
  const stuck = fakeLive({ pid: process.pid });
  const temp = fakeLive({ pid: process.pid, temp: true });
  mgr.byId.set('a', stuck); mgr.byId.set('t', temp);
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => (now += 1000);
  try { mgr.stopLiveSync(); } finally { Date.now = realNow; }
  assert.equal(stuck.ended, 1, 'EOF sent');
  assert.equal(temp.ended, 0, 'temps are shutdownTempSync\'s');
  assert.deepEqual(kills, [[process.pid, 'SIGKILL']]);

  kills.length = 0;
  Date.now = () => (now += 1000);
  try { mgr.shutdownForResumeSync(); } finally { Date.now = realNow; }
  assert.equal(kills.length, 2, 'every instance still alive at the deadline is killed');

  const posixMgr = new InstanceManager({ platform: posixPlatform });
  const s2 = fakeLive({ pid: process.pid });
  posixMgr.byId.set('a', s2);
  posixMgr.stopLiveSync();
  assert.equal(s2.ended, 0);
});
