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
//
// WHAT THIS FILE DOES NOT CLAIM. The container is on cc's own machine and
// shares its kernel; what is disjoint about it is its FILESYSTEM and its
// ENVIRONMENT. Nothing here is measured about SSH, about a genuinely remote
// host, about latency, or about a foreign libc or toolchain — no assertion or
// comment in this file may be read as covering any of them.
//
// DOUBLY OPT-IN SINCE THE FUSE-UNION GEOMETRY. This suite needs `RUN_DOCKER_SYSTEM=1`
// AND a host that can mount the union — `sudo -n`, `/dev/fuse`, `fusectl`, gcc and
// libfuse3 headers, the same set `tests/fuse-lifecycle.real.test.mjs` asserts. The
// union is mandatory for a remote-backed worker, and this is the ONE suite that
// crosses a real machine boundary: a worker here runs at the project's path
// INSIDE the container, which does not exist on the host, so a run that bypassed
// the union would be asserting the wrong geometry rather than testing the right
// one. A host without FUSE gets the criterion-9 refusal, by name.

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
import { disposeSystemHandles, systemById } from '../src/systems/registry.ts';

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
// A directory that is on the CONTAINER's PATH and on no host's, holding a
// binary that exists only there. It is what makes the argv-form assertion below
// a discriminator rather than a coincidence: resolving `cc-buildtool` at all
// means the command resolved through the target's PATH.
const TARGET_ONLY_BIN = '/opt/cc-target-only';
const TARGET_ONLY_TOOL = 'cc-buildtool';
// A SLEEPER WITH ITS OWN PROCESS NAME, for the cancellation test below. Nothing
// serialises (card 2026-0312), so the unrelated call it runs against is
// CONCURRENT and is itself a `sleep`: `pgrep -x sleep` would name both, and the
// witness has to name exactly one.
const CANCEL_SLEEPER = '/usr/local/bin/cc-cancelme';

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
    //
    // The container's PATH is its image's own with TARGET_ONLY_BIN prepended,
    // read back from the image rather than hardcoded so the tool stays
    // reachable and nothing else about the image changes.
    const imagePath = (await docker('run', '--rm', IMAGE, 'sh', '-c', 'printf %s "$PATH"')).stdout.trim();
    assert.ok(imagePath.startsWith('/'), `unexpected image PATH: ${imagePath}`);
    await docker('run', '-d', '--init', '--name', CTR,
      '-e', `PATH=${TARGET_ONLY_BIN}:${imagePath}`, IMAGE, 'tail', '-f', '/dev/null');
    // `git` for the adopt's repo-root check, `procps` for the pgrep the MUST-3
    // assertion uses to watch the command from inside. Neither is in the slim
    // image, and both are about the FIXTURE, not about what a provider needs.
    await docker('exec', CTR, 'sh', '-lc',
      'apt-get update -qq && apt-get install -y -qq --no-install-recommends git procps >/dev/null');
    await docker('exec', CTR, 'mkdir', '-p', '/opt/cc', '/app', TARGET_ONLY_BIN);
    await inCtr(`printf '#!/bin/sh\\necho target-toolchain-ok\\n' > ${TARGET_ONLY_BIN}/${TARGET_ONLY_TOOL}`
      + ` && chmod +x ${TARGET_ONLY_BIN}/${TARGET_ONLY_TOOL}`);
    await inCtr(`cp "$(command -v sleep)" ${CANCEL_SLEEPER}`);
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
    root = '/app';
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

  // PINS: the fixture really is two disjoint sides of one machine. Every
  // assertion after this one is worthless without it.
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

  // PINS: a command on the system runs in the SYSTEM's environment, not cc's.
  // THE STATIC HALF of that rule — what the two environments CONTAIN: PATH,
  // HOME, the toolchain. Those values coincide wherever the provider sits on
  // cc's own machine, so this is where the difference is observable at all,
  // and it is exactly how the old default survived. (The LIVE half — a
  // variable cc sets after the provider launched — needs no boundary and is
  // pinned in tests/systems-exec-env.test.mjs.)
  //
  // Three witnesses, because each alone can be satisfied by the wrong thing:
  // the VARIABLES cc has and the container does not, `$HOME` (measured to
  // survive `bash -l` sourcing /etc/profile, which rewrites PATH), and the
  // argv form resolving a binary that exists only in the container.
  //
  // NOT CLAIMING: that cc's environment is unreachable from the container by
  // any route — only that cc does not put it on the wire.
  test('a command on the system runs in the system\'s environment, not cc\'s', async () => {
    // Calibrated through the container's own `bash -l`, not `inCtr`'s `sh -l`:
    // the redirected command is spawned as `bash -lc`, and bash exports
    // variables of its own (`SHLVL`, `_`) that this image's dash does not. A
    // dash-calibrated set would count those as cc's and red on every run.
    const containerEnv = new Set(
      (await docker('exec', CTR, 'bash', '-lc', 'env')).stdout.split('\n')
        .map(l => l.slice(0, l.indexOf('='))).filter(Boolean));
    const orchestratorOnly = Object.keys(process.env).filter(k => !containerEnv.has(k));
    // NON-VACUITY, checked first: on a host whose environment happened to match
    // the image's, witness 1 would pass while asserting nothing.
    assert.ok(orchestratorOnly.length > 0,
      'cc has no variable the container lacks — witness 1 would be vacuous');
    // THE SAME GUARD FOR WITNESS 3, and it is the load-bearing one: `PATH` is a
    // key of BOTH environments, so it can never appear in `orchestratorOnly` —
    // witness 1 structurally cannot see a PATH crossing, and witness 2 pins only
    // `$HOME`. That leaves witness 3 as the sole guard on PATH resolution, and
    // it discriminates only while its directory is on no PATH of cc's: on a host
    // carrying one, cc's own environment would resolve the tool inside the
    // container too and witness 3 would go GREEN AGAINST THE BUG.
    assert.ok(!(process.env.PATH ?? '').split(path.delimiter).includes(TARGET_ONLY_BIN),
      `${TARGET_ONLY_BIN} is on cc's own PATH — witness 3 would not discriminate`);

    // 1. None of cc's own variables reached the far side.
    const seen = await bashAsWorker('env');
    assert.equal(seen.code, 0, seen.stderr);
    const workerEnv = new Set(seen.stdout.split('\n').map(l => l.slice(0, l.indexOf('='))).filter(Boolean));
    assert.deepEqual(orchestratorOnly.filter(k => workerEnv.has(k)), [],
      'cc\'s own environment crossed the boundary');

    // 2. $HOME is the container's, not cc's.
    const home = (await bashAsWorker('echo "$HOME"')).stdout.trim();
    assert.equal(home, (await inCtr('echo $HOME')).trim());
    assert.notEqual(home, process.env.HOME);

    // 3. The argv form resolves the TARGET's toolchain. `cc-buildtool` is on
    //    the container's PATH and on no path of cc's, so a command resolved
    //    through cc's PATH answers ENOENT instead.
    const sys = await systemById('ctrbox', null, 'the boundary test');
    const built = await sys.exec({ argv: [TARGET_ONLY_TOOL] }, { cwd: '/app' });
    assert.ok(!built.spawnError, `${TARGET_ONLY_TOOL} did not start: ${built.spawnError}`);
    assert.equal(built.code, 0, built.stderr);
    assert.equal(built.stdout.trim(), 'target-toolchain-ok');
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

  // PINS B1 ACROSS THE BOUNDARY: interrupting one call stops THAT call on the
  // far side and nothing else. Witnessed from INSIDE the container, because cc's
  // own return value cannot tell "was stopped" from "was abandoned and finished
  // anyway": `ProviderShell#runOneShot` (src/systems/providerShell.ts)
  // re-checks `signal?.aborted` once the exec has RETURNED and throws
  // `cancelled()` there, ahead of reading the result's own
  // `outputOverflowed`/`timedOut` — so the exec's result is discarded, and what
  // reaches the caller describes cc's cancellation rather than the far side's
  // state.
  //
  // THE CANCELLED CALL IS RUNNING, NOT QUEUED, and that is not a detail.
  // Card 2026-0312 removed the shell and its queue: nothing serialises, so a
  // second call is dispatched immediately and runs CONCURRENTLY with the first.
  // An earlier version of this test cancelled a bare `touch` and asserted it
  // never ran; measured, that effect landed on the far side AFTER the socket
  // died, so the assertion was a race the test could not win and said nothing
  // at all about cancellation (card 2026-0327 §4).
  //
  // AND THE SURVIVING BEHAVIOUR IS THE ONE THAT MATCHES LOCAL, which is why this
  // is a test defect and not a cc defect. A cancelled command keeps whatever it
  // had already done — MEASURED (card 2026-0327 §4) — exactly as an interrupted
  // local Bash does, which is ARGUED from the parity directive and was NOT
  // instrumented. What card 2026-0312 removed is the QUEUED state, the only
  // state in which a cancelled call had done nothing at all; a local session has
  // no such state, because a dispatched command has always started. So the
  // pre-0312 all-or-nothing outcome was cc's own serialisation layer showing
  // through, not parity with local.
  //
  // So the cancelled command's effect is placed BEHIND a delay, and the test
  // waits for the process itself before cancelling. Absence of the marker is
  // then the cancellation rather than the clock, and the process's disappearance
  // is the RELAY: `docker exec -i` children are reparented inside the container,
  // so cc closing a socket cannot reach this process — only the provider can.
  // Deliberately the same long-sleep idiom as this file's MUST-3 test below and
  // as tests/systems-remote-worker.test.mjs's `sleep 20` twin, so the three read
  // together.
  test('interrupting one call stops it inside the container and leaves a concurrent call alone', async () => {
    await inCtr('rm -f /app/Q_WITNESS /app/SURVIVOR /app/INFLIGHT');
    const concurrent = bashAsWorker('touch /app/INFLIGHT; sleep 4; touch /app/SURVIVOR');
    await waitFor(async () => /INFLIGHT/.test(await inCtr('ls /app')), { timeout: 15000 });

    const req = http.request(`${baseUrl}/api/instances/${instId}/bash-forward`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
    });
    const established = new Promise((r) => req.on('response', r));
    req.on('error', () => {});
    req.end(JSON.stringify({ command: `${CANCEL_SLEEPER} 20; touch /app/Q_WITNESS` }));
    await established;

    // NON-VACUITY, and the reason this shape replaces the old one: the command
    // must be RUNNING INSIDE THE CONTAINER before it is cancelled. Without that
    // wait, the marker's absence is also satisfied by a command that never
    // started.
    const cancelSleeper = async () => (await inCtr(`pgrep -x ${path.basename(CANCEL_SLEEPER)} || true`)).trim();
    await waitFor(async () => (await cancelSleeper()) !== '', { timeout: 15000 });
    req.destroy();

    const gone = await waitFor(async () => (await cancelSleeper()) === '', { timeout: 15000 })
      .then(() => true, () => false);
    if (!gone) {
      // ATTRIBUTION. `waitFor` swallows its predicate's errors, so a broken
      // `docker exec` and a genuinely surviving process both arrive here as a
      // timeout. Probe once more UNGUARDED: a fixture failure then throws its
      // own error instead of being reported as a cc failure.
      assert.equal(await cancelSleeper(), '',
        'the cancelled command was still running inside the container');
    }

    const survived = await concurrent;
    assert.equal(survived.code, 0, `the unrelated concurrent command was untouched: ${survived.of('err')}`);
    const ls = await inCtr('ls /app');
    assert.match(ls, /SURVIVOR/, 'and it finished its work');
    // WHAT THE LAST TWO ASSERTIONS PIN, because they are not the same claim.
    //   `gone` — the cancel reached the far side at all. MEASURED to
    //   discriminate, on card 2026-0327 and not by this file's author: deleting
    //   the route's close-to-abort wiring, or `runForwarded`'s relay of the
    //   caller's signal, turns it red.
    //   `Q_WITNESS` — the kill reached the WHOLE command rather than only its
    //   leading process: a provider that killed the sleeper alone would leave
    //   its parent shell to run the `touch`. MEASURED to discriminate, on
    //   card 2026-0327 and not by this file's author: a reference provider
    //   whose `#terminate` kills only the named leading process and spares the
    //   shell leaves `gone` green and reds THIS line, while the two
    //   mutants above die at `gone` and never reach it. That stimulus is
    //   CONSTRUCTED — it hard-codes this file's own fixture binary name into
    //   the provider — so what it establishes is that the two assertions are
    //   separable, not that an ordinary provider defect would take this shape.
    // `20` against a path to this line that is BOUNDED BY the concurrent
    // `sleep 4` above it, so the marker's absence is the cancellation and not
    // the clock — and far under `DEFAULT_COMMAND_TIMEOUT_MS`
    // (src/systems/providerShell.ts), so nothing but the cancel can be what
    // stopped it unless ORCH_SHELL_COMMAND_TIMEOUT_MS is set very low.
    assert.ok(!/Q_WITNESS/.test(ls), 'the cancelled command\'s later effects never landed');
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

    // And the session recovers, claiming NO reset it never had. Card 2026-0312
    // deleted the long-lived shell: the command's own `exec` was killed and no
    // state was shared for anyone to lose, so telling the next command its
    // exports were gone would be an R5-class false statement. The production
    // site says exactly that in its own comment — `ProviderShell#runOneShot`'s
    // post-exec `signal?.aborted` re-check (src/systems/providerShell.ts,
    // "NO RESET REASON", citing card 2026-0312 §2 D-b). THAT RE-CHECK IS NOT
    // PINNED HERE: deleting it leaves this whole file green, and an assertion
    // that does red is the same-machine one — the `interrupt|cancel` stderr
    // assertion in tests/systems-tool-redirect.test.mjs's `cancelling one call
    // leaves a live concurrent command untouched` (card 2026-0327). What THIS line
    // has teeth against was measured separately — it reds when the cwd notice
    // fires unconditionally rather than only when a command actually moved. The
    // same-machine twin asserts the same silence
    // (tests/systems-remote-worker.test.mjs).
    const next = await bashAsWorker('echo back');
    assert.equal(next.stdout, 'back\n');
    assert.equal(next.stderr, '', 'and it is told about no reset it never had');
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
    root = '/app';
    cwd = root;
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
