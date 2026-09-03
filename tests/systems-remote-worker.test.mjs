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
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { bootServer, api, freshProjectsRoot, rmrf, waitFor } from './helpers.mjs';
import { bindRemoteSystem, seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { adoptProject, orchStoreRoot } from '../src/projects.ts';
import { sessionTmpDir, sweepSessionTmpDirs } from '../src/instances.ts';
import { attachmentsDir } from '../src/worktrees.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { sessionRootPath } from '../src/systems/sessionRoot.ts';
import { composeProjectConventionsDoc } from '../src/projectClaudeMd.ts';

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
    root = sessionRootPath(remote.id, 'app', null);
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

  // PINS: the session's cwd is the local session root and it holds the config
  // surface pulled from the system — the CLI reads CLAUDE.md and `.claude/**`
  // with no hook, so anything not pulled here is simply absent from the prompt.
  test('the session root is composed from the system before the CLI starts', async () => {
    assert.equal(instances.get(instId).cwd, root);
    // Byte-identical to the system's copy — the local one is a read-only
    // snapshot of it, not a second document. (Adoption regenerated it on the
    // system, so its body is cc's composed conventions rather than the seed.)
    assert.equal(
      await fs.readFile(inSession('CONVENTIONS.md'), 'utf8'),
      await fs.readFile(onSystem('CONVENTIONS.md'), 'utf8'),
    );
    assert.match(await fs.readFile(inSession('CONVENTIONS.md'), 'utf8'), /^<!-- cc:conventions/);
    assert.match(await fs.readFile(inSession('CLAUDE.md'), 'utf8'), /^@CONVENTIONS\.md$/m);
    // The tree itself is NOT mirrored.
    await assert.rejects(fs.readFile(inSession('ONLY-ON-SYSTEM.txt')));
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
  test('the spawn argv carries the redirected settings', async () => {
    const argv = instances.get(instId)._spawnArgv;
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]);
    assert.deepEqual(settings.permissions.deny, ['Glob', 'Grep']);
    assert.match(settings.hooks.PreToolUse[0].matcher, /\bRead\b/);
    assert.ok(settings.hooks.PostToolUse);
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

  // PINS C1: the file-tool grant is the SPECIFIC paths a session needs, not the
  // whole cc store. With the store root granted, a worker on a remote project
  // could read AND write `settings.json`, `conventions/*.json`, every other
  // project's `project.json` and pulled session roots, every session sidecar
  // store, `shell-env` bundles, plugin manifests — a reviewer proved the write
  // half by overwriting cc's real convention store.
  //
  // Each path below is one a reviewer enumerated live. Asserted through the real
  // hook endpoint, and for the WRITE direction too: a deny on Read that let
  // Write through would be the worse half.
  test('a worker cannot reach cc own store outside its own two grants', async () => {
    const store = orchStoreRoot();
    const forbidden = {
      'app settings': path.join(store, 'settings.json'),
      'the convention store': path.join(store, 'conventions', 'workspace.json'),
      'another project metadata': path.join(store, 'projects', 'other', 'project.json'),
      'a session sidecar store': path.join(store, 'session-titles.json'),
      'a shell-env bundle': path.join(store, 'shell-env', 'bundle.json'),
      'another system pulled session root': path.join(store, 'systems', 'other', 'sessions', 'x', 'CLAUDE.md'),
    };
    for (const [what, file] of Object.entries(forbidden)) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, '{"real":"content"}');
      for (const tool of ['Read', 'Write', 'Edit']) {
        const d = await hook({ tool_name: tool, tool_input: { file_path: file } });
        assert.equal(d.body.hookSpecificOutput.permissionDecision, 'deny',
          `${tool} of ${what} (${file}) must be refused`);
      }
      // And nothing touched it.
      assert.equal(await fs.readFile(file, 'utf8'), '{"real":"content"}');
    }
  });

  // PINS C1's other half: another session's task output is refused. The comment
  // at the tmp-root pin claims "one session must not be able to read another's
  // task output" — measured, a probe read one and was ALLOWED, with a UUID the
  // orchestrator hands workers via list_sessions as the only separator.
  test('a worker cannot read another session task output', async () => {
    const mine = instances.get(instId)._spawnEnv.CLAUDE_CODE_TMPDIR;
    const theirs = path.join(orchStoreRoot(), 'session-tmp', 'some-other-instance-id');
    await fs.mkdir(path.join(theirs, 'tasks'), { recursive: true });
    const file = path.join(theirs, 'tasks', 'abc.output');
    await fs.writeFile(file, 'another session output\n');

    const d = await hook({ tool_name: 'Read', tool_input: { file_path: file } });
    assert.equal(d.body.hookSpecificOutput.permissionDecision, 'deny');
    // Its OWN is still reachable — the grant is per session, not per feature.
    const ownFile = path.join(mine, 'tasks', 'own.output');
    await fs.mkdir(path.dirname(ownFile), { recursive: true });
    await fs.writeFile(ownFile, 'mine\n');
    const ok = await hook({ tool_name: 'Read', tool_input: { file_path: ownFile } });
    assert.equal(ok.body.hookSpecificOutput.permissionDecision, 'allow',
      ok.body.hookSpecificOutput.permissionDecisionReason);
  });

  // PINS C1's kept grant: the OWNING project's attachments dir stays allowed.
  // An attachment is a local file the user handed this session, referenced by
  // absolute path in the prompt (S24) — refusing it would break attachments on
  // every remote project.
  test('the owning project attachments dir stays readable, another project does not', async () => {
    const mine = path.join(attachmentsDir('app', null), 'shot.png');
    await fs.mkdir(path.dirname(mine), { recursive: true });
    await fs.writeFile(mine, 'png bytes');
    const ok = await hook({ tool_name: 'Read', tool_input: { file_path: mine } });
    assert.equal(ok.body.hookSpecificOutput.permissionDecision, 'allow',
      ok.body.hookSpecificOutput.permissionDecisionReason);

    const other = path.join(attachmentsDir('someone-else', null), 'shot.png');
    await fs.mkdir(path.dirname(other), { recursive: true });
    await fs.writeFile(other, 'png bytes');
    const no = await hook({ tool_name: 'Read', tool_input: { file_path: other } });
    assert.equal(no.body.hookSpecificOutput.permissionDecision, 'deny');
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

    // And the other direction: a file that exists only in the session root is
    // NOT visible to the command, because the command is on the other machine.
    await fs.writeFile(inSession('ONLY-ON-CC.txt'), 'cc side\n');
    const miss = await hook({ tool_name: 'Bash', tool_input: { command: 'cat ONLY-ON-CC.txt' } });
    const ran2 = await runAsTheCliWould(miss.body.hookSpecificOutput.updatedInput.command, root);
    assert.notEqual(ran2.code, 0);
  });

  // PINS ALL FOUR HOPS of the agent id at once — hook envelope → forwarder argv
  // → forwarder POST body → runForwarded — by a witness that cannot be faked by
  // a hop that dropped it: the far side's OWN `pwd`.
  //
  // THE WITNESS MOVED ON CARD 2026-0312. It used to be the far-side shell's `$$`,
  // which no longer distinguishes anything: every command is its own process, so
  // every pid differs whether or not the id survived the trip.
  //
  // THIS IS THE FAIL-OPEN CATCHER. If `--agent` is lost anywhere on that path,
  // the subagent's command still runs and still exits zero; it just lands on the
  // main agent's cwd, and the two answers become equal.
  //
  // NOT CLAIMING that the CLI populates `agent_id` — this test supplies it. That
  // contract is the gated tests/systems-cli-contract.real.test.mjs's subject.
  test("a subagent's Bash keeps its own working directory, end to end", async () => {
    const moved = await hook({
      tool_name: 'Bash', tool_input: { command: 'cd / && pwd' }, agent_id: 'a8620fbbffcb7f234',
    });
    const ranMoved = await runAsTheCliWould(moved.body.hookSpecificOutput.updatedInput.command, root);
    assert.equal(ranMoved.stdout.trim(), '/', ranMoved.stderr);

    const where = await hook({ tool_name: 'Bash', tool_input: { command: 'pwd' } });
    const ranWhere = await runAsTheCliWould(where.body.hookSpecificOutput.updatedInput.command, root);
    assert.equal(ranWhere.stdout.trim(), tree, "the main agent's shell never moved");

    // And the subagent's own next command is still where it left it — so the id
    // survived the round trip in BOTH directions, not just once.
    const again = await hook({
      tool_input: { command: 'pwd' }, tool_name: 'Bash', agent_id: 'a8620fbbffcb7f234',
    });
    const ranAgain = await runAsTheCliWould(again.body.hookSpecificOutput.updatedInput.command, root);
    assert.equal(ranAgain.stdout.trim(), '/', 'the subagent came back to its own cwd');
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
    // It landed on the SYSTEM, not in the session root.
    assert.equal(await fs.readFile(onSystem('out.txt'), 'utf8'), expected);
    await assert.rejects(fs.readFile(inSession('out.txt')));
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

  // PINS: the full Read → Edit → write-back round trip over the REST hooks,
  // with the note that says where it landed.
  test('Read pulls and Edit pushes back, through the hook endpoint', async () => {
    await fs.writeFile(onSystem('greeting.js'), 'console.log("Hi")\n');

    const read = await hook({ tool_name: 'Read', tool_input: { file_path: inSession('greeting.js') } });
    assert.equal(read.body.hookSpecificOutput.permissionDecision, 'allow');
    assert.equal(await fs.readFile(inSession('greeting.js'), 'utf8'), 'console.log("Hi")\n');

    // The CLI applies the edit itself, locally, at that path.
    await hook({ tool_name: 'Edit', tool_input: { file_path: inSession('greeting.js'), old_string: 'Hi', new_string: 'Hello' } });
    await fs.writeFile(inSession('greeting.js'), 'console.log("Hello")\n');

    const post = await api(baseUrl, 'POST', `/api/instances/${instId}/hook-callback`, {
      hook_event_name: 'PostToolUse', tool_use_id: 'tp1', tool_name: 'Edit',
      tool_input: { file_path: inSession('greeting.js') }, tool_response: {},
    });
    assert.match(post.body.hookSpecificOutput.additionalContext, /Saved to/);
    assert.equal(await fs.readFile(onSystem('greeting.js'), 'utf8'), 'console.log("Hello")\n');
  });

  // PINS: THE MIXED CASE, which the spike measured as the normal one — a Bash
  // write followed by an Edit on the same file. Both changes survive on the
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

  // PINS: killing the forwarder — what the CLI does on a tool timeout or an
  // interrupt — stops the command ON THE SYSTEM. The socket closing is cc's only
  // signal that the worker no longer wants the command, so a kill that left it
  // running would leave work on someone else's machine with nobody to read it.
  //
  // RE-BASED on card 2026-0312: this also used to assert the NEXT command was
  // told its shell had been restarted. Nothing is restarted — the command's own
  // `exec` was killed and no state was shared for anyone to lose — so telling
  // the next command it lost its exports would be an R5-class false statement
  // about state it never had. What it must still say is nothing at all, which is
  // asserted here.
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

  // The one sentence a remote project adds to every worker's system prompt.
  //
  // It loads into the prompt of every session on the project, so it is held to
  // the workspace "System-prompt docs" rule: each sentence must change what the
  // agent DOES. Both do, and both were measured. The first pre-empts the
  // coordinate divergence the worker meets the moment a command prints a path.
  // The second is the correction the spike forced: an earlier wording that said
  // system paths "are the system's copies of what you see locally" sent the model
  // straight to `Read /app/greeting.py`, which cannot work — the CLI reads
  // locally. It must say files are read and edited at their LOCAL paths and that
  // system paths appear only in command output.
  
  test('a remote project discloses its system, and a local one says nothing', async () => {
    const doc = await composeProjectConventionsDoc([], { system: { id: 'prod-box', path: '/app' } });
    const block = doc.split('# Workspace conventions')[0];
  
    assert.match(block, /^<!-- cc:conventions/, 'the marker is still line 1');
    assert.match(block, /^# System$/m);
    assert.match(block, /\/app.*prod-box/s);
    assert.match(block, /Bash.*run/s);
    // The correction: local paths for reading and editing, and a prohibition on
    // opening a system path. A doc that says the opposite is worse than saying
    // nothing.
    assert.match(block, /working directory/);
    assert.match(block, /never at their `\/app` paths/);
    assert.ok(!/Read `?\/app/.test(block), 'it never suggests reading a system path');
  
    const local = await composeProjectConventionsDoc([]);
    assert.ok(!/^# System$/m.test(local), 'a local project carries no such section');
  });
  
  // PINS S5: the pair says nothing false. The earlier wording claimed a system
  // path "appears only in command output" — and cc's own PostToolUse note puts
  // one on a tool RESULT ("Saved to /app/… on system '<id>'."), which is not
  // command output. A worker holding a false statement from its system prompt
  // has to decide which of the two to trust.
  test('the disclosure does not claim system paths appear only in command output', async () => {
    const block = (await composeProjectConventionsDoc([], { system: { id: 'prod-box', path: '/app' } }))
      .split('# Workspace conventions')[0];
    assert.ok(!/only in command output/.test(block), block);
    // The behavioural half survives: never open a system path, and it names the
    // same file as its local counterpart.
    assert.match(block, /never/i);
    assert.match(block, /same file/);
  });

  // PINS AC6: the disclosure states that shell state is PER AGENT. On a remote
  // system `export` persists across an agent's own commands, where a local
  // session persists neither `export` nor `cd` — each local `Bash` call gets a
  // brand-new shell and the CLI resets the working directory to the project root
  // (measured on CLI 2.1.258; card 2026-0305 §2, correcting an earlier wording
  // here that said only `cd` failed to persist locally). So the asymmetry is
  // wider than it was documented as, and it invites the false generalisation
  // that a dispatched subagent inherits it; told, the agent passes the value in the subagent's prompt instead, and
  // told the converse it stops treating a subagent's `cd` as a hazard to its own
  // state. Nothing else volunteers either half: a missing export in a subagent
  // looks like an ordinary unset variable, and a subagent's `cd` NOT reaching the
  // parent is unobservable by construction.
  //
  // The two negative assertions are the two clauses deliberately CUT from the
  // draft, pinned so a later editor does not re-add them. "a subagent's Bash
  // starts at <systemPath>" is true only of that subagent's FIRST command, so a
  // subagent reading it would hold a false statement about itself — and neither
  // reader needs to know where the other starts, only that state does not cross.
  // "background jobs" is non-vacuously true in only one of the two capability
  // modes, and changes nothing the cwd/exports clause does not already change;
  // the facts a worker acts on about background jobs are delivered at the point
  // of use, by the reset notice and docs/features.md.
  //
  // NOT CLAIMING that the model obeys it.
  test('the disclosure states that each agent has its own shell', async () => {
    const block = (await composeProjectConventionsDoc([], { system: { id: 'prod-box', path: '/app' } }))
      .split('# Workspace conventions')[0];

    assert.match(block, /Each agent has its own shell here/);
    assert.match(block, /not shared with a subagent you dispatch/);
    assert.match(block, /in either direction/);

    assert.ok(!/starts/.test(block), `it makes no claim about where a subagent's Bash starts: ${block}`);
    assert.ok(!/background/i.test(block), `it makes no claim about background jobs: ${block}`);

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

// ── A session's shell, on a system that serves many targets ────────
//
// Every agent's shell is opened with an `exec` on the project's bound handle, so
// its commands must land on the project's target — not on the provider's default,
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
    root = sessionRootPath(remote.id, 'app', null);
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
