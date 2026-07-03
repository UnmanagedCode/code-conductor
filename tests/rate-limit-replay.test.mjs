// Regression test for the account-wide rate-limit chip bug: replaying a
// session's historical events (snapshot / reset_snapshot) must NOT feed the
// global rate-limit tracker, since a stale per-session history entry would
// clobber a fresher account-wide value already set by a live event or the
// periodic /api/usage fetch. tests/rate-limit-global.test.mjs covers
// RateLimitTracker's merge semantics in isolation; this file drives the real
// installWsRouter wiring so a regression in wsRouter.js itself is caught.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installWsRouter } from '../public/wsRouter.js';
import { bus } from '../public/ws.js';
import { RateLimitTracker } from '../public/usage.js';

function makeRLEvent(utilization) {
  return {
    kind: 'system',
    subtype: 'rate_limit_event',
    data: { rate_limit_info: { rateLimitType: 'five_hour', utilization } },
  };
}

function noop() {}

// installWsRouter registers a window 'popstate' listener (never fired by this
// test) — stub just enough of `window` for that registration to succeed.
globalThis.window ??= { addEventListener: noop };

test('replayed session history never clobbers the account-wide global rate-limit tracker', () => {
  const globalRLTracker = new RateLimitTracker();
  const usageApplyCalls = [];
  const state = { activeId: null, instances: [] };

  installWsRouter({
    state,
    getTracker: () => ({ completedBatches: [], reset: noop, seedActive: noop, apply: noop }),
    getUsage: () => ({ reset: noop, apply: (ev) => usageApplyCalls.push(ev) }),
    globalRLTracker,
    conversation: { clear: noop, reset: noop, apply: noop, _replayMode: false },
    headerHandle: { update: noop },
    lazyController: { init: noop, reset: noop },
    sessionActions: { consumePendingPrefill: () => null, resumeSession: async () => {} },
    composer: { prefill: noop },
    sidebar: { setInstances: noop },
    subagentPanel: { setInstances: noop },
    bumpUnread: noop,
    flushPendingAnswers: noop,
    refreshProjects: async () => {},
    refreshInstances: async () => {},
    selectInstance: noop,
    setSidebarStatus: noop,
  });

  // 1. A live rate_limit_event from instance A sets the account-wide value.
  bus.dispatchEvent(new CustomEvent('event', {
    detail: { id: 'inst-A', ev: makeRLEvent(0.9) },
  }));
  assert.equal(globalRLTracker.info.utilization, 0.9, 'live event sets the global tracker');

  // 2. Switching to / observing instance B replays its (stale) history via
  // a snapshot. The global tracker must be unaffected.
  bus.dispatchEvent(new CustomEvent('snapshot', {
    detail: { id: 'inst-B', events: [makeRLEvent(0.3)] },
  }));
  assert.equal(globalRLTracker.info.utilization, 0.9,
    'snapshot replay of a different session must not clobber the live value');
  assert.equal(usageApplyCalls.length, 2,
    'per-session usage tracker is still fed by snapshot replay (plus the live event from step 1)');

  // 3. A rewind / session switch on instance C replays via reset_snapshot
  // with another stale event. Still must not affect the global tracker.
  bus.dispatchEvent(new CustomEvent('reset_snapshot', {
    detail: { id: 'inst-C', events: [makeRLEvent(0.1)] },
  }));
  assert.equal(globalRLTracker.info.utilization, 0.9,
    'reset_snapshot replay after a session switch must not clobber the live value');
  assert.equal(usageApplyCalls.length, 3,
    'per-session usage tracker is still fed by reset_snapshot replay');
});
