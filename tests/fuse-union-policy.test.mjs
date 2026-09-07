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
import { encodeRequest, encodeReply, decodeRequests, CCU_OP, CCU_STATUS,
  CCU_FLAG_FOR_CREATE, CCU_FLAG_FOR_WRITE, CCU_FLAG_REMOVED } from '../src/systems/fuse/control.ts';

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

// One body extractor, shared by both source-shape tests.
function bodyOfIn(src, op) {
  const at = src.indexOf(`static int pt_${op}(`);
  assert.ok(at > 0, `pt_${op} is missing from union.c`);
  const next = src.indexOf('\nstatic ', at + 1);
  return src.slice(at, next === -1 ? src.length : next);
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
    // `pt_readdir` (union.c), which no unit fixture can reach. cc's half is
    // killed by `tests/systems-mirror-geometry-follow.test.mjs`'s fail-pin arm.
    // THE DAEMON'S HALF IS CURRENTLY UNKILLED, and saying so is the point of
    // this note: R2 was credited with it and R2 reads a FILE — no arm anywhere
    // runs a real directory listing through the mount. Recorded in
    // PROVENANCE.md's "what is measured where" as a real gap.
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
    ['b16-abandon',   'a project-tier abandon sends a bare DIRTY and drops the cached decision; no other tier sends anything',
                      'delete the ccu_call or the cache_invalidate; give the frame a REMOVED or FOR_WRITE bit; widen the tier test'],
    ['b15-unreconcilable',
                      "a project-tier op outside the reconcile's domain refuses EOPNOTSUPP, and a host-tier one does not",
                      '`return -EOPNOTSUPP` → `return 0`; the T_PROJECT test flipped or widened to every tier; EOPNOTSUPP collapsed into EROFS'],
  ];

  for (const [id, invariant] of CASES) {
    test(`${id}: ${invariant}`, async () => { await drive(id); });
  }

  // NO ORPHANED CASE. This loop is the ONLY runner, so a case the fixture
  // defines and dispatches but CASES never names is compiled, correct and
  // never executed — and the pass count stays arithmetically consistent, which
  // is how `b15` hid for a whole round. A prover mutating what an orphaned case
  // covers reads SURVIVED and files it as real.
  //
  // Derived from the fixture's own dispatcher rather than from a second list,
  // so adding a case to the driver and forgetting the table is a failure here.
  test('every case the fixture dispatches is in CASES', async () => {
    const src = await fs.readFile(DRIVER_SRC, 'utf8');
    const dispatched = [...src.matchAll(/strcmp\(c, "([a-z0-9-]+)"\)/g)].map(m => m[1]);
    assert.ok(dispatched.length > 10, `the dispatcher was not parsed: ${dispatched.length}`);
    const listed = new Set([...CASES.map(([id]) => id), 'frame-vectors']);
    const orphans = dispatched.filter(id => !listed.has(id));
    assert.deepEqual(orphans, [], 'these driver cases are defined but never run');
    // …and the other direction, so CASES cannot name a case that no longer
    // exists and quietly stop covering anything.
    const gone = [...listed].filter(id => !dispatched.includes(id));
    assert.deepEqual(gone, [], 'these CASES entries name no dispatcher case');
  });

  // THE WIRE, CROSS-CHECKED ACROSS THE LANGUAGE BOUNDARY. Both codecs implement
  // one spec, and a test that asserted each against its own transcription of
  // that spec would pass while they disagreed. So the C side PRINTS its bytes
  // and the TypeScript side is asserted against those, in both directions.
  test('the frame codec agrees byte for byte with control.ts', async () => {
    const r = await run(bin, ['frame-vectors']);
    assert.equal(r.code, 0, r.stderr);
    const hex = Object.fromEntries(r.stdout.split('\n').filter(Boolean).map(l => l.split(' ')));

    const P = '/srv/app/f.txt';
    const reply = encodeReply(CCU_STATUS.REFUSED, 13);
    assert.equal(reply.toString('hex'), hex.REPLY, 'cc encodes a reply the daemon would refuse');

    // THE INTENT BITS ARE IN HERE TOO, and they are the only thing between
    // cc's cache management and the worker's intent — a bit cc never sets or
    // reads as another is a data-loss bug, not a codec nit. Each alone AND the
    // pair, because a codec that ORs them into one value passes single-bit
    // vectors.
    const vectors = [
      ['REQ', CCU_OP.FETCH, CCU_FLAG_FOR_CREATE, { forCreate: true, forWrite: false, removed: false }],
      ['REQ_WRITE', CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, { forCreate: false, forWrite: true, removed: false }],
      ['REQ_CREATE_WRITE', CCU_OP.FETCH, CCU_FLAG_FOR_CREATE | CCU_FLAG_FOR_WRITE,
        { forCreate: true, forWrite: true, removed: false }],
      ['REQ_REMOVED', CCU_OP.DIRTY, CCU_FLAG_REMOVED, { forCreate: false, forWrite: false, removed: true }],
    ];
    for (const [name, op, flags, want] of vectors) {
      assert.ok(hex[name], `the C side printed no ${name} vector`);
      // cc ENCODES the same bytes…
      assert.equal(encodeRequest(op, flags, P).toString('hex'), hex[name],
        `cc encodes a ${name} the daemon would not have`);
      // …and DECODES what the daemon actually emitted, rather than only
      // producing the same bytes.
      const decoded = decodeRequests(Buffer.from(hex[name], 'hex'));
      assert.deepEqual(decoded.frames, [{ op, path: P, ...want }], name);
      assert.equal(decoded.rest.length, 0);
    }

    // THE VECTORS ARE DISTINCT. Four identical byte strings would satisfy
    // every assertion above.
    assert.equal(new Set(vectors.map(([n]) => hex[n])).size, vectors.length,
      'two flag vectors encode to the same bytes');
  });

  // WHICH OP BODIES ASK. `policy_mutation_check` owns the EROFS answer and
  // b6 proves the answer, but the driver cannot reach a libfuse op body — so
  // this asserts, from the source, that every mutating op consults it. Weaker
  // than an execution test and named as such; the real gate exercises the
  // reachable half (R3).
  test('every mutating op body consults policy_mutation_check', async () => {
    const src = await fs.readFile(UNION_C, 'utf8');
    // THE OPS WHOSE SYNTHETIC ANSWER IS -EROFS. `setxattr`/`removexattr` are
    // mutating too but answer -EOPNOTSUPP on a synthetic node, which is the
    // right answer and a different guard — they are enumerated just below.
    const MUTATING = ['mkdir', 'mknod', 'unlink', 'rmdir', 'symlink', 'create',
      'chmod', 'chown', 'truncate', 'utimens', 'rename', 'link'];
    // THE SECOND GUARD, and the reason this test now derives its set from the
    // ops table: these two were in NEITHER enumeration, so both this test's
    // "a thirteenth mutating op added without the guard is a failure" and the
    // partition test's "a new mutating op lands in neither list and fails
    // here" were vacuous for exactly the two ops that were changing the mirror
    // and landing nowhere. An enumeration that omits two of its own members is
    // the defect, not the omission.
    const XATTR_MUTATING = ['setxattr', 'removexattr'];
    for (const op of XATTR_MUTATING) {
      const at = src.indexOf(`static int pt_${op}(`);
      const next = src.indexOf('\nstatic ', at + 1);
      assert.match(src.slice(at, next), /SYNTHETIC\(r\.tier\)\) return -EOPNOTSUPP/,
        `pt_${op} does not refuse a synthetic node`);
    }
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

    // TABLE FIRST, NOT LIST FIRST. The previous shape iterated a hand-written
    // list of entry points against the bound set, so an op bound in
    // `fuse_operations` and missing from THAT list passed silently — which is
    // how `fallocate` sat unclassified while being content-mutating. Now every
    // binding must be classified, and an unclassified one fails here.
    const table = src.slice(src.indexOf('static const struct fuse_operations'));
    const bound = [...table.matchAll(/\.(\w+)\s*=\s*pt_(\w+),/g)].map(m => m[1]);
    assert.ok(bound.length > 20, `the ops table was not parsed: ${bound.length}`);
    const CLASS = {
      // Read-only: no path mutation, nothing to reconcile.
      init: 'read', getattr: 'read', access: 'read', readlink: 'read',
      opendir: 'read', readdir: 'read', releasedir: 'read', read: 'read',
      statfs: 'read', getxattr: 'read', listxattr: 'read', lseek: 'read',
      // `open` routes and may take the claim, but mutates nothing itself —
      // what it opens is mutated through `write`/`truncate`/`fallocate`.
      open: 'lifecycle',
      // Mutating, guarded by policy_mutation_check (-EROFS on a synthetic).
      mkdir: 'erofs', mknod: 'erofs', unlink: 'erofs', rmdir: 'erofs',
      symlink: 'erofs', create: 'erofs', chmod: 'erofs', chown: 'erofs',
      truncate: 'erofs', utimens: 'erofs', rename: 'erofs', link: 'erofs',
      // Mutating, guarded to -EOPNOTSUPP on a synthetic (an xattr is not a
      // read-only-filesystem question).
      setxattr: 'xattr', removexattr: 'xattr',
      // Act on an fd the open already routed, claimed and marked. They mutate
      // CONTENT, so each must leave the handle owing a push.
      write: 'fd', fsync: 'fd', fallocate: 'fd',
      // The handle's own lifecycle.
      flush: 'lifecycle', release: 'lifecycle',
    };
    const unclassified = bound.filter(op => !(op in CLASS));
    assert.deepEqual(unclassified, [],
      'these ops are bound in fuse_operations and classified nowhere');
    // …and the classification cannot name an op that is not bound.
    assert.deepEqual(Object.keys(CLASS).filter(op => !bound.includes(op)), []);
    // The two mutating classes ARE the two enumerations above, so a mutating
    // op cannot be classified here and still be missing from the guard lists.
    assert.deepEqual(bound.filter(op => CLASS[op] === 'erofs').sort(), [...MUTATING].sort());
    assert.deepEqual(bound.filter(op => CLASS[op] === 'xattr').sort(), [...XATTR_MUTATING].sort());
    // Every content-mutating fd op re-arms the push, or a change after the
    // last flush is silently never reconciled.
    for (const op of bound.filter(o => CLASS[o] === 'fd' && o !== 'fsync')) {
      assert.match(bodyOfIn(src, op), /fd_dirty\[|fd_mark_dirty\(/,
        `pt_${op} mutates content without re-arming the push`);
    }
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
    // reconciled and must not be applied to the mirror alone. `setxattr` and
    // `removexattr` are here because the mirror carries no extended attributes
    // at all — cc materialises with `copyFile` — so the attribute would live in
    // the mirror for the session, `getxattr` would keep answering the phantom,
    // and the system would never learn.
    const REFUSES = ['mknod', 'link', 'chown', 'setxattr', 'removexattr'];
    // `create`/`open` land through `pt_release`'s own push, which is why they
    // are in neither list — asserted, so the exemption is not a silent gap.
    const VIA_RELEASE = ['create', 'open'];

    const bodyOf = (op) => bodyOfIn(src, op);

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
    // AND THE PUSH THAT close(2) ACTUALLY SEES. The kernel discards release's
    // return value, so a reconcile answered only there is a refusal the worker
    // never learns about — criterion 10. `flush` is where close(2) reads from.
    assert.match(bodyOf('flush'), /push_mirror_flags\(|push_mirror\(/,
      'the push is not in flush, so a refused reconcile cannot reach close(2)');
    // EVERY CLAIMING OP RELEASES ITS CLAIM WHEN IT FAILS, or the path stays
    // uncached for the session with cc still serving reads from the mirror.
    for (const op of [...PUSHES.filter(o => o !== 'rename'), 'create', 'open', 'mknod']) {
      assert.match(bodyOf(op), /abandon_claim\(/, `pt_${op} leaks its write claim on failure`);
    }
    assert.match(bodyOf('rename'), /abandon_claim\(from[\s\S]*abandon_claim\(to/,
      'pt_rename releases only one of the two claims it takes');

    // ── THE FLAG IS PINNED WHERE IT IS PRODUCED ─────────────────────────────
    //
    // `route()` took `int for_create` and forwarded `for_create ? FOR_CREATE :
    // 0`, collapsing the flags byte to one bit — so FOR_WRITE never reached the
    // wire and every claim guard was dead for an entire round. NOTHING CAUGHT
    // IT, because every test exercised one side of the seam with hand-made
    // input: the codec vectors hand-craft flags on both sides, the driver calls
    // `policy_project_route` directly and bypasses `route()`, and the
    // control-channel tests hand-craft frames with the bit already set. So the
    // flag is asserted at the site that PRODUCES it.
    assert.match(src, /static int route\(const char \*op, const char \*path, uint8_t cflags,/,
      "route() takes a boolean again, so every bit but the lowest is dropped");
    assert.match(src, /policy_project_route\([^;]*fop, cflags\)/,
      'route() reconstructs the flags byte instead of forwarding it');
    // Every op that will mutate says so on its own ROUTE.
    for (const op of [...PUSHES.filter(o => o !== 'rename'), 'mknod', 'setxattr', 'removexattr', 'chown']) {
      assert.match(bodyOf(op), new RegExp(`ROUTE\\("${op}", path, [^)]*CCU_FLAG_FOR_WRITE`),
        `pt_${op} mutates the mirror without taking a write claim`);
    }
    assert.match(bodyOf('create'), /ROUTE\("create", path, CCU_FLAG_FOR_CREATE \| CCU_FLAG_FOR_WRITE/);
    assert.match(bodyOf('rename'), /route\("rename", from, CCU_FLAG_FOR_WRITE[\s\S]*route\("rename", to, CCU_FLAG_FOR_CREATE \| CCU_FLAG_FOR_WRITE/);
    // A WRITABLE open takes one and a read-only open does NOT — the second half
    // is what keeps the claim scoped, since claiming every read would disable
    // the cache wholesale.
    assert.match(bodyOf('open'),
      /ROUTE\("open", path, \(fi->flags & \(O_WRONLY \| O_RDWR\)\) \? CCU_FLAG_FOR_WRITE : 0/,
      'pt_open claims unconditionally or never');
    // `link` refuses at the project tier, so it must NOT take a claim nothing
    // would release.
    assert.doesNotMatch(bodyOf('link'), /CCU_FLAG_FOR_WRITE/,
      'pt_link takes a write claim it never releases');

    // THE PARTITION: the two lists are disjoint and together are exactly the
    // mutating set the previous test enumerates, minus the two that go through
    // release. A new mutating op lands in neither and fails here.
    const covered = [...PUSHES, ...REFUSES, ...VIA_RELEASE].sort();
    assert.equal(new Set(covered).size, covered.length, 'an op is in two lists');
    assert.deepEqual(covered,
      ['chmod', 'chown', 'create', 'link', 'mkdir', 'mknod', 'open', 'removexattr',
        'rename', 'rmdir', 'setxattr', 'symlink', 'truncate', 'unlink', 'utimens'].sort());

    // THE READS REFUSE TOO, and for the mirror's sake rather than the
    // reconcile's: a mirror entry never carried the source's xattrs, so
    // answering `getxattr` from it reports "no such attribute" about a file
    // that has one — undetectable from the caller's side.
    for (const op of ['getxattr', 'listxattr']) {
      assert.match(bodyOf(op), /policy_unreconcilable\(/,
        `pt_${op} answers a project path from a mirror entry that has no xattrs`);
    }
  });
});
