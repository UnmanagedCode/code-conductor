// The redirection policy: which tool call crosses to the system, which is
// refused, and what the worker is told.
//
// THE INVARIANT UNDER TEST IS BOUNDARY CONSISTENCY. A tool that half-redirects
// — a path visible from one side and not the other — is what makes a model
// distrust its own tool results and report the environment as broken. So every
// tool that can observe or mutate the system's tree is either fully redirected
// or refused by name; nothing is left to fall through to a local path that
// happens to exist.
//
// The fixture is disjoint on purpose: ONLY-ON-SYSTEM.txt exists only in the
// system's tree and ONLY-ON-CC.txt only in cc's session root, so a command or a
// read that landed on the wrong machine fails these assertions instead of
// quietly passing.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { freshProjectsRoot, rmrf, waitFor } from './helpers.mjs';
import { bindRemoteSystem } from './remoteSystem.mjs';
import { disposeSystemHandles, systemById } from '../src/systems/registry.ts';
import { SessionRedirect } from '../src/systems/toolRedirect.ts';

let home, remote, redirect, root, events;

async function build({ flags = [], idleTtlMs, shellCommandTimeoutMs } = {}) {
  ({ home } = await freshProjectsRoot());
  remote = await bindRemoteSystem({ flags });
  root = path.join(home, 'session-root');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'ONLY-ON-CC.txt'), 'cc side\n');
  await fs.writeFile(path.join(remote.root, 'ONLY-ON-SYSTEM.txt'), 'system side\n');
  events = [];
  redirect = new SessionRedirect({
    system: await systemById(remote.id, 'test'),
    systemId: remote.id,
    systemPath: remote.root,
    sessionRoot: root,
    forwarderUrl: 'http://127.0.0.1:1/api/instances/x/bash-forward',
    localRoots: [path.join(home, 'local-ok')],
    emit: (ev) => events.push(ev),
    ...(idleTtlMs === undefined ? {} : { idleTtlMs }),
    ...(shellCommandTimeoutMs === undefined ? {} : { shellCommandTimeoutMs }),
  });
}

beforeEach(async () => { await build(); });
afterEach(async () => {
  await redirect.close();
  disposeSystemHandles();
  await rmrf(home);
});

const onSystem = (rel) => path.join(remote.root, rel);
const inSession = (rel) => path.join(root, rel);
const pre = (tool, input) => redirect.preToolUse(tool, input);
const post = (tool, input, response = {}) => redirect.postToolUse(tool, input, response);
const bash = (command) => redirect.runForwarded(command, {});

