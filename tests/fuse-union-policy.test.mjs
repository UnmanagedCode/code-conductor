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
  CCU_FLAG_FOR_CREATE, CCU_FLAG_FOR_WRITE, CCU_FLAG_REMOVED,
  CCU_FLAG_RELEASE_ONLY } from '../src/systems/fuse/control.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER_SRC = path.join(HERE, 'fixtures', 'union-policy-driver.c');
const UNION_C = path.join(HERE, '..', 'src', 'systems', 'fuse', 'union.c');
const POLICY_H = path.join(HERE, '..', 'src', 'systems', 'fuse', 'policy.h');

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

// C COMMENTS BLANKED, OFFSETS PRESERVED — every comment byte becomes a space
// (newlines kept), so a scanner over the result still reports positions that
// index the original.
//
// IT IS NOT TIDINESS: a source-text derivation that cannot tell code from prose
// counts the PROSE. This one caught it — a `policy_event(` written inside
// policy.h's own explanatory comment was parsed as a call site and read as an
// unterminated one, because a comment has no argument list to close. Any
// derivation below that talks about "call sites" therefore runs on the stripped
// text, and the string/char-literal states are tracked so a literal containing
// `//` or `/*` is not mistaken for a comment opener.
function stripCComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '"' || c === "'") {
      const q = c;
      out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) out += src[k] === '\n' ? '\n' : ' ';
      i = stop;
      continue;
    }
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

// One body extractor, shared by both source-shape tests.
function bodyOfIn(src, op) {
  const at = src.indexOf(`static int pt_${op}(`);
  assert.ok(at > 0, `pt_${op} is missing from union.c`);
  const next = src.indexOf('\nstatic ', at + 1);
  return src.slice(at, next === -1 ? src.length : next);
}

