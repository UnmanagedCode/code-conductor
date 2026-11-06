// What an instance's event pager reads, kept after the instance has left the
// manager — so a web pane that was watching it when it was killed (or exited as
// a temp worker) keeps paging scroll-back by instance id, in the cursor space it
// already holds. Ring `_seq`s include stream-only events and so do not match a
// transcript's archive stamping (src/eventArchive.ts stampArchiveEvents): that
// pane cannot switch to a disk-numbered source mid-scroll.
//
// A frozen copy, taken once at the drop: the ring, its floor and seams, the echo
// counter, and where the transcript lives. Reading older history still reads the
// session's jsonl at that place, which is outside the worktree, so it survives
// delete_worktree. In memory only and bounded: a restart, or more than
// RETIRED_PAGER_CAP later drops, forgets it — the pane's next page then 404s and
// a reopened view reads the session from disk instead
// (GET /api/sessions/:sessionId/lineage-events).

import type { LineageSource } from './lineagePager.ts';
import type { InstanceLike } from './instanceTypes.ts';

export const RETIRED_PAGER_CAP = 16;

export type RetiredPager = LineageSource & { readonly id: string };

type Capturable = Pick<InstanceLike,
  'id' | 'sessionId' | 'backingSessionId' | 'transcriptPlace' | '_userEchoCount' | 'ring' | 'ringSnapshot'>;

export class RetiredPagers {
  #byId = new Map<string, RetiredPager>();

  // Insertion order is age: a recapture moves the entry to the newest end.
  capture(inst: Capturable): void {
    const ring = inst.ringSnapshot();
    const frozen: RetiredPager = {
      id: inst.id,
      sessionId: inst.sessionId,
      backingSessionId: inst.backingSessionId,
      transcriptPlace: inst.transcriptPlace,
      _userEchoCount: inst._userEchoCount,
      ring: { trimmedBefore: inst.ring.trimmedBefore, nextSeq: inst.ring.nextSeq, seams: [...inst.ring.seams] },
      ringSnapshot: () => ring.slice(),
    };
    this.#byId.delete(inst.id);
    this.#byId.set(inst.id, frozen);
    while (this.#byId.size > RETIRED_PAGER_CAP) {
      this.#byId.delete(this.#byId.keys().next().value as string);
    }
  }

  get(instanceId: string): RetiredPager | undefined {
    return this.#byId.get(instanceId);
  }
}
