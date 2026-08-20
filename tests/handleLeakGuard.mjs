// ============================================================================
// Layer B of the suite hang guard (card 2026-0190) — the CHILD-side detector.
//
// THE INVARIANT: no test file may outlive its own report. A file that finishes
// its tests but leaves the event loop open never exits, and node:test emits a
// file's terminal `test:summary` ONLY at child exit — so one leaked handle
// wedges the entire run forever (measured: tests/run.mjs's `reporter.on('end')`
// never resolves). That is what cost review 2026-0183 code-mutant's full 300s
// external ceiling.
//
// WHY THE DETECTOR MUST LIVE IN THE CHILD. The parent cannot distinguish "still
// running tests" from "leaked", because the only per-file signal it gets is the
// summary that arrives at exit. The child is the sole place where "all tests
// and all teardown have begun" and "the loop is still open" are both
// observable. Layer A's SIGKILL watchdog is the backstop for what the child
// cannot self-report (a CPU busy-loop, a process.exit before any test runs);
// this layer is what turns a leak into a NAMED failure instead of a kill.
//
// HOW: preloaded into every per-file child via `--import` (see `execArgv` on
// `run({…})` in tests/run.mjs — the same mechanism dom-assert-tripwire.mjs
// uses). A `--import` preload evaluates before the test file body, so the root
// after() hook registered here is registered first and therefore runs first,
// BEFORE the file's own `after(() => ctx.close())`. It deliberately does not
// check anything there — it arms an UNREF'D timer:
//
//   * clean file → teardown completes, the loop drains, the process exits and
//     the unref'd timer never fires. Zero cost on the happy path. This is
//     precisely why arming it ahead of the file's own teardown does not race
//     that teardown.
//   * leaking file → something is still holding the loop LEAK_GRACE_MS after
//     all teardown began, so the timer gets a turn. That firing IS the
//     criterion. Cost of a leak becomes LEAK_GRACE_MS instead of infinity.
// ============================================================================

import { after } from 'node:test';
import { writeSync } from 'node:fs';
import { LEAK_GRACE_MS } from './hangGuardConfig.mjs';

// The marker tests/run.mjs greps its children's stderr for, and the string the
// guard's own regression suite asserts on. Keep the two in sync via this const.
export const LEAK_MARKER = 'handle-leak-guard:';

// process._getActiveHandles is a PRIVATE Node API (present through v24.18.0,
// the version this was measured against). It is the only way to NAME a culprit;
// there is no public equivalent. It is used for the DIAGNOSTIC ONLY — never as
// the pass/fail criterion — so if a future Node drops it the guard still fails
// the file correctly and merely says less about why. A guard whose own failure
// mode is a crash would just be a new hang class.
function refdHandles() {
  const fn = process._getActiveHandles;
  if (typeof fn !== 'function') return null;
  let handles;
  try { handles = fn.call(process); } catch { return null; }
  if (!Array.isArray(handles)) return null;

  // stdio is always "active" and is never the leak. Exclude by identity (the
  // stream objects) and by fd, since a child's own stdio can surface as either.
  const stdio = new Set([process.stdout, process.stderr, process.stdin].filter(Boolean));
  return handles.filter(h => {
    if (!h || stdio.has(h)) return false;
    const fd = h.fd ?? h._handle?.fd;
    if (fd === 0 || fd === 1 || fd === 2) return false;
    // hasRef() lives on the internal _handle, not the JS wrapper (measured:
    // net.Server / net.Socket / ChildProcess all expose it only there). An
    // UNREF'D handle cannot hold the loop open, so it is not a leak — this
    // filter is what separates the 12 genuinely-leaking files from the 207
    // that a naive process.getActiveResourcesInfo() check flags.
    const hasRef = h._handle?.hasRef ?? h.hasRef;
    if (typeof hasRef !== 'function') return true; // can't tell — report it
    try { return hasRef.call(h._handle?.hasRef ? h._handle : h); } catch { return true; }
  });
}

