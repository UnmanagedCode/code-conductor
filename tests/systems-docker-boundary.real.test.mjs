// THE REAL MACHINE BOUNDARY. Skipped by default — opt in with
// `RUN_DOCKER_SYSTEM=1`, which needs a working docker daemon.
//
//   RUN_DOCKER_SYSTEM=1 node tests/run.mjs tests/systems-docker-boundary.real.test.mjs
//   RUN_DOCKER_SYSTEM=1 CC_DOCKER='sudo -n docker' node tests/run.mjs …
//
// Every other Systems test reaches the reference provider on cc's own machine.
// That is enough to prove the protocol, and NOT enough to prove the
// redirection: a bug that sends an operation to the wrong machine looks exactly
// like success when both machines are the same one. Two defects hid behind that
// in an earlier phase.
//
// So this one runs the provider INSIDE a container over `docker exec -i`:
// different hostname, disjoint filesystems. `/app` exists only in the container
// and cc cannot create it; `/workspaces` and the session root are invisible
// from inside. Every assertion below names a fact only one of the two machines
// can produce, so a wrong-machine bug fails rather than passes.
//
// It also exercises MUST 3, which only a real container boundary can: `docker
// exec -i` children are reparented inside the container, so cc's kill of the
// local forwarder cannot reach them — the PROVIDER has to relay it.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf, waitFor } from './helpers.mjs';
import { addSystem } from '../src/appSettings.ts';
import { adoptProject } from '../src/projects.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { sessionRootPath } from '../src/systems/sessionRoot.ts';

const ENABLED = process.env.RUN_DOCKER_SYSTEM === '1';
const IMAGE = process.env.CC_DOCKER_IMAGE ?? 'node:24-slim';
// Some hosts only reach the daemon through sudo; the whole command is
// configurable rather than the flag, so any wrapper works.
const DOCKER = (process.env.CC_DOCKER ?? 'docker').split(/\s+/);
const CTR = `cc-systems-p5-${process.pid}`;
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The provider and the three modules it imports — nothing else crosses in.
const PROVIDER_FILES = ['referenceProvider.ts', 'protocol.ts', 'execCollector.ts', 'system.ts'];

const run = (argv, opts = {}) => new Promise((resolve, reject) => {
  execFile(argv[0], argv.slice(1), { maxBuffer: 1 << 24, ...opts }, (err, stdout, stderr) => {
    if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
  });
});
const docker = (...args) => run([...DOCKER, ...args]);
// A command run INSIDE the container, independently of cc — the only witness
// this test trusts about the system's state.
const inCtr = async (sh) => (await docker('exec', CTR, 'sh', '-lc', sh)).stdout;

function runAsTheCliWould(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('exit', (code) => resolve({ stdout, stderr, code }));
  });
}

