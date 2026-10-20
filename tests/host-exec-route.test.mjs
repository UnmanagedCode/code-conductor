// POST /api/exec ON cc's OWN MACHINE (src/hostExec.ts, mounted in src/routes.ts).
//
// The contract a plugin backend relies on: a command addressed by project
// (+ worktree) or by system + cwd runs THERE, with the caller's env overlay and
// stdin, and its output comes back whole — base64 when asked, byte-exact. A
// nonzero exit is still a 200; every other outcome is a refusal with a stable
// code. Under `gate:systems` the `local` system here is a ProviderSystem, so the
// same assertions also run the wire path.
//
// The git shapes are the ones the code-review plugin issues: a private index
// via GIT_INDEX_FILE, NUL-separated paths into `update-index -z --stdin`, and
// an empty stdin into `hash-object -t tree --stdin`.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, api, freshProjectsRoot, rmrf, registerLocalProject, waitFor } from './helpers.mjs';
import { git, seedRepo, referenceLaunch } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { createWorktree } from '../src/worktrees.ts';
import { adoptProject } from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { posixPlatform } from '../src/platform/posix.ts';
import { EXEC_MAX_OUTPUT_BYTES, EXEC_MAX_TIMEOUT_MS } from '../src/hostExec.ts';

const RECORDING = path.join(import.meta.dirname, 'fixtures', 'recordingProvider.mjs');
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('POST /api/exec on the local system', () => {
  let ctx, baseUrl, home, repo, scratch;
  const exec = (body) => api(baseUrl, 'POST', '/api/exec', body);

  before(async () => { ctx = await bootServer(); ({ baseUrl } = ctx); });
  after(async () => { await ctx.close(); });

  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    repo = await fs.realpath(await seedRepo(path.join(process.env.PROJECTS_ROOT, 'demo')));
    await registerLocalProject('demo', repo);
    scratch = await fs.realpath(await mkdtemp('cc-host-exec-'));
  });

  afterEach(async () => {
    await ctx.instances.shutdown();
    disposeSystemHandles();
    await rmrf(scratch);
    await rmrf(home);
  });

  // PINS: project form runs argv in the project's tree and returns its whole
  // output with the resolved place echoed; `local` has no remoteId.
  test('project form: argv runs in the project tree', async () => {
    const head = (await git(repo, 'rev-parse', 'HEAD')).stdout;
    const r = await exec({ project: 'demo', argv: ['git', 'rev-parse', 'HEAD'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.exitCode, 0);
    assert.equal(r.body.stdout, head);
    assert.equal(r.body.stderr, '');
    assert.equal(r.body.encoding, 'utf8');
    assert.equal(r.body.system, 'local');
    assert.equal(r.body.remoteId, null);
    assert.equal(r.body.cwd, repo);
    assert.equal(typeof r.body.durationMs, 'number');
  });

  // PINS: shell form runs through a shell; a NONZERO exit is a 200 carrying
  // the exit code and both streams kept apart.
  test('shell form: a nonzero exit is 200 with exitCode and both streams', async () => {
    const r = await exec({ project: 'demo', shell: 'echo out; echo err >&2; exit 3' });
    assert.equal(r.status, 200);
    assert.equal(r.body.exitCode, 3);
    assert.equal(r.body.stdout, 'out\n');
    assert.equal(r.body.stderr, 'err\n');
  });

  // PINS: the env overlay reaches git — a private GIT_INDEX_FILE is written
  // and read through it, and the repository's own index is untouched.
  test('env overlay: GIT_INDEX_FILE points git at a private index', async () => {
    const realIndex = await fs.readFile(path.join(repo, '.git', 'index'));
    const idx = path.join(scratch, 'private-index');
    const env = { GIT_INDEX_FILE: idx, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
    const read = await exec({ project: 'demo', argv: ['git', 'read-tree', 'HEAD'], env });
    assert.equal(read.status, 200);
    assert.equal(read.body.exitCode, 0, read.body.stderr);
    await fs.stat(idx);
    const ls = await exec({ project: 'demo', argv: ['git', 'ls-files'], env });
    assert.equal(ls.body.stdout, 'README.md\n');
    assert.deepEqual(await fs.readFile(path.join(repo, '.git', 'index')), realIndex);
  });

  // PINS: stdinB64 delivers NUL-separated bytes to the command's stdin intact —
  // `update-index --add -z --stdin` adds exactly the named paths, to the
  // private index only.
  test('stdinB64: NUL-separated paths into update-index -z --stdin', async () => {
    await fs.writeFile(path.join(repo, 'a b.txt'), 'a\n');
    await fs.writeFile(path.join(repo, 'c.txt'), 'c\n');
    const env = { GIT_INDEX_FILE: path.join(scratch, 'idx') };
    assert.equal((await exec({ project: 'demo', argv: ['git', 'read-tree', 'HEAD'], env })).body.exitCode, 0);
    const add = await exec({
      project: 'demo', argv: ['git', 'update-index', '--add', '-z', '--stdin'], env,
      stdinB64: Buffer.from('a b.txt\0c.txt\0').toString('base64'),
    });
    assert.equal(add.status, 200);
    assert.equal(add.body.exitCode, 0, add.body.stderr);
    const ls = await exec({ project: 'demo', argv: ['git', 'ls-files'], env });
    assert.equal(ls.body.stdout, 'README.md\na b.txt\nc.txt\n');
    assert.equal((await git(repo, 'ls-files')).stdout, 'README.md\n', 'the real index is untouched');
  });

  // PINS: `stdin: ''` is an empty stdin that reaches EOF — hash-object of an
  // empty tree answers the well-known empty-tree id instead of hanging.
  test('stdin "": an empty input into hash-object -t tree --stdin', async () => {
    const r = await exec({ project: 'demo', argv: ['git', 'hash-object', '-t', 'tree', '--stdin'], stdin: '', timeoutMs: 10_000 });
    assert.equal(r.status, 200);
    assert.equal(r.body.stdout, `${EMPTY_TREE}\n`);
  });

  // PINS: text stdin arrives as UTF-8.
  test('stdin text arrives as UTF-8', async () => {
    const r = await exec({ project: 'demo', argv: ['cat'], stdin: 'héllo\n' });
    assert.equal(r.body.stdout, 'héllo\n');
  });

  // PINS: encoding base64 returns the command's stdout byte-exact — a blob
  // holding NUL and 0xff decodes to the committed bytes.
  test('encoding base64: git show of a binary blob decodes to the committed bytes', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0x0a, 0xc3, 0x28, 0x00]);
    await fs.writeFile(path.join(repo, 'bin'), bytes);
    await git(repo, 'add', 'bin');
    await git(repo, 'commit', '-q', '-m', 'bin');
    const r = await exec({ project: 'demo', argv: ['git', 'show', 'HEAD:bin'], encoding: 'base64' });
    assert.equal(r.status, 200);
    assert.equal(r.body.encoding, 'base64');
    assert.deepEqual(Buffer.from(r.body.stdout, 'base64'), bytes);
    assert.equal(r.body.stderr, '');
  });

  // PINS: worktree form runs in the WORKTREE's path, not the project's.
  test('worktree form runs in the worktree path', async () => {
    const wt = await createWorktree('demo', { name: 'feature' });
    const r = await exec({ project: 'demo', worktree: wt.worktreeName, argv: ['pwd'] });
    assert.equal(r.status, 200);
    assert.equal(r.body.stdout.trim(), await fs.realpath(wt.worktreePath));
    assert.equal(r.body.cwd, wt.worktreePath);
  });

  // PINS: direct form with system 'local' runs in the given absolute cwd.
  test('direct form: system local + cwd', async () => {
    const r = await exec({ system: 'local', cwd: scratch, argv: ['pwd'] });
    assert.equal(r.status, 200);
    assert.equal(r.body.stdout, `${scratch}\n`);
    assert.equal(r.body.system, 'local');
    assert.equal(r.body.remoteId, null);
    assert.equal(r.body.cwd, scratch);
  });

  // PINS: the route's own body limit sits ahead of the router-wide 1mb parser,
  // so a stdin larger than 1mb is accepted and delivered whole.
  test('a 2mb stdin is accepted past the router-wide 1mb limit', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    const r = await exec({ project: 'demo', argv: ['wc', '-c'], stdin: big });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.equal(r.body.stdout.trim(), String(big.length));
  });

  // PINS: every request-shape violation is a 400 INVALID_ARGUMENT, refused
  // before anything runs.
  test('shape violations are 400 INVALID_ARGUMENT', async () => {
    const bad = [
      [],
      {},
      { argv: ['true'] },
      { project: 'demo', system: 'local', cwd: '/', argv: ['true'] },
      { project: 'demo', argv: ['true'], shell: 'true' },
      { project: 'demo' },
      { project: 'demo', argv: ['true'], input: 'typo for stdin' },
      { system: 'local', remoteId: 't', cwd: '/', argv: ['true'] },
      { system: 'local', argv: ['true'] },
      { project: 'demo', argv: [] },
      { project: 'demo', argv: [1] },
      { project: 'demo', argv: [''] },
      { project: 'demo', argv: ['echo', 'a\0b'] },
      { project: 'demo', shell: '  ' },
      { project: 'demo', argv: ['true'], env: { 'BAD-NAME': 'x' } },
      { project: 'demo', argv: ['true'], env: { OK: 1 } },
      { project: 'demo', argv: ['true'], env: { OK: 'a\0b' } },
      { project: 'demo', argv: ['true'], env: ['A=b'] },
      { project: 'demo', argv: ['true'], stdin: 'a', stdinB64: 'YQ==' },
      { project: 'demo', argv: ['true'], stdinB64: 'abc' },
      { project: 'demo', argv: ['true'], stdin: 5 },
      { project: 'demo', argv: ['true'], timeoutMs: 0 },
      { project: 'demo', argv: ['true'], timeoutMs: 1.5 },
      { project: 'demo', argv: ['true'], timeoutMs: EXEC_MAX_TIMEOUT_MS + 1 },
      { project: 'demo', argv: ['true'], maxOutputBytes: 0 },
      { project: 'demo', argv: ['true'], maxOutputBytes: EXEC_MAX_OUTPUT_BYTES + 1 },
      { project: 'demo', argv: ['true'], encoding: 'hex' },
      { project: 'demo', worktree: '', argv: ['true'] },
    ];
    for (const body of bad) {
      const r = await exec(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.code, 'INVALID_ARGUMENT', JSON.stringify(body));
    }
  });

  // PINS: the named addressing refusals carry their codes — a relative cwd,
  // an unknown project, an unknown worktree, an unregistered system.
  test('addressing refusals: CWD_NOT_ABSOLUTE, PROJECT_UNKNOWN, WORKTREE_UNKNOWN, SYSTEM_NOT_REGISTERED', async () => {
    const cases = [
      [{ system: 'local', cwd: 'relative/dir', argv: ['true'] }, 400, 'CWD_NOT_ABSOLUTE'],
      [{ project: 'no-such-project', argv: ['true'] }, 404, 'PROJECT_UNKNOWN'],
      [{ project: 'demo', worktree: 'no-such-wt', argv: ['true'] }, 404, 'WORKTREE_UNKNOWN'],
      [{ system: 'ghost', cwd: '/', argv: ['true'] }, 501, 'SYSTEM_NOT_REGISTERED'],
    ];
    for (const [body, status, code] of cases) {
      const r = await exec(body);
      assert.equal(r.status, status, JSON.stringify(r.body));
      assert.equal(r.body.code, code);
      assert.equal(typeof r.body.error, 'string');
    }
  });

  // PINS: a command that never started is 422 EXEC_SPAWN_FAILED with its
  // errno — with and without stdin/env, so the wrapped path agrees.
  test('a missing binary is 422 EXEC_SPAWN_FAILED with errno ENOENT', async () => {
    for (const extra of [{}, { stdin: 'x' }, { env: { A: 'b' } }]) {
      const r = await exec({ project: 'demo', argv: ['cc-definitely-not-a-binary'], ...extra });
      assert.equal(r.status, 422, JSON.stringify(extra));
      assert.equal(r.body.code, 'EXEC_SPAWN_FAILED');
      assert.equal(r.body.errno, 'ENOENT');
    }
  });

  // PINS: output past maxOutputBytes is a 422 EXEC_OUTPUT_TOO_LARGE naming the
  // limit — a failure, never clipped output in a 200.
  test('output over maxOutputBytes is 422 EXEC_OUTPUT_TOO_LARGE', async () => {
    const r = await exec({ project: 'demo', argv: ['head', '-c', '4096', '/dev/zero'], maxOutputBytes: 1024 });
    assert.equal(r.status, 422);
    assert.equal(r.body.code, 'EXEC_OUTPUT_TOO_LARGE');
    assert.equal(r.body.limitBytes, 1024);
    assert.equal('stdout' in r.body, false);
  });

  // PINS: a command past timeoutMs is 504 EXEC_TIMEOUT carrying the partial
  // output, and its process GROUP is killed — the backgrounded grandchild dies
  // too, unless the system says it may have survived.
  test('a timeout is 504 EXEC_TIMEOUT with partial output, and the group is killed', async () => {
    const pidfile = path.join(scratch, 'pid');
    const r = await exec({
      system: 'local', cwd: scratch, timeoutMs: 200,
      argv: ['sh', '-c', `echo started; sleep 30 & echo $! > ${pidfile}; wait`],
    });
    assert.equal(r.status, 504, JSON.stringify(r.body));
    assert.equal(r.body.code, 'EXEC_TIMEOUT');
    assert.equal(r.body.stdout, 'started\n');
    assert.equal(r.body.encoding, 'utf8');
    const pid = Number(await fs.readFile(pidfile, 'utf8'));
    if (r.body.descendantsMaySurvive) {
      // A provider without processGroupSignal reached only the direct child,
      // and said so — the flag is the contract there.
      process.kill(pid, 'SIGKILL');
    } else {
      await waitFor(() => !alive(pid), { timeout: 5_000 });
    }
  });

  // PINS: a timeout in base64 mode carries the partial output base64-encoded.
  test('a timeout in base64 mode carries base64 partial output', async () => {
    const r = await exec({ system: 'local', cwd: scratch, timeoutMs: 200, encoding: 'base64', argv: ['sh', '-c', 'printf "\\377"; exec sleep 30'] });
    assert.equal(r.status, 504);
    assert.equal(r.body.encoding, 'base64');
    assert.deepEqual(Buffer.from(r.body.stdout, 'base64'), Buffer.from([0xff]));
  });

  // PINS: a client that disconnects mid-command KILLS the command.
  test('aborting the request kills the command', async () => {
    const pidfile = path.join(scratch, 'pid');
    const ac = new AbortController();
    const pending = fetch(`${baseUrl}/api/exec`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ac.signal,
      body: JSON.stringify({ system: 'local', cwd: scratch, argv: ['sh', '-c', `echo $$ > ${pidfile}; exec sleep 30`] }),
    }).catch(e => e);
    const pid = await waitFor(async () => Number(await fs.readFile(pidfile, 'utf8')) || false, { timeout: 5_000 });
    // `exec sleep` replaces the shell, so the pid is the sleep — wait for that.
    await waitFor(async () => (await fs.readFile(`/proc/${pid}/comm`, 'utf8')).trim() === 'sleep', { timeout: 5_000 });
    ac.abort();
    assert.equal((await pending).name, 'AbortError');
    await waitFor(() => !alive(pid), { timeout: 5_000 });
  });
});

