// A worker session on a remote project, end to end through the real REST
// surface — the phase's whole point, and the first time cc runs a worker
// anywhere but its own machine.
//
// The CLI is faked, but nothing between it and the system is: the rewritten
// Bash command is executed by a real shell exactly as the CLI would execute it,
// which runs the real forwarder process, which posts to the real endpoint,
// which drives the real shell over the real provider protocol. A rewrite that
// does not survive quoting, a forwarder that cannot reach cc, or a shell that
// runs on the wrong machine all fail here.
//
// ONLY-ON-SYSTEM.txt / ONLY-ON-CC.txt keep the two sides distinguishable, so no
// assertion below can be satisfied by the wrong machine.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, accessSync, constants as fsc } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { bootServer, api, freshProjectsRoot, rmrf, waitFor, seedSessionJsonl } from './helpers.mjs';
import { InProcessClaudeLauncher } from './inProcessLauncher.mjs';
import { bindRemoteSystem, seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { adoptProject, orchStoreRoot } from '../src/projects.ts';
import { sessionTmpDir, sweepSessionTmpDirs } from '../src/instances.ts';
import { attachmentsDir } from '../src/worktrees.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { composeProjectConventionsDoc } from '../src/projectClaudeMd.ts';

const exists = (p) => fs.access(p).then(() => true, () => false);

// Run a command string the way the CLI's Bash tool runs one: through a shell,
// on cc's machine. For a redirected session that string IS the forwarder
// invocation, so this is the real end-to-end path.
function runAsTheCliWould(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('exit', (code) => resolve({ stdout, stderr, code, pid: child.pid }));
  });
}

// The same, but recording each write SEPARATELY rather than concatenating. A
// forwarder that buffers to completion necessarily coalesces the whole output
// into one write, so "part1 arrived in a write that did not also carry part2"
// is a structural test for streaming — no wall clock, nothing to flake on.
function runAsTheCliWouldStreaming(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const writes = [];
    let code = null;
    child.stdout.on('data', (b) => writes.push({ fd: 'out', text: String(b) }));
    child.stderr.on('data', (b) => writes.push({ fd: 'err', text: String(b) }));
    child.on('exit', (c) => { code = c; });
    // `close`, not `exit`: stdout can still be draining when the process exits,
    // and resolving early would drop the very writes under test.
    child.on('close', () => resolve({ writes, code, of: (fd) => writes.filter(w => w.fd === fd).map(w => w.text).join('') }));
  });
}

