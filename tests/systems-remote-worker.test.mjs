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

describe('a worker session on a remote system', () => {
  let ctx, baseUrl, instances, home, remote, tree, instId, root;

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
    const ran = await runAsTheCliWould(next.body.hookSpecificOutput.updatedInput.command, root);
    assert.equal(ran.stdout, 'back\n');
    assert.match(ran.stderr, /was restarted/);
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
});
