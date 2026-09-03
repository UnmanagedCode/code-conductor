// The fixture every remote-placement test binds to: a registered system reached
// over the wire protocol by the reference provider.
//
// The reference provider IS this machine, spoken the long way round, which is
// what makes "remote" testable without a transport. What keeps the tests honest
// is that the system's path space is disjoint from cc's: a project's tree lives
// under a temp dir that is NOT inside PROJECTS_ROOT, so any code that composes a
// path from projectsRoot() lands somewhere the tree is not, and the assertion
// fails instead of accidentally succeeding.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile as execFileCb } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './tmpRegistry.mjs';
import { addSystem } from '../src/appSettings.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FLAKY_PROVIDER = path.join(__dirname, 'fixtures', 'flakyProvider.mjs');
const FAKE_PROVIDER = path.join(__dirname, 'fake-provider.mjs');
export const REFERENCE_PROVIDER = path.join(__dirname, '..', 'src', 'systems', 'referenceProvider.ts');

// The FLAKY wrapper's launch argv: the same real provider behind a passthrough
// that dies mid-operation. The behaviour is in the ARGV, so it is baked into the
// registry row — a test swaps a healthy system for a flaky one with
// `updateSystem(id, { launch: flakyLaunch({...}) })`, which disposes the live
// handle, so the next operation gets the flaky process rather than a handle
// spawned before the test configured anything.
export function flakyLaunch({ budget, dieOn, dieStderr, errorFrame, errorCode, flags = [] } = {}) {
  return [
    'node', FLAKY_PROVIDER,
    ...(budget === undefined ? [] : ['--budget', String(budget)]),
    ...(dieOn === undefined ? [] : ['--die-on', dieOn]),
    ...(dieStderr === undefined ? [] : ['--die-stderr', dieStderr]),
    ...(errorFrame === undefined ? [] : ['--error-frame', errorFrame]),
    ...(errorCode === undefined ? [] : ['--error-code', errorCode]),
    ...flags,
  ];
}

export function referenceLaunch(...flags) {
  return ['node', REFERENCE_PROVIDER, ...flags];
}

// A registered system whose provider completes the handshake and then answers
// NOTHING — accepted operations, no terminating frame, no death, no protocol
// violation. Nothing in ProviderConnection's supervision fires on it, so the
// only thing that settles an operation is the ceiling.
//
// `fake-provider.mjs --mode wedge` already IS that behaviour, so this wraps it
// rather than adding a second fixture. Swap a healthy row to it with
// `updateSystem(id, { launch: wedgeLaunch() })` exactly as `flakyLaunch` is
// swapped in: the handshake still succeeds, so registration and resolution both
// pass the door and the stall happens inside the operation.
export function wedgeLaunch() {
  return ['node', FAKE_PROVIDER, '--mode', 'wedge'];
}

// A registered system whose provider answers an exec with `timedOut:true` and a
// code that is NOT 124 — the one wire-legal shape that separates a cc-side
// guard reading the FLAG from one reading the exit code. Every other producer
// in the tree emits the 124 pair, so without this fixture the two readings are
// indistinguishable by test.
export function timedOutCode1Launch() {
  return ['node', FAKE_PROVIDER, '--mode', 'timedout-code1'];
}

// The registered SYSTEM's id, which is not a remote's: one system serves many
// remotes, and the two are different keys.
export const SYSTEM_ID = 'refbox';

// Register the reference provider as a non-local system and return a temp
// directory on it to place trees under. `flags` reach the provider, so a test
// can run the same fixture with a capability turned off.
export async function bindRemoteSystem({ id = SYSTEM_ID, flags = [] } = {}) {
  const rec = await addSystem({ id, label: 'Reference box', launch: referenceLaunch(...flags) });
  const root = await fs.realpath(await mkdtemp('cc-remote-'));
  return { id: rec.id, root };
}

export const git = (cwd, ...args) => new Promise((resolve, reject) => {
  execFileCb('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
    if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
  });
});

// A committed git repo at `dir`, built with the real git binary — the fixture a
// remote adopt or a remote worktree needs to already exist on the system.
export async function seedRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, 'init', '-q');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(dir, 'README.md'), '# fixture\n');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

// Every path under `dir`, with its bytes — the "byte-identical" comparison D11
// needs, taken before and after a delete.
export async function snapshotTree(dir) {
  const out = new Map();
  async function walk(rel) {
    const abs = path.join(dir, rel);
    for (const e of await fs.readdir(abs, { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { out.set(r + '/', null); await walk(r); }
      else out.set(r, await fs.readFile(path.join(dir, r)).catch(() => null));
    }
  }
  await walk('');
  return out;
}

export function assertTreeUnchanged(assert, before, after, msg) {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), `${msg} (entries)`);
  for (const [k, v] of before) {
    const b = after.get(k);
    if (v === null) { assert.equal(b, null, `${msg} (${k} kind)`); continue; }
    assert.ok(b && Buffer.compare(v, b) === 0, `${msg} (${k} bytes)`);
  }
}
