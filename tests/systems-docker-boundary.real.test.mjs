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
import http from 'node:http';
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
// Copied into the container. The provider's ENTIRE local import closure is
// `protocol.ts` and nothing else, so the first two files are all it needs to
// run; `execCollector.ts` and `system.ts` are inert here and are carried only
// so the copied set matches the module's siblings. Nothing else crosses in.
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

// Each write kept SEPARATE, with the moment it arrived. A forwarder that
// buffered to completion would coalesce a whole command's output into one
// write, so the split itself is the evidence of streaming — no wall clock
// needed for the primary assertion.
function runAsTheCliWould(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const started = Date.now();
    const writes = [];
    let code = null;
    child.stdout.on('data', (b) => writes.push({ fd: 'out', text: String(b), at: Date.now() - started }));
    child.stderr.on('data', (b) => writes.push({ fd: 'err', text: String(b), at: Date.now() - started }));
    child.on('exit', (c) => { code = c; });
    // `close`, not `exit`: stdout can still be draining when the process exits,
    // and resolving early would drop the very writes under test.
    child.on('close', () => resolve({
      writes, code, endedAt: Date.now() - started,
      of: (fd) => writes.filter(w => w.fd === fd).map(w => w.text).join(''),
      get stdout() { return this.of('out'); },
      get stderr() { return this.of('err'); },
    }));
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

  // PINS STREAMING ACROSS THE MACHINE BOUNDARY: output produced inside the
  // container reaches the worker while the command is still running, not at
  // exit. Two independent witnesses, because either alone can be satisfied by
  // the wrong thing — the SPLIT (a buffering forwarder coalesces the whole
  // output into one write) and the GAP (the first write lands well before the
  // process ends). The command forces a pause the buffering is visible in.
  test('a command inside the container streams its output as it is produced', async () => {
    const r = await hook({ tool_name: 'Bash', tool_input: {
      command: 'printf "part1 from $(hostname)\\n"; sleep 2; printf "part2\\n"',
    } });
    const ran = await runAsTheCliWould(r.body.hookSpecificOutput.updatedInput.command, root);
    const ctrHost = (await inCtr('hostname')).trim();

    assert.equal(ran.code, 0, ran.of('err'));
    assert.equal(ran.of('out'), `part1 from ${ctrHost}\npart2\n`, 'the bytes are right, and from the container');
    const first = ran.writes.find(w => w.text.includes('part1'));
    assert.ok(first, 'part1 arrived');
    assert.ok(!first.text.includes('part2'),
      `part1 and part2 arrived in ONE write — the output was buffered: ${JSON.stringify(ran.writes)}`);
    assert.ok(ran.endedAt - first.at > 1000,
      `part1 arrived only ${ran.endedAt - first.at}ms before the end; it should lead by the whole pause`);
  });

  // PINS: streaming across the boundary keeps the two descriptors apart and
  // still ends with the command's own exit code — the two things a rewrite of
  // the transport is most likely to lose.
  test('a streamed command keeps stdout and stderr apart and still reports its exit code', async () => {
    const r = await hook({ tool_name: 'Bash', tool_input: {
      command: 'printf "O\\n"; printf "E\\n" >&2; sleep 1; printf "O2\\n"; bash -c "exit 3"',
    } });
    const ran = await runAsTheCliWould(r.body.hookSpecificOutput.updatedInput.command, root);
    assert.equal(ran.of('out'), 'O\nO2\n');
    assert.equal(ran.of('err'), 'E\n');
    assert.equal(ran.code, 3, 'the command\'s own code, not the forwarder\'s');
  });

  // PINS B1 ACROSS THE BOUNDARY: interrupting one call cancels that call and
  // nothing else. Witnessed from INSIDE the container, which is the only witness
  // that can tell "was not run" from "was run and the result discarded" — the
  // whole defect was that a cancelled command's effects landed on the system.
  //
  // The cancelled call is driven straight at the endpoint rather than through a
  // forwarder process, so the ORDERING is exact: its request is established
  // (headers flushed) while the shell is demonstrably busy, so it is certainly
  // QUEUED when the socket dies. Two forwarder processes could have reached cc in
  // either order, which would test nothing. That a killed forwarder closes this
  // same socket is pinned separately, below.
  test('interrupting a queued call runs neither it nor over the one in flight', async () => {
    await inCtr('rm -f /app/Q_WITNESS /app/SURVIVOR /app/INFLIGHT');
    const inFlight = bashAsWorker('touch /app/INFLIGHT; sleep 4; touch /app/SURVIVOR');
    // The shell is now demonstrably occupied — witnessed from inside.
    await waitFor(async () => /INFLIGHT/.test(await inCtr('ls /app')), { timeout: 15000 });

    const req = http.request(`${baseUrl}/api/instances/${instId}/bash-forward`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
    });
    // The route flushes headers before it runs anything, so `response` means the
    // handler is live; one macrotask later its waiter is on the queue.
    const established = new Promise((r) => req.on('response', r));
    req.on('error', () => {});
    req.end(JSON.stringify({ command: 'touch /app/Q_WITNESS' }));
    await established;
    await new Promise(r => setTimeout(r, 50));
    req.destroy();

    const survived = await inFlight;
    assert.equal(survived.code, 0, `the unrelated in-flight command was untouched: ${survived.of('err')}`);
    const ls = await inCtr('ls /app');
    assert.match(ls, /SURVIVOR/, 'and it finished its work');
    assert.ok(!/Q_WITNESS/.test(ls), 'the cancelled command never ran inside the container');
  });

  // PINS B3 ACROSS THE BOUNDARY: a runaway command on the far side is a named
  // failure here, not an orchestrator that runs out of memory. The output is
  // produced INSIDE the container, so the bytes really do cross the wire.
  test('a runaway command inside the container is fenced, not accumulated', async () => {
    const before = process.memoryUsage().heapUsed;
    const r = await bashAsWorker('head -c 40000000 /dev/zero | base64');
    assert.notEqual(r.code, 0, 'a fence is a failure, not a truncated success');
    assert.match(r.of('err'), /output exceeded the \d+-byte limit/);
    assert.ok(process.memoryUsage().heapUsed - before < 300 * 1024 * 1024,
      `heap grew by ${(process.memoryUsage().heapUsed - before) >> 20}MB`);
    // And the session survives it.
    assert.equal((await bashAsWorker('echo alive')).of('out'), 'alive\n');
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

// ── A MIRROR WIDER THAN THE PROJECT, across the real boundary ────────
//
// THE ONE MEASUREMENT SAME-MACHINE FIXTURES CANNOT MAKE. Every other mirror
// test reaches the reference provider on cc's own filesystem, where a wide
// mirror makes the local/remote path overlap TOTAL rather than incidental: with
// `mirrorRoot: '/'`, a bridge that read cc's own `/etc/...` instead of the far
// side's would find a plausible file every single time and go green.
//
// So the container's `/etc/os-release` is given a SENTINEL at fixture time and
// the assertion is on that sentinel — not on the host's and container's copies
// merely differing, which a host running the same base image would satisfy for
// entirely the wrong reason.

const WIDE_CTR = `${CTR}-wide`;
// Unique per run, so a stale copy on the host from an earlier run cannot make
// this pass.
const SENTINEL = `CC_MIRROR_SENTINEL_${process.pid}_${Date.now()}`;

describe('a worker whose session mirrors the whole container filesystem', { skip: !ENABLED }, () => {
  let ctx, baseUrl, instances, home, instId, root, cwd;

  const inWide = async (sh) => (await docker('exec', WIDE_CTR, 'sh', '-lc', sh)).stdout;

  before(async () => {
    await docker('rm', '-f', WIDE_CTR).catch(() => {});
    await docker('run', '-d', '--init', '--name', WIDE_CTR, IMAGE, 'tail', '-f', '/dev/null');
    // `git` only — the adopt's repo-root check needs it; nothing here watches
    // processes from inside.
    await docker('exec', WIDE_CTR, 'sh', '-lc',
      'apt-get update -qq && apt-get install -y -qq --no-install-recommends git >/dev/null');
    await docker('exec', WIDE_CTR, 'mkdir', '-p', '/opt/cc', '/app');
    for (const f of PROVIDER_FILES) {
      await docker('cp', path.join(REPO, 'src', 'systems', f), `${WIDE_CTR}:/opt/cc/${f}`);
    }
    await inWide('cd /app && git init -q && git config user.email t@e && git config user.name T'
      + ' && printf "system-side\\n" > ONLY-ON-SYSTEM.txt && git add -A && git commit -q -m initial');
    // THE SENTINEL, written into a file that exists on BOTH machines and is the
    // classic "same on any two Linux boxes" file. Appended rather than replaced,
    // so the file stays a real /etc/os-release.
    await inWide(`printf '${SENTINEL}=1\\n' >> /etc/os-release`);

    ctx = await bootServer();
    ({ baseUrl, instances } = ctx);
    ({ home } = await freshProjectsRoot());
    await addSystem({
      id: 'widebox', label: 'container, whole filesystem mirrored',
      launch: [...DOCKER, 'exec', '-i', WIDE_CTR, 'node', '/opt/cc/referenceProvider.ts', '--mirror', '/'],
    });
    assert.equal((await adoptProject('wide', '/app', { system: 'widebox' })).ok, true);

    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'wide', mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    instId = r.body.id;
    root = sessionRootPath('widebox', 'wide', null);
    cwd = path.join(root, 'app');
    await waitFor(() => instances.get(instId).status === 'idle');
  });

  after(async () => {
    if (ctx) await ctx.instances.shutdown();
    disposeSystemHandles();
    if (home) await rmrf(home);
    if (ctx) await ctx.close();
    await docker('rm', '-f', WIDE_CTR).catch(() => {});
  });

  const hook = (body) => api(baseUrl, 'POST', `/api/instances/${instId}/hook-callback`, {
    session_id: 's', hook_event_name: 'PreToolUse', tool_use_id: `tu${Math.random()}`, ...body,
  });

  // PINS THE PREMISE. The sentinel must exist inside the container and NOT on
  // cc's own machine, or every assertion below is satisfied by the wrong file.
  test('the sentinel discriminates the two machines', async () => {
    assert.match(await inWide('cat /etc/os-release'), new RegExp(SENTINEL));
    const hostOsRelease = await fs.readFile('/etc/os-release', 'utf8').catch(() => '');
    assert.ok(!hostOsRelease.includes(SENTINEL), 'cc\'s own /etc/os-release must not carry it');
  });

  // PINS: the CLI's cwd is the PROJECT's place inside the image, and the image
  // root is a directory above it — the geometry a wide mirror produces.
  //
  // NOT CLAIMING: that the directories above the cwd hold anything. They are
  // cc-created and empty until the bridge pulls into them.
  test('the session root is the image of / and the CLI works one level in', async () => {
    assert.equal(instances.get(instId).cwd, cwd);
    assert.notEqual(cwd, root);
    assert.ok((await fs.stat(cwd)).isDirectory());
    // The project's config surface landed at the cwd, not at the image root.
    assert.ok(await fs.readFile(path.join(cwd, 'CONVENTIONS.md'), 'utf8'));
    await assert.rejects(fs.readFile(path.join(root, 'CONVENTIONS.md')));
    // And the image is still cc's, invisible from inside the container.
    assert.match(await inWide(`ls ${root} 2>&1 || true`), /No such file/);
  });

  // PINS §9, AND IT IS THE ONLY POSITIVE PROOF IN THE FEATURE that a wide
  // mirror maps to the FAR SIDE: a Read of a path that exists on both machines
  // returns the container's bytes, identified by a sentinel cc's own copy
  // cannot have.
  //
  // NOT CLAIMING: anything about paths the container does not have. Absence is a
  // value, and the bridge deletes the local copy for one.
  test('a Read outside the project returns the CONTAINER\'s file, by sentinel', async () => {
    const local = path.join(root, 'etc', 'os-release');
    const d = await hook({ tool_name: 'Read', tool_input: { file_path: local } });
    assert.notEqual(d.body.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(d.body));
    const pulled = await fs.readFile(local, 'utf8');
    assert.ok(pulled.includes(SENTINEL),
      `the pulled file is not the container's:\n${pulled}`);
  });

  // PINS the other direction across the same boundary: an edit to an
  // out-of-project file is pushed INTO the container, witnessed by the
  // container itself rather than by cc's report of it.
  test('an Edit outside the project lands inside the container', async () => {
    const local = path.join(root, 'etc', 'cc-wide-probe.conf');
    await hook({ tool_name: 'Read', tool_input: { file_path: local } });
    await hook({ tool_name: 'Write', tool_input: { file_path: local, content: 'x' } });
    await fs.writeFile(local, `written-through-the-mirror ${SENTINEL}\n`);
    const post = await api(baseUrl, 'POST', `/api/instances/${instId}/hook-callback`, {
      hook_event_name: 'PostToolUse', tool_use_id: 'tpw', tool_name: 'Write',
      tool_input: { file_path: local }, tool_response: {},
    });
    assert.match(post.body.hookSpecificOutput.additionalContext, /\/etc\/cc-wide-probe\.conf/);
    assert.equal(await inWide('cat /etc/cc-wide-probe.conf'),
      `written-through-the-mirror ${SENTINEL}\n`);
    // And it exists only there.
    await assert.rejects(fs.stat('/etc/cc-wide-probe.conf'), 'cc\'s own /etc was never touched');
  });

  // PINS: widening the mirror does NOT move the shell. Bash still opens at the
  // project root inside the container, not at `/`.
  test('Bash still runs at the project root, not at the mirror root', async () => {
    const r = await hook({ tool_name: 'Bash', tool_input: { command: 'pwd && cat ONLY-ON-SYSTEM.txt' } });
    const ran = await runAsTheCliWould(r.body.hookSpecificOutput.updatedInput.command, cwd);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.stdout, '/app\nsystem-side\n');
  });
});
