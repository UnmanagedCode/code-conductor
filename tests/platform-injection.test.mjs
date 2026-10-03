// Proves each chokepoint routes through the injected Platform, using a
// recording fake that wraps posix. Some tests make the fake REWRITE its result
// so the assertion fails if a call site ignored it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import { posixPlatform } from '../src/platform/posix.ts';
import { samePath } from '../src/platform/index.ts';
import { runGroupedCommand, killProcessGroup } from '../src/groupedCommand.ts';
import { LocalSystem } from '../src/systems/localSystem.ts';
import { createSupervisor, headSha } from '../src/plugins/supervisor.ts';
import { RealClaudeLauncher, resolveClaudeBin, resolveBackendLaunch } from '../src/claudeLauncher.ts';
import { fetchOriginBounded } from '../src/gitLive.ts';
import { addBackend, addCustomModel } from '../src/appSettings.ts';
import { cliEnvBase } from '../src/cliEnv.ts';
import { projectsRoot } from '../src/projects.ts';
import { checkClaudeReadiness } from '../src/health.ts';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';

function fakePlatform(overrides = {}) {
  const calls = [];
  const rec = (name) => (...a) => { calls.push([name, ...a]); return posixPlatform[name](...a); };
  const p = {
    calls,
    capabilities: posixPlatform.capabilities,
    softSigterm: true, cliEnv: () => ({}), canonicalPath: (p) => p,
    commandFor: rec('commandFor'), spawnOptions: rec('spawnOptions'), killProcess: rec('killProcess'),
    killGroup: rec('killGroup'), splitCommand: rec('splitCommand'), pathKey: rec('pathKey'),
  };
  for (const [k, v] of Object.entries(overrides)) p[k] = (...a) => { calls.push([k, ...a]); return v(...a); };
  return p;
}
const names = (p) => p.calls.map(c => c[0]);

test('runGroupedCommand runs the platform command and asks for group options', async () => {
  const fake = fakePlatform({ commandFor: () => ({ command: 'echo', args: ['routed'] }) });
  const r = await runGroupedCommand({ shell: 'echo original' }, { cwd: os.tmpdir() }, fake);
  assert.equal(r.stdout.trim(), 'routed');
  assert.ok(fake.calls.some(c => c[0] === 'spawnOptions' && c[1] === 'group'));
});

test('LocalSystem.exec routes through its platform', async () => {
  const fake = fakePlatform({ commandFor: () => ({ command: 'echo', args: ['routed'] }) });
  const r = await new LocalSystem(fake).exec({ shell: 'echo original' }, { cwd: os.tmpdir() });
  assert.equal(r.stdout.trim(), 'routed');
});