describe('a worker session on a remote system', () => {
  let ctx, baseUrl, instances, home, remote, tree, instId, root, r0;

  before(async () => { ctx = await bootServer(); ({ baseUrl, instances } = ctx); });
  after(async () => { await ctx.close(); });

  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    remote = await bindRemoteSystem();
    tree = await seedRepo(path.join(remote.root, 'app'));
    await fs.writeFile(path.join(tree, 'ONLY-ON-SYSTEM.txt'), 'system side\n');
    await fs.writeFile(path.join(tree, 'CLAUDE.md'), '@CONVENTIONS.md\nproject notes\n');
    await fs.writeFile(path.join(tree, 'CONVENTIONS.md'), '<!-- cc:conventions -->\nrules\n');
    assert.equal((await adoptProject('app', tree, { system: remote.id })).ok, true);
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    instId = r.body.id;
    root = tree;
    await waitFor(() => instances.get(instId).status === 'idle');
    r0 = await api(baseUrl, 'POST', `/api/instances/${instId}/hook-callback`, {
      session_id: 's', hook_event_name: 'PreToolUse', tool_use_id: 'tu0',
      tool_name: 'Bash', tool_input: { command: 'true' },
    });
  });

  afterEach(async () => {
    await ctx.instances.shutdown();
    disposeSystemHandles();
    await rmrf(home);
  });

  const hook = (body) => api(baseUrl, 'POST', `/api/instances/${instId}/hook-callback`, {
    session_id: 's', hook_event_name: 'PreToolUse', tool_use_id: `tu${Math.random()}`, ...body,
  });
  const onSystem = (rel) => path.join(tree, rel);
  const inSession = (rel) => path.join(root, rel);

  // PINS CRITERION 8: the session's cwd IS the project's tree on its system.
  // Nothing is composed, nothing is copied, and the config surface the CLI reads
  // implicitly is simply the project's own — no allow-list walk decides what it
  // gets to see.
  test("the CLI's cwd is the tree on the system, and nothing is composed", async () => {
    assert.equal(instances.get(instId).cwd, tree);
    assert.match(await fs.readFile(onSystem('CONVENTIONS.md'), 'utf8'), /^<!-- cc:conventions/);
    assert.match(await fs.readFile(onSystem('CLAUDE.md'), 'utf8'), /^@CONVENTIONS\.md$/m);
    // THE WHOLE TREE, not a pulled subset: the file the allow-list walk left
    // behind is now simply there, because the filesystem decides.
    assert.equal(await fs.readFile(onSystem('ONLY-ON-SYSTEM.txt'), 'utf8'), 'system side\n');
    // And NO session root under the store — the geometry is gone, not unused.
    assert.equal(await exists(path.join(orchStoreRoot(), 'systems', remote.id, 'sessions')), false);
  });

  // PINS B4 AT THE SPAWN: a session whose pulled settings turn hooks off is
  // REFUSED by name. Running it would execute the worker's own commands on the
  // orchestrator's machine while every result claimed the system — and because
  // `disableAllHooks` leaves `permissions.*` working, nothing else would fail
  // loudly. The file is pulled off the system, so its content is not cc's.
  test('a project whose settings disable hooks refuses the spawn', async () => {
    const before = instances.list().length;
    await fs.mkdir(path.join(tree, '.claude'), { recursive: true });
    await fs.writeFile(path.join(tree, '.claude', 'settings.json'),
      JSON.stringify({ disableAllHooks: true }));
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
    assert.equal(r.status, 501, JSON.stringify(r.body));
    const why = JSON.stringify(r.body);
    assert.match(why, /REDIRECT_HOOKS_DISABLED/);
    assert.match(why, /disableAllHooks/);
    // And it names the file it read, which is what the operator edits on the
    // system.
    assert.match(why, /settings\.json/);
    // No session was registered: a refusal that left a phantom instance behind
    // would be resumable into the very state it refused.
    assert.equal(instances.list().length, before);
  });

  // PINS T3: WHICH refusal wins when a settings file trips both scans. The
  // hooks check runs first deliberately — `disableAllHooks` is the bigger
  // failure, because it silently runs the worker's own commands on the
  // orchestrator while `Bash(...)` rules merely stop discriminating — and with
  // only one of the two set in a fixture, either ordering refuses identically,
  // so nothing held the choice.
  test('a file that trips both scans refuses with the hooks code, not the rules one', async () => {
    await fs.mkdir(path.join(tree, '.claude'), { recursive: true });
    await fs.writeFile(path.join(tree, '.claude', 'settings.json'),
      JSON.stringify({ disableAllHooks: true, permissions: { deny: ['Bash(rm:*)'] } }));
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
    assert.equal(r.status, 501, JSON.stringify(r.body));
    const why = JSON.stringify(r.body);
    assert.match(why, /REDIRECT_HOOKS_DISABLED/);
    assert.ok(!why.includes('BASH_RULES_NOT_ENFORCEABLE'), `the bigger failure is the one reported: ${why}`);
  });

  // PINS: the Bash-rule refusal is still reached when hooks are NOT disabled —
  // so the ordering above is a priority, not the rules scan being dead.
  test('a Bash rule alone still refuses with the rules code', async () => {
    await fs.mkdir(path.join(tree, '.claude'), { recursive: true });
    await fs.writeFile(path.join(tree, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }));
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
    assert.equal(r.status, 501, JSON.stringify(r.body));
    assert.match(JSON.stringify(r.body), /BASH_RULES_NOT_ENFORCEABLE/);
  });

  // ARM B OF THE LAUNCHER-RESOLUTION PAIR, AND THE HALF THAT GIVES ARM A ITS
  // MEANING (arm A lives in its own realProcess describe below). This server's
  // launcher is the in-process one: it runs the CLI inside cc's own process, so
  // there is no chroot, no marking event and nothing to pin — and the same
  // unresolvable CLAUDE_BIN that refuses arm A must NOT refuse here. Without
  // this, FUSE_LAUNCHER_UNRESOLVED could be a blanket refusal on every remote
  // spawn and arm A would still pass.
  test('an unresolvable CLAUDE_BIN does NOT refuse an in-process session', async () => {
    const saved = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = 'cc-no-such-command-anywhere';
    try {
      const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = saved;
    }
  });

  // PINS: the refusal is about the setting, not about remote projects. Hooks
  // that are ON must not block anything.
  test('settings that leave hooks on spawn normally', async () => {
    await fs.mkdir(path.join(tree, '.claude'), { recursive: true });
    await fs.writeFile(path.join(tree, '.claude', 'settings.json'),
      JSON.stringify({ disableAllHooks: false }));
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  // PINS: the injected settings widen the hook surface AND remove Glob/Grep.
  // A redirected session that still offered Grep would answer searches from a
  // session root holding the config surface and nothing else.
  //
  // The `Read` clause: Read is hooked to REFUSE a path the union does not serve
  // to this session (criterion 11), so a Read
  // missing from this matcher would leak an -ENOENT the model reads as "the
  // file is absent". It is hooked and NOT gated — see the ask-mode arm in
  // tests/systems-redirect-hooks.test.mjs.
  test('the spawn argv carries the redirected settings', async () => {
    const argv = instances.get(instId)._spawnArgv;
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]);
    assert.deepEqual(settings.permissions.deny, ['Glob', 'Grep']);
    assert.match(settings.hooks.PreToolUse[0].matcher, /\bRead\b/,
      'Read is not hooked — the refusal seam criterion 11 needs is gone');
    assert.ok(settings.hooks.PostToolUse, 'the PostToolUse write-back seam is still registered');
  });

  // PINS B5: a worker can read its OWN backgrounded command's interim output.
  // The CLI's background-Bash result tells the worker verbatim to Read the task
  // file it names under the per-uid tmp root — a path on the ORCHESTRATOR — and
  // the redirect refused it, with a suggestion ("use Bash") that is wrong
  // because the file is not on the system at all.
  //
  // The fix relocates the whole per-uid tmp root with CLAUDE_CODE_TMPDIR, so the
  // task file lands somewhere cc chose and already trusts. Pointing it INSIDE
  // the session root would be worse than the bug: the file would become a
  // "mapped" path, the pull would stat it on the system, find it absent, and
  // `fs.rm` the worker's own output.
  test('the task-output root is cc-owned, outside the session root, and readable', async () => {
    const inst = instances.get(instId);
    const tmpRoot = inst._spawnEnv.CLAUDE_CODE_TMPDIR;
    assert.ok(tmpRoot, 'the session pins its own tmp root');

    // Outside the session root — see above.
    assert.equal(path.relative(root, tmpRoot).startsWith('..'), true,
      `${tmpRoot} must not be inside the session root ${root}`);
    // cc-owned and 0700: the CLI validates ownership and mode on the override,
    // and one session must not be able to read another's task output.
    const st = await fs.stat(tmpRoot);
    assert.equal(st.mode & 0o777, 0o700);
    assert.ok(tmpRoot.includes(instId), 'per session, so the dirs cannot be shared');

    // And a Read of a file under it is ALLOWED by the redirect — the whole
    // point. Asserted through the real hook endpoint.
    const taskFile = path.join(tmpRoot, 'tasks', 'probe.output');
    await fs.mkdir(path.dirname(taskFile), { recursive: true });
    await fs.writeFile(taskFile, 'interim output\n');
    const d = await hook({ tool_name: 'Read', tool_input: { file_path: taskFile } });
    assert.equal(d.body.hookSpecificOutput.permissionDecision, 'allow',
      d.body.hookSpecificOutput.permissionDecisionReason);
    // Untouched: it is a local path, so nothing pulls or deletes it.
    assert.equal(await fs.readFile(taskFile, 'utf8'), 'interim output\n');
  });

  // PINS: the per-session tmp root is REMOVED with the session. cc creates one
  // dir per redirected session under its own store; never removing them is a
  // leak that grows for the life of the install.
  test('removing the session removes its tmp root', async () => {
    const tmpRoot = instances.get(instId)._spawnEnv.CLAUDE_CODE_TMPDIR;
    assert.ok((await fs.stat(tmpRoot)).isDirectory());
    await api(baseUrl, 'DELETE', `/api/instances/${instId}`);
    await assert.rejects(fs.stat(tmpRoot), 'the session-tmp directory is gone');
  });




  // PINS C3: the tmp root is reclaimed on the paths that ACTUALLY happen, not
  // only on an explicit DELETE. `remove()` had it; a graceful cc shutdown, a
  // project's sessions being removed, a crashed instance and a killed server all
  // left the directory behind, with no boot sweep — and it holds command output,
  // so it accumulated real data while the doc claimed "removed with the session".
  test('a graceful shutdown reclaims every session tmp root', async () => {
    const tmpRoot = instances.get(instId)._spawnEnv.CLAUDE_CODE_TMPDIR;
    assert.ok((await fs.stat(tmpRoot)).isDirectory());
    await ctx.instances.shutdown();
    await assert.rejects(fs.stat(tmpRoot), 'shutdown reclaimed it');
  });

  test('removing a project sessions reclaims their tmp roots', async () => {
    const tmpRoot = instances.get(instId)._spawnEnv.CLAUDE_CODE_TMPDIR;
    assert.ok((await fs.stat(tmpRoot)).isDirectory());
    assert.equal(await instances.removeAllForProject('app'), 1);
    await assert.rejects(fs.stat(tmpRoot), 'removeAllForProject reclaimed it');
  });

  // PINS: the boot sweep is what covers a KILLED server, where no teardown path
  // ran at all. An instance id is a fresh uuid per process, so a directory left
  // under session-tmp can never belong to a live session after a restart.
  test('the boot sweep reclaims tmp roots no live session owns', async () => {
    const mine = instances.get(instId)._spawnEnv.CLAUDE_CODE_TMPDIR;
    const orphan = sessionTmpDir('a-dead-instance-from-a-killed-server');
    await fs.mkdir(path.join(orphan, 'tasks'), { recursive: true });
    await fs.writeFile(path.join(orphan, 'tasks', 'x.output'), 'stale output\n');

    await sweepSessionTmpDirs([...instances.byId.keys()]);
    await assert.rejects(fs.stat(orphan), 'the orphan is gone');
    assert.ok((await fs.stat(mine)).isDirectory(), 'and a LIVE session keeps its own');
  });

  // PINS: a LOCAL session's tmp root is not touched. The override exists for the
  // redirect's path policy; changing it for every session would move the CLI's
  // per-uid tmp root for reasons that have nothing to do with this feature.
  test('a local session gets no tmp-root override', async () => {
    const local = await seedRepo(path.join(home, 'projects', 'plain'));
    assert.equal((await adoptProject('plain', local)).ok, true);
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'plain', mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(instances.get(r.body.id)._spawnEnv.CLAUDE_CODE_TMPDIR, process.env.CLAUDE_CODE_TMPDIR);
  });

  // PINS THE HOT PATH, end to end: the rewritten command, run by a real shell
  // exactly as the CLI would run it, executes on the SYSTEM and reports the
  // system's output and the command's own exit code.
  test('the rewritten Bash command really runs on the system', async () => {
    const r = await hook({ tool_name: 'Bash', tool_input: { command: 'cat ONLY-ON-SYSTEM.txt' } });
    const rewritten = r.body.hookSpecificOutput.updatedInput.command;
    assert.notEqual(rewritten, 'cat ONLY-ON-SYSTEM.txt', 'it was rewritten');

    const ran = await runAsTheCliWould(rewritten, root);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.stdout, 'system side\n');

    // And the other direction, which is the CLAIM THAT INVERTED: there is no
    // cc-only side of this directory any more. A path the command cannot see is
    // one that is not on the system, and cc no longer keeps a second copy of
    // the tree for a path to hide in.
    const miss = await hook({ tool_name: 'Bash', tool_input: { command: 'cat NOWHERE-AT-ALL.txt' } });
    const ran2 = await runAsTheCliWould(miss.body.hookSpecificOutput.updatedInput.command, root);
    assert.notEqual(ran2.code, 0, 'a genuinely absent file still fails');
  });

  // PINS: quoting survives the rewrite. The command travels through a shell as
  // one argv element, so a command containing quotes, `$` or a newline must
  // arrive byte-identical or the worker silently runs something else.
  test('a command full of shell metacharacters survives the rewrite', async () => {
    const expected = "it's $HOME & `backtick` \u00e9\n";
    const command = 'printf \'%s\\n\' "it\'s \\$HOME & \\`backtick\\` \u00e9" > out.txt; cat out.txt';
    const r = await hook({ tool_name: 'Bash', tool_input: { command } });
    const ran = await runAsTheCliWould(r.body.hookSpecificOutput.updatedInput.command, root);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.stdout, expected);
    // It landed on the SYSTEM — which is the one and only place it could.
    assert.equal(await fs.readFile(onSystem('out.txt'), 'utf8'), expected);
  });

  // PINS THE PHASE'S POINT: the worker sees output AS IT ARRIVES. The whole
  // chain is live here — the hook's rewrite, a real shell running it, the real
  // forwarder process, the real streaming endpoint, the real shell on the
  // system — and the assertion is structural: a forwarder that buffered to exit
  // would deliver part1 and part2 in one write.
  test('a redirected Bash streams its output instead of delivering it at exit', async () => {
    const r = await hook({ tool_name: 'Bash', tool_input: {
      command: 'printf "part1\\n"; sleep 0.5; printf "part2\\n"',
    } });
    const ran = await runAsTheCliWouldStreaming(r.body.hookSpecificOutput.updatedInput.command, root);

    assert.equal(ran.code, 0, ran.of('err'));
    assert.equal(ran.of('out'), 'part1\npart2\n', 'and the bytes are exactly right');
    assert.ok(
      ran.writes.some(w => w.text.includes('part1') && !w.text.includes('part2')),
      `part1 was never delivered on its own: ${JSON.stringify(ran.writes)}`,
    );
  });

  // PINS: stdout and stderr stay on their own file descriptors through the
  // streamed path. Merging them would put a command's output into the channel a
  // caller reads diagnostics from.
  test('streamed stdout and stderr arrive on their own descriptors', async () => {
    const r = await hook({ tool_name: 'Bash', tool_input: {
      command: 'printf "to-out\\n"; printf "to-err\\n" >&2; sleep 0.3; printf "more-out\\n"',
    } });
    const ran = await runAsTheCliWouldStreaming(r.body.hookSpecificOutput.updatedInput.command, root);
    assert.equal(ran.of('out'), 'to-out\nmore-out\n');
    assert.equal(ran.of('err'), 'to-err\n');
  });

  // PINS: the framing never reaches the worker on the streamed path either.
  // Streaming forwards bytes before the frame boundary has been seen, which is
  // exactly when a sentinel could leak.
  test('no framing leaks into a streamed result, even when the command echoes one', async () => {
    const r = await hook({ tool_name: 'Bash', tool_input: {
      command: 'printf "__CC_deadbeef__ 0 Lw==\\n"; sleep 0.3; printf "still here\\n"',
    } });
    const ran = await runAsTheCliWouldStreaming(r.body.hookSpecificOutput.updatedInput.command, root);
    assert.equal(ran.of('out'), '__CC_deadbeef__ 0 Lw==\nstill here\n',
      'a forged sentinel is the command\'s own output and survives verbatim');
    assert.equal(ran.code, 0);
  });

  // PINS: cc's own refusals still reach the worker. The endpoint answers in
  // frames now, so a refusal written in the old single-object shape would be
  // silently ignored by the forwarder and surface as an unexplained failure.
  test('a forwarder pointed at a session that is not redirected says so', async () => {
    const bogus = r0.body.hookSpecificOutput.updatedInput.command
      .replace(`/instances/${instId}/`, '/instances/no-such-instance/');
    const ran = await runAsTheCliWouldStreaming(bogus, root);
    assert.equal(ran.code, 1);
    assert.match(ran.of('err'), /not redirected to a system/);
  });


  // PINS: THE MIXED CASE, measured as the normal one — a Bash write followed
  // by an Edit on the same file. Both changes survive on the
  // system, because the Edit's pull refreshed the local copy first.
  test('a Bash write and an Edit on the same file both survive on the system', async () => {
    await fs.writeFile(onSystem('mix.txt'), 'alpha\nbeta\n');
    const b = await hook({ tool_name: 'Bash', tool_input: { command: "sed -i 's/alpha/ALPHA/' mix.txt" } });
    assert.equal((await runAsTheCliWould(b.body.hookSpecificOutput.updatedInput.command, root)).code, 0);

    await hook({ tool_name: 'Edit', tool_input: { file_path: inSession('mix.txt'), old_string: 'beta', new_string: 'BETA' } });
    // The pull left the local copy holding the Bash write; the CLI's edit
    // applies on top of that.
    const local = await fs.readFile(inSession('mix.txt'), 'utf8');
    assert.equal(local, 'ALPHA\nbeta\n');
    await fs.writeFile(inSession('mix.txt'), local.replace('beta', 'BETA'));
    await api(baseUrl, 'POST', `/api/instances/${instId}/hook-callback`, {
      hook_event_name: 'PostToolUse', tool_use_id: 'tp2', tool_name: 'Edit',
      tool_input: { file_path: inSession('mix.txt') }, tool_response: {},
    });
    assert.equal(await fs.readFile(onSystem('mix.txt'), 'utf8'), 'ALPHA\nBETA\n');
  });

  // PINS: killing the forwarder — what the CLI does when the worker INTERRUPTS
  // or stops a background task — stops the command ON THE SYSTEM. The socket
  // closing is cc's only signal that the worker no longer wants the command, so
  // a kill that left it running would leave work on someone else's machine with
  // nobody to read it.
  //
  // NOT a tool TIMEOUT: at the timeout the CLI detaches the forwarder rather
  // than killing it, so this test drives the kill itself rather than
  // reproducing one the timeout would have caused.
  //
  // IT MUST NOT ASSERT THE NEXT COMMAND IS TOLD ITS SHELL WAS RESTARTED.
  // Nothing is restarted — the command's own `exec` is killed and no state is
  // shared for anyone to lose — so telling the next command it lost its exports
  // would be an R5-class false statement about state it never had. What it must
  // say is nothing at all, which is asserted here.
  //
  // ITS BOUNDARY TWIN is `killing the forwarder stops the command inside the
  // container` in tests/systems-docker-boundary.real.test.mjs. That suite is
  // opt-in behind `RUN_DOCKER_SYSTEM=1` and is in neither gated command, so a
  // change made here alone sits red there unnoticed. Change one, change both.
  test('killing the forwarder stops the command on the system', async () => {
    const marker = onSystem('slow-finished.txt');
    const started = onSystem('slow-started.txt');
    const r = await hook({
      tool_name: 'Bash',
      tool_input: { command: `touch ${started}; sleep 20; touch ${marker}` },
    });
    const child = spawn('bash', ['-c', r.body.hookSpecificOutput.updatedInput.command], { cwd: root, stdio: 'ignore' });
    // The far side's own answer that the command is genuinely running: cc holds
    // no observable for it any more, and killing the forwarder before the
    // command started would prove nothing.
    await waitFor(() => fs.stat(started).then(() => true, () => false));
    child.kill('SIGKILL');

    const next = await hook({ tool_name: 'Bash', tool_input: { command: 'echo back' } });
    const ran = await runAsTheCliWouldStreaming(next.body.hookSpecificOutput.updatedInput.command, root);
    assert.equal(ran.of('out'), 'back\n');
    assert.equal(ran.of('err'), '', 'and it is told about no reset it never had');
    // The command really was stopped, not merely abandoned. `sleep 20` against a
    // test that gets here in well under a second, so the marker's absence is the
    // kill and not the clock.
    await assert.rejects(fs.stat(marker));
  });

  // T3's END-TO-END HALF: removing the session reaches the redirect's teardown
  // through the ROUTE, and a command still running on the system is stopped
  // there rather than merely abandoned.
  //
  // WHY THIS PATH AND NOT ONLY THE UNIT ONE (tests/systems-tool-redirect.test.mjs
  // exercises `SessionRedirect.close()` directly): the defect that motivated the
  // fix was found at the unit layer, and `close()` having a live lever proves
  // nothing about anything CALLING it. Instance exit, kill and DELETE all reach
  // it, and only a real DELETE proves the wiring.
  //
  // THE WITNESS IS THE FAR SIDE'S OWN FILESYSTEM, for the same reason as the
  // unit test: cc's bookkeeping reads clean whether the command was reaped or
  // forgotten, and only a file the command writes AFTER a delay can tell them
  // apart.
  //
  // NOT CLAIMING anything about the forwarder process's own exit code — the CLI
  // is not running here, and cc closing the response is what the forwarder sees.
  test('deleting the session stops a command still running on the system', async () => {
    const started = onSystem('DEL_STARTED.txt');
    const late = onSystem('DEL_LATE.txt');
    const r = await hook({ tool_name: 'Bash', tool_input: {
      command: `touch ${started}; sleep 3; touch ${late}`,
    } });
    // Not awaited: it is the in-flight command.
    const running = runAsTheCliWouldStreaming(r.body.hookSpecificOutput.updatedInput.command, root)
      .catch(() => {});
    await waitFor(() => fs.stat(started));

    const del = await api(baseUrl, 'DELETE', `/api/instances/${instId}`);
    assert.equal(del.status, 200, JSON.stringify(del.body));

    // Past when the command would have written it, had it survived teardown.
    await new Promise(res => setTimeout(res, 3500));
    await assert.rejects(fs.stat(late),
      'the command must not have run to completion after the session was deleted');
    await running;
  });

  // The TWO sentences a remote project adds to every worker's system prompt.
  //
  // It loads into the prompt of every session on the project, so it is held to
  // the workspace "System-prompt docs" rule: each sentence must change what the
  // agent DOES. Both do, and both were measured. The first pre-empts the
  // coordinate divergence the worker meets the moment a command prints a path.
  // The second says the CLI's file tools and the shell see the SAME path: the
  // CLI is chrooted at the system path, so that path IS the working directory
  // and a prohibition on using it would forbid the only path that works. It
  // makes no claim about where such a path can APPEAR, which is the claim a
  // wrong wording gets wrong.
  
  // PINS THE `inProcess` DEFAULT — the fail-safe polarity, which had no test.
  // Both STATED directions were pinned (RealClaudeLauncher declares `false`, the
  // in-process one declares `true`), but every launcher in the tree declares the
  // field, so `undefined` never occurred at runtime and nothing held the default.
  // That default is the whole reason the field is optional: a future launcher
  // class that omits it must get the union, not skip it — skipping would run a
  // remote worker unwrapped at a path that need not exist on cc's machine, which
  // is exactly the state deleting CC_FUSE_WORKERS was meant to make unreachable.
  //
  // THE MUTATION THIS MUST DIE UNDER: `!inst._launcher.inProcess` →
  // `inst._launcher.inProcess === false` in the create path. Under it a launcher
  // with no field attaches no FuseSession and the assertion below fails.
  //
  // The stub's `launch` THROWS, so nothing is spawned and no mount is attempted:
  // the decision under test is made at CREATE, before launch, and the instance
  // is registered in `byId` before launch runs — so the create failing is how
  // this stays fast and hermetic rather than something to work around.
  test('a launcher that declares no inProcess field still gets the union', async () => {
    const real = instances._claudeLauncher;
    instances._claudeLauncher = {
      launch() { throw new Error('stub launcher: nothing is spawned in this case'); },
    };
    // Identified by a DELTA of exactly one against the pre-call key set, not by
    // `.at(-1)`: this describe registers other instances, and a fallback that
    // took the newest key could read a leftover from an earlier case and pass
    // for the wrong reason.
    const idsBefore = new Set(instances.byId.keys());
    let id = null;
    try {
      const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
      // The create is EXPECTED to fail — at the spawn, or earlier at the FUSE
      // preflight on a host that cannot mount. Either way the decision has
      // already been made and recorded on the instance, which is registered
      // before launch runs.
      const fresh = [...instances.byId.keys()].filter(k => !idsBefore.has(k));
      assert.equal(fresh.length, 1,
        `exactly one instance should have been registered, got ${fresh.length}: ${JSON.stringify(r.body)}`);
      id = fresh[0];
      const inst = instances.byId.get(id);
      assert.notEqual(inst._fuse, null,
        'a launcher with no `inProcess` field ran a remote worker with NO union');
      // And the control half, so this is about the field and not about remoteness:
      // the same project on a launcher that DOES declare `inProcess` gets none.
      assert.equal(inst._redirect === null, false, 'the session was not redirected at all');
    } finally {
      instances._claudeLauncher = real;
      if (id) { try { await instances.remove(id); } catch { /* the create already failed */ } }
    }
  });

  // A10-LIVE — PINS CRITERION 15 AT THE PRODUCTION CALL SITE, which the unit
  // half in tests/systems-file-tool-refusals.test.mjs cannot reach.
  //
  // THIS IS THE THIRD ITERATION IN THIS EPIC OF ONE DEFECT: a test that exists,
  // reads correctly, and does not reach the call site it was written for. The
  // unit A10 asserts `===` between a hand-built SessionRedirect and a hand-built
  // FusePlan, which is a claim about the two constructors and NOT about
  // src/instances.ts — add a second `buildTierTable({...same input})` at the
  // `buildFusePlan` call and every unit assertion still passes: two arrays equal
  // today, free to drift tomorrow, suite green.
  //
  // Criterion 15 says a test must FAIL if the two can drift, so the claim has to
  // be made against the object graph the production create path actually built.
  //
  // THE MUTATION THIS MUST DIE UNDER: any second `buildTierTable(...)` call in
  // the create path feeding either consumer — equality survives it, identity
  // does not.
  //
  // Reached with the same stub-launcher technique as the arm above and for the
  // same reason: the wiring under test is done at CREATE, before launch, and the
  // instance is registered in `byId` before launch runs — so a throwing `launch`
  // keeps this hermetic with no mount and no spawn.
  test('the redirect and the fuse plan hold the SAME tier table object', async () => {
    const real = instances._claudeLauncher;
    instances._claudeLauncher = {
      launch() { throw new Error('stub launcher: nothing is spawned in this case'); },
    };
    const idsBefore = new Set(instances.byId.keys());
    let id = null;
    try {
      await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
      const fresh = [...instances.byId.keys()].filter(k => !idsBefore.has(k));
      assert.equal(fresh.length, 1, 'exactly one instance should have been registered');
      id = fresh[0];
      const inst = instances.byId.get(id);
      // Both consumers exist at all — without this the identity below could hold
      // vacuously on two undefineds.
      assert.notEqual(inst._redirect, null, 'the session was not redirected');
      assert.notEqual(inst._fuse, null, 'the session got no union');
      assert.ok(Array.isArray(inst._redirect.tiers), 'the redirect holds no table');
      assert.ok(inst._redirect.tiers.length > 0, 'the table is empty, so identity would be trivial');
      // THE CLAIM: one object, not two equal ones.
      assert.equal(inst._redirect.tiers, inst._fuse.plan.tiers,
        'the hook and the daemon hold different tier-table objects — they can now drift');
      // And the pins the daemon parses were rendered from THAT object, so the
      // identity reaches the artifact rather than stopping at a field.
      const projectLines = inst._fuse.plan.pinsText.split('\n').filter(l => l.startsWith('project\t'));
      assert.ok(projectLines.length > 0, 'the rendered pins carry no project rule');
      for (const e of inst._redirect.tiers.filter(t => t.tier === 'project')) {
        assert.ok(projectLines.includes(`project\t${e.prefix}`),
          `${e.prefix} is in the hook's table but not in the rendered pins`);
      }
    } finally {
      instances._claudeLauncher = real;
      if (id) { try { await instances.remove(id); } catch { /* the create already failed */ } }
    }
  });

  test('a remote project discloses its system, and a local one says nothing', async () => {
    const doc = await composeProjectConventionsDoc([], { system: { id: 'prod-box', path: '/app' } });
    const block = doc.split('# Workspace conventions')[0];
  
    assert.match(block, /^<!-- cc:conventions/, 'the marker is still line 1');
    assert.match(block, /^# System$/m);
    assert.match(block, /\/app.*prod-box/s);
    assert.match(block, /Bash.*run/s);
    // THE CORRECTION: the CLI is chrooted at the system path, so that path IS
    // the working directory, and a prohibition on using it would forbid the
    // only path that works.
    assert.match(block, /working directory/);
    assert.match(block, /same path/);
    assert.ok(!/never at their/.test(block),
      'the doc still forbids the system path, which is now the working directory');
  
    const local = await composeProjectConventionsDoc([]);
    assert.ok(!/^# System$/m.test(local), 'a local project carries no such section');
  });
  
  // PINS: the pair says nothing false. This is a SYSTEM PROMPT — a worker
  // holding a false statement from it has to decide which of the two to trust —
  // and every wording this sentence has had was falsified by a later change, so
  // the claims it must not make are pinned rather than only the ones it makes.
  test('the disclosure makes no claim the geometry has falsified', async () => {
    const block = (await composeProjectConventionsDoc([], { system: { id: 'prod-box', path: '/app' } }))
      .split('# Workspace conventions')[0];
    // Two dead wordings: "appears only in command output", and the local/system
    // path split that the chroot collapsed.
    assert.ok(!/only in command output/.test(block), block);
    assert.ok(!/local path/i.test(block), block);
    // And it does not claim there is a second spelling to prefer.
    assert.ok(!/never at their/.test(block), block);
    // The behavioural half: one path, named as such.
    assert.match(block, /same path/);
  });

  // PINS A DELETION, WHICH IS THE ONLY WAY A DELETION FROM A SYSTEM PROMPT
  // STAYS DELETED. NO SENTENCE MAY SAY SHELL STATE IS PER AGENT: with one shell
  // per command nothing an agent's command sets reaches ANY later command, its
  // own included — exactly as locally — so such a sentence has no subject.
  //
  // EACH NEGATIVE IS A CLAIM SOMEONE WOULD PLAUSIBLY RE-ADD, not a grep for
  // absence: a per-agent shell-state sentence, the two clauses that would
  // over-claim beside it, and the "every command starts at the project root"
  // fact that is deliberately NOT here — it is delivered by cc's own
  // notice on the one command whose `cd` was discarded, at the point of use,
  // which the workspace "push what nothing volunteers" rule prefers to a
  // sentence every session pays for.
  //
  // NOT CLAIMING that the two surviving sentences are enough — the tests above
  // pin what each of them says.
  test('the disclosure says nothing about shells, agents or where a command starts', async () => {
    const block = (await composeProjectConventionsDoc([], { system: { id: 'prod-box', path: '/app' } }))
      .split('# Workspace conventions')[0];

    assert.ok(!/shell/i.test(block), `it makes no claim about shells: ${block}`);
    assert.ok(!/subagent|each agent/i.test(block), `nor about agents: ${block}`);
    assert.ok(!/starts/i.test(block), `nor about where a command starts: ${block}`);
    assert.ok(!/background/i.test(block), `nor about background jobs: ${block}`);
    assert.ok(!/export/i.test(block), `nor about exported variables: ${block}`);

    // And a local project still says nothing at all.
    assert.ok(!/^# System$/m.test(await composeProjectConventionsDoc([])));
  });

  // PINS: the sentence really reaches the worker — it is written into the
  // project's CONVENTIONS.md on the SYSTEM and pulled into the session root,
  // which is where the CLI's `@CONVENTIONS.md` import reads it from.
  test('the disclosure reaches the session root through the system copy', async () => {
    const onSys = await fs.readFile(path.join(tree, 'CONVENTIONS.md'), 'utf8');
    assert.match(onSys, /^# System$/m);
    assert.match(onSys, new RegExp(remote.id));
    assert.equal(await fs.readFile(path.join(root, 'CONVENTIONS.md'), 'utf8'), onSys);
  });
});

// ── A session's commands, on a system that serves many targets ─────
//
// Every command is its own `exec` on the project's bound handle, so it must land
// on the project's target — not on the provider's default,
// and not on a sibling project's. Asserted with CC_REMOTE, because on a machine
// where every target is one filesystem "the command worked" is exactly what the
// wrong target produces too.
describe('a worker session on a system serving many targets', () => {
  let ctx, baseUrl, instances, home, sandbox, remote, tree, instId, root;

  before(async () => { ctx = await bootServer(); ({ baseUrl, instances } = ctx); });
  after(async () => { await ctx.close(); });

  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    sandbox = await fs.realpath(await mkdtemp('cc-remote-'));
    remote = await bindRemoteSystem({ flags: ['--remote', `a=${sandbox}`, '--remote', `b=${sandbox}`] });
    tree = await seedRepo(path.join(sandbox, 'app'));
    // Bound to `b` deliberately: the FIRST target would also be what a
    // defaulting bug picked.
    assert.equal((await adoptProject('app', tree, { system: remote.id, remoteId: 'b' })).ok, true);
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    instId = r.body.id;
    root = tree;
    await waitFor(() => instances.get(instId).status === 'idle');
  });

  afterEach(async () => {
    await ctx.instances.shutdown();
    disposeSystemHandles();
    await rmrf(home);
  });

  // PINS: a redirected Bash command runs on the project's OWN target, all the
  // way through the real hook, the real forwarder and the real shell.
  test("a session shell's commands land on the project's target", async () => {
    const r = await api(baseUrl, 'POST', `/api/instances/${instId}/hook-callback`, {
      session_id: 's', hook_event_name: 'PreToolUse', tool_use_id: 'tu-remote',
      tool_name: 'Bash', tool_input: { command: 'echo "$CC_REMOTE"' },
    });
    const ran = await runAsTheCliWould(r.body.hookSpecificOutput.updatedInput.command, root);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.stdout.trim(), 'b');
  });

  // PINS: the file bridge is bound too — a hooked Read pulls through the
  // project's target, so the bytes the worker sees came from the right machine.
  test('a hooked Read pulls through the bound target', async () => {
    await fs.writeFile(path.join(tree, 'note.txt'), 'from target b\n');
    const local = path.join(root, 'note.txt');
    const d = await api(baseUrl, 'POST', `/api/instances/${instId}/hook-callback`, {
      session_id: 's', hook_event_name: 'PreToolUse', tool_use_id: 'tu-read',
      tool_name: 'Read', tool_input: { file_path: local },
    });
    assert.equal(d.body.hookSpecificOutput.permissionDecision, 'allow',
      d.body.hookSpecificOutput.permissionDecisionReason);
    assert.equal(await fs.readFile(local, 'utf8'), 'from target b\n');
  });
});