function describe(h) {
  const name = h?.constructor?.name ?? typeof h;
  const bits = [];
  if (typeof h?.address === 'function') {
    try {
      const a = h.address();
      if (a && typeof a === 'object') bits.push(`${a.address}:${a.port}`);
      else if (a) bits.push(String(a));
    } catch { /* not bound / already closed */ }
  }
  if (h?.spawnfile) bits.push(`spawnfile=${h.spawnfile}${h.pid ? ` pid=${h.pid}` : ''}`);
  if (h?.remoteAddress) bits.push(`peer=${h.remoteAddress}:${h.remotePort}`);
  const fd = h?.fd ?? h?._handle?.fd;
  if (fd !== undefined) bits.push(`fd=${fd}`);
  return bits.length > 0 ? `${name}@${bits.join(' ')}` : name;
}

function report() {
  const handles = refdHandles();
  const lines = [
    `\n${LEAK_MARKER} the event loop was STILL OPEN ${LEAK_GRACE_MS}ms after teardown began.`,
    `${LEAK_MARKER} this file would never have exited, and node:test only emits a file's`,
    `${LEAK_MARKER} terminal summary at child exit — so it would have wedged the whole run.`,
    `${LEAK_MARKER} file: ${process.argv[1] ?? '<unknown>'}`,
  ];
  if (handles === null) {
    lines.push(`${LEAK_MARKER} culprits: UNAVAILABLE — process._getActiveHandles() is absent on this`);
    lines.push(`${LEAK_MARKER}   Node (${process.version}). The leak above is still real; only the`);
    lines.push(`${LEAK_MARKER}   naming of it is lost. See docs/architecture.md → "Suite hang guard".`);
  } else if (handles.length === 0) {
    // Timers are NOT reported by _getActiveHandles() in Node v24 (measured), yet
    // a ref'd setTimeout absolutely does hold the loop open. So an empty handle
    // list with a live loop is the signature of a leaked timer — the most likely
    // cause being a watchdog/interval a teardown path failed to clear.
    lines.push(`${LEAK_MARKER} culprits: no ref'd HANDLE — but the loop is open, which in Node`);
    lines.push(`${LEAK_MARKER}   ${process.version} means a leaked ref'd TIMER (setTimeout/setInterval);`);
    lines.push(`${LEAK_MARKER}   _getActiveHandles() does not report timers. Active resource types:`);
    lines.push(`${LEAK_MARKER}   ${JSON.stringify(safeResourceCensus())}`);
    lines.push(`${LEAK_MARKER}   (census includes this guard's own unref'd grace timer.)`);
  } else {
    lines.push(`${LEAK_MARKER} culprits (${handles.length} ref'd handle(s)):`);
    for (const h of handles) lines.push(`${LEAK_MARKER}   ${describe(h)}`);
    lines.push(`${LEAK_MARKER} fix the teardown so it releases these on the FAIL path too, not`);
    lines.push(`${LEAK_MARKER}   only on the success path (try/finally or afterEach, never a`);
    lines.push(`${LEAK_MARKER}   trailing cleanup line after the assertions).`);
  }
  // writeSync, NOT console.error: a synchronous fd-2 write cannot be truncated
  // the way process.exit() truncates an async pipe write. Losing the diagnostic
  // that explains the exit(1) would leave a bare unexplained failure.
  writeSync(2, lines.join('\n') + '\n');
}

function safeResourceCensus() {
  try {
    const info = process.getActiveResourcesInfo?.();
    if (!Array.isArray(info)) return [];
    // Types only, de-duplicated with counts — the individual entries carry no
    // identifying detail, so a census is all there is to say.
    const counts = {};
    for (const t of info) counts[t] = (counts[t] ?? 0) + 1;
    return counts;
  } catch {
    return [];
  }
}

after(() => {
  const timer = setTimeout(() => {
    report();
    // exit(1) surfaces to the parent as a file-level test:fail, so run.mjs's
    // existing counter fires and the run goes red. The diagnostic above is
    // already flushed synchronously, so this cannot truncate it.
    process.exit(1);
  }, LEAK_GRACE_MS);
  timer.unref?.();
});
