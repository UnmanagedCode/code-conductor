// Detects when a top-level session ENTERS the needs-you strip's Waiting or
// Finished group, from successive /api/instances lists. Pure: no DOM, no
// Notification. The population and the group rule are the strip's own
// (topLevelEntries, stripGroupOf), so the strip and the notifier cannot disagree
// about what "top-level", "Waiting" and "Finished" mean.
//
// The transition inputs are the live-only per-Instance counters in the summary
// (liveAsks, liveTurnEnds, lastTurnError), never hydrated, so a resume or a
// pre-launch listing cannot fake one. Baselines are keyed by instanceId, because
// the counters belong to an Instance object.

import { topLevelEntries, stripGroupOf } from './needsYou.js';
import { deriveConductors } from './conductors.js';

export function createAttentionTracker() {
  // instanceId → { asks, turnEnds, pending }. `pending`: first seen already past
  // its turn end but held in Running (idle with subagents live or a wake armed),
  // so its settle into Finished is owed a notification with no new turn end.
  const baselines = new Map();

  // Returns the transitions this list produced: { kind: 'waiting' | 'finished',
  // sessionId, instanceId, entry, ask?, source?, isError? }.
  function observe(instances) {
    const byId = new Map(instances.map(i => [i.id, i]));
    const pool = topLevelEntries({ conductors: deriveConductors({ instances }).live, instances });
    const out = [];
    const present = new Set();
    for (const entry of pool) {
      const inst = byId.get(entry.instanceId);
      if (!inst) continue;
      present.add(entry.instanceId);
      const asks = inst.liveAsks ?? 0;
      const turnEnds = inst.liveTurnEnds ?? 0;
      const base = baselines.get(entry.instanceId);
      const group = stripGroupOf(entry);
      // First sight, or a counter that went backwards (the id now fronts a fresh
      // Instance object): re-baseline silently.
      if (!base || asks < base.asks || turnEnds < base.turnEnds) {
        baselines.set(entry.instanceId, { asks, turnEnds, pending: group === 'running' && inst.status === 'idle' });
        continue;
      }
      // Observed actively working: it owes nothing beyond what a counted turn end
      // gives it (a stop-interrupted turn ends without counting).
      if (inst.status !== 'idle') base.pending = false;
      if (group === 'waiting' && asks > base.asks) {
        out.push({
          kind: 'waiting', sessionId: entry.sessionId, instanceId: entry.instanceId, entry,
          ask: entry.awaitingUser, source: entry.awaitingUserSource,
        });
      }
      base.asks = asks;
      if (group === 'finished' && (turnEnds > base.turnEnds || base.pending)) {
        out.push({
          kind: 'finished', sessionId: entry.sessionId, instanceId: entry.instanceId, entry,
          isError: !!inst.lastTurnError,
        });
        base.turnEnds = turnEnds;
        base.pending = false;
      } else if (group === 'waiting') {
        // The turn that asked is announced as Waiting, never again as Finished.
        base.turnEnds = turnEnds;
        base.pending = false;
      }
    }
    for (const id of [...baselines.keys()]) if (!present.has(id)) baselines.delete(id);
    return out;
  }

  return { observe };
}
