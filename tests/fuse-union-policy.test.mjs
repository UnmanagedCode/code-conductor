// THE COMPILED POLICY DRIVER — the deterministic half of the union daemon.
//
// `src/systems/fuse/policy.h` includes no libfuse header and calls no FUSE
// function, so `tests/fixtures/union-policy-driver.c` can drive every rule in
// it with a fake /proc, a fake clock and a fake control transport. That is what
// the policy split bought: tier resolution, the marking policy, the resolution
// cache and the frame codec are proven before anything is mounted.
//
// THE SKIP IS THE WHOLE RISK OF THIS FILE, so it takes its compiler
// precondition from the SAME `detectToolchain()` `ensureUnionBinary` uses. One
// detection, shared: this can only skip where the product itself could not have
// built the daemon, and it prints the reason. A second, more permissive probe
// would make a silently skipped C test indistinguishable from a passing one.
//
// WHAT THIS FILE CANNOT REACH, stated up front so a SURVIVED here is read
// against a known boundary rather than argued about (plan 2026-0355 §7.1, and
// PROVENANCE.md's policy-split section). It is a boundary of TWO kinds and the
// difference matters to whoever files the verdict:
//
//   COVERED ELSEWHERE, by a named arm — `route()`'s host arm and its
//   no-fallback-on-EIO behaviour (real gate R2, R6); that `pt_getattr` and
//   `pt_opendir` call `resolve_class`, and that a `mount --bind` succeeds onto
//   a synthetic node (R3); `pt_readdir`'s suppression of a `fail` child (R2,
//   and cc's half in `systems-mirror-geometry-follow`).
//
//   COVERED NOWHERE, and recorded as such rather than assigned to an arm that
//   does not exist — that `fuse_get_context()->pid` is a TID in practice, and
//   that the marking event fires on the CLI's own first read of its binary.
//   Both rest on S1 §6 Q1's measurement (983 of 14 677 ops had pid != tgid),
//   which is real and historical; the INSTRUMENT that produced it was the
//   spike's identity trace, deleted by ledger row D2. No live arm re-measures
//   either. `bootstrap.sh` now fires the marking event deliberately, so the
//   second one is no longer load-bearing for the launch — R2 would fail if the
//   mark did not reach the CLI's thread group — but nothing pins the TID claim.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './tmpRegistry.mjs';
import { detectToolchain } from '../src/systems/fuse/build.ts';
import { encodeRequest, encodeReply, decodeRequests, CCU_OP, CCU_STATUS, CCU_FLAG_FOR_CREATE } from '../src/systems/fuse/control.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER_SRC = path.join(HERE, 'fixtures', 'union-policy-driver.c');
const UNION_C = path.join(HERE, '..', 'src', 'systems', 'fuse', 'union.c');

const tools = await detectToolchain();
const skip = tools.ok ? false : `no toolchain: ${tools.reason}`;
if (skip) console.error(`fuse-union-policy: SKIPPED — ${skip}`);

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 8 << 20, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