test('killProcessGroup signals via platform.killGroup, then falls back when it throws', async () => {
  const fake = fakePlatform({ killGroup: () => { throw new Error('no group'); } });
  const fb = [];
  killProcessGroup(4242, { graceMs: 5, fallback: (s) => fb.push(s), platform: fake });
  await waitFor(() => fb.length === 2);
  assert.deepEqual(fake.calls.filter(c => c[0] === 'killGroup').map(c => c[2]), ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(fb, ['SIGTERM', 'SIGKILL']);
});

test('createSupervisor spawns the platform command with daemon options and stops via killGroup', () => {
  const fake = fakePlatform({
    commandFor: () => ({ command: 'rewritten', args: ['x'] }),
    spawnOptions: () => ({ detached: true, windowsHide: true }),
    killGroup: () => {},
  });
  let seen;
  const _spawn = (cmd, args, opts) => {
    seen = { cmd, args, opts };
    const p = new EventEmitter(); p.pid = 99999; p.stdout = new PassThrough(); p.stderr = new PassThrough();
    return p;
  };
  const sup = createSupervisor({ platform: fake, _spawn, _allocatePort: async () => 1, _settleMs: 0, _readyTimeoutMs: 1 });
  sup.start({ id: 'p', manifest: { backend: { start: 'node s.js' } }, cwd: os.tmpdir() }).catch(() => {});
  return waitFor(() => seen).then(() => {
    assert.equal(seen.cmd, 'rewritten');
    assert.deepEqual(seen.args, ['x']);
    assert.equal(seen.opts.windowsHide, true);
    assert.ok(fake.calls.some(c => c[0] === 'spawnOptions' && c[1] === 'daemon'));
    sup.stop({ id: 'p', pgid: 99999 });
    assert.ok(fake.calls.some(c => c[0] === 'killGroup' && c[1] === 99999));
  });
});

test('RealClaudeLauncher consults spawnOptions(child)', async () => {
  const fake = fakePlatform();
  const proc = new RealClaudeLauncher(fake).launch({ command: process.execPath, args: ['-e', ''], cwd: os.tmpdir(), env: process.env });
  await new Promise(r => proc.once('close', r));
  assert.ok(fake.calls.some(c => c[0] === 'spawnOptions' && c[1] === 'child'));
});

test('resolveClaudeBin / resolveBackendLaunch use platform.splitCommand', () => {
  const fake = fakePlatform({ splitCommand: () => ['a b', 'c'] });
  const prev = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = 'ignored';
  try { assert.deepEqual(resolveClaudeBin(fake), { command: 'a b', prefixArgs: ['c'] }); }
  finally { if (prev === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prev; }
  const r = resolveBackendLaunch({ id: 'x', template: 'whatever', env: [] }, 'm', { command: 'claude', prefixArgs: [] }, fake);
  assert.deepEqual([r.command, r.prefixArgs], ['a b', ['c']]);
});

test('samePath uses the platform key', () => {
  const lower = fakePlatform({ pathKey: (p) => p.toLowerCase() });
  assert.equal(samePath('C:/X', 'c:/x', lower), true);
  assert.equal(samePath('C:/X', 'c:/x'), false);
});

test('headSha and fetchOriginBounded consult spawnOptions(child)', async () => {
  const fake = fakePlatform();
  await headSha(os.tmpdir(), fake);
  await fetchOriginBounded(os.tmpdir(), fake);
  assert.equal(fake.calls.filter(c => c[0] === 'spawnOptions' && c[1] === 'child').length, 2);
});

test('Instance.kill escalates through platform.killProcess with the launch handle', async () => {
  const fake = fakePlatform();
  let child;
  const launcher = {
    inProcess: true,
    launch() {
      child = new EventEmitter();
      child.pid = null;
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => {
        child.stdout.end(); child.stderr.end();
        setImmediate(() => child.emit('exit', null, 'SIGTERM'));
        return true;
      };
      return child;
    },
  };
  const ctx = await bootServer({ claudeLauncher: launcher, platform: fake });
  try {
    await freshProjectsRoot();
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inst = ctx.instances.get(r.body.id);
    await waitFor(() => child);
    await inst.kill({ graceMs: 20 });
    assert.ok(fake.calls.some(c => c[0] === 'killProcess' && c[1] === child && c[2] === 'SIGTERM'));
  } finally { await ctx.close(); }
});

test('Instance.spawn splits CLAUDE_BIN and the backend template through the injected platform', async () => {
  const fake = fakePlatform();
  const launcher = {
    inProcess: true,
    launch() {
      const child = new EventEmitter();
      child.pid = null;
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('exit', null, 'SIGTERM')); return true; };
      return child;
    },
  };
  const ctx = await bootServer({ claudeLauncher: launcher, platform: fake });
  try {
    await freshProjectsRoot();
    await addBackend({ id: 'split-probe', label: 'Split probe', template: 'probectl claude --model {model} --', env: [] });
    await addCustomModel({ label: 'Probe', model: 'probe:v1', backend: 'split-probe', contextWindow: 100_000 });
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', model: 'probe:v1', backend: 'split-probe' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await waitFor(() => fake.calls.some(c => c[0] === 'splitCommand' && c[1] === 'probectl claude --model {model} --'));
    assert.ok(fake.calls.some(c => c[0] === 'splitCommand' && c[1] === process.env.CLAUDE_BIN), 'CLAUDE_BIN split via the platform');
  } finally { await ctx.close(); }
});

test('cliEnvBase merges the platform cliEnv under the host env, which wins', () => {
  const fake = fakePlatform({ cliEnv: () => ({ PLATFORM_ONLY: 'p', PLATFORM_AND_HOST: 'platform' }) });
  const prev = process.env.PLATFORM_AND_HOST;
  process.env.PLATFORM_AND_HOST = 'host';
  try {
    const env = cliEnvBase(fake);
    assert.equal(env.PLATFORM_ONLY, 'p');
    assert.equal(env.PLATFORM_AND_HOST, 'host');
  } finally {
    if (prev === undefined) delete process.env.PLATFORM_AND_HOST; else process.env.PLATFORM_AND_HOST = prev;
  }
});

test('projectsRoot goes through the host platform canonicalPath', async () => {
  const { hostPlatform } = await import('../src/platform/index.ts');
  const prevRoot = process.env.PROJECTS_ROOT;
  const orig = hostPlatform.canonicalPath;
  hostPlatform.canonicalPath = (p) => `${p}/CANON`;
  try {
    process.env.PROJECTS_ROOT = '/tmp/cc-canon-probe';
    assert.equal(projectsRoot(), '/tmp/cc-canon-probe/CANON');
  } finally {
    hostPlatform.canonicalPath = orig;
    process.env.PROJECTS_ROOT = prevRoot;
  }
});

test('runGroupedCommand resolves a spawnError when commandFor throws', async () => {
  const fake = fakePlatform({ commandFor: () => { throw new Error('no bash here'); } });
  const r = await runGroupedCommand({ shell: 'x' }, { cwd: os.tmpdir() }, fake);
  assert.equal(r.code, 1);
  assert.match(r.spawnError, /no bash here/);
});

test('checkClaudeReadiness reports an unresolvable host shell', async () => {
  const fake = fakePlatform({ commandFor: () => { throw new Error('bash.exe not found'); } });
  const r = await checkClaudeReadiness({ configDir: os.tmpdir(), timeoutMs: 200, platform: fake });
  const issue = r.issues.find(i => i.code === 'shell_missing');
  assert.ok(issue);
  assert.match(issue.title, /bash\.exe not found/);
});
