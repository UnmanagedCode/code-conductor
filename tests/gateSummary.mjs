// What a red `gate:systems` row says about itself, in the block a `tail` keeps.
//
// card 2026-0290 §5c: the first observed red of this gate lost its failing test name
// outright — the operator had piped the run through `tail -25`, which kept only
// the last row's summary, and the run was not re-capturable. The card exists
// because of that loss. Fixing the operator does not scale; fixing the artefact
// does, so the diagnosis is carried INTO the final `=== gate:systems ===` block:
// every FAIL row prints its hang-guard verdict and the tests that named it.
//
// A row that reds with NO failing test at all is a different defect (a wedged or
// killed file, a leaked process — card 2026-0268's shape) and is called out as
// such, so the two are told apart at a glance instead of by re-running the gate.
//
// Split out of tests/systems-gate.mjs so it is exercised by
// tests/systems-gate-summary.test.mjs rather than only by a gate that has
// already gone red.

// The spec reporter's failure line: `✖ <name> (<n>ms)`, indented one level per
// nesting depth, and repeated verbatim in its trailing `✖ failing tests:`
// section. The duration suffix is what distinguishes a real failure line from
// that section's own `✖ failing tests:` header, which carries none.
//
// TWO patterns, because neither single one is right (card 2026-0290 §5c):
//
//   * The `$` end-anchor is what makes the NAME correct. `.+?` is lazy, so
//     without an anchor it stops at the FIRST duration-shaped substring — and a
//     real test in this suite is called `slow hook (200ms) does not interfere:
//     subprocess spawns after hook completes`, which a loose pattern would
//     report as `slow hook`. Anchored, backtracking finds the LAST one and the
//     name comes through whole.
//   * But an anchor DROPS anything it rejects, and a dropped diagnosis is this
//     card's own failure mode. So a line that opens like a failure and carries a
//     duration somewhere is never discarded: the loose pattern takes it verbatim,
//     trailing text and all. A garbled name in the summary beats a name that is
//     not there.
//
// The duration requirement is what keeps `✖ failing tests:` out of BOTH.
const FAIL_LINE = /^\s*✖ (.+?) \(\d[\d.]*ms\)$/;
const FAIL_LINE_LOOSE = /^\s*✖ (.+ \(\d[\d.]*ms\).*?)\s*$/;

// The gate's live output is a TTY often enough to matter, and the spec reporter
// COLOURIZES when it is: a failure line arrives as
// `\x1b[31m✖ name \x1b[90m(1ms)\x1b[39m\x1b[39m`, which no plain-text pattern
// matches. A pty also rewrites the line ending to CRLF. Both are stripped before
// matching, so the scan says the same thing about a TTY run and a redirected one
// — the alternative is a diagnosis that silently exists in one and not the other,
// which is this card's own defect wearing a different hat.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const plain = (line) => line.replace(ANSI, '').replace(/\r$/, '');

// tests/run.mjs's completeness verdict — the one line that says whether every
// discovered file reported, and whether anything was killed, leaked or wedged.
const HANG_GUARD = /^hang-guard: \d+\/\d+ files reported.*$/;

// Streaming scanner: the gate feeds it stdout chunks as they arrive, so a whole
// suite's output never has to be held in memory to be scanned. `scanRowOutput`
// below is the same scanner over a single string — one implementation, two
// entry points.
export function createRowScanner() {
  const failingTests = [];
  const seen = new Set();
  let hangGuard = null;
  let pending = '';

  const line = (raw) => {
    const text = plain(raw);
    // Exact first, salvage second — never the other way round, or the salvage
    // pattern would truncate every name the exact one gets right.
    const fail = FAIL_LINE.exec(text) ?? FAIL_LINE_LOOSE.exec(text);
    if (fail) {
      // The same name arrives up to twice (inline, then in the trailer); the
      // set is what makes the printed count a count of TESTS, not of lines.
      if (!seen.has(fail[1])) { seen.add(fail[1]); failingTests.push(fail[1]); }
      return;
    }
    // Last one wins: only one is ever printed per run, and if a future runner
    // printed two the later is the settled verdict.
    if (HANG_GUARD.test(text)) hangGuard = text;
  };

  return {
    push(chunk) {
      pending += chunk;
      const parts = pending.split('\n');
      pending = parts.pop(); // the (possibly partial) trailing line
      for (const p of parts) line(p);
    },
    // Flush the trailing fragment — a runner that exits without a final newline
    // would otherwise drop its last line, which could be the verdict itself.
    result() {
      if (pending) { line(pending); pending = ''; }
      return { failingTests, hangGuard };
    },
  };
}

export function scanRowOutput(text) {
  const scanner = createRowScanner();
  scanner.push(text);
  return scanner.result();
}

// How many names a FAIL row prints before it starts counting instead. A whole
// suite can red in the hundreds; the point is to name the failure, not to
// reprint the run.
export const NAMED_FAILURE_LIMIT = 10;

// `results` is one entry per configuration:
//   { name, code, failingTests, hangGuard }
// Returns the lines of the closing block, in order. Pure — the caller prints.
export function renderGateSummary(results) {
  const lines = ['=== gate:systems ==='];
  for (const r of results) {
    lines.push(`  ${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.name}`);
    if (r.code === 0) continue;
    lines.push(r.hangGuard
      ? `        ${r.hangGuard}`
      : '        hang-guard: NO VERDICT LINE — the runner never reached its own summary.');
    const failing = r.failingTests ?? [];
    if (failing.length === 0) {
      lines.push('        NO TEST WAS NAMED — this row went red without a single ✖ line, so it is');
      lines.push('        not a test failure: read the hang-guard verdict above (a killed or wedged');
      lines.push('        file, a leaked process, or a runner that exited before reporting).');
      continue;
    }
    const shown = failing.slice(0, NAMED_FAILURE_LIMIT);
    lines.push(`        failing tests (${failing.length}):`);
    for (const name of shown) lines.push(`          ✖ ${name}`);
    if (failing.length > shown.length) {
      lines.push(`          … and ${failing.length - shown.length} more (search the row's output for '✖ ')`);
    }
  }
  return lines;
}
