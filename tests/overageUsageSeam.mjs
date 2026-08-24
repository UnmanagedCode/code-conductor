// Card 2026-0208. The overage resume/monitor `fetchUsage` seams default to the REAL
// getAccountUsage (src/overageResume.ts, src/usageOverageMonitor.ts). A fire-path test
// that forgets to inject therefore makes a live api.anthropic.com request bounded by
// `AbortSignal.timeout(10_000)` (src/accountUsage.ts) — numerically identical to the
// overage tests' own 10 000 ms `waitFor` budget, so on a box where that egress hangs the
// resume lands *after* the assertion expires. That is the whole of the card.
//
// So the overage test files install a deterministic NON-NETWORK default instead, and
// make the omission fail loudly. A throw inside the stub would NOT be loud: both call
// sites swallow it into `usage = null` (OverageResumeController's `_tick` and `fireNow`).
// Hence: count the calls here, assert the count in `afterEach`.

import assert from 'node:assert/strict';

// Replace both usage seams with a counting stub that never touches the network.
// Returns `null` — the existing "can't confirm" branch — deliberately, NOT an
// under-the-bar payload: an un-injected test must not silently *work*. It fails open
// after FAIL_OPEN_AFTER rechecks in ~300 ms, and is then failed by `afterEach`.
export function installUsageSeamTripwire(instances) {
  const state = { calls: 0 };
  const tripwire = async () => { state.calls++; return null; };
  instances._overageResume.fetchUsage = tripwire;
  instances._usageMonitor.fetchUsage = tripwire;
  return state;
}

// Assert no usage verify ran against the un-injected default. Call from `afterEach`,
// AFTER shutdown()/rmrf() so a teardown-path fetch is caught too and cleanup still runs.
export function assertUsageSeamInjected(state) {
  assert.equal(state.calls, 0,
    `card 2026-0208: ${state.calls} usage verify/verifies ran against the un-injected seam default — ` +
    'this test reached the resume/monitor fire path without injecting a usage stub ' +
    '(setResumeUsage(...) / _overageResume.fetchUsage = ...). With the production default ' +
    'installed those would have been live network calls to api.anthropic.com, each bounded by a ' +
    '10 000 ms AbortSignal — the exact race that made this card. Fix by injecting what the test ' +
    'actually means; do not relax this assertion.');
}
