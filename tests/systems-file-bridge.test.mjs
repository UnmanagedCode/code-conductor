// Pull-then-push: how a hooked Read/Write/Edit crosses the machine boundary.
//
// NOT path rewriting. The CLI executes Read/Edit itself, locally, and validates
// `Edit`'s `old_string` against the pre-hook path BEFORE any hook fires — so a
// rewritten `/app/...` is a local ENOENT and the hook never even runs. The
// bridge instead materialises the system's bytes at the local path the CLI is
// about to open (pull), and writes the local result back afterwards (push).
//
// The fixture keeps the two sides distinguishable: the system's tree is a temp
// dir outside PROJECTS_ROOT and every file carries a system-side marker, so a
// bridge that read or wrote cc's own copy would fail these assertions rather
// than look right.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { bindRemoteSystem } from './remoteSystem.mjs';
import { disposeSystemHandles, systemById } from '../src/systems/registry.ts';
import { SessionPathMap } from '../src/systems/sessionRoot.ts';
import { FileBridge, SESSION_FILE_CAP_BYTES } from '../src/systems/fileBridge.ts';

let home, remote, bridge, map, root;

beforeEach(async () => {
  ({ home } = await freshProjectsRoot());
  remote = await bindRemoteSystem();
  root = path.join(home, 'session-root');
  await fs.mkdir(root, { recursive: true });
  map = new SessionPathMap(root, remote.root);
  bridge = new FileBridge(await systemById(remote.id, 'test'), map);
});
afterEach(async () => { disposeSystemHandles(); await rmrf(home); });

const onSystem = (rel) => path.join(remote.root, rel);
const inSession = (rel) => path.join(root, rel);
const seed = async (rel, body, mode) => {
  await fs.mkdir(path.dirname(onSystem(rel)), { recursive: true });
  await fs.writeFile(onSystem(rel), body);
  if (mode !== undefined) await fs.chmod(onSystem(rel), mode);
};

// PINS: a pull materialises the SYSTEM's bytes at the local path the CLI will
// open — the whole mechanism Read rests on.
test('pull materialises the system bytes at the mapped local path', async () => {
  await seed('src/index.js', 'ONLY-ON-SYSTEM\n');
  const r = await bridge.pull(inSession('src/index.js'));
  assert.equal(r.kind, 'pulled');
  assert.equal(await fs.readFile(inSession('src/index.js'), 'utf8'), 'ONLY-ON-SYSTEM\n');
});

// PINS: a pull of a path the system does not have removes any stale local copy
// and reports absence. A surviving local copy is the leak that makes Read
// answer about a file Bash says is gone.
test('pull of an absent system path removes the stale local copy', async () => {
  await seed('gone.txt', 'was here\n');
  await bridge.pull(inSession('gone.txt'));
  await fs.rm(onSystem('gone.txt'));

  const r = await bridge.pull(inSession('gone.txt'));
  assert.equal(r.kind, 'absent');
  await assert.rejects(fs.readFile(inSession('gone.txt')));
});

// PINS: binary and oversized content is REFUSED by name, never truncated and
// never written locally — a truncated pull would let an Edit push back a file
// with its tail cut off.
test('pull refuses binary content and content over the cap, writing nothing', async () => {
  await seed('logo.png', Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
  const bin = await bridge.pull(inSession('logo.png'));
  assert.equal(bin.kind, 'refused');
  assert.match(bin.reason, /binary/);
  await assert.rejects(fs.readFile(inSession('logo.png')));

  await seed('huge.txt', 'x'.repeat(SESSION_FILE_CAP_BYTES + 1));
  const big = await bridge.pull(inSession('huge.txt'));
  assert.equal(big.kind, 'refused');
  assert.match(big.reason, /cap/);
  await assert.rejects(fs.readFile(inSession('huge.txt')));
});

// PINS: a push writes the local result back to the SYSTEM and keeps the file's
// mode, so editing a script does not silently strip its executable bit.
test('push writes back to the system and preserves the mode', async () => {
  await seed('run.sh', '#!/bin/sh\necho old\n', 0o755);
  await bridge.pull(inSession('run.sh'));
  await fs.writeFile(inSession('run.sh'), '#!/bin/sh\necho new\n');
  await bridge.push(inSession('run.sh'));

  assert.equal(await fs.readFile(onSystem('run.sh'), 'utf8'), '#!/bin/sh\necho new\n');
  assert.equal((await fs.stat(onSystem('run.sh'))).mode & 0o777, 0o755);
});

// PINS: a push never follows a symlink on the system — it replaces the link
// rather than writing through it to whatever it points at.
test('push replaces a symlink instead of writing through it', async () => {
  await seed('real.txt', 'the real file\n');
  await fs.symlink(onSystem('real.txt'), onSystem('link.txt'));
  await bridge.pull(inSession('link.txt'));
  await fs.writeFile(inSession('link.txt'), 'written via the link\n');
  await bridge.push(inSession('link.txt'));

  assert.equal(await fs.readFile(onSystem('real.txt'), 'utf8'), 'the real file\n');
  assert.equal((await fs.lstat(onSystem('link.txt'))).isSymbolicLink(), false);
});

// PINS: a push that creates a new file works, parents and all — a Write to a
// path the system does not have yet is the ordinary case.
test('push creates a new file and its parent directories on the system', async () => {
  await fs.mkdir(path.dirname(inSession('a/b/new.txt')), { recursive: true });
  await fs.writeFile(inSession('a/b/new.txt'), 'brand new\n');
  await bridge.push(inSession('a/b/new.txt'));
  assert.equal(await fs.readFile(onSystem('a/b/new.txt'), 'utf8'), 'brand new\n');
});

// PINS: a FAILED push is loud and sticky — the path is marked diverged by name,
// so the layer above can refuse later writes to it instead of letting the
// worker believe an edit landed on the system.
test('a failed push marks the path diverged, and a fresh pull clears it', async () => {
  await seed('locked/file.txt', 'system copy\n');
  await bridge.pull(inSession('locked/file.txt'));
  await fs.writeFile(inSession('locked/file.txt'), 'local edit\n');

  // Make the write fail on the system: the parent is replaced by a FILE, so
  // creating the temp file under it is ENOTDIR.
  await fs.rm(onSystem('locked'), { recursive: true });
  await fs.writeFile(onSystem('locked'), 'not a directory\n');

  await assert.rejects(() => bridge.push(inSession('locked/file.txt')));
  assert.equal(bridge.isDirty(inSession('locked/file.txt')), true);
  assert.match(bridge.dirtyReason(inSession('locked/file.txt')), /locked\/file\.txt/);

  // Repairing the system and re-pulling resyncs local from the system, which is
  // the honest end of the divergence — so the mark clears.
  await fs.rm(onSystem('locked'));
  await seed('locked/file.txt', 'system copy\n');
  await bridge.pull(inSession('locked/file.txt'));
  assert.equal(bridge.isDirty(inSession('locked/file.txt')), false);
});

// PINS: the bridge only ever touches paths under the session root. A local path
// outside it has no system counterpart, and acting on one would read or write
// the wrong machine.
test('the bridge refuses a local path outside the session root', async () => {
  await assert.rejects(() => bridge.pull(path.join(home, 'elsewhere.txt')), /session root/);
  await assert.rejects(() => bridge.push(path.join(home, 'elsewhere.txt')), /session root/);
});