// ── THE STRIPPER, ON SYNTHETIC INPUT AND NOT ON THE REAL SOURCES ───────────
//
// UNSKIPPED, because it needs no toolchain — and SYNTHETIC, because that is the
// whole point. Three mutants of `stripCComments` survived a mutation run while
// the derivation below stayed green at 40/40, and every one of them survived
// for the same reason: the real sources do not happen to contain the construct
// the branch exists for. A non-vacuity block that asserts only "it removed
// something and kept the call sites" cannot see any of them.
//
// What each survivor would have done to input the derivation does not read
// TODAY — which is what makes them latent traps rather than dead code:
//
//   `if (c === '"' || c === "'")` → `if (false)`   stops tracking literals, so
//       a `//` INSIDE A STRING opens a line comment and everything after it on
//       that line is destroyed. `union.c` really has one (`'//'` in a string at
//       the time of writing); the moment a `policy_event(` call lands near such
//       a literal, the derivation reads mangled text.
//   `src[k] === '\n' ? '\n' : ' '` → `' '`         blanks newlines inside block
//       comments, so LINE STRUCTURE collapses. Offsets survive — a space is one
//       byte, like the newline it replaced — which is exactly why a length
//       assertion cannot see it. The derivation's `lastIndexOf('\n', at)` then
//       finds a line start somewhere back inside the comment, and the
//       `static inline void` definition test reads the wrong text.
//   `stop = end + 2` → `stop = end`                leaves the `*/` terminator
//       behind for every block comment.
describe('stripCComments — the comment stripper the kind derivation runs on', () => {
  // ONE FIXTURE, EVERY BRANCH. Line-numbered in the assertions below, so a
  // failure names the construct rather than an offset.
  const LINES = [
    'static const char *sep = "//";',                  // 0: `//` inside a string
    "static const char *odd = '/*';",                  // 1: `/*` inside a quote
    'static const char *frag = "/* kept */";',         // 2: a `*/` that must SURVIVE
    '/* a block comment',                              // 3: opens…
    ' * with an inner line',                           // 4:
    ' */',                                             // 5: …and closes
    'int keep = 1; // a real line comment',            // 6: a real line comment
    "char esc = '\\'';",                               // 7: an escaped quote
    'int tail = 2;',                                   // 8: must survive it all
  ];
  const SRC = LINES.join('\n') + '\n';
  const out = stripCComments(SRC);
  const got = out.split('\n');

  // PINS: LITERAL TRACKING. A quote's contents are copied verbatim, so neither
  // `//` nor `/*` inside one opens anything — and the code AFTER it on the same
  // line survives.
  // DIES UNDER: `if (c === '"' || c === "'")` → `if (false)`, which blanks from
  // the `//` in line 0 to end of line and destroys the `;`.
  test('a `//` or `/*` inside a quote opens nothing, and the line survives it', () => {
    assert.equal(got[0], LINES[0], 'a string containing `//` was treated as a comment');
    assert.equal(got[1], LINES[1], 'a quote containing `/*` was treated as a comment');
    assert.equal(got[7], LINES[7], 'an escaped quote ended the literal early');
    // AND THE FAR SIDE OF THE WHOLE FIXTURE. Under the `/*`-in-a-quote mutant
    // the run opens at line 1 and closes at line 2's `*/`, so line 2's code is
    // eaten; under the `//` mutant line 0 loses its tail. Either way this is
    // the load-bearing check that no run escaped its construct.
    assert.equal(got[2], LINES[2], 'a `*/` inside a string did not survive');
    assert.equal(got[8], LINES[8], 'the text after every construct was destroyed');
  });

  // PINS: LINE STRUCTURE, which is what makes a position in the stripped text
  // index the original. Asserted as LINE COUNT and per-line boundaries, NOT as
  // total length — the mutant preserves length exactly.
  // DIES UNDER: `src[k] === '\n' ? '\n' : ' '` → `' '`, which merges lines 3–5.
  test('block-comment newlines are preserved, so lines still line up', () => {
    assert.equal(got.length, SRC.split('\n').length,
      'the stripper changed the LINE COUNT, so `lastIndexOf("\\n", at)` no longer '
      + 'finds the line a position is on');
    // The three comment lines are blanked to whitespace but each is still its
    // own line, with its original width.
    for (const i of [3, 4, 5]) {
      assert.match(got[i], /^ *$/, `line ${i} was not blanked: ${JSON.stringify(got[i])}`);
      assert.equal(got[i].length, LINES[i].length, `line ${i} changed width`);
    }
    // And offsets really do still index the original — the property the line
    // structure exists to support.
    assert.equal(out.length, SRC.length, 'offsets shifted');
    assert.equal(out.indexOf('int tail'), SRC.indexOf('int tail'), 'a position moved');
  });

  // PINS: THE TERMINATOR IS CONSUMED. Counted rather than asserted absent,
  // because line 2's STRING legitimately contains one and must keep it.
  // DIES UNDER: `stop = end + 2` → `stop = end`, which leaves the block
  // comment's own `*/` in the output and makes the count 2.
  test('a block comment takes its `*/` with it, and a string keeps its own', () => {
    assert.equal((out.match(/\*\//g) ?? []).length, 1,
      `exactly one \`*/\` survives — the one inside the string on line 2: ${JSON.stringify(out)}`);
    assert.ok(out.includes('"/* kept */"'), 'the string literal lost its content');
  });

  // PINS: line comments really are removed — the branch the real sources never
  // exercise in code text, which is why a mutant on it was waived as dead.
  // DIES UNDER: dropping the `c === '/' && d === '/'` branch.
  test('a real line comment is blanked, and its code is kept', () => {
    assert.ok(!out.includes('a real line comment'), 'the line comment survived');
    assert.match(got[6], /^int keep = 1; +$/, JSON.stringify(got[6]));
  });

  // PINS: an UNTERMINATED block comment does not run off the end or throw. The
  // derivation asserts on unterminated CALL SITES, so the stripper must hand it
  // well-formed text to make that assertion mean anything.
  test('an unterminated block comment is blanked to the end, without throwing', () => {
    const un = stripCComments('int a = 1;\n/* never closed\nint b = 2;\n');
    assert.match(un.split('\n')[0], /^int a = 1;$/);
    assert.ok(!un.includes('int b'), 'text inside an unterminated comment survived');
    assert.equal(un.length, 'int a = 1;\n/* never closed\nint b = 2;\n'.length);
  });
});

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
    ['b0-parse',      'the pins parser accepts exactly five kinds and rejects the DERIVED `synth` and `cwd`',
                      'add `synth` or `cwd` to the kind table, or drop the absolute-path rule'],
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
    // RE-SCOPED BY 2026-0382 and the entry says so: this guard used to be
    // defence in depth behind a wider plan in which `project` was substituted
    // to `host` for an unmarked caller. The owner narrowed the substitution to
    // `fail` alone, so `policy_project_route`'s mark check is THE LIVE
    // PRODUCTION MECHANISM again — the only thing denying an unmarked caller at
    // a project path. Same assertion, load-bearing for a different reason.
    ['b7-unmarked',   'an unmarked caller at a project path gets -ENOENT and sends no frame — the LIVE mechanism, not defence in depth',
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
    ['b14-reasons',   'each control failure names itself in the event log as a `deny` row, and the three are distinguished',
                      'collapse remote-absent and control-refused into one reason'],
    ['b13-refusals',  'the event log records each (path, reason) from one caller exactly once, as EIGHT columns (seven tabs) with the KIND first',
                      'drop the dedupe, or key it on op as well; append the kind instead of leading with it; drop a column from the row'],
    // NOT `add the kind to the dedupe key` — that mutant is SEMANTICS-
    // PRESERVING and therefore unkillable anywhere. Every reason maps to
    // exactly one kind (the source-derived set equality below), so the kind is
    // a function of the reason and the two keys partition identically. Listed
    // as a mutant for one round; removed rather than "killed", because the only
    // way to kill it would be to assert on a cross-kind emission the daemon
    // cannot produce.
    ['b16-abandon',   'a project-tier abandon sends a RELEASE_ONLY DIRTY and drops the cached decision; no other tier sends anything',
                      'delete the ccu_call or the cache_invalidate; give the frame a REMOVED or FOR_WRITE bit or a BARE ZERO (which cc cannot tell from a killed handle\'s release); widen the tier test'],
    ['b17-cwd-exempt', 'an unmarked caller may getattr the cwd (here the project root) and nothing inside it, from a fixed 0111 node in the chain inode sub-range, with no frame and no cache entry',
                      'make the exemption unconditional; swap the chain predicate for tier_of; widen the op test past getattr; 0111 → 0555; route the inode through policy_bind_ino'],
    // INVERTED BY 2026-0382, WHICH ABSORBS 2026-0375. It used to record the
    // residual as a test; the 2026-09-08 amendment closes it, so the case now
    // asserts the exemption where it asserted the denial. This is the PRIMARY
    // proof of the widening, and it lives here because a mount test cannot see
    // it: `default_permissions` makes the kernel refuse the unmarked `opendir`
    // before the daemon's op allow-list is asked.
    ['b18-cwd-wide-mirror',
                      'under a WIDE advertised mirror root an intermediate project-tier directory with no exact pin IS exempt as a cwd chain component, so the chdir lives (2026-0375 closed)',
                      'restore the pin_exact test ⇒ /srv stops being exempt and the chdir dies one component early again; widen to tier_of ⇒ a child of the cwd becomes exempt'],
    ['b19-caller-tier-matrix',
                      'all 7 tiers × {marked, unmarked}: identity everywhere EXCEPT (unmarked, fail) → host',
                      'T_PROJECT → T_HOST for unmarked (the owner ruling violated — the headline mutant); T_HIDE → T_HOST (the confinement hole); T_BIND → T_HOST (breaks the three bind targets); let the MARKED branch substitute'],
    ['b20-caller-sensitive-set',
                      'policy_tier_is_caller_sensitive is true for EXACTLY {T_FAIL}, over all seven enum values',
                      'add T_PROJECT to the set; add T_HIDE; drop T_FAIL; `return 1` for everything'],
    ['b21-unmarked-refused-only-at-project',
                      'for an unmarked caller the substitution denies at NO tier, and the only denial policy.h can give one is policy_project_route’s',
                      'make the substitution emit a `deny` row at T_FAIL; make T_PROJECT stop denying'],
    ['b22-cwd-chain-extent',
                      'the cwd chain is ancestor-or-equal AT A COMPONENT BOUNDARY — both directions of the prefix-sharing sibling trap, and an unset cwd exempts nothing',
                      "drop the `/`-boundary check ⇒ /root/app and /roo become exempt for a cwd of /root/app3; use tier_of instead of the chain ⇒ a child becomes exempt; drop the op check; return T_CWD for a marked caller; make policy_cwd_component answer for a NULL cwd_path ⇒ the unset-cwd arm dies. NOT `default cwd_path in main()` — that mutant lives in union.c, which this fixture cannot reach; A16b's no-default source pin is what kills it"],
    ['b26-cwd-traverse-only',
                      'every chain component reports exactly S_IFDIR|0111, nlink 2, uid/gid 0, size 0, all three times 0 — and the op allow-list is {getattr}, with the refusal named in the log',
                      '0111 → 0555 (the ruling violated in the mode bits); drop the strcmp(op,"getattr") ⇒ readdir becomes exempt; change the allowed op to "opendir"; S_IFDIR → S_IFREG; nlink → the real child count'],
    ['b27-cwd-ino-distinct',
                      'every chain component gets a DISTINCT st_ino, and the chain sub-range is disjoint from both the ancestor range and the exact-pin range',
                      'route the chain through policy_bind_ino ⇒ every unpinned component collapses to SYNTH_INO_BASE + MAX_ANC; drop the `npins` term ⇒ the chain overlaps the pin range'],
    ['b28-cwd-input-validated',
                      'the cwd normalisation predicate rejects a trailing `/`, a `//` and a `.`/`..` component, and accepts a dotfile-named one',
                      'accept a doubled slash ⇒ the cwd itself stops matching and every chdir dies at its destination; accept a `..` component; reject a dotfile-named component ⇒ a real cwd is refused'],
    ['b24-event-kinds',
                      'each reason policy.h emits carries exactly one kind, read back out of the sink, and five emissions produce five rows',
                      'classify unmarked-host-served as `deny` (it would join R4’s fatal filter); classify unmarked-project-denied as `served`'],
    ['b25-substitution-logged-at-fail-only',
                      'an unmarked caller at `fail` emits exactly one served/unmarked-host-served row PER DISTINCT (PATH, THREAD GROUP); at `project` it emits a deny row and no served row',
                      'emit `served` at T_PROJECT (the ruling violated, from the log’s side); drop the row at T_FAIL; emit `deny` for the substitution; key the dedupe on op as well ⇒ two rows for one path'],
    ['b15-unreconcilable',
                      "a project-tier op outside the reconcile's domain refuses EOPNOTSUPP, and a host-tier one does not",
                      '`return -EOPNOTSUPP` → `return 0`; the T_PROJECT test flipped or widened to every tier; EOPNOTSUPP collapsed into EROFS'],
    ['b29-escape',    'policy_escape maps each byte class to its own escape, emits no raw tab/newline/CR/NUL, passes high bytes through, and reports a short buffer',
                      "escape the tab before the backslash ⇒ a literal `\\`+`t` and a real tab collapse to one spelling; render NUL as a space; drop the `\\x%02x` arm ⇒ a control byte goes through raw; let the escaper overrun instead of returning 0"],
    ['b30-absence',   'the three /proc absences are DISTINCT recorded values, an over-cap cmdline carries the `\\!truncated` suffix with the bytes it did read, and an argv spelling a sentinel is escaped so it cannot forge one',
                      'collapse gone and unreadable into one sentinel; report a zero-byte read as gone; drop the truncation suffix ⇒ a short argv reads as complete; emit the raw cmdline unescaped ⇒ `\\!gone` in an argv is indistinguishable from an exited process'],
    ['b31-dedupe-tgid',
                      'the dedupe key carries the TGID — one (path, reason) from two thread groups is two rows — and the row spells the calling TID then its thread group, in that order',
                      'revert the key to (path, reason) ⇒ every caller after the first is silently dropped; add the op to the key ⇒ two rows for one caller; swap the pid and tgid columns; read comm from the TID instead of the thread group'],
    ['b32-cwd-row',   'a GRANTED cwd traversal writes exactly one served/cwd-traversal-served row naming the thread group that needed the link, and the three refused shapes write none',
                      'drop the emission ⇒ no capture can ever show which process needed which link; emit before the conjunction is decided ⇒ a marked caller, a non-getattr op or an off-chain path all report an exemption that never happened; log the TID instead of the thread group'],
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
    const listed = new Set([...CASES.map(([id]) => id), 'frame-vectors', 'field-vectors']);
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
      ['REQ', CCU_OP.FETCH, CCU_FLAG_FOR_CREATE,
        { forCreate: true, forWrite: false, removed: false, releaseOnly: false }],
      ['REQ_WRITE', CCU_OP.FETCH, CCU_FLAG_FOR_WRITE,
        { forCreate: false, forWrite: true, removed: false, releaseOnly: false }],
      ['REQ_CREATE_WRITE', CCU_OP.FETCH, CCU_FLAG_FOR_CREATE | CCU_FLAG_FOR_WRITE,
        { forCreate: true, forWrite: true, removed: false, releaseOnly: false }],
      ['REQ_REMOVED', CCU_OP.DIRTY, CCU_FLAG_REMOVED,
        { forCreate: false, forWrite: false, removed: true, releaseOnly: false }],
      // T20 — THE FOURTH BIT. `0x08`, on DIRTY, and it must be DISTINCT from
      // every vector above: reusing `0x04` would make a release-only frame
      // decode as a removal and delete the file on the system.
      ['REQ_RELEASE_ONLY', CCU_OP.DIRTY, CCU_FLAG_RELEASE_ONLY,
        { forCreate: false, forWrite: false, removed: false, releaseOnly: true }],
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

  // ── THE EVENT ROW'S ESCAPING, CROSS-CHECKED ACROSS THE LANGUAGE BOUNDARY ──
  //
  // Same shape and same reason as the frame codec above: `policy_escape` (C)
  // and `decodeEventField` (session.ts) implement ONE format, and a test that
  // asserted each against its own transcription of that format would pass while
  // they disagreed. So the C side WRITES REAL ROWS and PRINTS the raw bytes it
  // put in them, and the TypeScript decoder is asserted against those.
  //
  // FIVE ROWS, ONE PER SHAPE THE DECODER MUST TELL APART — an ordinary argv,
  // the FORGERY, and the three /proc outcomes that are not a value. Read as
  // `latin1` so a byte is a code unit and every comparison is on BYTES rather
  // than on a decoding of them; `harvestEvents` reads it the same way, so this
  // test has no property production lacks.
  test('the event row round-trips every field shape into session.ts’s decoder', async () => {
    const { decodeEventField, parsePolicyEvents } = await import('../src/systems/fuse/session.ts');
    const dir = await mkdtemp('cc-policy-fields-');
    const logPath = path.join(dir, 'events.log');
    const r = await run(bin, ['field-vectors', logPath]);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    const printed = r.stdout.split('\n').filter(Boolean).map(l => l.split(' '));
    const vec = (label) => printed.filter(l => l[0] === 'VEC' && l[1] === label).map(l => l[2]);
    const one = (label) => { const v = vec(label); assert.equal(v.length, 1, label); return v[0]; };
    const truncLen = Number(printed.find(l => l[0] === 'TRUNCLEN')[1]);
    // NON-VACUITY: the fixture really emitted a multi-element argv and a cap,
    // so an empty decode cannot read as agreement.
    assert.equal(vec('argv').length, 4, `the fixture printed ${vec('argv').length} argv vectors`);
    assert.ok(truncLen > 0, `the fixture printed no cap: ${truncLen}`);

    const text = await fs.readFile(logPath, 'latin1');
    const lines = text.split('\n').filter(l => l !== '' && !l.startsWith('#'));
    assert.equal(lines.length, 5, `expected five rows, got: ${JSON.stringify(lines)}`);
    for (const l of lines)
      assert.equal(l.split('\t').length, 8, `a row is not eight columns: ${JSON.stringify(l)}`);
    const rows = parsePolicyEvents(text);
    assert.equal(rows.length, 5, JSON.stringify(rows.map(x => x.path)));
    const byPath = new Map(rows.map(x => [x.path, x]));
    const hexOf = (v) => Buffer.from(v, 'latin1').toString('hex');

    // ── 1. AN ORDINARY ARGV, every byte class in it ──────────────────────────
    const ok = byPath.get(Buffer.from(one('path'), 'hex').toString('latin1'));
    assert.ok(ok, `the parser did not recover the nasty path: ${[...byPath.keys()]}`);
    assert.equal(ok.cmdline.status, 'ok', JSON.stringify(ok.cmdline));
    assert.deepEqual(ok.cmdline.argv.map(hexOf), vec('argv'),
      'the parser did not recover the argv the C side put on the wire');
    assert.equal(hexOf(ok.comm.value), one('comm'));
    // …and the field decoder ALONE, on the raw column: every byte back,
    // NUL separators included.
    const rawCmd = decodeEventField(ok.cmdline.raw);
    assert.equal(rawCmd.status, 'ok');
    assert.equal(hexOf(rawCmd.value), vec('argv').join('00') + '00',
      'the field decoder did not recover the cmdline byte for byte');

    // ── 2. THE FORGERY. Raw bytes ending `\!truncated` escape to `\\!truncated`,
    //      which a right-to-left `endsWith` reads as the marker — dropping ten
    //      content bytes and calling a COMPLETE read truncated. All three
    //      escaped fields carry the shape at once.
    const forged = byPath.get(Buffer.from(one('fpath'), 'hex').toString('latin1'));
    assert.ok(forged, `the forging path did not round-trip: ${[...byPath.keys()]}`);
    assert.equal(hexOf(forged.path), one('fpath'), 'the forging PATH lost bytes');
    assert.equal(forged.comm.status, 'ok',
      `a complete comm was reported ${forged.comm.status}: ${JSON.stringify(forged.comm)}`);
    assert.equal(hexOf(forged.comm.value), one('fcomm'), 'the forging COMM lost bytes');
    assert.equal(forged.cmdline.status, 'ok',
      `a complete cmdline was reported ${forged.cmdline.status}: ${JSON.stringify(forged.cmdline)}`);
    assert.deepEqual(forged.cmdline.argv.map(hexOf), vec('fargv'), 'the forging ARGV lost bytes');

    // ── 3, 4. THE TWO ABSENCES THAT ARE NOT `gone`, decoded as absences ──────
    const unreadable = byPath.get('/f-unreadable');
    assert.equal(unreadable.comm.status, 'unreadable', JSON.stringify(unreadable.comm));
    assert.equal(unreadable.comm.value, null);
    assert.equal(unreadable.cmdline.status, 'unreadable', JSON.stringify(unreadable.cmdline));
    assert.equal(unreadable.cmdline.argv, undefined, 'an absence was split into an argv');
    const empty = byPath.get('/f-empty');
    assert.equal(empty.comm.status, 'empty', JSON.stringify(empty.comm));
    assert.equal(empty.cmdline.status, 'empty', JSON.stringify(empty.cmdline));

    // ── 5. A REAL TRUNCATION, which is what row 2 must not be confused with ──
    const trunc = byPath.get('/f-trunc');
    assert.equal(trunc.cmdline.status, 'truncated', JSON.stringify(trunc.cmdline).slice(0, 200));
    assert.equal(trunc.cmdline.value.length, truncLen,
      'the truncated field did not keep the bytes it did read');
    assert.match(trunc.cmdline.value, /^a+$/, 'the kept bytes are not the ones read');
    assert.equal(trunc.comm.status, 'ok', 'the comm of a truncated-cmdline row is unaffected');
  });

  // ── C4: THE CWD EXEMPTION'S OP ALLOW-LIST, AS AN ENUMERATION DERIVED FROM
  // union.c ──────────────────────────────────────────────────────────────────
  //
  // `getattr` is the ONLY op a chdir(2) performs against this daemon: with
  // `default_permissions` the kernel answers `access(2)` itself, and with
  // entry_timeout=0/attr_timeout=0 the LOOKUP and the MAY_EXEC refresh both
  // land in `pt_getattr`. Every other op is therefore out — and `opendir` is out
  // twice over, because a directory's LISTING is content inside it, which is the
  // exact thing the ruling withholds.
  //
  // ONE LITERAL, USED TWICE: it is driven through the predicate in the fixture
  // (where no kernel gate can mask the daemon's own answer) AND set-compared
  // against the op strings union.c actually routes, so an op added there without
  // being classified fails here rather than silently joining the allow-list.
  const NOT_EXEMPT_OPS = ['access', 'chmod', 'chown', 'create', 'getxattr', 'link',
    'listxattr', 'mkdir', 'mknod', 'open', 'opendir', 'readlink', 'removexattr',
    'rename', 'rmdir', 'setxattr', 'statfs', 'symlink', 'truncate', 'unlink', 'utimens'];

  test('the cwd exemption allows getattr and nothing else, at every chain component, and the set is union.c’s own', async () => {
    const src = await fs.readFile(UNION_C, 'utf8');
    const routed = [...src.matchAll(/\b(?:ROUTE|route)\("([a-z]+)"/g)].map(m => m[1]);
    assert.ok(routed.length > 20, `union.c's ops were not parsed: ${routed.length}`);
    assert.deepEqual([...new Set(routed)].sort(), [...NOT_EXEMPT_OPS, 'getattr'].sort(),
      'an op union.c routes is classified neither exempt nor not-exempt');

    // AND THE DERIVATION CANNOT BE EVADED. The set above is read off LITERAL
    // `ROUTE("…")` / `route("…")` call sites, so an op routed through a
    // VARIABLE would be invisible to it and would join the allow-list's blind
    // spot silently. Every non-literal call site is therefore enumerated here
    // — the three structural ones — and a fourth FAILS, rather than a comment
    // asking a future author to keep to the convention.
    const STRUCTURAL = [
      /^const char \*op, const char \*path, uint8_t cflags,/,   // route()'s own definition
      /^op, p, cflags, fop\)/,                                  // the ROUTE macro's parameter list
      /^op, p, cflags, fop, &r\);/,                             // and its body's forwarding call
    ];
    // PER LINE, AND THE WINDOW IS WHY. A `(.{0,60})` capture SWALLOWS any call
    // site whose text begins inside the previous match's window, and that was
    // already happening in this file: `route("rename", to, …)` at :1119 sits
    // one line below :1118 and went unseen (26 sites found, 27 present). A
    // variable-form op placed directly after a literal one — exactly the
    // rename/link two-line shape — therefore evaded both the per-site guard
    // and the count. Matching per line and taking the head to end-of-line
    // cannot overlap, so every site is classified.
    //
    // The lookbehind keeps `policy_project_route(` and friends out: `_` is a
    // word character, so there is no word boundary before `route` in them.
    const sites = [];
    src.split('\n').forEach((line) => {
      for (const m of line.matchAll(/(?<![\w])(?:ROUTE|route)\(/g))
        sites.push(line.slice(m.index + m[0].length));
    });
    assert.ok(sites.length > routed.length, `route() call sites were not parsed: ${sites.length}`);
    // Every literal site the op set was derived from is one of these, so the
    // two counts cannot drift apart unnoticed.
    assert.equal(sites.filter(t => t.startsWith('"')).length, routed.length,
      'the per-line sweep and the op-name extraction disagree about the literal sites');
    const nonLiteral = sites.filter(t => !t.startsWith('"'));
    for (const t of nonLiteral)
      assert.ok(STRUCTURAL.some(re => re.test(t)),
        `union.c routes an op through a NON-LITERAL name, so the allow-list cannot see it: route(${t}`);
    assert.equal(nonLiteral.length, STRUCTURAL.length,
      `expected exactly ${STRUCTURAL.length} structural route( sites, got ${nonLiteral.length}`);
    // …and every one of them is actually refused by the predicate — at the
    // project root (b17) AND at every other component of the cwd chain (b26).
    // BOTH, because the exemption widened: an allow-list that held at the root
    // and leaked at an intermediate component would pass b17 alone.
    for (const [id, want] of [['b17-cwd-exempt', 1], ['b26-cwd-traverse-only', 3]]) {
      const r = await run(bin, [id, ...NOT_EXEMPT_OPS]);
      assert.equal(r.code, 0, `${id}:\n${r.stdout}\n${r.stderr}`);
      const lines = r.stdout.split('\n').filter(Boolean);
      assert.ok(lines.every(l => l.startsWith('ok ')), r.stdout);
      for (const op of NOT_EXEMPT_OPS) {
        const n = lines.filter(l => l.includes(`\`${op}\` is not exempt`)).length;
        assert.equal(n, want,
          `${id} drove \`${op}\` against ${n} paths, expected ${want} — the op list reached `
          + 'fewer chain components than the case has');
      }
    }
  });

  // ── C8: WHERE union.c ASKS, AND WHERE IT DISPATCHES ────────────────────────
  //
  // The fixture cannot reach union.c, so the two-line call site is pinned from
  // the source — as `route()`'s flags byte is, and for the same reason: every
  // behavioural test drives `policy_cwd_exempt` directly, so a call site that
  // was never added, or that assigned the wrong tier, would be invisible.
  test('route() asks the exemption and pt_getattr dispatches T_CWD before SYNTHETIC', async () => {
    const src = await fs.readFile(UNION_C, 'utf8');
    assert.match(src, /policy_cwd_exempt\(op, path, \(pid_t\)fuse_get_context\(\)->pid\)\)\s*\{\s*\n\s*r->tier = T_CWD;/,
      'INVARIANT: route() asks policy_cwd_exempt with the CALLING THREAD id and assigns T_CWD — '
      + 'the call site is missing, takes a different id, or assigns another tier');
    const body = bodyOfIn(src, 'getattr');
    const dispatch = body.search(/if \(r\.tier == T_CWD\)\s*\n?\s*return policy_cwd_getattr\(path, st\);/);
    const synthetic = body.search(/if \(SYNTHETIC\(r\.tier\)\)/);
    assert.ok(dispatch > 0,
      'INVARIANT: pt_getattr dispatches T_CWD to policy_cwd_getattr — that branch is gone');
    assert.ok(synthetic > 0,
      'INVARIANT: pt_getattr keeps its SYNTHETIC branch — the ordering below compares two LIVE branches');
    // BEFORE the synthetic branch — and the order is INERT today, because
    // `SYNTHETIC(t)` is `(t == T_SYNTH || t == T_BIND)` and so is false for
    // T_CWD: moving the branch below it changes nothing behaviourally. What
    // this pins is the safe placement for the day SYNTHETIC() is widened to
    // include T_CWD, after which the ordering is the only thing keeping this
    // node from being answered out of the ancestor table it is not in. (The
    // -ENOENT outcome belongs to the CALL-SITE mutant the first assertion
    // covers, not to this move.)
    assert.ok(dispatch < synthetic,
      'INVARIANT: the T_CWD branch comes BEFORE SYNTHETIC(), so that widening SYNTHETIC() to '
      + 'include T_CWD cannot start answering this node from the ancestor table it is not in');
    // The exemption is asked INSIDE the T_PROJECT arm, after the self-recursion
    // guard — liveness first, and no other tier may reach it.
    const arm = src.slice(src.indexOf('case T_PROJECT: {'), src.indexOf('case T_FAIL:'));
    // PRESENCE FIRST, because `indexOf` answers -1 for an absent needle and -1
    // is less than everything — so both orderings below would pass VACUOUSLY
    // against an arm that had lost a call site altogether.
    for (const needle of ['caller_is_self()', 'policy_cwd_exempt(', 'policy_project_route('])
      assert.ok(arm.includes(needle), `route()'s T_PROJECT arm no longer calls ${needle}`);
    assert.ok(arm.indexOf('caller_is_self()') < arm.indexOf('policy_cwd_exempt('),
      'INVARIANT: the self-recursion guard is asked BEFORE the exemption — liveness first, '
      + 'since the guard exists to stop this daemon re-entering itself');
    assert.ok(arm.indexOf('policy_cwd_exempt(') < arm.indexOf('policy_project_route('),
      'INVARIANT: the exemption is asked BEFORE policy_project_route — after it, the unmarked '
      + 'denial has already returned and the exemption can never fire');
  });

  // ── THE EVENT LOG'S KIND CLASSIFICATION, DERIVED AND SET-COMPARED ─────────
  //
  // DISTRUST THE HAND-MAINTAINED ENUMERATION — which is the whole reason the
  // kind became a column. One side of this comparison is READ OFF THE C SOURCE
  // (every `policy_event(` call site in both files, with its kind and its
  // reason expression); the other is the table below. Compared in BOTH
  // directions, so neither a reason with no table entry nor a table entry
  // naming no reason can survive.
  //
  // WHY A SOURCE PIN AND NOT A BEHAVIOURAL ONE. `b24` reads the kinds back out
  // of the sink for the five reasons policy.h emits — pinned where they are
  // PRODUCED. The other seven live in `union.c` op bodies that no deterministic
  // fixture can reach (there is no libfuse here and no host fd), so their only
  // enforcing layer is the source. The split is stated so neither half is
  // credited with the other's coverage.
  //
  // `served` MEANS "THE OP SUCCEEDED, BUT NOT THE WAY THE TIER TABLE SAID", and
  // getting one of these wrong is a live defect rather than a label:
  // R4's fatal filter is `kind === 'deny'`, so a `served` row mis-kinded
  // `deny` reds the gate on an ordinary shell startup, and a `deny` row
  // mis-kinded `served` drops out of the check that the pin list is derived
  // from.
  const EVENT_KINDS = {
    // ── deny: the caller got a negative errno ───────────────────────────────
    'unpinned-fail-closed':      'EV_DENY',   // route()'s fall-through, -ENOENT
    'unmarked-project-denied':   'EV_DENY',   // policy_project_route's mark check
    'control-unavailable':       'EV_DENY',   // -EIO
    'remote-absent':             'EV_DENY',   // -ENOENT
    'control-refused':           'EV_DENY',   // -EACCES
    'not-reconcilable':          'EV_DENY',   // -EOPNOTSUPP
    'xdev-rename':               'EV_DENY',   // -EXDEV
    'dirty-push-refused':        'EV_DENY',   // push_mirror_flags returns the op's rc
    'dirty-remove-refused':      'EV_DENY',
    // ── served: the op succeeded, off the tier table's script ───────────────
    // Returns 0 with `host_fd` — a liveness precondition, not a refusal. It is
    // the row that made `refusals.log` a false name.
    'self-recursion':            'EV_SERVED',
    // The readdir SUCCEEDS; a name past MAX_PINNED_CHILDREN is dropped from it.
    'pinned-children-truncated': 'EV_SERVED',
    // 2026-0382: an unmarked caller was routed to the host at an unpinned path.
    'unmarked-host-served':      'EV_SERVED',
    // 2026-0389: the cwd-chain exemption GRANTED — the getattr succeeds off the
    // tier table's script, and the row is what makes the traversal capturable.
    'cwd-traversal-served':      'EV_SERVED',
  };

  test('every reason the daemon emits carries exactly one kind, and the set matches both ways', async () => {
    const raw = { 'union.c': await fs.readFile(UNION_C, 'utf8'), 'policy.h': await fs.readFile(POLICY_H, 'utf8') };
    // COMMENTS BLANKED FIRST — see stripCComments. Both files DISCUSS
    // `policy_event(` in prose, and a raw scan reads those as call sites.
    const srcs = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, stripCComments(v)]));
    // NON-VACUITY OF THE STRIP ITSELF: it must remove something and must not
    // remove the code. A stripper that returned '' would make every derivation
    // below pass by finding nothing.
    for (const [name, v] of Object.entries(srcs)) {
      assert.ok(v.length === raw[name].length, `${name}: the strip changed the offsets`);
      assert.ok(v.includes('policy_event('), `${name}: the strip removed the call sites too`);
      assert.ok(!/\bDEDUPE KEY\b/.test(v), `${name}: the strip left comment prose behind`);
    }
    // Reason → the set of kinds the SOURCE emits it under, and where.
    const found = new Map();
    for (const [name, src] of Object.entries(srcs)) {
      let at = 0;
      for (;;) {
        at = src.indexOf('policy_event(', at);
        if (at < 0) break;
        // The definition itself is not a call site.
        const lineStart = src.lastIndexOf('\n', at) + 1;
        if (/static inline void\s*$/.test(src.slice(lineStart, at))) { at += 1; continue; }
        // Split the argument list on TOP-LEVEL commas, so the ternary reason
        // expression at `push_mirror_flags` (one argument, two literals) is not
        // shredded and the op-name literals cannot be mistaken for reasons.
        let i = at + 'policy_event('.length, depth = 0;
        const args = ['']; 
        for (; i < src.length; i++) {
          const ch = src[i];
          if (ch === '(') depth++;
          else if (ch === ')') { if (depth === 0) break; depth--; }
          if (ch === ',' && depth === 0) { args.push(''); continue; }
          args[args.length - 1] += ch;
        }
        assert.ok(i < src.length, `an unterminated policy_event( call site in ${name}`);
        assert.equal(args.length, 5,
          `policy_event takes (kind, op, path, reason, tid); ${name} has a call site with ${args.length} arguments: ${args.join('|')}`);
        const kind = args[0].trim();
        assert.match(kind, /^EV_(DENY|SERVED)$/,
          `${name}: a policy_event call site passes a non-literal kind '${kind}', so this derivation cannot see it`);
        const reasons = [...args[3].matchAll(/"([a-z][a-z-]*)"/g)].map(m => m[1]);
        assert.ok(reasons.length > 0,
          `${name}: a policy_event call site has no literal reason: ${args[3].trim()}`);
        for (const r of reasons) {
          if (!found.has(r)) found.set(r, new Set());
          found.get(r).add(kind);
        }
        at = i;
      }
    }
    // NON-VACUITY: the parse ran and found real call sites.
    assert.ok(found.size >= 10, `the policy_event call sites were not parsed: ${found.size}`);

    // 1. EXACTLY ONE KIND PER REASON, derived purely from the code — nothing
    //    below is consulted for this half.
    const multi = [...found].filter(([, ks]) => ks.size !== 1).map(([r, ks]) => `${r}: ${[...ks].join('+')}`);
    assert.deepEqual(multi, [], 'these reasons are emitted under more than one kind');

    // 2. SET EQUALITY, BOTH DIRECTIONS.
    assert.deepEqual([...found.keys()].sort(), Object.keys(EVENT_KINDS).sort(),
      'the reasons union.c/policy.h emit and the reasons EVENT_KINDS classifies differ — '
      + 'add the new reason with its kind, or drop the entry that names none');

    // 3. AND THE KIND ITSELF AGREES, per reason.
    for (const [reason, kinds] of found)
      assert.equal([...kinds][0], EVENT_KINDS[reason], `${reason} is emitted as ${[...kinds][0]}`);

    // 4. `ev_kind_name` MAPS BOTH AND NOTHING ELSE, so the column an operator
    //    (and R4) filters on cannot silently gain a third value: the switch has
    //    no `default:` arm, and a third enumerator would fail the -Werror
    //    compile of the driver fixture before any of this ran.
    const kindDecl = raw['policy.h'].match(/enum ev_kind \{[^}]*\}/);
    assert.ok(kindDecl, 'enum ev_kind is gone from policy.h');
    assert.equal(kindDecl[0], 'enum ev_kind { EV_DENY = 0, EV_SERVED }',
      'enum ev_kind gained or lost a member — R4 filters on exactly these two');
  });

  // ── THE CALLER-SENSITIVE SUBSTITUTION'S CALL SITE ─────────────────────────
  //
  // `b19`/`b20` drive the two predicates directly, so a call site that was
  // never added — or that asks with the wrong id, or in the wrong place — is
  // invisible to them. Same reason `route()`'s flags byte and the cwd
  // exemption's call site are pinned from the source.
  test('route() substitutes the caller-sensitive tier, after the mark and before dispatch', async () => {
    const src = await fs.readFile(UNION_C, 'utf8');
    assert.match(src,
      /if \(policy_tier_is_caller_sensitive\(r->tier\)\)\s*\n\s*r->tier = policy_caller_tier\(op, path, r->tier,\s*\n\s*policy_is_marked_tid\(\(pid_t\)fuse_get_context\(\)->pid\),\s*\n\s*\(pid_t\)fuse_get_context\(\)->pid\);/,
      'INVARIANT: route() asks policy_tier_is_caller_sensitive and reassigns r->tier from '
      + 'policy_caller_tier with the CALLING THREAD id — for the mark AND for the log row\'s '
      + 'identity columns. The call site is missing, takes a different id, or drops the '
      + 'reassignment');
    // AFTER THE MARKING EVENT. `mark_maybe` is what makes the CLI's own thread
    // group marked at all; asking the mark before it fires would substitute the
    // host for the CLI's very first op.
    const body = src.slice(src.indexOf('static int route('), src.indexOf('#define ROUTE('));
    for (const needle of ['mark_maybe(path);', 'policy_tier_is_caller_sensitive(', 'switch (r->tier) {'])
      assert.ok(body.includes(needle), `route() no longer contains ${needle}`);
    assert.ok(body.indexOf('mark_maybe(path);') < body.indexOf('policy_tier_is_caller_sensitive('),
      'INVARIANT: the substitution is asked AFTER the marking event — before it, the CLI is '
      + 'unmarked on its own first op and would be served the host at `fail`');
    // AND BEFORE THE SWITCH, because the T_HOST arm is what gives the
    // substituted route its host fd. Inside an arm it could not reach one.
    assert.ok(body.indexOf('policy_tier_is_caller_sensitive(') < body.indexOf('switch (r->tier) {'),
      'INVARIANT: the substitution happens BEFORE the tier switch, so the T_HOST arm assigns '
      + 'the substituted route its host fd');
    // THE `fail` FALL-THROUGH IS STILL THE ONLY PLACE `unpinned-fail-closed` IS
    // WRITTEN, so the reason really is the marked CLI's alone.
    assert.equal((src.match(/"unpinned-fail-closed"/g) ?? []).length, 1,
      'unpinned-fail-closed is emitted from more than one place');
  });

  // ── THE TIER ENUM'S MEMBER SET ────────────────────────────────────────────
  //
  // `b19` and `b20` iterate `0 .. T_CWD`, so a member APPENDED after T_CWD
  // would be uncovered by both. `tier_name`'s default-less switch makes that a
  // -Werror compile failure of the driver fixture — but a member added WITH a
  // switch arm would compile and slip past the loops silently, and its
  // caller-sensitivity would be nobody's decision. Pinned at the declaration.
  test('enum tier has exactly the seven members the caller-tier matrix drives', async () => {
    const src = await fs.readFile(POLICY_H, 'utf8');
    const decl = src.match(/enum tier \{[^}]*\}/);
    assert.ok(decl, 'enum tier is gone from policy.h');
    assert.equal(decl[0], 'enum tier { T_FAIL = 0, T_HOST, T_PROJECT, T_HIDE, T_BIND, T_SYNTH, T_CWD }',
      'enum tier changed: b19/b20 iterate 0..T_CWD, so a member appended past T_CWD is driven by '
      + 'neither and its caller-sensitivity was never decided');
  });

  // ── T19b: THE TRACE SEPARATES A READ OPEN FROM A WRITE OPEN ────────────────
  //
  // PINS: every ROUTE-traced line carries the CCU_FLAG_* byte the op declared,
  // so `open` at `cflags=2` is a WRITE open and `cflags=0` is a read one.
  //
  // IT IS AN INSTRUMENT CLAIM AND THAT IS WHY IT IS PINNED. The two-handle
  // premise is carried as a standing condition whose CHECK is a
  // `CC_FUSE_TRACE=1` capture counted offline (PROVENANCE D13c, measurement
  // M6) — and a trace that reported `cflags=0` for every op would answer the
  // question with a confident zero instead of failing. A source-shape
  // assertion, because no deterministic fixture can reach a libfuse op body.
  test('T19b: the trace line carries the frame intent the op declared', async () => {
    const src = await fs.readFile(UNION_C, 'utf8');
    assert.match(src, /"%s\\t%s\\ttier=%s cflags=%u /,
      'INVARIANT: the trace line has a cflags field — without it a capture cannot tell a read '
      + 'open from a write open, and M6 cannot be measured at all');
    // CARRIED ON THE ROUTE, not re-derived. `struct route` records the byte it
    // was handed, and every trace site reads it back off the route — so a
    // route whose flags change cannot leave a trace site reporting the old
    // intent.
    assert.match(src, /struct route \{[\s\S]*?uint8_t\s+intent;[\s\S]*?\};/,
      'INVARIANT: struct route carries the frame intent it was given');
    assert.match(src, /r->intent = cflags;/,
      'INVARIANT: route() records the cflags byte it was handed — without it every trace '
      + 'site reads an uninitialised value');
    assert.match(src, /tr\(op, p, tier_name\(r\.tier\), r\.intent\);/,
      'INVARIANT: ROUTE forwards the ROUTE\'S OWN intent to tr — a literal there reports the '
      + 'same intent for every op');
    // AND THE TWO OPS THAT ROUTE BOTH ENDS BY HAND. These called `route()`
    // directly and traced a HAND-COPIED literal; the literals happened to
    // equal the `to` route's flags, so the trace was right by coincidence and
    // would have gone on reporting the old intent the moment either call
    // changed. A confidently wrong number is one level worse than the blind
    // instrument this field was added to fix.
    for (const op of ['rename', 'link']) {
      assert.match(src, new RegExp(`tr\\("${op}", to, tier_name\\(rt\\.tier\\), rt\\.intent\\);`),
        `INVARIANT: pt_${op} traces the intent its own \`to\` route carries, not a copy of it`);
      assert.doesNotMatch(src, new RegExp(`tr\\("${op}", to, tier_name\\(rt\\.tier\\), CCU_FLAG`),
        `INVARIANT: pt_${op}'s trace does not hand-copy a flag literal`);
    }
    // AND THE `fh` BRANCHES REPORT 0 HONESTLY: they send no frame, so there is
    // no intent to report, and a non-zero there would invent one.
    for (const op of ['getattr', 'chmod', 'chown', 'truncate', 'utimens']) {
      assert.match(src, new RegExp(`tr\\("${op}", path, "fh", 0\\);`),
        `INVARIANT: pt_${op}'s fh branch reports cflags=0 — it sends no frame`);
    }
  });

  // ── T19: THE RELEASING FRAME'S FLAGS, PINNED AT THE PRODUCER ───────────────
  //
  // PINS: `pt_release`'s reconcile frame carries CCU_FLAG_RELEASE_ONLY exactly
  // when the handle is NOT dirty, and carries nothing when it is.
  //
  // A SOURCE-SHAPE ASSERTION, and the asymmetry is the same one PROVENANCE
  // records for FOR_WRITE: no deterministic fixture can observe what the
  // libfuse daemon put on the wire, because the fixture cannot reach an op
  // body. The CONSUMER's half of this bit is driven for real in
  // tests/fuse-transport.test.mjs (T14/T15); this is the half that says the
  // daemon sends it, and that the condition is `fd_dirty` — the expression that
  // keeps the killed-process backstop alive.
  test('T19: pt_release sends RELEASE_ONLY only when the handle is not dirty', async () => {
    const src = await fs.readFile(UNION_C, 'utf8');
    const body = bodyOfIn(src, 'release');
    // The frame is sent through the FLAGS entry point at all — `push_mirror`
    // cannot express this bit, so a body still calling it is the mutant that
    // reinstates the double upload.
    assert.match(body, /push_mirror_flags\("release", path,/,
      'INVARIANT: pt_release sends its reconcile through push_mirror_flags — a `push_mirror` call '
      + 'here cannot carry RELEASE_ONLY at all, and every written file uploads twice');
    assert.doesNotMatch(body, /push_mirror\("release"/,
      'INVARIANT: pt_release no longer sends a flagless reconcile');
    // THE CONDITION, AND ITS DIRECTION. `fd_dirty[fd] ? 0 : RELEASE_ONLY` — an
    // inversion compiles, keeps the flag present, and silently drops the bytes
    // of every handle whose flush never ran.
    assert.match(body, /fd_dirty\[fd\] \? 0 : CCU_FLAG_RELEASE_ONLY/,
      'INVARIANT: the flag is conditioned on fd_dirty, and in this direction — a dirty handle '
      + 'sends a FULL reconcile (the killed-process backstop) and a clean one sends RELEASE_ONLY');
    // AND THE TIER/CLAIM GUARD IS STILL WHAT DECIDES WHETHER ANY FRAME GOES.
    // Without this, a mutant that hoisted the push out of the guard would keep
    // both assertions above and start sending release frames for host-tier
    // handles.
    assert.match(body, /fd_claimed\[fd\] &&\s+\(enum tier\)fd_tier\[fd\] == T_PROJECT\) \{\s+push_mirror_flags\("release"/,
      'INVARIANT: the release frame is sent only for a CLAIMED project-tier handle');
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
    // EITHER ENTRY POINT COUNTS HERE — the claim this line makes is that a
    // release still sends a reconcile frame at all. WHICH flags it carries is
    // T19's, above, and a `push_mirror(` here would fail that one.
    assert.match(bodyOf('release'), /push_mirror_flags\(|push_mirror\(/, 'pt_release stopped pushing');
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
    // WHAT THIS LOOP IS AND IS NOT. It is a PRESENCE grep: b16 proves what an
    // abandon does, and the real-gate arms exercise one end to end without ever
    // observing the release. So a future claiming op with a post-READY failure
    // path that forgets its abandon is caught by nothing here except the name
    // being absent from its body. No live gap — every claiming op's failure
    // paths were re-enumerated at this tree — but a weakness of the record, and
    // one that only bites daemon-side: cc's `#fetch` wrapper releases on any
    // non-READY reply, so the whole FETCH-side class is backstopped
    // behaviourally whatever union.c does. See PROVENANCE.md, "what is measured
    // where".

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