describe('POST /api/exec with remoteSystems off', () => {
  let ctx, baseUrl, home, scratch;
  const exec = (body) => api(baseUrl, 'POST', '/api/exec', body);

  before(async () => {
    ctx = await bootServer({ platform: { ...posixPlatform, capabilities: { remoteSystems: false, fuseUnion: false, voice: false } } });
    ({ baseUrl } = ctx);
  });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    scratch = await fs.realpath(await mkdtemp('cc-host-exec-off-'));
  });
  afterEach(async () => { disposeSystemHandles(); await rmrf(scratch); await rmrf(home); });

  // PINS: a non-local system is refused 501 SYSTEMS_UNAVAILABLE BEFORE it is
  // resolved — no provider process is launched (the recording provider writes
  // nothing) — while `local` still runs.
  test('direct form: a non-local system is 501 before any provider launches; local still runs', async () => {
    const record = path.join(scratch, 'wire.jsonl');
    await addSystem({ id: 'recbox', label: 'rec', launch: ['node', RECORDING, '--record', record] });
    // Registration verifies the provider by launching it once; that probe's
    // transcript is not the request's.
    disposeSystemHandles();
    await fs.rm(record, { force: true });
    const r = await exec({ system: 'recbox', cwd: '/', argv: ['true'] });
    assert.equal(r.status, 501);
    assert.equal(r.body.code, 'SYSTEMS_UNAVAILABLE');
    await assert.rejects(fs.stat(record), { code: 'ENOENT' }, 'no provider was launched');
    const ok = await exec({ system: 'local', cwd: scratch, argv: ['true'] });
    assert.equal(ok.status, 200);
  });

  // PINS: project form on a project placed on a non-local system is refused
  // 501 SYSTEMS_UNAVAILABLE too, and runs nothing there.
  test('project form: a project on a non-local system is 501', async () => {
    await addSystem({ id: 'refbox', label: 'ref', launch: referenceLaunch() });
    const tree = await seedRepo(path.join(scratch, 'app'));
    assert.equal((await adoptProject('app', tree, { system: 'refbox' })).ok, true);
    const marker = path.join(scratch, 'ran');
    const r = await exec({ project: 'app', argv: ['touch', marker] });
    assert.equal(r.status, 501);
    assert.equal(r.body.code, 'SYSTEMS_UNAVAILABLE');
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  });
});