// ARM A OF THE LAUNCHER-RESOLUTION PAIR. Its own server, because the file's
// default in-process boot is EXEMPT by design (see the arm-B control above) and
// so cannot drive this path at all: only a launcher that spawns an OS process
// gets a chroot, and only a chroot needs a marking event.
//
// Nothing is mounted here — the refusal fires in `_doCreateResolved`, above
// `new Instance(…)` and long before any FUSE preflight — so this costs a
// process-launcher boot and no sudo.
// PATH stripped of `claude`, by the SAME predicate `resolveOnPath` uses, so the
// empty-CLAUDE_BIN case below genuinely fails to resolve whether or not the
// machine running the suite has the CLI installed. Filtering the entries that
// hold one — rather than emptying PATH — keeps everything else on it reachable.
function pathWithoutClaude() {
  return (process.env.PATH ?? '').split(path.delimiter).filter((dir) => {
    if (!dir) return false;
    try { accessSync(path.join(dir, 'claude'), fsc.X_OK); return false; }
    catch { return true; }
  }).join(path.delimiter);
}

describe('a union-bound spawn whose launcher does not resolve', () => {
  let ctx, baseUrl, instances, home, remote, tree;

  before(async () => { ctx = await bootServer({ realProcess: true }); ({ baseUrl, instances } = ctx); });
  after(async () => { await ctx.close(); });

  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    remote = await bindRemoteSystem();
    tree = await seedRepo(path.join(remote.root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: remote.id })).ok, true);
  });

  afterEach(async () => {
    await ctx.instances.shutdown();
    disposeSystemHandles();
    await rmrf(home);
  });

  const BAD = 'cc-no-such-command-anywhere';

  const withBin = async (value, fn) => {
    const saved = process.env.CLAUDE_BIN;
    if (value === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = value;
    try { return await fn(); } finally {
      if (saved === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = saved;
    }
  };

  // PINS: the absolute path of the CLI is the union's marking event and the
  // CLI's only host pin, so a spawn that cannot resolve one is refused rather
  // than mounted with a mark path nothing can ever match — the silent
  // host-only filesystem the daemon's own refusal exists to prevent. Over HTTP
  // the STATUS is the machine-readable half (the shared error handler sends the
  // message alone), so the code itself is pinned on the thrown error below.
  test('is refused 501, leaving no instance behind', async () => {
    const before = instances.list().length;
    await withBin(BAD, async () => {
      const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
      assert.equal(r.status, 501, JSON.stringify(r.body));
      // No session was registered: a refusal that left a phantom instance
      // behind would be resumable into the very state it refused.
      assert.equal(instances.list().length, before);
    });
  });

  // PINS THE REFUSAL'S IDENTITY AND ITS DIAGNOSIS, at the layer that carries
  // both. `code` is asserted as a FIELD rather than read out of the message:
  // the message opens with the same token, so a body-wide match is satisfied by
  // the prose and says nothing about what a caller branches on. And the message
  // must name the VALUE that failed to resolve — a sentence that only mentions
  // `CLAUDE_BIN` as the repair leaves an operator with no way to see what cc
  // actually tried.
  test('carries code FUSE_LAUNCHER_UNRESOLVED and names the value it tried', async () => {
    await withBin(BAD, async () => {
      await assert.rejects(
        async () => instances.create({ project: 'app', mode: 'bypassPermissions' }),
        (e) => {
          assert.equal(e.code, 'FUSE_LAUNCHER_UNRESOLVED', `code field: ${e.code} — ${e.message}`);
          assert.equal(e.statusCode, 501, e.message);
          assert.match(e.message, new RegExp(`Tried '${BAD}'`), e.message);
          assert.match(e.message, new RegExp(`CLAUDE_BIN is "${BAD}"`), e.message);
          return true;
        },
      );
    });
  });

  // PINS THE SPELLING DOCKER SHIPS, all the way into this refusal:
  // `docker/compose.yaml` renders `CLAUDE_BIN: ""`, which resolves to the stock
  // `claude` — so with no `claude` on PATH the union-bound spawn is refused
  // here, and the message must render BOTH halves. They differ in this case
  // (raw `""`, resolved `claude`) and that is exactly why neither may be
  // printed in place of the other: the raw value alone says nothing about what
  // was looked up, and the resolved spelling alone hides that the operator set
  // the variable empty.
  test('the empty CLAUDE_BIN docker ships is refused, naming the raw value AND the resolved spelling', async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = pathWithoutClaude();
    try {
      await withBin('', async () => {
        const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
        assert.equal(r.status, 501, JSON.stringify(r.body));
        assert.match(r.body.error, /CLAUDE_BIN is ""/, r.body.error);
        assert.match(r.body.error, /Tried 'claude'/, r.body.error);
      });
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });
});

