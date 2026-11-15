// The idle-wake hub's quiescence barrier, for a negative assertion ("no wake was
// sent") that must hold after every wake the hub has decided. A leaf — it imports
// only ./poll.mjs — so a light hub test can take it without the server graph.
//
// QUIESCENT = one macrotask turn (a decision deferred by a microtask has run),
// then no wake in flight to anyone, no idle-drain settle and no park backstop
// pending. deliver() raises `_inFlight` synchronously at decision time, and the
// settle and park timers are the only other producers of a wake, so a wrong
// delivery decided before this call is visible after it, however slow its send.
// Heartbeat intervals are excluded: an armed subscription always owns one, so a
// test that needs them to fire drives them (`t.mock.timers`, apis `setInterval`).
// A late event on a bare timer the hub does not track is invisible here.
import { waitFor } from './poll.mjs';

export async function quiesceHub(hub) {
  await new Promise((r) => setImmediate(r));
  await waitFor(
    () => hub._inFlight.size === 0 && hub._pendingSettles.size === 0 && hub._parkTimers.size === 0,
    { interval: 2, timeout: 2000, label: 'the hub to quiesce' },
  );
}