// PINS: `Bash` becomes an invocation of the local forwarder that carries the
// ORIGINAL command — the one rewrite the whole redirection rests on.
test('Bash is rewritten into the forwarder, carrying the original command', async () => {
  const d = await pre('Bash', { command: "echo 'it\\'s here' && ls", description: 'x' });
  assert.equal(d.decision, 'allow');
  assert.match(d.updatedInput.command, /bashForwarder\.ts/);
  assert.match(d.updatedInput.command, /--url 'http:/);
  // The other input fields survive: updatedInput REPLACES the input, so
  // dropping one would silently change the call.
  assert.equal(d.updatedInput.description, 'x');
});

// PINS: a forwarded command runs on the SYSTEM, not on cc. Both directions are
// asserted, so a forwarder that quietly ran locally cannot pass.
test('a forwarded command runs on the system and not on cc', async () => {
  const hit = await bash('cat ONLY-ON-SYSTEM.txt');
  assert.equal(hit.code, 0);
  assert.equal(hit.stdout, 'system side\n');

  const miss = await bash('cat ONLY-ON-CC.txt');
  assert.notEqual(miss.code, 0);
});

// PINS: the shell is one long-lived shell per session — `cd` and `export` carry
// between commands, and cwd is read back from the shell rather than parsed out
// of the command.
test('the redirected shell carries cwd and exports between commands', async () => {
  await fs.mkdir(onSystem('sub'), { recursive: true });
  await bash('cd sub');
  const pwd = await bash('pwd');
  assert.equal(pwd.stdout.trim(), path.join(remote.root, 'sub'));

  await bash('export CC_PROBE=carried');
  const echo = await bash('echo "$CC_PROBE"');
  assert.equal(echo.stdout.trim(), 'carried');
});

// PINS: exit codes are the command's own, not the forwarder's.
test('a forwarded command reports the real exit code', async () => {
  assert.equal((await bash('true')).code, 0);
  assert.equal((await bash('false')).code, 1);
  assert.equal((await bash('ls /definitely-not-here')).code, 2);
  assert.equal((await bash("bash -c 'exit 7'")).code, 7);
});

// PINS: a Read under the session root pulls the system's bytes to the local
// path FIRST, so the CLI's own local read answers about the system's file.
test('Read under the session root pulls before the tool runs', async () => {
  await fs.writeFile(onSystem('greeting.py'), 'print("from the system")\n');
  const d = await pre('Read', { file_path: inSession('greeting.py') });
  assert.equal(d.decision, 'allow');
  assert.equal(d.updatedInput, undefined, 'the path is NOT rewritten — the CLI reads locally');
  assert.equal(await fs.readFile(inSession('greeting.py'), 'utf8'), 'print("from the system")\n');
});

// PINS: pull-before-EDIT, which is what makes the mixed Bash-write / Edit case
// safe — a worker that `sed -i`s through Bash and then Edits the same file is
// the normal case.
test('Edit pulls the file again, so a Bash write earlier in the turn is not clobbered', async () => {
  await fs.writeFile(onSystem('mixed.txt'), 'original\n');
  await pre('Read', { file_path: inSession('mixed.txt') });
  await bash("printf 'changed by bash\\n' > mixed.txt");

  await pre('Edit', { file_path: inSession('mixed.txt'), old_string: 'a', new_string: 'b' });
  assert.equal(await fs.readFile(inSession('mixed.txt'), 'utf8'), 'changed by bash\n');
});

// PINS: PostToolUse pushes the local result back to the system, and says so.
test('PostToolUse pushes an edit back to the system and states where it landed', async () => {
  await fs.writeFile(onSystem('app.js'), 'const a = 1\n');
  await pre('Edit', { file_path: inSession('app.js'), old_string: '1', new_string: '2' });
  await fs.writeFile(inSession('app.js'), 'const a = 2\n');

  const note = await post('Edit', { file_path: inSession('app.js') }, { filePath: inSession('app.js') });
  assert.equal(await fs.readFile(onSystem('app.js'), 'utf8'), 'const a = 2\n');
  assert.match(note, new RegExp(onSystem('app.js').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(note, new RegExp(remote.id));
});

// PINS: a failed push is a HARD, LOUD failure — it names the divergence on the
// spot and REFUSES the next write to that path, so a worker can never come away
// believing an edit reached the system when it did not.
test('a failed push names the divergence and denies the next write to that path', async () => {
  await fs.mkdir(onSystem('d'), { recursive: true });
  await fs.writeFile(onSystem('d/f.txt'), 'system copy\n');
  await pre('Edit', { file_path: inSession('d/f.txt'), old_string: 'a', new_string: 'b' });
  await fs.writeFile(inSession('d/f.txt'), 'local edit\n');
  // Break the push: the parent directory becomes a file on the system.
  await fs.rm(onSystem('d'), { recursive: true });
  await fs.writeFile(onSystem('d'), 'not a directory\n');

  const note = await post('Edit', { file_path: inSession('d/f.txt') }, {});
  assert.match(note, /did not reach/);
  assert.ok(events.some(e => e.kind === 'system' && JSON.stringify(e).includes('did not reach')),
    'the failure is surfaced to the operator, not only to the model');

  const denied = await pre('Edit', { file_path: inSession('d/f.txt'), old_string: 'x', new_string: 'y' });
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reason, /did not reach/);
});

// PINS: THE BOUNDARY. A local path with no counterpart on the system and no
// business being local is REFUSED, not quietly written to cc's disk where Bash
// can never see it.
test('a file tool aimed outside the session root is refused by name', async () => {
  for (const p of [path.join(os.tmpdir(), 'cc-redirect-scratch.txt'), '/etc/hosts', onSystem('greeting.py')]) {
    const d = await pre('Write', { file_path: p, content: 'x' });
    assert.equal(d.decision, 'deny', p);
    assert.match(d.reason, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

// PINS: the prefix rule's other half — a path cc KNOWS is local (an attachment
// under the store, a plan under ~/.claude) passes through untouched. Refusing
// those would break attachments on a remote project.
test('a known-local path passes through untouched', async () => {
  const local = path.join(home, 'local-ok', 'note.txt');
  await fs.mkdir(path.dirname(local), { recursive: true });
  await fs.writeFile(local, 'attachment\n');
  const d = await pre('Read', { file_path: local });
  assert.equal(d.decision, 'allow');
  assert.equal(d.updatedInput, undefined);
});

// PINS: R2's annotation is TARGETED — it fires only when the output actually
// shows a system path, so the model is not fed a note on every command.
test('a Bash result is annotated only when it actually shows a system path', async () => {
  const shown = await post('Bash', {}, { stdout: `cwd is ${remote.root}\n`, stderr: '' });
  assert.ok(shown && shown.includes(remote.id));

  assert.equal(await post('Bash', {}, { stdout: 'all tests passed\n', stderr: '' }), null);
});

// PINS: a shell that had to be restarted TELLS the worker, rather than
// restoring cwd and looking continuous while its exports are silently gone.
test('a restarted shell tells the worker what it lost', async () => {
  await bash('export CC_PROBE=before');
  // `exit` inside the framed command group takes the shell with it, so no
  // sentinel can arrive — one of the two wedge modes, both of which reset.
  const died = await bash('exit');
  assert.notEqual(died.code, 0);

  const after = await bash('echo "[$CC_PROBE]"');
  assert.equal(after.code, 0);
  assert.match(after.notice, /restarted/);
  assert.match(after.notice, /export/i);
  assert.equal(after.stdout.trim(), '[]', 'the export really is gone — the notice is not decorative');
  // Told ONCE: the next command is ordinary again.
  assert.equal((await bash('true')).notice, null);
});

// PINS: an idle shell is closed rather than held open for the life of the
// session, and the next command transparently opens a fresh one.
test('an idle shell is closed on its TTL', async () => {
  await redirect.close();
  await build({ idleTtlMs: 40 });
  await bash('true');
  assert.equal(redirect.shellOpen, true);
  await waitFor(() => redirect.shellOpen === false, { timeout: 4000 });
  assert.equal((await bash('echo alive')).stdout.trim(), 'alive');
});

// PINS: `@mention` pre-hydration pulls the named file into the session root
// BEFORE the prompt reaches the CLI — the CLI expands a mention with no hook,
// so a file that is not already local is simply absent from the turn.
test('@mention pre-hydration pulls the named files before the prompt is sent', async () => {
  await fs.mkdir(onSystem('docs'), { recursive: true });
  await fs.writeFile(onSystem('docs/spec.md'), '# the spec\n');
  await redirect.hydrateMentions('please read @docs/spec.md and @nope/missing.md then stop');
  assert.equal(await fs.readFile(inSession('docs/spec.md'), 'utf8'), '# the spec\n');
});

// PINS: with the persistent-shell capability absent, a redirected Bash still
// works and still carries cwd — the fallback is the deliverable, not the flag.
test('the persistentShell fallback still runs commands and carries cwd', async () => {
  await redirect.close();
  await build({ flags: ['--no-persistent-shell'] });
  await fs.mkdir(onSystem('sub'), { recursive: true });
  assert.equal((await bash('cat ONLY-ON-SYSTEM.txt')).stdout, 'system side\n');
  await bash('cd sub');
  assert.equal((await bash('pwd')).stdout.trim(), path.join(remote.root, 'sub'));
  // Exactly the local CLI's own behaviour: cwd carries, exports do not.
  await bash('export CC_PROBE=gone');
  assert.equal((await bash('echo "[$CC_PROBE]"')).stdout.trim(), '[]');
});