// THE PLACEMENT INVARIANT, which is the whole reason the refusal lives in
// `_doCreateResolved`'s `if (remote)` block rather than beside the value it
// guards: it runs ABOVE `new Instance(…)` and therefore above the resume
// reclaim, so a REFUSED resume must leave the session's existing instance
// exactly as it found it (docs/architecture.md → "Resume reclaims the instances
// it supersedes"). The reclaim calls `remove()`, so a guard below it destroys a
// session on the way out of a refusal — invisible to any test that only ever
// refuses a FRESH spawn.
//
// THE LAUNCHER IS INJECTED rather than `realProcess: true` because the husk has
// to EXIST first, and on a subprocess launcher a remote-project session gets a
// FuseSession and a real mount — which the default suite cannot require. The
// injected launcher runs the CLI in cc's own process throughout and carries the
// one structural fact the refusal is gated on (`inProcess`) as its own state,
// so the husk is spawned under the exemption and the resume is not.
describe('a RESUME whose launcher does not resolve', () => {
  let ctx, baseUrl, instances, launcher, home, claudeProjectsRoot, remote, tree;

  before(async () => {
    launcher = new InProcessClaudeLauncher();
    ctx = await bootServer({ claudeLauncher: launcher });
    ({ baseUrl, instances } = ctx);
  });
  after(async () => { await ctx.close(); });

  beforeEach(async () => {
    launcher.inProcess = true;
    ({ home, claudeProjectsRoot } = await freshProjectsRoot());
    remote = await bindRemoteSystem();
    tree = await seedRepo(path.join(remote.root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: remote.id })).ok, true);
  });

  afterEach(async () => {
    launcher.inProcess = true;
    await ctx.instances.shutdown();
    disposeSystemHandles();
    await rmrf(home);
  });

  test('leaves the superseded instance registered and answering to the session', async () => {
    const created = await api(baseUrl, 'POST', '/api/instances',
      { project: 'app', temp: false, mode: 'bypassPermissions' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const husk = instances.get(created.body.id);
    await waitFor(() => husk.status === 'idle' && husk.sessionId);
    const sessionId = husk.sessionId;
    // The fake engine writes no transcript, and the resume pre-flight wants
    // one: seeded so the resume below is refused by the LAUNCHER guard and not
    // by a missing conversation.
    await seedSessionJsonl(claudeProjectsRoot, husk.cwd, husk.backingSessionId);
    await husk.kill({ graceMs: 50 });
    await waitFor(() => !husk.proc && (husk.status === 'exited' || husk.status === 'crashed'));
    assert.equal(instances.get(husk.id), husk, 'premise: a non-temp exit is RETAINED in byId');

    launcher.inProcess = false;
    const saved = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = 'cc-no-such-command-anywhere';
    try {
      await assert.rejects(
        async () => instances.create({ project: 'app', resume: sessionId, mode: 'bypassPermissions' }),
        (e) => {
          // Past _doCreate's 409 liveness guard — which this settled husk
          // passes — and therefore past the point an early reclaim would fire.
          assert.equal(e.code, 'FUSE_LAUNCHER_UNRESOLVED', `${e.statusCode}: ${e.message}`);
          return true;
        },
      );
    } finally {
      launcher.inProcess = true;
      if (saved === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = saved;
    }

    assert.equal(instances.get(husk.id), husk,
      'the refused resume reclaimed the instance it was superseding — the sidebar row and every '
      + 'timer, arm and connection remove() takes with it go with it');
    assert.deepEqual(instances.idsForSession(sessionId), [husk.id],
      'and it is still the session\'s one instance');
  });
});
