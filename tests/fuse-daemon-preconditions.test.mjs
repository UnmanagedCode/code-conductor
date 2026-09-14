// THE DAEMON'S MOUNT PRECONDITIONS, DRIVEN THROUGH THE REAL COMPILED BINARY.
//
// `tests/fuse-union-policy.test.mjs` drives `policy.h` through a fixture, and
// A16b (`tests/fuse-lifecycle.test.mjs`) greps `union.c` for these refusals
// because the POLICY FIXTURE cannot reach `main()`. Neither is the enforcement.
// This file is: every env refusal in `main()` fires before `pthread_key_create`,
// before `control_connect` and before `fuse_main`, so exec'ing the daemon
// `ensureUnionBinary()` actually ships reaches them with no socket, no mount,
// no FUSE and no sudo.
//
// THE SKIP TAKES ITS COMPILER PRECONDITION FROM `detectToolchain()` — the same
// one `ensureUnionBinary` builds through — so this can only skip where the
// product itself could not have built the daemon, and it prints the reason.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdtemp } from './tmpRegistry.mjs';
import { detectToolchain, ensureUnionBinary } from '../src/systems/fuse/build.ts';

const tools = await detectToolchain();
const skip = tools.ok ? false : `no toolchain: ${tools.reason}`;
if (skip) console.error(`fuse-daemon-preconditions: SKIPPED — ${skip}`);

function run(bin, env) {
  return new Promise((resolve) => {
    execFile(bin, [], { env, timeout: 30_000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

describe('the daemon\'s env preconditions', { skip }, () => {
  let bin, dir, prevRoot;

  before(async () => {
    // The binary is content-addressed under `fuseBinDir()` → `orchStoreRoot()`
    // → `projectsRoot()`, so pointing PROJECTS_ROOT at a throwaway keeps this
    // build out of the real store.
    dir = await mkdtemp('cc-daemon-pre-');
    prevRoot = process.env.PROJECTS_ROOT;
    process.env.PROJECTS_ROOT = dir;
    bin = await ensureUnionBinary();
    await fs.writeFile(path.join(dir, 'pins'), '');
  });

  after(() => {
    if (prevRoot === undefined) delete process.env.PROJECTS_ROOT;
    else process.env.PROJECTS_ROOT = prevRoot;
  });

  // Everything the daemon needs to get PAST the mark-path gate, so the only
  // variable across the rows below is CC_UNION_MARK_PATH itself.
  const baseEnv = () => ({
    CC_UNION_REMOTE: dir,
    CC_UNION_PINS: path.join(dir, 'pins'),
    // A path in a directory that EXISTS with no socket at it: `control_connect`
    // opens the directory and then fails to connect, which is the refusal the
    // positive control below asserts.
    CC_UNION_CONTROL: path.join(dir, 'no-such-socket'),
    CC_UNION_CWD: '/srv/app',
  });

  // PINS: the pre-existing absence refusal, behaviourally for the first time —
  // A16b only ever saw its string in the source.
  test('an absent CC_UNION_MARK_PATH refuses the mount', async () => {
    const r = await run(bin, baseEnv());
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /REFUSED — CC_UNION_MARK_PATH is required/, r.stderr);
  });

  // PINS THE WHOLE POINT OF THE VALIDATION GUARD: `getenv` answers a non-NULL
  // "" for a variable exported empty, so the NULL test above it passes and the
  // daemon would mount with a mark path `strcmp` can never match — a silent
  // host-only filesystem that looks exactly like a containment success.
  //
  // The three malformed spellings ride the same guard for the same reason:
  // `mark_maybe` compares against a path the KERNEL hands the daemon, always
  // absolute and normalised, so no other spelling can ever match either.
  for (const [label, value] of [
    ['an empty', ''],
    ['a relative', 'relative/claude'],
    ['a trailing-slash', '/srv/app/'],
    ['a doubled-slash', '/srv//app'],
  ]) {
    test(`${label} CC_UNION_MARK_PATH refuses the mount`, async () => {
      const r = await run(bin, { ...baseEnv(), CC_UNION_MARK_PATH: value });
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr,
        new RegExp(`REFUSED — CC_UNION_MARK_PATH=${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not a normalised absolute path`),
        r.stderr);
    });
  }

  // THE POSITIVE CONTROL, AND IT IS NOT OPTIONAL. It proves execution got PAST
  // the mark-path gate rather than dying earlier for an unrelated reason —
  // without it every row above passes vacuously the moment the binary refuses
  // for any other cause.
  test('a well-formed CC_UNION_MARK_PATH gets past the gate and fails at the control socket', async () => {
    const r = await run(bin, { ...baseEnv(), CC_UNION_MARK_PATH: '/usr/bin/claude' });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /REFUSED — cannot connect to cc's control socket/, r.stderr);
    assert.doesNotMatch(r.stderr, /CC_UNION_MARK_PATH/, r.stderr);
  });
});