describe('a worker across a real machine boundary', { skip: !ENABLED }, () => {
  let ctx, baseUrl, instances, home, instId, root, ccHostname;

  before(async () => {
    ({ stdout: ccHostname } = await run(['hostname']));
    await docker('rm', '-f', CTR).catch(() => {});
    // `--init` so PID 1 REAPS. Without it the killed command lingers as a
    // zombie and the assertion below cannot tell "still running" from "dead but
    // unreaped" — a property of this fixture's PID 1, not of the provider.
    // `--init` so PID 1 REAPS: without it the killed command lingers as a zombie
    // and the MUST-3 assertion cannot tell "still running" from "dead but
    // unreaped". `tail -f` rather than `sleep` as the keep-alive, so the
    // container's own idle process is not itself matched by that assertion's
    // `pgrep -x sleep`.
    await docker('run', '-d', '--init', '--name', CTR, IMAGE, 'tail', '-f', '/dev/null');
    // `git` for the adopt's repo-root check, `procps` for the pgrep the MUST-3
    // assertion uses to watch the command from inside. Neither is in the slim
    // image, and both are about the FIXTURE, not about what a provider needs.
    await docker('exec', CTR, 'sh', '-lc',
      'apt-get update -qq && apt-get install -y -qq --no-install-recommends git procps >/dev/null');
    await docker('exec', CTR, 'mkdir', '-p', '/opt/cc', '/app');
    for (const f of PROVIDER_FILES) {
      await docker('cp', path.join(REPO, 'src', 'systems', f), `${CTR}:/opt/cc/${f}`);
    }
    // A repo at /app, seeded INSIDE the container. `/app` does not exist on
    // cc's machine and cc has no way to create it.
    await inCtr('cd /app && git init -q && git config user.email t@e && git config user.name T'
      + ' && printf "system-side\\n" > ONLY-ON-SYSTEM.txt'
      + ' && printf "console.log(\\"Hi\\")\\n" > greeting.js'
      + ' && git add -A && git commit -q -m initial');

    ctx = await bootServer();
    ({ baseUrl, instances } = ctx);
    ({ home } = await freshProjectsRoot());
    await addSystem({
      id: 'ctrbox', label: 'container',
      launch: [...DOCKER, 'exec', '-i', CTR, 'node', '/opt/cc/referenceProvider.ts'],
    });
    assert.equal((await adoptProject('app', '/app', { system: 'ctrbox' })).ok, true);

    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    instId = r.body.id;
    root = sessionRootPath('ctrbox', 'app', null);
    await waitFor(() => instances.get(instId).status === 'idle');
  });

  after(async () => {
    if (ctx) await ctx.instances.shutdown();
    disposeSystemHandles();
    if (home) await rmrf(home);
    if (ctx) await ctx.close();
    await docker('rm', '-f', CTR).catch(() => {});
  });

  const hook = (body) => api(baseUrl, 'POST', `/api/instances/${instId}/hook-callback`, {
    session_id: 's', hook_event_name: 'PreToolUse', tool_use_id: `tu${Math.random()}`, ...body,
  });
  const bashAsWorker = async (command) => {
    const r = await hook({ tool_name: 'Bash', tool_input: { command } });
    return runAsTheCliWould(r.body.hookSpecificOutput.updatedInput.command, root);
  };

  // PINS: the fixture really is two machines. Every assertion after this one is
  // worthless without it.
  test('the two sides are genuinely disjoint', async () => {
    assert.notEqual((await inCtr('hostname')).trim(), ccHostname.trim());
    await assert.rejects(fs.stat('/app'), 'cc has no /app');
    assert.match(await inCtr('ls / 2>&1'), /app/);
    assert.match(await inCtr('ls /workspaces 2>&1 || true'), /No such file/,
      'and the container cannot see cc\'s filesystem');
  });

  // PINS: a redirected Bash runs on the OTHER machine — asserted by the
  // container's own hostname, which cc cannot produce.
  test('a redirected Bash command runs inside the container', async () => {
    const r = await bashAsWorker('hostname && cat ONLY-ON-SYSTEM.txt && pwd');
    assert.equal(r.code, 0, r.stderr);
    const [host, marker, cwd] = r.stdout.trim().split('\n');
    assert.equal(host, (await inCtr('hostname')).trim());
    assert.notEqual(host, ccHostname.trim());
    assert.equal(marker, 'system-side');
    assert.equal(cwd, '/app', 'in a directory that exists only there');
  });

  // PINS: the session root is a cc-owned LOCAL directory and stays one. Its
  // path does not exist in the container, and the container's tree is not
  // mirrored into it.
  test('the session root is local and holds no copy of the tree', async () => {
    assert.equal(instances.get(instId).cwd, root);
    assert.ok((await fs.stat(root)).isDirectory(), 'it exists on cc');
    assert.match(await inCtr(`ls ${root} 2>&1 || true`), /No such file/, 'and not in the container');
    await assert.rejects(fs.readFile(path.join(root, 'ONLY-ON-SYSTEM.txt')));
    // But the config surface WAS pulled across.
    assert.ok(await fs.readFile(path.join(root, 'CONVENTIONS.md'), 'utf8'));
  });

  // PINS: pull-then-push across a real boundary. The file's bytes travel from a
  // path cc cannot open to a path the container cannot see, and back — verified
  // by the container itself, not by cc's report of it.
  test('Read pulls from the container and Edit pushes back into it', async () => {
    const local = path.join(root, 'greeting.js');
    await hook({ tool_name: 'Read', tool_input: { file_path: local } });
    assert.equal(await fs.readFile(local, 'utf8'), 'console.log("Hi")\n');

    await hook({ tool_name: 'Edit', tool_input: { file_path: local, old_string: 'Hi', new_string: 'Hello' } });
    await fs.writeFile(local, 'console.log("Hello")\n');
    const post = await api(baseUrl, 'POST', `/api/instances/${instId}/hook-callback`, {
      hook_event_name: 'PostToolUse', tool_use_id: 'tp', tool_name: 'Edit',
      tool_input: { file_path: local }, tool_response: {},
    });
    assert.match(post.body.hookSpecificOutput.additionalContext, /\/app\/greeting\.js/);
    assert.equal(await inCtr('cat /app/greeting.js'), 'console.log("Hello")\n');
    // git inside the container agrees the working tree really changed.
    assert.match(await inCtr('cd /app && git status --porcelain'), /greeting\.js/);
  });

  // PINS MUST 3. `docker exec -i` children are reparented inside the container,
  // so killing the local forwarder cannot reach the command — only the
  // provider, which is itself inside, can. If it did not relay, the marker file
  // would appear.
  test('killing the forwarder stops the command inside the container', async () => {
    const r = await hook({ tool_name: 'Bash', tool_input: { command: 'sleep 15; touch /app/SURVIVED.txt' } });
    const child = spawn('bash', ['-c', r.body.hookSpecificOutput.updatedInput.command], { cwd: root, stdio: 'ignore' });
    // `pgrep -x`, matching the process NAME exactly: `pgrep -f` would also match
    // the `sh -lc 'pgrep -f "sleep 15"'` this very probe runs in, so the
    // "it is gone" half could never become true.
    const sleeping = async () => (await inCtr('pgrep -x sleep || true')).trim() !== '';
    await waitFor(sleeping);
    child.kill('SIGKILL');

    await waitFor(async () => !(await sleeping()), { timeout: 15000 });
    assert.match(await inCtr('ls /app/SURVIVED.txt 2>&1 || true'), /No such file/,
      'the command was killed, not merely abandoned to finish');

    // And the session recovers, saying what it lost.
    const next = await bashAsWorker('echo back');
    assert.equal(next.stdout, 'back\n');
    assert.match(next.stderr, /was restarted/);
  });
});
