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
    // RE-SCOPED BY 2026-0382: this guard had been defence in depth behind a
    // wider plan in which `project` was substituted to `host` for an unmarked
    // caller; the owner narrowed the substitution to `fail` alone, which made
    // the mark check the live production mechanism for one card's worth of
    // history. Recorded because the reasoning is what moved, not the assertion.
    // RE-SCOPED AGAIN BY 2026-0398, AND THE DIRECTION IS BACK. An unmarked
    // caller resolves in VIEW_HOST, where `tier_of` skips every `project` pin —
    // so no unmarked resolution can produce T_PROJECT and route() cannot
    // dispatch one here. The mark check is DEFENCE IN DEPTH once more, and the
    // live mechanism is the view (b41). Kept, because deleting a liveness guard
    // on the only function that sends a control frame is not worth the risk.
    ['b7-unmarked',   'an unmarked caller at a project path gets -ENOENT and sends no frame — defence in depth behind the view, which is where the invariant is now structural',
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
    ['b19-caller-tier-matrix',
                      'all 6 tiers × {marked, unmarked}, run once per HOST AXIS: the marked side is identity everywhere, the unmarked side is host at fail/project/synth and identity at host/hide/bind — and THE TWO PASSES AGREE, so the host axis is out of the decision',
                      'restore a host-existence gate at T_PROJECT or T_SYNTH ⇒ the two passes diverge; drop the T_SYNTH re-resolution ⇒ the synth row stays synth; T_HIDE → T_HOST (the confinement hole); T_BIND → T_HOST (breaks the three bind targets); let the MARKED branch substitute'],
    ['b20-caller-sensitive-set',
                      'policy_tier_is_caller_sensitive is true for EXACTLY {T_FAIL, T_PROJECT, T_SYNTH}, over all six enum values',
                      'drop T_SYNTH (every ancestor-of-a-pin directory keeps meeting a 0555 scaffold node over a directory the orchestrator HAS — the headline mutant, and nothing else in the fixture sees it); drop T_PROJECT; add T_HIDE (the confinement hole); add T_BIND; drop T_FAIL; `return 1` for everything'],
    ['b21-unmarked-refused-only-at-project',
                      'with the host holding an entry at every probe path, the substitution denies at NO tier and serves at exactly three (fail + project + synth, all landing on the one `fail -> host` rule); the only denial policy.h can give is policy_project_route’s',
                      'make the substitution emit a `deny` row at any substituted tier; drop any of the three ⇒ the served count falls; give the re-resolved tiers a reason of their own ⇒ the count is unchanged but b24’s reason set breaks; make policy_project_route stop denying'],
    ['b22-cwd-chain-extent',
                      'the cwd chain is ancestor-or-equal AT A COMPONENT BOUNDARY — both directions of the prefix-sharing sibling trap — and it is the OVERLAY’s whole domain: an unset cwd synthesizes nothing anywhere',
                      "drop the `/`-boundary check ⇒ /root/app and /roo join the chain for a cwd of /root/app3; use tier_of instead of the chain ⇒ a child of the cwd gets an overlay node; make policy_cwd_component answer for a NULL cwd_path ⇒ the unset-cwd arm dies; drop the overlay clause from resolve_class ⇒ the cwd itself stops answering. NOT `default cwd_path in main()` — that mutant lives in union.c, which this fixture cannot reach; A16b's no-default source pin is what kills it"],
    ['b27-cwd-ino-distinct',
                      'every chain component gets a DISTINCT st_ino — now read through the overlay node’s own policy_synth_getattr in VIEW_HOST — and the chain sub-range is disjoint from both the ancestor range and the exact-pin range',
                      'route the chain through policy_bind_ino ⇒ every unpinned component collapses to SYNTH_INO_BASE + MAX_ANC; drop the `npins` term ⇒ the chain overlaps the pin range; take the overlay node’s inode from anc_find ⇒ it answers -ENOENT, the node the chain is not in'],
    ['b28-cwd-input-validated',
                      'the cwd normalisation predicate rejects a trailing `/`, a `//` and a `.`/`..` component, and accepts a dotfile-named one',
                      'accept a doubled slash ⇒ the cwd itself stops matching and every chdir dies at its destination; accept a `..` component; reject a dotfile-named component ⇒ a real cwd is refused'],
    ['b24-event-kinds',
                      'each of the FIVE reasons policy.h emits carries exactly one kind, read back out of the sink, and one emission per reason produces exactly one row each',
                      'classify unmarked-host-served as `deny` (it would join R4’s fatal filter on an ordinary shell startup); classify unmarked-project-denied as `served`; give the re-resolved project/synth substitution a reason of its own ⇒ a sixth reason the table does not name'],
    ['b25-substitution-logged-per-path-and-tgid',
                      'the substitution emits exactly one served row PER DISTINCT (PATH, THREAD GROUP), and a project-tier path produces the SAME `unmarked-host-served` row as a fail-tier one rather than a second reason',
                      'drop the row; emit `deny` for it; key the dedupe on op as well ⇒ two rows for one path; give the project re-resolution its own reason ⇒ the shared-reason count at the project path dies'],
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
    ['b37-unmarked-never-gets-remote',
                      'over 6 tiers × {host-has, host-lacks} × {marked, unmarked} the map returns the INPUT tier or T_HOST and nothing else, and at (unmarked, project) it is T_HOST ON BOTH HOST AXES',
                      'return any third tier from the map; return T_PROJECT for an unmarked caller at a host-having project path (the ruling violated). NOT `make the map op-sensitive` — every case here drives `"getattr"` only, so a mutant keying on the op while PRESERVING getattr survives the whole unit fixture, and the graded mutation suite with it (that suite sets no RUN_FUSE_LIFECYCLE). Measured by hand at the real gate, where the two variants die in DIFFERENT places: keying the T_PROJECT rule alone dies at R2 and at R13(d)’s host-shadowed half — pt_getattr still substitutes, the shell’s open does not, and the read fails — while keying BOTH rules dies at R2 and at R13(a), the first fail-tier open in the file, so (b) and (f) never run'],
    // ── 2026-0398: ONE RULE, TWO VIEWS, NO GEOMETRY IN EITHER ────────────
    ['b38-view-is-geometry-invariant',
                      'the VIEW_HOST resolution of one fixed path set is IDENTICAL at all three geometries (mirrorRoot == systemPath, a strict ancestor, and /), and the answers are the right ones — while VIEW_CLI DIFFERS across the same three builds',
                      'key anything unmarked on mirrorRoot; let VIEW_HOST consult the ancestor table ⇒ `/` is synth at N and fail at W and the identity dies at the first path; stop striking `project` pins in VIEW_HOST ⇒ the space between mirrorRoot and systemPath answers per-geometry again; strike `hide` or `bind` too'],
    ['b39-chdir-lives-at-every-geometry',
                      'every component of the cwd chain is ENTERABLE in VIEW_HOST at all three geometries — by the orchestrator’s own 0700 directory with the floor’s 0111, or by the overlay node where it has none — including the two arms never run before: an EXACT project pin on the intervening component (M) and prefix coverage (W)',
                      'drop the floor ⇒ the 0700 link is unsearchable and every spawn dies in chdir(); drop the overlay ⇒ the cwd leaf answers -ENOENT; scope either to the project path instead of the chain ⇒ M and W die while N passes'],
    ['b40-marked-is-untouched',
                      'constraint 5: VIEW_CLI’s resolution is the tier table as written at all three geometries — project root and its files remote, the space above it remote at M and W and a synthetic ancestor at N, host/hide/bind pins unmoved — and a marked caller takes the identity map',
                      'strike `project` pins in VIEW_CLI; skip the ancestor table in VIEW_CLI; let the MARKED branch of policy_caller_tier substitute ⇒ the CLI reads the host’s file at the project’s own spelling'],
    ['b41-no-unmarked-resolution-names-the-remote',
                      'constraint 3, structurally: over the path set × three geometries VIEW_HOST never yields T_PROJECT and policy_caller_tier never returns it, and the re-resolution’s range over that set is {T_HOST, T_SYNTH, T_FAIL, T_HIDE} — the geometry BUILDS the hide/longer-project overlap that meets the fourth member, and `n_hide == 3` is what keeps the claim from passing vacuously',
                      'stop striking `project` pins in VIEW_HOST ⇒ an unmarked caller names the remote and policy_project_route becomes reachable again; return the input tier unchanged from the re-resolution ⇒ T_PROJECT survives; substitute T_HIDE to host in the re-resolution ⇒ the mirror and the control socket become reachable to an unmarked caller at a project-pinned spelling, and the n_hide count dies; drop the overlap from the geometry ⇒ the fourth member goes unmet and the range claim is vacuous again'],
    ['b43-uncovered-is-still-the-hosts',
                      '`fail -> host` is untouched and UNCONDITIONAL at all three geometries, for an unpinned file and for an unpinned directory that is NOT a chain component — including a path the host does not have',
                      'gate the T_FAIL substitution on policy_host_absent ⇒ the unmarked CREATE at an unpinned path (real gate R13(f)) dies, the 2026-09-08 "host means host" decision reverted; make the overlay fire off the chain ⇒ an unpinned directory becomes a synthetic node'],
    ['b44-dirent-visible',
                      'card 2026-0403, AT THE DEFAULT NARROW ROOT: policy_dirent_visible answers per view — T_HIDE invisible to both, T_FAIL invisible to VIEW_CLI and visible to VIEW_HOST (both the explicit `fail` pin and the wholly unpinned name), host/bind/synth/project visible to both — and policy_synth_children asks the SAME predicate',
                      'restore the caller-insensitive `T_HIDE || T_FAIL` filter ⇒ an unmarked `ls /tmp` emits nothing while `cat /tmp/x` works, the measured defect; drop the T_HIDE clause ⇒ the run dir and the mirror are listed; make T_FAIL visible to VIEW_CLI ⇒ `ls` and `cat` disagree for the CLI; leave policy_synth_children’s own tier test inline ⇒ the two arms drift'],
    ['b46-floor-scope',
                      'the floor fires ONLY on a VIEW_HOST directory that is a cwd-chain component — not a file, not off the chain, not below the cwd, not the prefix-sharing sibling, not VIEW_CLI — and its effect is exactly `|= 0111` with nothing else in the stat touched',
                      'drop the S_ISDIR guard; drop policy_cwd_component ⇒ an unscoped floor grants traversal the host denies (constraint 1); drop the VIEW_HOST guard ⇒ the marked CLI is handed a mode the host does not report; widen 0111 to 0555'],
    ['b47-floor-is-applied-at-every-reporting-op',
                      'the floor’s TWO entry points agree: `stat`, `fstat` and the readdir child stat report the same 0111, and policy_floor_mask grants X_OK exactly where they do while referring R_OK and F_OK to the host unchanged',
                      'floor in one pt_getattr arm only ⇒ stat and fstat disagree; omit policy_floor_mask ⇒ `test -x /root` refuses what `stat /root` advertises, from one caller; clear R_OK as well ⇒ the floor grants access, not just resolution; return 0 for F_OK ⇒ every existence probe on the chain answers yes without asking the host'],
    ['b49-table-child-exists',
                      'a table-derived dirent name is emitted only where the RESOLVING VIEW can open it: a fixed node (ancestor in VIEW_CLI, overlay in VIEW_HOST, bind in both) exists by construction, everything else exactly where the orchestrator has it — driven over an excluded child of an overlay, a project-pinned child that IS the overlay, an ancestor the host lacks, a present and an absent host pin, and a bind target. AND THE SCAFFOLD AXIS: on a node with no backing store the flag carves out T_PROJECT and NOTHING ELSE — a project child is taken on trust, a host pin child of that same node is still checked in both directions, a fixed node is unaffected, and the flag changes no VIEW_HOST answer at all',
                      'branch on the RAW PIN TIER ⇒ the project-pinned overlay child is host-checked and dropped (`cd <systemPath>` works while `ls` of its parent omits the name) and a host-absent ancestor is emitted unchecked in VIEW_HOST; drop the T_SYNTH/T_BIND arm ⇒ the overlay cwd vanishes from its parent’s listing; drop the host probe ⇒ an excluded child of an overlay is listed while every op on it answers -ENOENT; reuse policy_dirent_visible for this question ⇒ visibility and existence collapse and all three return. ON THE FLAG: widen the carve-out past T_PROJECT (`if (scaffold) return 1`) ⇒ the marked CLI’s `ls /etc` names ETC_PINS entries absent on this host while `cat` answers -ENOENT, card 2026-0403’s third instance restored; drop the carve-out (`scaffold` ignored) ⇒ a project child of a scaffold node is host-probed on the wrong axis and the project leaves the marked `ls` of its parent, breaking §4’s marked row; make the flag reach VIEW_HOST ⇒ the inertness assertion dies'],
    ['b48-probe-falls-not-absent',
                      'policy_host_absent answers ABSENT for ENOENT / ENOTDIR / ENAMETOOLONG and for a negative fd, NOT ABSENT for a present file, directory or DANGLING symlink, and NOT ABSENT for an ELOOP — the failure direction that keeps an unknown error loud instead of silently hiding a host directory',
                      '`return fstatat(...) != 0` ⇒ ELOOP reads as absence and a synthetic node hides real host data, the silent-hiding direction; reuse policy_host_has’s polarity ⇒ every answer inverts; drop AT_SYMLINK_NOFOLLOW ⇒ a dangling symlink reads as absent and gets an overlay node; return 0 for a negative fd ⇒ the seam-unset axis every other case leans on collapses'],
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
  // THE FLOOR'S OP ENUMERATION, DRIVEN FROM ONE LIST. The floor is the only
  // mutation of a host stat this daemon makes, and applying it at fewer than
  // every op that REPORTS PERMISSION makes it a seam inside the seam it exists
  // to close: `stat /root` advertising a traversal that `test -x /root` then
  // refuses, from one caller. `b47` proves the two entry points AGREE; what no
  // fixture can reach is WHICH OP BODIES CALL THEM, because there is no libfuse
  // here — so that half is pinned from the source, the way `route()`'s flags
  // byte is.
  //
  // TWO ENTRY POINTS, AND THE SPLIT IS MECHANICAL RATHER THAN A SECOND RULE:
  // three of the four ops hold a `struct stat` and go through
  // `policy_floor_traversal`; `pt_access` holds a MASK and goes through
  // `policy_floor_mask`. Both are `policy_floor_applies` underneath.
  const FLOOR_OPS = {
    // pt_getattr carries BOTH stat-shaped arms — the path arm, which is the one
    // that carries the chain, and the fh arm, which is a no-op today (libfuse
    // passes `fi` to getattr only for regular files) and is applied anyway so
    // the two agree structurally rather than by a property of the library.
    getattr: 'policy_floor_traversal',
    // The per-child stat handed to filler(). attr_timeout=0 and kernel_cache=0
    // mean the kernel revalidates each of these through pt_getattr, so it
    // cannot currently diverge; applied for the same structural reason.
    readdir_child: 'policy_floor_traversal',
    // The mask, before faccessat.
    access: 'policy_floor_mask',
  };

  test('the floor is applied at every op that reports permission, and nowhere else', async () => {
    const raw = await fs.readFile(UNION_C, 'utf8');
    const src = stripCComments(raw);

    // BOTH ARMS OF pt_getattr, counted. One call site would satisfy a bare
    // `body.includes(...)` while the fh arm went unfloored — which is exactly
    // the mutant `b47`'s stat/fstat agreement is written against, and which
    // this is the only layer that can see.
    const getattr = bodyOfIn(src, 'getattr');
    assert.equal((getattr.match(/policy_floor_traversal\(/g) ?? []).length, 2,
      'INVARIANT: pt_getattr floors BOTH arms — the path arm after its fstatat and the fh arm '
      + 'after its fstat. One call site means stat and fstat disagree the day libfuse passes '
      + '`fi` for a directory');
    assert.match(getattr, /policy_floor_traversal\(path, st,\s*\n?\s*fh >= 0/,
      'INVARIANT: the fh arm takes its view from the open\'s own fd_view record, not from a '
      + 'fresh /proc read — the fast path stays fast');
    assert.match(getattr, /policy_floor_traversal\(path, st, route_view\(&r\)\);/,
      'INVARIANT: the path arm floors with the view the ROUTE derives — a bare `r.view` here '
      + 'is VIEW_CLI on every host-pinned chain component, and the floor declines');

    // THE READDIR CHILD STAT, in the one helper both dirent streams share.
    const child = src.slice(src.indexOf('static int readdir_child('),
      src.indexOf('static int pt_readdir('));
    assert.ok(child.length > 100, 'readdir_child is gone from union.c');
    assert.match(child, /policy_floor_traversal\(child, &st, h->view\);/,
      'INVARIANT: the per-child stat is floored in the handle\'s own view');

    // THE MASK.
    const access = bodyOfIn(src, 'access');
    assert.match(access, /policy_floor_mask\(path, mask, route_view\(&r\)\)/,
      'INVARIANT: pt_access clears X_OK through policy_floor_mask — without it `test -x` and '
      + '`stat` disagree from one caller');
    assert.match(access, /floored != mask && floored == 0/,
      'INVARIANT: the short-circuit fires only on a mask the floor actually CHANGED. F_OK is 0, '
      + 'so a bare `if (!mask) return 0;` answers "it exists" for every existence probe on the '
      + 'chain without asking the host');

    // AND NOWHERE ELSE. Every other op body keeps the host's real mode, which
    // is what makes constraint 1 exactly satisfied: an unscoped floor would
    // grant traversal the host itself denies.
    const bodies = [...src.matchAll(/^static int pt_([a-z]+)\(/gm)].map(m => m[1]);
    assert.ok(bodies.length > 20, `union.c's op bodies were not parsed: ${bodies.length}`);
    const floored = bodies.filter(op => /policy_floor_(traversal|mask)\(/.test(bodyOfIn(src, op)));
    assert.deepEqual(floored.sort(), ['access', 'getattr'],
      'these op bodies apply the floor; exactly pt_getattr and pt_access may, and the readdir '
      + 'child stat through readdir_child. A fifth site means the enumeration is wrong rather '
      + 'than that the site should be added');
    // …and the classification above names no op that does not exist, so the
    // table cannot quietly stop covering one.
    for (const [op, fn] of Object.entries(FLOOR_OPS)) {
      const body = op === 'readdir_child' ? child : bodyOfIn(src, op);
      assert.ok(body.includes(`${fn}(`), `${op} no longer calls ${fn}`);
    }
  });

  // ── THE VIEW IS DERIVED WHEREVER IT IS CONSUMED, NOT ONLY WHERE THE TIER
  //    NEEDED SUBSTITUTING ────────────────────────────────────────────────────
  //
  // THE DEFECT THIS PINS. `policy_tier_is_caller_sensitive` is a gate on the
  // TIER: it is right that `host`/`hide`/`bind` resolve identically in both
  // views, so the routed path's own answer does not need the mark. But the view
  // does not stay with the routed path — it is carried into the dirhandle and
  // used to classify CHILDREN, and into the floor, which requires VIEW_HOST.
  // Deriving it only inside the gate left two live failures:
  //
  //   an unmarked `ls` of a HOST-PINNED directory classified its children in
  //   VIEW_CLI, so an unpinned child was hidden while `cat` on it returned the
  //   bytes — card 2026-0403's defect class, at the call site `b44` cannot
  //   reach; and
  //
  //   a cwd-chain component covered by a HOST pin never entered the gate, so
  //   the floor declined and an unmarked spawn died in chdir() on a
  //   search-denied orchestrator directory — this card's own symptom.
  //
  // THE FIX IS LAZY, NOT UNCONDITIONAL, AND THE COST IS WHY. Setting the view
  // in `route()` for every op would pay a /proc mark read per op at `host`, the
  // CLI's hottest tier under attr_timeout=0. `route_view()` derives it ONCE per
  // route, on demand, and seeds itself for free when the gate already computed
  // `marked` — so the read is paid only where a consumer actually asks.
  test('the view is derived wherever it is consumed, not only inside the caller-sensitive gate', async () => {
    const raw = await fs.readFile(UNION_C, 'utf8');
    const src = stripCComments(raw);

    assert.match(src, /static enum view route_view\(struct route \*r\)/,
      'INVARIANT: union.c has ONE lazy view accessor — without it the view is whatever the '
      + 'caller-sensitive gate left behind, which is VIEW_CLI on every host/hide/bind route');
    // MEMOISED, so one route reads /proc at most once however many consumers ask.
    assert.match(src, /if \(!r->view_known\)/,
      'INVARIANT: route_view memoises — a consumer asking twice must not pay two /proc reads');
    assert.match(src, /struct route \{[\s\S]*?unsigned char view_known;[\s\S]*?\};/,
      'INVARIANT: struct route carries the memo flag beside the view');
    assert.match(src, /r->view_known = 0;/,
      'INVARIANT: route() clears the memo — a stack-garbage flag would serve a previous '
      + 'route\'s view');
    // AND THE GATE SEEDS IT, so the hot caller-sensitive path pays no SECOND read.
    assert.match(src, /r->view\s*=\s*marked \? VIEW_CLI : VIEW_HOST;\s*\n\s*r->view_known = 1;/,
      'INVARIANT: the gate seeds the memo from the `marked` it already derived — otherwise a '
      + 'project-tier consumer pays a second /proc read on the CLI\'s hottest tier');

    // EVERY CONSUMER ASKS THE ACCESSOR. A bare `r.view` at any of these is the
    // defect above: correct for a caller-sensitive tier and silently VIEW_CLI
    // for every other.
    const opendir = bodyOfIn(src, 'opendir');
    assert.match(opendir, /h->view = route_view\(&r\);/,
      'INVARIANT: pt_opendir derives the view for the HANDLE — a host-pinned directory never '
      + 'enters the gate, so `r.view` there is VIEW_CLI and every child is misclassified');
    const getattr = bodyOfIn(src, 'getattr');
    assert.match(getattr, /policy_floor_traversal\(path, st, route_view\(&r\)\);/,
      'INVARIANT: pt_getattr\'s path arm derives the view for the floor — a cwd component '
      + 'covered by a host pin never enters the gate');
    const access = bodyOfIn(src, 'access');
    assert.match(access, /policy_floor_mask\(path, mask, route_view\(&r\)\)/,
      'INVARIANT: pt_access derives it too, or `test -x` and `stat` disagree on exactly the '
      + 'chain links a host pin covers');
    assert.match(getattr, /return policy_synth_getattr\(path, st, route_view\(&r\)\);/,
      'INVARIANT: and so does the synthetic answer — T_BIND is view-invariant and T_SYNTH is '
      + 'caller-sensitive, but reasoning from the tier is what produced this defect');

    // THE COST GATE IS A COST GATE AND NOT THE RULE. Both floor sites test the
    // bounded string compare BEFORE paying the /proc read; `policy_floor_applies`
    // still re-tests it, so a mutant dropping it from the predicate is killed by
    // `b46` rather than masked here.
    for (const [op, body] of [['getattr', getattr], ['access', access]])
      assert.ok(/policy_cwd_component\(path\)/.test(body),
        `INVARIANT: pt_${op} gates the view derivation behind policy_cwd_component, so the `
        + 'floor costs a /proc read only on the cwd chain and not on every op');

    // THE TWO OPEN SITES ARE GATED TOO, AND "IT IS ONLY AN OPEN" IS NOT A
    // REASON TO SKIP THE GATE. `fd_view` has exactly ONE reader — pt_getattr's
    // fi-arm floor — and that arm's own comment records it as a NO-OP TODAY,
    // because libfuse passes `fi` to getattr only for regular files and the
    // floor's S_ISDIR test is therefore false for every handle it passes. An
    // ungated read here buys a field nothing reads and taxes `host`, the CLI's
    // hottest tier, which was read-free before. Storing VIEW_CLI off the chain
    // is harmless: policy_floor_applies cannot fire off the chain whatever the
    // stored view says, so the two getattr arms still agree STRUCTURALLY —
    // which is the property that arm's comment exists to protect.
    //
    // AND THE ARGUMENT IS PINNED PER SITE, WHICH THE FILE-WIDE BAN BELOW CANNOT
    // DO: `fd_tier_set(fd, r.tier, 1, VIEW_CLI)` is round 1's exact defect
    // shape — a hardcoded literal at the consumer that caused it — and a ban on
    // the bare FIELD does not see a LITERAL. Every other consumer already has a
    // per-site match; these two did not.
    const open = bodyOfIn(src, 'open'), create = bodyOfIn(src, 'create');
    for (const [name, body] of [['open', open], ['create', create]]) {
      assert.match(body,
        /fd_tier_set\(fd, r\.tier, [^,]+,\s*\n?\s*policy_cwd_component\(path\) \? route_view\(&r\) : VIEW_CLI\);/,
        `INVARIANT: pt_${name} stores the view for the fi-arm floor, GATED on the chain compare — `
        + 'an ungated route_view() here pays a /proc read per open at the CLI\'s hottest tier for a '
        + 'field whose only reader is a no-op, and a hardcoded VIEW_CLI is round 1\'s defect');
    }

    // AND NOTHING READS THE RAW FIELD OUTSIDE route() AND THE ACCESSOR.
    const outside = src.split('\n')
      .filter(l => /(?<![_\w])r\.view(?![_\w])/.test(l));
    assert.deepEqual(outside, [],
      `these sites read the route's raw view field instead of asking route_view(): ${outside.join(' | ')}`);
  });

  // ── BOTH readdir ARMS ASK ONE PREDICATE ────────────────────────────────────
  //
  // Card 2026-0403 was TWO INSTANCES OF ONE DEFECT — a caller-insensitive tier
  // filter in `pt_readdir`'s real arm and the same test inline in
  // `policy_synth_children` — so the fix is one predicate and the pin is that
  // neither arm holds a second copy. A second inline `ct == T_FAIL` would pass
  // every behavioural test while re-hiding a name an unmarked caller can open.
  test('both readdir arms classify dirents through policy_dirent_visible alone', async () => {
    const [rawU, rawP] = await Promise.all([
      fs.readFile(UNION_C, 'utf8'), fs.readFile(POLICY_H, 'utf8'),
    ]);
    const union = stripCComments(rawU), policy = stripCComments(rawP);

    assert.match(policy, /static inline int policy_dirent_visible\(const char \*child, enum view v\)/,
      'INVARIANT: policy.h owns the dirent rule, where the unit fixture can drive it (b44)');

    // THE REAL STREAM, in the shared helper.
    const child = union.slice(union.indexOf('static int readdir_child('),
      union.indexOf('static int pt_readdir('));
    assert.match(child, /if \(!policy_dirent_visible\(child, h->view\)\)/,
      'INVARIANT: the dirent stream asks policy_dirent_visible in the HANDLE\'s view — a '
      + 'caller-insensitive filter here is card 2026-0403');

    // THE SYNTHETIC STREAM, through policy_synth_children.
    const synthAt = policy.indexOf('static inline size_t policy_synth_children(');
    assert.ok(synthAt > 0, 'policy_synth_children is gone from policy.h');
    // TO ITS OWN CLOSING BRACE, not to end-of-file: the whole tail of policy.h
    // contains every tier name there is, so an unbounded slice makes the
    // no-second-filter assertion below vacuously false — and a shorter slice
    // would make it vacuously true.
    const synth = policy.slice(synthAt, policy.indexOf('\n}', synthAt) + 2);
    assert.ok(synth.includes('return emitted;'), 'the policy_synth_children body was not bounded');
    assert.match(synth, /if \(!policy_dirent_visible\(full, v\)\)/,
      'INVARIANT: policy_synth_children asks the same predicate rather than testing tiers itself');

    // AND NEITHER HOLDS A SECOND, INLINE TIER FILTER. The old shape was
    // `enum tier ct = resolve_class(child); if (ct == T_HIDE || ct == T_FAIL)`.
    for (const [name, body] of [['readdir_child', child], ['policy_synth_children', synth]])
      assert.ok(!/T_HIDE\s*\|\|/.test(body) && !/==\s*T_FAIL/.test(body),
        `INVARIANT: ${name} holds no second inline tier filter beside policy_dirent_visible`);

    // THE MERGE'S PLUMBING, which is what makes the synthetic arm able to name
    // the orchestrator's own children at all.
    assert.match(union, /DIR\s+\*hostd;/, 'INVARIANT: the dirhandle carries the host directory');
    assert.match(union, /if \(h->hostd\) closedir\(h->hostd\);/,
      'INVARIANT: and pt_releasedir closes it — one leak per synthetic listing otherwise');
    assert.match(bodyOfIn(union, 'opendir'), /cred_enter\(\);\s*\n\s*h->hostd = opendir_at\(policy_host_fd, policy_rel\(path\)\);\s*\n\s*cred_leave\(\);/,
      'INVARIANT: the host directory is opened under the CALLER\'s credentials — an unreadable '
      + 'one must be evaluated against the caller, not against root');
  });

  // ── C8: WHERE union.c DERIVES THE VIEW, AND WHERE IT DISPATCHES ───────────
  //
  // The fixture cannot reach union.c, so the wiring is pinned from the source —
  // as `route()`'s flags byte is, and for the same reason: every behavioural
  // case drives policy.h's functions directly, so a view that was derived once
  // and then never carried, or carried and then re-derived per op, would be
  // invisible to all of them.
  //
  // ONE VIEW PER ROUTE, CARRIED, NOT RE-DERIVED. A second
  // `policy_is_marked_tid(` anywhere in an op body would pay a second /proc read
  // AND could answer differently from the tier already in hand.
  test('route() derives the view from the mark and every consumer carries it', async () => {
    const raw = await fs.readFile(UNION_C, 'utf8');
    const src = stripCComments(raw);

    assert.match(src, /struct route \{[\s\S]*?enum view\s+view;[\s\S]*?\};/,
      'INVARIANT: struct route carries the view it resolved in');
    assert.match(src, /r->view\s*=\s*marked \? VIEW_CLI : VIEW_HOST;/,
      'INVARIANT: the view IS the mark — marked resolves VIEW_CLI, everyone else VIEW_HOST. '
      + 'A literal here would give one caller two answers');
    assert.match(src, /r->tier\s+= resolve_class\(path, VIEW_CLI\);/,
      'INVARIANT: route() classifies in VIEW_CLI first, so policy_tier_is_caller_sensitive gates '
      + 'the /proc read — resolving in the caller\'s view up front would pay it on every op');
    assert.match(src, /r->view\s+= VIEW_CLI;/,
      'INVARIANT: and the view defaults to VIEW_CLI, so a tier that is NOT caller-sensitive '
      + 'carries a defined view rather than whatever was on the stack');

    // THE DIRENT HANDLE AND THE fd TABLE, the two places a view outlives the
    // route that derived it.
    assert.match(src, /struct dirhandle \{[\s\S]*?enum view view;[\s\S]*?\};/,
      'INVARIANT: the dirhandle carries the view opendir routed with, so every dirent in one '
      + 'listing is classified the same way');
    assert.match(bodyOfIn(src, 'opendir'), /h->view = route_view\(&r\);/,
      'INVARIANT: and pt_opendir DERIVES it — a host-pinned directory never enters the '
      + 'caller-sensitive gate, so a bare `r.view` classifies its children in the wrong view');
    assert.match(src, /static void fd_tier_set\(int fd, enum tier t, int writable, enum view v\)/,
      'INVARIANT: the per-fd table takes the view from the SAME call the open already makes — a '
      + 'separate setter is how a handle acquires a tier and a view from two decisions');
    assert.match(src, /fd_view\[fd\] = \(unsigned char\)v;/,
      'INVARIANT: and writes it');

    // SYNTHETIC ATTRIBUTES ARE ANSWERED IN THE ROUTE'S VIEW. In VIEW_HOST the
    // node's inode comes from the chain's sub-range and not from the ancestor
    // table it is deliberately not in — hard-coding VIEW_CLI here makes every
    // overlay node answer -ENOENT, and the chdir dies at its destination.
    assert.match(bodyOfIn(src, 'getattr'), /return policy_synth_getattr\(path, st, route_view\(&r\)\);/,
      'INVARIANT: pt_getattr answers a synthetic node in the view the ROUTE derives');

    // AND THE MARK IS READ ONCE PER OP, in route() and nowhere else.
    // TWO CALL SITES, AND EXACTLY TWO: `route()`'s gate, which pays the read
    // where the TIER needs it, and `route_view()`, which pays it where a
    // CONSUMER needs it and memoises so one route cannot pay twice. A third
    // would be an op body deriving its own, which is both a second /proc read
    // and a chance to disagree with the view already on the route.
    assert.equal((src.match(/policy_is_marked_tid\(/g) ?? []).length, 2,
      'INVARIANT: union.c reads the mark in exactly two places — route()\'s caller-sensitive '
      + 'gate and route_view()\'s memo');
    const routeBody = src.slice(src.indexOf('static int route('), src.indexOf('#define ROUTE('));
    assert.ok(routeBody.length > 200, 'route() is gone from union.c');
    assert.match(routeBody, /marked = policy_is_marked_tid\(/,
      'INVARIANT: one of them is route()\'s caller-sensitive gate');
    assert.match(src.slice(src.indexOf('static enum view route_view(')), /policy_is_marked_tid\(/,
      'INVARIANT: and the other is route_view()\'s memo');
  });

  // ── A TABLE-DERIVED NAME IS EMITTED ONLY IF THE VIEW CAN OPEN IT ───────────
  //
  // §5.5 IN THE DIRECTION THE FIRST ROUND MISSED. `policy_dirent_visible` answers
  // "may this view SEE this name"; it does not answer "is there anything there".
  // Three breaches came of conflating them, all at the merge boundary:
  //
  //   the VIEW_HOST synthetic arm emitted the table's children with no existence
  //   check at all, so an `exclude` under the project put `node_modules` into an
  //   unmarked `ls` of the overlay cwd while every op on it answered -ENOENT;
  //
  //   `pinned_children_emit` branched on the RAW PIN TIER, so a project-pinned
  //   child that resolves to the OVERLAY in VIEW_HOST was host-checked, found
  //   absent and dropped — `stat <systemPath>` answering and `cd` working while
  //   `ls` of its parent omitted the name, which is a regression this card
  //   introduced; and
  //
  //   the same function's T_SYNTH branch emitted unchecked, which is true of a
  //   VIEW_CLI scaffold node and false in VIEW_HOST, where an off-chain
  //   host-absent ancestor is `fail` -> host -> -ENOENT.
  //
  // ONE PREDICATE ANSWERS ALL THREE, in policy.h where `b49` drives it.
  test('a table-derived dirent is emitted only where the resolving view can open it', async () => {
    const [rawU, rawP] = await Promise.all([
      fs.readFile(UNION_C, 'utf8'), fs.readFile(POLICY_H, 'utf8'),
    ]);
    const union = stripCComments(rawU), policy = stripCComments(rawP);

    assert.match(policy, /static inline int policy_table_child_exists\(const char \*child, enum view v, int scaffold\)/,
      'INVARIANT: policy.h owns the existence half of the dirent rule, where the unit fixture '
      + 'can drive it against a seam-injected host tree (b49)');

    const emit = union.slice(union.indexOf('static void pinned_children_emit('),
      union.indexOf('static int readdir_child('));
    assert.ok(emit.length > 100, 'pinned_children_emit is gone from union.c');
    assert.match(emit, /policy_table_child_exists\(pc->full\[i\], v, 0\)/,
      'INVARIANT: the emit asks the predicate in the HANDLE\'s view, with the scaffold flag '
      + 'CLEAR — a real directory has a backing store, so nothing there is taken on trust');
    // AND HOLDS NO SECOND, RAW-TIER COPY OF THE QUESTION. `pc->tier[i] == T_SYNTH`
    // and a bare fstatat here are the two halves of the shape that was wrong.
    assert.ok(!/pc->tier\[i\]/.test(emit),
      'INVARIANT: the emit no longer branches on the RAW PIN TIER — that is what dropped a '
      + 'project-pinned child resolving to the overlay');
    assert.ok(!/fstatat\(/.test(emit),
      'INVARIANT: and holds no inline host probe beside the predicate');
    // THE TIER IT HANDS THE CALLBACK IS THE RESOLVED ONE, so `synth_emit`'s
    // SYNTHETIC() test and policy_synth_getattr agree with the classification the
    // emit just made.
    assert.match(emit, /resolve_class\(pc->full\[i\], v\)/,
      'INVARIANT: the emitted tier is resolved in the view, not copied from the pin');

    // AND THE VIEW_HOST SYNTHETIC ARM GOES THROUGH IT. Before this the arm
    // called policy_synth_children directly and emitted unchecked.
    const readdir = bodyOfIn(union, 'readdir');
    // THE SCAFFOLD ARM ASKS THE PREDICATE TOO, AND THE CARVE-OUT IS NARROWER
    // THAN "VIEW_CLI SKIPS THE CHECK". It has two parts and only the first was
    // ever written down: (i) for a `project` child the host is the WRONG AXIS —
    // a project path's existence to the CLI is the MIRROR's question, by tier,
    // wherever the host happens to hold it, and the right channel is a control
    // frame this card does not add. NOT "the orchestrator has nothing at
    // systemPath": that is deployment- and geometry-conditional, and the axis
    // argument holds without it; (ii) for a `host` pin
    // child of that SAME node the host IS the right axis and the probe costs one
    // fstatat with no control frame, so the carve-out does not reach it. Leaving
    // (ii) unchecked left the MARKED CLI's `ls /etc` naming ETC_PINS entries
    // absent on this host while `cat` answered -ENOENT — the third instance of
    // card 2026-0403's class, and the reason that card could not close as
    // absorbed while it stood.
    assert.match(readdir, /if \(h->view == VIEW_CLI\) \{\s*\n\s*policy_synth_children\(h->path, VIEW_CLI, scaffold_emit, &fc\);/,
      'INVARIANT: the VIEW_CLI scaffold streams its table children through scaffold_emit, which '
      + 'asks policy_table_child_exists — an unchecked emit here lists a pinned name the CLI '
      + 'cannot open');
    const scaffold = union.slice(union.indexOf('static void scaffold_emit('),
      union.indexOf('static int readdir_child('));
    assert.ok(scaffold.length > 50, 'scaffold_emit is gone from union.c');
    assert.match(scaffold, /policy_table_child_exists\(full, f->view, 1\)/,
      'INVARIANT: and it asks with the scaffold flag SET — that flag is the carve-out, and it '
      + 'reaches a `project` child and nothing else');
    const hostArm = readdir.slice(readdir.indexOf('if (h->view == VIEW_CLI)'));
    assert.match(hostArm, /pinned_children_of\(h->path, h->view, &pc\)/,
      'INVARIANT: the VIEW_HOST synthetic arm collects its table children…');
    assert.match(hostArm, /pinned_children_emit\(&pc, h->view, synth_emit, &fc\)/,
      'INVARIANT: …and emits them through the checked path, hostd or no hostd');
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
    // 2026-0398 RETIRED TWO REASONS, and the deletions are the point rather
    // than an omission: `unmarked-project-host-served` existed because the
    // project rule was a SECOND rule with a host-existence test of its own, and
    // `cwd-traversal-served` recorded a grant by an exemption that no longer
    // exists. A project-tier path now re-resolves in VIEW_HOST and lands on the
    // `unmarked-host-served` row above, and the cwd chain is answered by the
    // host or by the overlay with no grant to record. Re-adding either means
    // re-adding a mechanism — which is what the set comparison below forces.
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
      /if \(policy_tier_is_caller_sensitive\(r->tier\)\) \{\s*\n\s*marked = policy_is_marked_tid\(\(pid_t\)fuse_get_context\(\)->pid\);\s*\n(?:\s*\/\*[\s\S]*?\*\/\s*\n)?\s*r->view = marked \? VIEW_CLI : VIEW_HOST;\s*\n\s*r->view_known = 1;\s*\n\s*r->tier = policy_caller_tier\(op, path, r->tier, marked,\s*\n\s*\(pid_t\)fuse_get_context\(\)->pid\);\s*\n\s*\}/,
      'INVARIANT: route() asks policy_tier_is_caller_sensitive, derives `marked` from the '
      + 'CALLING THREAD id and reassigns r->tier from policy_caller_tier with it — for the mark '
      + 'AND for the log row\'s identity columns. The call site is missing, takes a different '
      + 'id, or drops the reassignment');
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
    // ONE /proc READ PER OP, SHARED. `marked` is derived once inside the guard
    // and handed to BOTH the substitution and the cwd-exemption short-circuit;
    // a second `policy_is_marked_tid(` in route() would double the per-op /proc
    // cost at the CLI's hottest tier under attr_timeout=0.
    assert.equal((body.match(/policy_is_marked_tid\(/g) ?? []).length, 1,
      'INVARIANT: route() derives the mark exactly once and shares it — a second call site '
      + 'pays a second /proc read on every caller-sensitive op');
    // THERE IS NO ORDERING LEFT TO PIN HERE, and saying so is the point: the
    // traversal bound this test used to guard — "stop at the first ancestor the
    // host has", a property of running the substitution before the cwd
    // exemption — is GONE with the exemption (card 2026-0398). An unmarked
    // caller resolves in VIEW_HOST, where the chain is answered by the host or
    // by the overlay and there is no grant whose extent an ordering could bound.
    assert.ok(!/policy_cwd_exempt\(/.test(src),
      'INVARIANT: the cwd exemption is gone from union.c — its rule is the view now, and a '
      + 'restored call site would be a second, conditional answer for one path');
    // THE `fail` FALL-THROUGH IS STILL THE ONLY PLACE `unpinned-fail-closed` IS
    // WRITTEN, so the reason really is the marked CLI's alone.
    assert.equal((src.match(/"unpinned-fail-closed"/g) ?? []).length, 1,
      'unpinned-fail-closed is emitted from more than one place');
  });

  // ── ONE HOST fd, ONE RELATIVISER ──────────────────────────────────────────
  //
  // The host-existence probe (policy.h) and the T_HOST arm (union.c) must open
  // the SAME fd through the SAME relativiser, or the probe can answer for a
  // path the arm would not serve. Two variables for one fd is exactly the drift
  // union.c's own comments warn about, so the single declaration is pinned
  // rather than merely arranged: `b48` drives the probe but cannot see a second
  // spelling reappearing in union.c.
  test('the host fd and its relativiser are declared once, in policy.h', async () => {
    const [policy, union] = await Promise.all([
      fs.readFile(POLICY_H, 'utf8'), fs.readFile(UNION_C, 'utf8'),
    ]);
    assert.match(policy, /static int policy_host_fd = -1;/,
      'INVARIANT: policy.h owns the host fd — the probe needs it and the unit fixture drives it');
    assert.match(policy, /static inline const char \*policy_rel\(const char \*path\)/,
      'INVARIANT: policy.h owns the relativiser the probe and the T_HOST arm share');
    assert.ok(!/\bstatic\s+int\s+host_fd\b/.test(union),
      'INVARIANT: union.c declares no host_fd of its own — two variables for one fd is the drift');
    assert.ok(!/\bstatic\s+const\s+char\s+\*rel\(/.test(union),
      'INVARIANT: union.c declares no rel() of its own');
    assert.ok(!/(?<![_a-zA-Z0-9])rel\(/.test(union.replace(/policy_rel\(/g, 'policy_REL_OK(')),
      'INVARIANT: no bare rel( identifier survives in union.c — every call goes through policy_rel');
  });

  // ── THE TIER ENUM'S MEMBER SET ────────────────────────────────────────────
  //
  // `b19` and `b20` iterate `0 .. T_SYNTH`, so a member APPENDED after T_SYNTH
  // would be uncovered by both. `tier_name`'s default-less switch makes that a
  // -Werror compile failure of the driver fixture — but a member added WITH a
  // switch arm would compile and slip past the loops silently, and its
  // caller-sensitivity would be nobody's decision. Pinned at the declaration.
  test('enum tier has exactly the six members the caller-tier matrix drives', async () => {
    const src = await fs.readFile(POLICY_H, 'utf8');
    const decl = src.match(/enum tier \{[^}]*\}/);
    assert.ok(decl, 'enum tier is gone from policy.h');
    assert.equal(decl[0], 'enum tier { T_FAIL = 0, T_HOST, T_PROJECT, T_HIDE, T_BIND, T_SYNTH }',
      'enum tier changed: b19/b20 iterate 0..T_SYNTH, so a member appended past T_SYNTH is driven '
      + 'by neither and its caller-sensitivity was never decided');
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
    // WHAT THIS LOOP IS AND IS NOT, because the residual is easy to overstate
    // and easy to forget. `b16` proves what an abandon DOES. That every
    // claiming op CALLS one is pinned by exactly two things: this presence grep
    // over union.c, and real-gate arms that exercise an abandon end to end
    // WITHOUT ever observing the release. So a future claiming op with a
    // post-READY failure path that forgets its `abandon_claim` is caught by
    // nothing except the name being absent from its body here, or the real gate
    // happening to fail.
    //
    // THE RESIDUAL IS DAEMON-SIDE ONLY, and it covers exactly the case where
    // the FETCH SUCCEEDED and the op then failed. cc's `#fetch` wrapper is a
    // BEHAVIOURAL backstop for the whole FETCH-side class: any FETCH that does
    // not answer READY releases the claim at cc, whatever the daemon's wiring
    // does, so a route failure cannot leak the claim regardless. Which
    // invariants are proven only by the real gate is tabulated in
    // `harness/mutation/RATIONALE.md`, under the env-gated suites.

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
