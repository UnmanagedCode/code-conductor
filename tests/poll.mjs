// The one polling wait and the one sleep for node tests. A leaf — it imports
// nothing — so a light test file can take these without the server.ts graph
// that tests/helpers.mjs loads; helpers.mjs re-exports both.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Default deadline is generous on purpose. These tests spawn fake-claude
// (a Node subprocess) and poll for the result of a turn round-trip; under the
// concurrent runner (up to 4 files in parallel) on a slow Termux/Android box
// the children CPU-starve each other, so spawn + round-trip can spike past a
// few seconds. waitFor returns the instant the predicate is true, so a wide
// ceiling is free on the happy path and only widens the failure-detection
// window. 10s stays well under the runner's 60s per-test timeout even when a
// test chains several waits.
//
// A predicate that throws counts as not-yet and is retried: a transient throw
// (a file not written yet, a server still binding) is a legitimate wait. The
// timeout error carries the latest throw — in its message, with the attempt it
// came from, and as `cause` — so a predicate bug reads as that bug, not as a
// slow condition. `label` names the condition in the message. The message
// always begins `waitFor: timeout`: negative waits assert /timeout/ on it.
export async function waitFor(predicate, { timeout = 10000, interval = 20, label } = {}) {
  const start = Date.now();
  let attempts = 0;
  let thrownAt = 0;
  let thrown;
  for (;;) {
    attempts++;
    let v;
    try { v = await predicate(); } catch (e) { v = false; thrown = e; thrownAt = attempts; }
    if (v) return v;
    if (Date.now() - start > timeout) {
      const why = thrownAt ? `; attempt ${thrownAt} threw: ${describe(thrown)}` : '';
      throw new Error(`waitFor: timeout after ${timeout} ms${label ? `: ${label}` : ''} (${attempts} attempts${why})`,
        ...(thrownAt ? [{ cause: thrown }] : []));
    }
    await sleep(interval);
  }
}

// A thrown value as text; never itself throws (a null-prototype object has no toString).
function describe(e) {
  try { return String(e); } catch { return Object.prototype.toString.call(e); }
}
