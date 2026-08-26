// Rendezvous for the four RANKING fixtures (fast → subsecond → medium → slow).
//
// WHY IT EXISTS. tests/run.mjs reports each file as `done - dequeue`, i.e.
// `work + C`, where C is THAT FILE'S OWN fork+exec+node-boot+import+teardown+exit
// cost. C is a pure machine-speed quantity: measured max ~320ms at the repo's
// standard 24-way starve, but ~770ms at 72-way. Any assertion comparing two such
// figures by RATIO multiplies C instead of cancelling it, which is how the old
// `fast * 3 < medium` collapsed into an absolute `C < 600ms` cap and went red 42%
// of the time at load1 ~73 on a COMPLETELY CORRECT reporter (card 2026-0222).
//
// The fix is not a wider tolerance. The fixtures chain their COMPLETIONS, so each
// pair's separation is a designed increment rather than a race against C, and the
// test asserts differences against those increments.
//
// ── IT GATES ON THE PREDECESSOR'S PROCESS EXIT, NOT ON ITS MARKER APPEARING ──────
// THIS IS LOAD-BEARING AND WAS MEASURED, NOT ASSUMED. The first cut of this helper
// released the successor when the predecessor WROTE its marker — which happens at
// the end of the predecessor's test BODY, leaving its whole teardown+exit cost
// outside the rendezvous. That residual is `exitCost_pred` and it subtracts
// directly from the pair's separation:
//
//     done_succ - done_pred = delta + sleepMs + exitCost_succ - exitCost_pred
//
// At 72-way starvation (load1 70.0-75.7, 24 paired probes) that broke ALL THREE
// bounds: minima medium-fast 1050 (floor 1200), slow-medium 811 (floor 900),
// sub-fast 460 (floor 550), and the standalone test went red 13/24. The deficits
// tracked the PREDECESSOR's own reported figure monotonically — `fast` at 97ms gave
// sub-fast 1043ms, `fast` at 754ms gave 460ms — which isolates the term exactly: a
// PRE-marker cost in the predecessor delays the successor's start by the same
// amount and cancels, so only POST-marker cost can shrink the difference.
//
// Gating on process exit removes `exitCost_pred` from the identity entirely and
// turns `exitCost_succ` into a POSITIVE buffer:
//
//     done_succ - done_pred = delta + sleepMs + exitCost_succ + (J_succ - J_pred)
//
// where J is the parent's event-delivery jitter for the file-level `test:complete`.
// What remains is a parent-side quantity that must exceed a whole designed increment
// WITHIN ONE STALL to break a bound, and it is buffered by `exitCost_succ` — not the
// child-lifecycle cost that reaches 770ms here. DO NOT "simplify" this back to
// waiting on the marker's existence; that is the measured-red construction.
//
// Not `*.test.mjs`, so run.mjs's discover() never picks it up — same convention as
// tests/hangGuardCase.mjs.
import fs from 'node:fs';
import path from 'node:path';

// A SYNC DIR IS SINGLE-RUN. NEVER REUSE ONE ACROSS ITERATIONS — the markers hold pids
// of processes that are by then DEAD, so every successor reads a stale pid, gets an
// instant ESRCH and starts its increment before this run's predecessor even exists.
// Reproduced: sharing one dir collapses medium-fast to 656 and slow-medium to 251.
// tests/summary-attribution.test.mjs mints one per runFixtures() call with mkdtemp;
// any ad-hoc probe loop must do the same, per iteration.
const DIR = process.env.CC_ATTR_SYNC_DIR;
const WAIT_CAP_MS = 10_000;   // < the 30s inner run cap and the 30s outer bail: a broken
                              // chain fails LOUDLY and fast, it does not ride a deadline.
                              // The longest real wait measured at 72-way is ~3.3s (slow's).
const POLL_MS = 10;           // << the 550ms smallest designed link, so poll granularity
                              // cannot reorder anything.

const sleep = ms => new Promise(r => setTimeout(r, ms));

// after   — marker name whose OWNING PROCESS must have exited before this link starts.
// sleepMs — this link's designed increment.
// signal  — marker name to publish this process's pid under, releasing the successor.
export async function link({ after: waitFor, sleepMs = 0, signal = null } = {}) {
  if (!DIR) {
    throw new Error('CC_ATTR_SYNC_DIR is unset — the attribution fixtures are only ' +
      'runnable through tests/summary-attribution.test.mjs, which mints the sync dir.');
  }
  if (waitFor) await waitForPredecessorExit(waitFor);
  if (sleepMs) await sleep(sleepMs);
  if (signal) publishPid(signal);
}

// Written via rename so a successor can never read a half-created file: the marker
// either does not exist or holds a complete pid.
function publishPid(name) {
  const final = path.join(DIR, name);
  const tmp = `${final}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, String(process.pid));
  fs.renameSync(tmp, final);
}

async function waitForPredecessorExit(name) {
  const p = path.join(DIR, name);
  const deadline = Date.now() + WAIT_CAP_MS;
  let pid = null;
  for (;;) {
    if (pid === null) {
      let raw = null;
      try { raw = fs.readFileSync(p, 'utf8'); } catch { /* not published yet */ }
      const n = Number(raw);
      if (raw && Number.isInteger(n) && n > 0) pid = n;
    }
    if (pid !== null && hasExited(pid)) return;
    if (Date.now() > deadline) {
      throw new Error(`attribution chain: predecessor '${name}' did not publish a pid ` +
        `and exit within ${WAIT_CAP_MS}ms (pid seen: ${pid ?? 'none'}). It never ran to ` +
        `completion — almost always because TEST_CONCURRENCY was below the number of ` +
        `chained fixtures, so they could not overlap.`);
    }
    await sleep(POLL_MS);
  }
}

// Signal 0 probes for existence without delivering anything.
//
// WHY "POLL UNTIL ESRCH" IS SAFE AGAINST PID REUSE, even though that reads like the
// classically unlucky pattern. The failure that would matter is releasing a link EARLY,
// and it is UNREACHABLE: the kernel cannot hand a live process's pid to a new one, so
// ESRCH is only ever observed after the predecessor is genuinely gone. Reuse can only
// go the other way — some unrelated process inherits the pid after the predecessor
// exits, `hasExited` keeps returning false, and the successor waits LONGER, ending at
// the loud WAIT_CAP_MS cap. Every error mode is late-and-loud, never early-and-silent.
// DO NOT "harden" this into anything that can return true before an ESRCH.
//
// EPERM means the process is alive and owned by someone else, which cannot happen for a
// sibling fixture — but treat it as ALIVE regardless, same direction.
function hasExited(pid) {
  try { process.kill(pid, 0); return false; } catch (err) { return err.code === 'ESRCH'; }
}
