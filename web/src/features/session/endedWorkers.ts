// The Workers panel's ended list: the sessions a conductor spawned that no longer
// run, and the one browser-wide switch that shows them.
import * as React from 'react';
import { createStore } from '@/state/createStore';
import type { Instance } from '@/state/types';
import { apiFetch } from '@shared/http';
import { isLiveStatus } from '@shared/conductors';
import type { SpawnedSessionRow } from '@shared/wireRows';

export const SHOW_ENDED_WORKERS_KEY = 'code-conductor:workers-show-ended';
function readShowEnded(): boolean {
  try { return localStorage.getItem(SHOW_ENDED_WORKERS_KEY) === '1'; } catch { return false; }
}
export const showEndedWorkersStore = createStore<{ show: boolean }>({ show: readShowEnded() });

/** Show or hide the ended workers; when it is already in force nothing is written. */
export function setShowEndedWorkers(show: boolean) {
  if (showEndedWorkersStore.get().show === show) return;
  showEndedWorkersStore.set({ show });
  try { localStorage.setItem(SHOW_ENDED_WORKERS_KEY, show ? '1' : '0'); } catch { /* storage unavailable */ }
}

export type EndedWorker = {
  sessionId: string; project: string; worktreeName: string | null;
  title: string | null; firstPrompt: string | null;
  /** exited / crashed (a retained instance), archived or offline (no instance). */
  status: string;
  /** The retained dead instance holding the session, when there is one. */
  instanceId: string | null;
};

/**
 * Which spawned sessions are ended, in the server's order. A row is dropped when
 * its session is a live worker already listed (`liveSessionIds`) or a live
 * instance holds it (re-owned or resumed elsewhere). A retained dead instance
 * (a persistent worker) keeps it ended with that instance's status.
 */
export function endedWorkers(rows: SpawnedSessionRow[], instances: Instance[], liveSessionIds: ReadonlySet<string>): EndedWorker[] {
  const out: EndedWorker[] = [];
  for (const r of rows) {
    if (liveSessionIds.has(r.sessionId)) continue;
    if (instances.some((i) => i.sessionId === r.sessionId && isLiveStatus(i.status))) continue;
    const held = instances.find((i) => i.sessionId === r.sessionId);
    out.push({
      sessionId: r.sessionId, project: r.project, worktreeName: r.worktreeName, title: r.title, firstPrompt: r.firstPrompt,
      status: held ? (held.displayStatus ?? held.status) : r.archived ? 'archived' : 'offline',
      instanceId: held?.id ?? null,
    });
  }
  return out;
}

/**
 * The sessions `sessionId` spawned, re-read whenever `refreshKey` changes. Rows
 * are returned only while they belong to the current `sessionId`.
 */
export function useSpawnedSessions(sessionId: string | null | undefined, refreshKey: string): SpawnedSessionRow[] {
  const [read, setRead] = React.useState<{ sessionId: string; rows: SpawnedSessionRow[] } | null>(null);
  React.useEffect(() => {
    if (!sessionId) return;
    const ac = new AbortController();
    apiFetch<{ workers?: SpawnedSessionRow[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/workers`, { signal: ac.signal })
      .then((body) => setRead({ sessionId, rows: Array.isArray(body?.workers) ? body.workers : [] }))
      .catch((e) => {
        if ((e as { name?: unknown })?.name === 'AbortError') return;
        console.warn('workers panel: ended-workers read failed:', e);
      });
    return () => ac.abort();
  }, [sessionId, refreshKey]);
  return read && read.sessionId === sessionId ? read.rows : EMPTY;
}
const EMPTY: SpawnedSessionRow[] = [];
