// HOW A PROVIDER SYSTEM DELIVERS A CALLER'S STDIN AND ENV OVERLAY
// (ProviderSystem.exec, src/systems/execWrap.ts).
//
// The wire has no frame that carries bytes into an exec and cc never sends a
// frame `env`, so stdin is staged as an exclusive 0600 temp file on the target
// and the overlay rides inside the command. Those are claims about FRAMES, so
// the evidence is the recording provider's transcript of what crossed the
// pipe, not a result. Cleanup is observed through an instance-level spy on
// `removeEntry`, the one call the staging path makes to remove its file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { ProviderSystem } from '../src/systems/providerSystem.ts';
import { REFERENCE_PROVIDER, FLAKY_PROVIDER } from './remoteSystem.mjs';
import { rmrf } from './rmrf.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { waitFor } from './helpers.mjs';

const RECORDING = path.join(import.meta.dirname, 'fixtures', 'recordingProvider.mjs');
const GATED = path.join(import.meta.dirname, 'fixtures', 'gatedProvider.mjs');

async function withRecording(flags, fn, { remoteId = null } = {}) {
  const dir = await fs.realpath(await mkdtemp('cc-stdin-staging-'));
  const record = path.join(dir, 'wire.jsonl');
  const sys = new ProviderSystem({ id: 'rec', remoteId, launch: { argv: ['node', RECORDING, '--record', record, ...flags] } });
  const frames = async () => (await fs.readFile(record, 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
  try { return await fn({ sys, dir, frames }); } finally { sys.dispose(); await rmrf(dir); }
}

// Spy on the cleanup call; `impl` decides how it answers.
function spyRemove(sys, impl) {
  const calls = [];
  const real = sys.removeEntry.bind(sys);
  sys.removeEntry = async (p) => { calls.push(p); return impl ? impl(p) : real(p); };
  return calls;
}

const stagedWrites = (fs_) => fs_.filter(f => f.type === 'writeFile');
const execs = (fs_) => fs_.filter(f => f.type === 'exec');

// PINS: a Buffer stdin is ONE exclusive, mode-0600 writeFile under
// /tmp/cc-stdin-, the exec frame itself carries `stdin:'ignore'`, and NO exec
// frame carries `env` even with an overlay set — the overlay rides in argv.
// After a clean exit the file is gone and no cleanup call was needed.
test('stdin is one exclusive 0600 staged write; no exec frame carries env', async () => {
  await withRecording([], async ({ sys, dir, frames }) => {
    const removes = spyRemove(sys);
    const r = await sys.exec({ argv: ['cat'] }, { cwd: dir, stdin: Buffer.from('hello\0world'), envOverlay: { CC_X: '1' } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'hello\0world');
    const all = await frames();
    const writes = stagedWrites(all);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].exclusive, true);
    assert.equal(writes[0].mode, 0o600);
    assert.match(writes[0].path, /^\/tmp\/cc-stdin-[0-9a-f]{32}$/);
    const ex = execs(all).filter(f => f.cwd === dir);
    assert.equal(ex.length, 1);
    assert.equal(ex[0].stdin, 'ignore');
    assert.equal('env' in ex[0], false, 'the overlay never travels as a frame env');
    assert.ok(ex[0].argv.includes('CC_X=1'), 'the overlay rides as env(1) in argv');
    assert.equal(existsSync(writes[0].path), false, 'the wrapper removed the staged file');
    assert.deepEqual(removes, [], 'a clean exit needs no cleanup call');
  });
});

// PINS: shell form with an overlay sends no frame env either — the overlay is
// `export` lines in the shell string.
test('a shell-form overlay is export lines in the shell string, never a frame env', async () => {
  await withRecording([], async ({ sys, dir, frames }) => {
    const r = await sys.exec({ shell: 'printf %s "$CC_Y"' }, { cwd: dir, envOverlay: { CC_Y: 'v' } });
    assert.equal(r.stdout, 'v');
    const ex = execs(await frames()).filter(f => f.cwd === dir);
    assert.equal(ex.length, 1);
    assert.equal('env' in ex[0], false);
    assert.match(ex[0].shell, /^export CC_Y='v'\n/);
  });
});

// PINS: an empty Buffer stages nothing — no writeFile at all — and the exec
// frame carries `stdin:'ignore'`.
test('an empty Buffer stdin stages nothing and closes stdin', async () => {
  await withRecording([], async ({ sys, dir, frames }) => {
    const r = await sys.exec({ argv: ['cat'] }, { cwd: dir, stdin: Buffer.alloc(0), timeoutMs: 10_000 });
    assert.equal(r.code, 0);
    const all = await frames();
    assert.deepEqual(stagedWrites(all), []);
    const ex = execs(all).filter(f => f.cwd === dir);
    assert.equal(ex[0].stdin, 'ignore');
    assert.deepEqual(ex[0].argv, ['cat'], 'no overlay and no stdin: the command is not wrapped');
  });
});

// PINS: after a TIMEOUT the staged file is gone — the wrapper unlinked it
// before the command ran — and the best-effort cleanup is still attempted.
test('after a timeout the staged file is gone and cleanup was attempted', async () => {
  await withRecording([], async ({ sys, dir, frames }) => {
    const removes = spyRemove(sys);
    const r = await sys.exec({ argv: ['sleep', '10'] }, { cwd: dir, stdin: Buffer.from('x'), timeoutMs: 200 });
    assert.equal(r.timedOut, true);
    const [w] = stagedWrites(await frames());
    assert.equal(existsSync(w.path), false);
    await waitFor(() => removes.length === 1, { timeout: 5_000 });
    assert.deepEqual(removes, [w.path]);
  });
});

// PINS: a staging write the far side REFUSES resolves as a never-started
// result carrying the refusal's code — exec never rejects — and the command
// is never sent. (A remote rooted away from /tmp refuses the write EACCES.)
test('a refused staging write is a spawnError with its code, and the command never runs', async () => {
  const root = await fs.realpath(await mkdtemp('cc-stdin-root-'));
  try {
    await withRecording(['--remote', `t=${root}`], async ({ sys, frames }) => {
      const removes = spyRemove(sys);
      const r = await sys.exec({ argv: ['cat'] }, { cwd: root, stdin: Buffer.from('x') });
      assert.equal(r.code, 1);
      assert.match(r.spawnError, /could not stage stdin/);
      assert.equal(r.spawnErrorCode, 'EACCES');
      assert.equal(r.transportFailure, undefined);
      assert.deepEqual(execs(await frames()).filter(f => f.cwd === root), [], 'the command was never sent');
      await waitFor(() => removes.length === 1, { timeout: 5_000 });
    }, { remoteId: 't' });
  } finally { await rmrf(root); }
});

// PINS: a provider that cannot be reached at staging time is a TRANSPORT
// failure (`transportFailure`), not a spawn error with a code.
test('an unreachable provider at staging time is a transportFailure result', async () => {
  const dir = await fs.realpath(await mkdtemp('cc-stdin-gated-'));
  const gate = path.join(dir, 'gate');
  await fs.writeFile(gate, '');
  const sys = new ProviderSystem({ id: 'gated', launch: { argv: ['node', GATED, '--gate', gate] } });
  try {
    spyRemove(sys, async () => { throw new Error('still down'); });
    const r = await sys.exec({ argv: ['cat'] }, { cwd: dir, stdin: Buffer.from('x') });
    assert.equal(r.transportFailure, true);
    assert.equal(r.code, 1);
    assert.ok(r.spawnError);
  } finally { sys.dispose(); await rmrf(dir); }
});

// PINS: a provider dying MID-EXEC gives `transportFailure`; cleanup of the
// staged file is attempted, and a cleanup that fails is WARNED (naming the
// file) rather than thrown or awaited into the result.
test('a provider dying mid-exec: transportFailure, cleanup attempted, failure warned not thrown', async (t) => {
  const dir = await fs.realpath(await mkdtemp('cc-stdin-flaky-'));
  const sys = new ProviderSystem({ id: 'flaky', launch: { argv: ['node', FLAKY_PROVIDER, '--die-on', 'cc-stdin-'] } });
  const warn = t.mock.method(console, 'warn', () => {});
  try {
    const removes = spyRemove(sys, async () => { throw new Error('provider is gone'); });
    const r = await sys.exec({ argv: ['sleep', '5'] }, { cwd: dir, stdin: Buffer.from('x'), timeoutMs: 10_000 });
    assert.equal(r.transportFailure, true);
    await waitFor(() => warn.mock.calls.length > 0, { timeout: 5_000 });
    assert.equal(removes.length, 1);
    assert.match(removes[0], /^\/tmp\/cc-stdin-[0-9a-f]{32}$/);
    const msg = String(warn.mock.calls[0].arguments[0]);
    assert.ok(msg.includes(removes[0]), msg);
    assert.match(msg, /provider is gone/);
  } finally { sys.dispose(); await rmrf(dir); }
});
