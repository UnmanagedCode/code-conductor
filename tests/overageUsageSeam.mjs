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
// under-the-bar payload: an un-injected test must not silently *work*.
//
// How an un-injected test actually fails depends on its `resetsAt`, because
// `_resolveDue`'s can't-confirm branch reschedules via `_reschedule`, which parks at
// `max(resetsAt, now + recheck)` (src/overageResume.ts):
//   - FUTURE `resetsAt` (the dominant shape in these files — `nowSec() + 3600`): the
//     park lands ~1 h out, so no recheck ever comes due inside the test. The fail-open
//     counter stalls at 1, never reaching FAIL_OPEN_AFTER, and the test body burns its
//     full 10 s `waitFor` and fails THERE. (node:test reports only the body error in
//     that case, so `assertUsageSeamInjected` is not what you see — but the file is red
//     either way, and deterministically, with no packet sent.)
//   - PAST `resetsAt` (e.g. the fail-open tests' `nowSec() - 100`, which use that value
//     precisely so the counter CAN climb): the park lands one recheck out, rechecks do
//     accumulate, and the resume fails open — so the body can pass. Here the call count
//     is the ONLY detector, which is exactly why `assertUsageSeamInjected` exists.
// Both regimes are offline and deterministic. Do not relax the count assertion on the
// strength of the first regime looking like a timeout rather than a guard.
export function installUsageSeamTripwire(instances) {
  const state = { calls: 0 };
  const tripwire = async () => { state.calls++; return null; };
  state.fn = tripwire; // identity handle — see assertUsageSeamsInstalled
  instances._overageResume.fetchUsage = tripwire;
  instances._usageMonitor.fetchUsage = tripwire;
  return state;
}

// Assert THIS file's `beforeEach` actually installed the tripwire on both seams.
// Every overage test file needs its own call: each file's `beforeEach` is independently
// editable, so a file whose wiring is reverted to the live `getAccountUsage` default
// must be caught by a test inside that same file, not by a sibling's.
//
// Identity, not invocation, and identity FIRST: if the tripwire is not installed the
// seam may be the real getAccountUsage, and calling it to find out would make the very
// live request this guard exists to prevent. Comparing against `state.fn` is also
// strictly stronger than `notStrictEqual(fn, getAccountUsage)` — it additionally
// rejects a stale tripwire left over from an earlier test, or any other wrong stub.
export async function assertUsageSeamsInstalled(instances, state) {
  const why = (seamName) =>
    `card 2026-0208: the ${seamName} fetchUsage seam is not this test's tripwire. This file's ` +
    'beforeEach must call installUsageSeamTripwire(instances); without it the seam keeps the ' +
    'production default — the real getAccountUsage — and any fire-path test in this file makes ' +
    'a live api.anthropic.com request bounded by a 10 000 ms AbortSignal.';
  assert.strictEqual(instances._overageResume.fetchUsage, state?.fn, why('resume'));
  assert.strictEqual(instances._usageMonitor.fetchUsage, state?.fn, why('monitor'));
  // Proven to be the tripwire above ⇒ exercising it is safe and cannot reach the network.
  const before = state.calls;
  assert.equal(await instances._overageResume.fetchUsage(), null,
    'the tripwire resolves null ("can\'t confirm"), never a payload that could make an un-injected test pass');
  assert.equal(state.calls, before + 1,
    'the tripwire counts its calls — that count is what assertUsageSeamInjected asserts on');
  state.calls = before; // consume the deliberate call so afterEach stays green
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
