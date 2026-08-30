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
import { adoptProject } from '../src/projects.ts';
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
  // interrupt — stops the command on the system, and the NEXT command tells the
  // worker its shell was restarted rather than looking continuous.
  test('killing the forwarder resets the shell and the next command says so', async () => {
    const marker = onSystem('slow-finished.txt');
    const r = await hook({ tool_name: 'Bash', tool_input: { command: `sleep 20; touch ${marker}` } });
    const child = spawn('bash', ['-c', r.body.hookSpecificOutput.updatedInput.command], { cwd: root, stdio: 'ignore' });
    await waitFor(async () => instances.get(instId)._redirect.shellOpen);
    child.kill('SIGKILL');

    const next = await hook({ tool_name: 'Bash', tool_input: { command: 'echo back' } });
    const ran = await runAsTheCliWouldStreaming(next.body.hookSpecificOutput.updatedInput.command, root);
    assert.equal(ran.of('out'), 'back\n');
    assert.match(ran.of('err'), /was restarted/);
    // FIRST on stderr, ahead of anything else there: a shell that lost its
    // exports has to say so before output that may be wrong because of it.
    assert.match(ran.writes.filter(w => w.fd === 'err')[0].text, /^\[cc\]/);
    // The command really was stopped, not merely abandoned.
    await assert.rejects(fs.stat(marker));
  });

  // PINS: removing the session closes its shell on the system. A shell left
  // open is a process on someone else's machine keyed to a session that is
  // gone — and removal has to do it independently of the process teardown,
  // since a crashed or already-exited session has no process left to kill.
  test('removing the session closes its shell on the system', async () => {
    const r = await hook({ tool_name: 'Bash', tool_input: { command: 'echo hi' } });
    await runAsTheCliWould(r.body.hookSpecificOutput.updatedInput.command, root);
    const redirect = instances.get(instId)._redirect;
    assert.equal(redirect.shellOpen, true);
    assert.equal(instances.get(instId).proc, null, 'no process left — the shell must still be reaped');

    const del = await api(baseUrl, 'DELETE', `/api/instances/${instId}`);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(redirect.shellOpen, false);
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
  
  test('a remote project discloses its system in one sentence pair, and a local one says nothing', async () => {
    const doc = await composeProjectConventionsDoc([], { system: { id: 'prod-box', path: '/app' } });
    const block = doc.split('# Workspace conventions')[0];
  
    assert.match(block, /^<!-- cc:conventions/, 'the marker is still line 1');
    assert.match(block, /^# System$/m);
    assert.match(block, /\/app.*prod-box/s);
    assert.match(block, /Bash.*run/s);
    // The correction: local paths for reading and editing, system paths only in
    // output. A doc that says the opposite is worse than saying nothing.
    assert.match(block, /working directory/);
    assert.match(block, /only in command output/);
    assert.ok(!/Read `?\/app/.test(block), 'it never suggests reading a system path');
  
    const local = await composeProjectConventionsDoc([]);
    assert.ok(!/^# System$/m.test(local), 'a local project carries no such section');
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