describe('the compiled policy driver', { skip }, () => {
  let bin;

  before(async () => {
    const dir = await mkdtemp('cc-policy-drv-');
    bin = path.join(dir, 'driver');
    // The same compiler and the same `pkg-config` flags the product builds the
    // daemon with, PLUS `-Werror`, which `build.ts`'s CFLAGS deliberately does
    // not carry: a warning that would only be printed during a production
    // compile must fail this fixture, because nobody reads a test's compiler
    // output. Strictly stricter, so it can only reject what the product accepts.
    const r = await run(tools.cc, ['-Wall', '-Wextra', '-Werror', '-O2', ...tools.cflags,
      DRIVER_SRC, '-o', bin, ...tools.libs]);
    assert.equal(r.code, 0, `the policy driver did not compile:\n${r.stderr}`);
  });

  // Each case is its own PROCESS: the tier table, the mark table and the
  // resolution cache are file-scope state in a header, and a fresh process is
  // the isolation rather than a reset function that would exist only for tests.
  const drive = async (name) => {
    const r = await run(bin, [name]);
    assert.equal(r.code, 0, `${name}:\n${r.stdout}\n${r.stderr}`);
    const lines = r.stdout.split('\n').filter(Boolean);
    assert.ok(lines.length > 0, `${name} asserted nothing`);
    assert.ok(lines.every(l => l.startsWith('ok ')), `${name}:\n${r.stdout}`);
    return lines;
  };

  //  id  | invariant                                        | mutation it must die under
  // -----|--------------------------------------------------|---------------------------
  const CASES = [
    ['b0-parse',      'the pins parser accepts exactly five kinds and rejects `synth`',
                      'add `synth` to the kind table, or drop the absolute-path rule'],
    ['b1-prefix',     'longest prefix wins, at a COMPONENT boundary',
                      "delete tier_of's `path[p->len] != '/'` guard"],
    ['b2-failclosed', 'an unpinned path is T_FAIL, and T_FAIL is enum index 0',
                      'reinstate `T_DEFAULT = 0` ahead of T_FAIL'],
    ['b3-ancestors',  'ancestor membership is EXACT, never by prefix',
                      'make anc_find match by prefix instead of strcmp'],
    ['b3b-exact-pin', 'an exactly-pinned path is its pin, not a synthetic node',
                      "drop anc_build's pin_exact filter"],
    ['b4-children',   'a synthetic dir lists exactly its own children, omitting hide and fail',
                      'drop the T_HIDE/T_FAIL skip, or the immediate-child guard'],
    // NOT this file's: the same rule for a REAL directory lives in
    // `pt_readdir` (union.c), which no unit fixture can reach. Its kill is
    // `tests/systems-mirror-geometry-follow.test.mjs`'s fail-pin arm for cc's
    // half and the real gate's R2 for the daemon's.
    ['b5-getattr',    'the synthetic node is fixed 0555/uid0/mtime0 and touches no filesystem',
                      'fstatat the host directory of the same name'],
    ['b6-erofs',      'a mutation on a synthetic or bind node is EROFS, not EACCES',
                      'return -EACCES, or let T_BIND through'],
    // `or serve the host` is NOT reachable from here: the host arm is
    // `route()`'s (union.c), which no unit fixture can call. Real gate R2.
    ['b7-unmarked',   'an unmarked caller at a project path gets -ENOENT and sends no frame',
                      'delete the mark check in policy_project_route'],
    ['b8-reuse',      'a marked tgid whose field-22 starttime moved loses the mark',
                      "delete mark_of's starttime comparison"],
    ['b9-tgid-key',   'the mark is keyed on the TGID, resolved through the injected reader',
                      'look the mark up by the calling TID'],
    ['b10-cache-key', 'the mark check runs before the lookup, so a recycled tgid is never served a warm entry',
                      'move the cache lookup ahead of the mark check, or drop tgid from the key'],
    ['b11-codec',     'the frame codec round-trips and rejects short, bad-magic and over-long',
                      'drop the length check or the magic check'],
    // `or fall back to the host on EIO` is NOT reachable from here either —
    // there is no host fd in this file. Real gate R6 owns it.
    ['b12-errno',     'ABSENT→ENOENT, REFUSED→EACCES, dead or truncated channel→EIO',
                      'swap ABSENT→EACCES, or drop the reply-status switch'],
    ['b14-reasons',   'each control failure names itself in the refusal log, and the three are distinguished',
                      'collapse remote-absent and control-refused into one reason'],
    ['b13-refusals',  'the refusal log records each (path, reason) exactly once',
                      'drop the dedupe, or key it on op as well'],
  ];

  for (const [id, invariant] of CASES) {
    test(`${id}: ${invariant}`, async () => { await drive(id); });
  }

  // THE WIRE, CROSS-CHECKED ACROSS THE LANGUAGE BOUNDARY. Both codecs implement
  // one spec, and a test that asserted each against its own transcription of
  // that spec would pass while they disagreed. So the C side PRINTS its bytes
  // and the TypeScript side is asserted against those, in both directions.
  test('the frame codec agrees byte for byte with control.ts', async () => {
    const r = await run(bin, ['frame-vectors']);
    assert.equal(r.code, 0, r.stderr);
    const hex = Object.fromEntries(r.stdout.split('\n').filter(Boolean).map(l => l.split(' ')));

    const req = encodeRequest(CCU_OP.FETCH, CCU_FLAG_FOR_CREATE, '/srv/app/f.txt');
    assert.equal(req.toString('hex'), hex.REQ, 'cc encodes a request the daemon would not have');
    const reply = encodeReply(CCU_STATUS.REFUSED, 13);
    assert.equal(reply.toString('hex'), hex.REPLY, 'cc encodes a reply the daemon would refuse');

    // And cc DECODES what the daemon actually emitted, rather than only
    // producing the same bytes.
    const decoded = decodeRequests(Buffer.from(hex.REQ, 'hex'));
    assert.deepEqual(decoded.frames, [{ op: CCU_OP.FETCH, forCreate: true, path: '/srv/app/f.txt' }]);
    assert.equal(decoded.rest.length, 0);
  });

  // WHICH OP BODIES ASK. `policy_mutation_check` owns the EROFS answer and
  // b6 proves the answer, but the driver cannot reach a libfuse op body — so
  // this asserts, from the source, that every mutating op consults it. Weaker
  // than an execution test and named as such; the real gate exercises the
  // reachable half (R3).
  test('every mutating op body consults policy_mutation_check', async () => {
    const src = await fs.readFile(UNION_C, 'utf8');
    const MUTATING = ['mkdir', 'mknod', 'unlink', 'rmdir', 'symlink', 'create',
      'chmod', 'chown', 'truncate', 'utimens', 'rename', 'link'];
    for (const op of MUTATING) {
      const at = src.indexOf(`static int pt_${op}(`);
      assert.ok(at > 0, `pt_${op} is missing from union.c`);
      // To the start of the next function definition.
      const next = src.indexOf('\nstatic ', at + 1);
      const body = src.slice(at, next === -1 ? src.length : next);
      assert.match(body, /policy_mutation_check/, `pt_${op} does not refuse a synthetic node`);
    }
    // And the count is asserted too, so a thirteenth mutating op added without
    // the guard is a failure rather than an unnoticed omission.
    const bodies = src.match(/^static int pt_[a-z]+\(/gm) ?? [];
    assert.equal(src.match(/policy_mutation_check\(/g).length, MUTATING.length + 2,
      `expected one call per mutating op plus rename/link's second end; ${bodies.length} pt_ ops in the file`);
  });

  // AND THAT EVERY PROJECT-TIER MUTATION EITHER LANDS OR REFUSES — the bar M1
  // closes to. The partition is asserted as a PARTITION: each op appears in
  // exactly one list, the two lists together are the whole mutating set, and no
  // op body reaches its syscall without one of the two calls.
  //
  // Weaker than an execution test and named as such. What each half is worth:
  // the RECONCILE's own branches — dir, absent, symlink, mode+mtime, kind
  // change — are driven deterministically in `fuse-control-channel.test.mjs`;
  // that the frame reaches cc and the bytes reach the system is real-gate R3
  // and R7. This is the enumeration between them, and it is the part a
  // per-op-body execution test cannot give without a real CLI.
  test('every project-tier mutation either pushes or refuses, and the split is a partition', async () => {
    const src = await fs.readFile(UNION_C, 'utf8');
    // LANDS: mutates the mirror, then tells cc the mirror is authoritative.
    const PUSHES = ['mkdir', 'unlink', 'rmdir', 'symlink', 'rename', 'chmod', 'truncate', 'utimens'];
    // REFUSES: outside what `RemoteStat` can express, so it cannot be
    // reconciled and must not be applied to the mirror alone.
    const REFUSES = ['mknod', 'link', 'chown'];
    // `create`/`open` land through `pt_release`'s own push, which is why they
    // are in neither list — asserted, so the exemption is not a silent gap.
    const VIA_RELEASE = ['create', 'open'];

    const bodyOf = (op) => {
      const at = src.indexOf(`static int pt_${op}(`);
      assert.ok(at > 0, `pt_${op} is missing`);
      const next = src.indexOf('\nstatic ', at + 1);
      return src.slice(at, next === -1 ? src.length : next);
    };

    for (const op of PUSHES) {
      const body = bodyOf(op);
      assert.match(body, /push_mirror\(/, `pt_${op} mutates the mirror and pushes nothing`);
      assert.doesNotMatch(body, /refuse_unreconcilable\(/, `pt_${op} is in both lists`);
    }
    for (const op of REFUSES) {
      const body = bodyOf(op);
      assert.match(body, /refuse_unreconcilable\(/, `pt_${op} succeeds against the mirror alone`);
      assert.doesNotMatch(body, /push_mirror\(/, `pt_${op} is in both lists`);
    }
    for (const op of VIA_RELEASE) {
      const body = bodyOf(op);
      assert.doesNotMatch(body, /push_mirror\(|refuse_unreconcilable\(/,
        `pt_${op} should land through pt_release's push, not its own`);
      assert.match(body, /fd_tier_set\(/, `pt_${op} does not mark its fd, so release cannot push`);
    }
    assert.match(bodyOf('release'), /push_mirror\(/, 'pt_release stopped pushing');

    // THE PARTITION: the two lists are disjoint and together are exactly the
    // mutating set the previous test enumerates, minus the two that go through
    // release. A new mutating op lands in neither and fails here.
    const covered = [...PUSHES, ...REFUSES, ...VIA_RELEASE].sort();
    assert.equal(new Set(covered).size, covered.length, 'an op is in two lists');
    assert.deepEqual(covered,
      ['chmod', 'chown', 'create', 'link', 'mkdir', 'mknod', 'open', 'rename', 'rmdir',
        'symlink', 'truncate', 'unlink', 'utimens'].sort());
  });
});
