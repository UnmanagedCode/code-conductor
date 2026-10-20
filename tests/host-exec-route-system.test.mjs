// POST /api/exec AGAINST A NON-LOCAL SYSTEM (src/hostExec.ts).
//
// The reference provider is registered as a system other than `local`, so every
// call crosses the wire protocol. Where the claim is "this went to the
// provider", the evidence is the recording provider's transcript of the frames
// cc sent; where it is "this target", the reference provider's CC_REMOTE
// routing evidence (src/systems/referenceProvider.ts). The refusals are the
// named codes a plugin branches on — never raw transport text.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { git, seedRepo, referenceLaunch, flakyLaunch } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { adoptProject } from '../src/projects.ts';
import { addSystem, updateSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';

const RECORDING = path.join(import.meta.dirname, 'fixtures', 'recordingProvider.mjs');
const GATED = path.join(import.meta.dirname, 'fixtures', 'gatedProvider.mjs');

describe('POST /api/exec on a provider system', () => {
  let ctx, baseUrl, home, root, record, tree;
  const exec = (body) => api(baseUrl, 'POST', '/api/exec', body);
  const frames = async () => (await fs.readFile(record, 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
  const execFrames = async (cwd) => (await frames()).filter(f => f.type === 'exec' && f.cwd === cwd);

  before(async () => { ctx = await bootServer(); ({ baseUrl } = ctx); });
  after(async () => { await ctx.close(); });

  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    root = await fs.realpath(await mkdtemp('cc-host-exec-sys-'));
    record = path.join(root, 'wire.jsonl');
    await addSystem({ id: 'recbox', label: 'rec', launch: ['node', RECORDING, '--record', record] });
    tree = await seedRepo(path.join(root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: 'recbox' })).ok, true);
  });

  afterEach(async () => {
    await ctx.instances.shutdown();
    disposeSystemHandles();
    await rmrf(root);
    await rmrf(home);
  });

  // PINS: project form on a project placed on a system runs the command THERE —
  // its exec frame crossed the wire with the project's tree as cwd — and the
  // response echoes that system.
  test('project form reaches the provider', async () => {
    const head = (await git(tree, 'rev-parse', 'HEAD')).stdout;
    const r = await exec({ project: 'app', argv: ['git', 'rev-parse', 'HEAD'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.stdout, head);
    assert.equal(r.body.system, 'recbox');
    assert.equal(r.body.remoteId, null);
    assert.equal(r.body.cwd, tree);
    const ex = await execFrames(tree);
    assert.ok(ex.some(f => JSON.stringify(f.argv) === JSON.stringify(['git', 'rev-parse', 'HEAD'])), JSON.stringify(ex));
  });

  // PINS: direct form addresses the system by id and runs in the given cwd on
  // it — over the wire.
  test('direct form reaches the provider', async () => {
    const r = await exec({ system: 'recbox', cwd: tree, argv: ['pwd'] });
    assert.equal(r.status, 200);
    assert.equal(r.body.stdout, `${tree}\n`);
    assert.equal(r.body.system, 'recbox');
    assert.ok((await execFrames(tree)).some(f => JSON.stringify(f.argv) === '["pwd"]'));
  });

  // PINS: stdin, an env overlay and base64 output all survive the wire: NUL
  // paths into update-index on a private index, then a binary blob back.
  test('stdin, env and base64 over the wire', async () => {
    await fs.writeFile(path.join(tree, 'bin'), Buffer.from([0x00, 0xff, 0x0a]));
    const env = { GIT_INDEX_FILE: path.join(root, 'idx') };
    assert.equal((await exec({ project: 'app', argv: ['git', 'read-tree', 'HEAD'], env })).body.exitCode, 0);
    const add = await exec({
      project: 'app', argv: ['git', 'update-index', '--add', '-z', '--stdin'], env,
      stdinB64: Buffer.from('bin\0').toString('base64'),
    });
    assert.equal(add.body.exitCode, 0, add.body.stderr);
    const ls = await exec({ project: 'app', argv: ['git', 'ls-files', '-s', 'bin'], env });
    const blob = ls.body.stdout.split(/\s+/)[1];
    const show = await exec({ project: 'app', argv: ['git', 'cat-file', 'blob', blob], encoding: 'base64' });
    assert.deepEqual(Buffer.from(show.body.stdout, 'base64'), Buffer.from([0x00, 0xff, 0x0a]));
    assert.equal((await git(tree, 'ls-files')).stdout, 'README.md\n', 'the real index is untouched');
    for (const f of await execFrames(tree)) assert.equal('env' in f, false, 'no frame env');
    assert.equal((await frames()).filter(f => f.type === 'writeFile' && /^\/tmp\/cc-stdin-/.test(f.path)).length, 1);
  });

  // PINS: a remoteId routes the command to THAT target (the provider's
  // CC_REMOTE evidence), with an env overlay alongside, and is echoed back.
  test('a remoteId reaches that target', async () => {
    await addSystem({ id: 'multi', label: 'multi', launch: referenceLaunch('--remote', 't1=/', '--remote', 't2=/') });
    const r = await exec({ system: 'multi', remoteId: 't2', cwd: root, shell: 'printf "%s|%s" "$CC_REMOTE" "$CC_O"', env: { CC_O: 'o' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.stdout, 't2|o');
    assert.equal(r.body.remoteId, 't2');
  });

  // PINS: the resolution refusals keep their codes: a row with no provider,
  // a remoteId on a provider without named targets, an unknown remote.
  test('SYSTEM_NO_PROVIDER, SYSTEM_NO_REMOTES and REMOTE_NOT_FOUND', async () => {
    await addSystem({ id: 'bare', label: 'bare' });
    await addSystem({ id: 'multi', label: 'multi', launch: referenceLaunch('--remote', 't1=/') });
    const cases = [
      [{ system: 'bare', cwd: '/', argv: ['true'] }, 501, 'SYSTEM_NO_PROVIDER'],
      [{ system: 'recbox', remoteId: 'x', cwd: '/', argv: ['true'] }, 501, 'SYSTEM_NO_REMOTES'],
      [{ system: 'multi', remoteId: 'nope', cwd: '/', argv: ['true'] }, 502, 'REMOTE_NOT_FOUND'],
    ];
    for (const [body, status, code] of cases) {
      const r = await exec(body);
      assert.equal(r.status, status, JSON.stringify(r.body));
      assert.equal(r.body.code, code);
    }
  });

  // PINS: a system that cannot be reached is 502 SYSTEM_UNREACHABLE on both
  // target forms.
  test('an unreachable system is 502 SYSTEM_UNREACHABLE on both forms', async () => {
    const gate = path.join(root, 'gate');
    await addSystem({ id: 'gated', label: 'gated', launch: ['node', GATED, '--gate', gate] });
    const gtree = await seedRepo(path.join(root, 'gapp'));
    assert.equal((await adoptProject('gapp', gtree, { system: 'gated' })).ok, true);
    await fs.writeFile(gate, '');
    disposeSystemHandles();
    for (const body of [{ system: 'gated', cwd: gtree, argv: ['true'] }, { project: 'gapp', argv: ['true'] }]) {
      const r = await exec(body);
      assert.equal(r.status, 502, JSON.stringify(r.body));
      assert.equal(r.body.code, 'SYSTEM_UNREACHABLE');
    }
  });

  // PINS: a provider that dies DURING the command is 502 SYSTEM_UNREACHABLE —
  // a named refusal, not the raw transport error as the code.
  test('a provider dying mid-exec is 502 SYSTEM_UNREACHABLE', async () => {
    await updateSystem('recbox', { launch: flakyLaunch({ dieOn: 'cc-die-here' }) });
    const r = await exec({ system: 'recbox', cwd: tree, argv: ['sh', '-c', 'sleep 5 # cc-die-here'] });
    assert.equal(r.status, 502, JSON.stringify(r.body));
    assert.equal(r.body.code, 'SYSTEM_UNREACHABLE');
    assert.match(r.body.error, /^exec on system 'recbox': the system could not be reached/);
  });

  // PINS: a timeout over the wire is 504 EXEC_TIMEOUT with the partial output.
  test('a timeout over the wire is 504 EXEC_TIMEOUT', async () => {
    const r = await exec({ system: 'recbox', cwd: tree, timeoutMs: 200, argv: ['sh', '-c', 'echo started; exec sleep 30'] });
    assert.equal(r.status, 504, JSON.stringify(r.body));
    assert.equal(r.body.code, 'EXEC_TIMEOUT');
    assert.equal(r.body.stdout, 'started\n');
  });
});
