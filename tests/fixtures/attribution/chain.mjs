// Rendezvous for the four RANKING fixtures (fast → subsecond → medium → slow).
//
// WHY IT EXISTS. tests/run.mjs reports each file as `done - dequeue`, i.e.
// `work + C`, where C is THAT FILE'S OWN fork+exec+node-boot+import cost. C is a
// pure machine-speed quantity: measured max ~320ms at the repo's standard 24-way
// starve, but ~770ms at 72-way. Any assertion comparing two such figures by RATIO
// multiplies C instead of cancelling it, which is how the old
// `fast * 3 < medium` collapsed into an absolute `C < 600ms` cap and went red 42%
// of the time at load1 ~73 on a COMPLETELY CORRECT reporter (card 2026-0222).
//
// The fix is not a wider tolerance. The fixtures now chain their COMPLETIONS
// through marker files, so each pair's separation is a designed increment rather
// than a race against spawn cost, and the test asserts differences against those
// increments. See tests/summary-attribution.test.mjs's header for the identity
// that makes each bound unconditional.
//
// Not `*.test.mjs`, so run.mjs's discover() never picks it up — same convention as
// tests/hangGuardCase.mjs.
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.CC_ATTR_SYNC_DIR;
const WAIT_CAP_MS = 10_000;   // < the 30s inner run cap and the 30s outer bail: a broken
                              // chain fails LOUDLY and fast, it does not ride a deadline.
const POLL_MS = 10;           // << the 550ms smallest designed link, so poll granularity
                              // cannot reorder anything.

// after   — marker name this link waits for before it starts its own increment.
// sleepMs — this link's designed increment.
// signal  — marker name written once the increment is spent, releasing the successor.
export async function link({ after: waitFor, sleepMs = 0, signal = null } = {}) {
  if (!DIR) {
    throw new Error('CC_ATTR_SYNC_DIR is unset — the attribution fixtures are only ' +
      'runnable through tests/summary-attribution.test.mjs, which mints the sync dir.');
  }
  if (waitFor) await waitForMarker(waitFor);
  if (sleepMs) await new Promise(r => setTimeout(r, sleepMs));
  if (signal) fs.writeFileSync(path.join(DIR, signal), '');
}

async function waitForMarker(name) {
  const p = path.join(DIR, name);
  const deadline = Date.now() + WAIT_CAP_MS;
  while (!fs.existsSync(p)) {
    if (Date.now() > deadline) {
      throw new Error(`attribution chain: marker '${name}' never appeared within ` +
        `${WAIT_CAP_MS}ms. The predecessor fixture never ran to completion — almost ` +
        `always because TEST_CONCURRENCY was below the number of chained fixtures, so ` +
        `they could not overlap.`);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}
