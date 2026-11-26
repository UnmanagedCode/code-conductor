// The pending context chip of each session this client is subscribed to, kept in
// step with the server: a snapshot sets it, a `chip` frame replaces or clears it.
// The store only ever holds what a subscription delivered — selecting another
// session drops everything, and the new session's snapshot refills it — so a
// stale chip is never shown. The composer reads it and never clears it locally:
// the server's `chip: null` frame (after a send or a ×) clears it on every client.
import { bus } from '@shared/ws';
import { apiFetch } from '@shared/http';
import type { ContextChip } from '@shared/wireRows';
import { createStore } from '@/state/createStore';
import { on } from '@/app/events';
import { toast } from '@/ui/feedback';

/** Keyed by instance id. */
export const contextChipStore = createStore<{ chips: ReadonlyMap<string, ContextChip> }>({ chips: new Map() });

function setChip(id: string, chip: ContextChip | null) {
  contextChipStore.set((s) => {
    const chips = new Map(s.chips);
    if (chip) chips.set(id, chip);
    else chips.delete(id);
    return { chips };
  });
}

const clearAll = () => contextChipStore.set({ chips: new Map() });

export function startContextChips(): () => void {
  const ac = new AbortController();
  const { signal } = ac;
  bus.addEventListener('snapshot', (e) => setChip(e.detail.id, e.detail.chip ?? null), { signal });
  bus.addEventListener('chip', (e) => setChip(e.detail.id, e.detail.chip), { signal });
  bus.addEventListener('close', clearAll, { signal });
  const off = on('select', clearAll);
  return () => { ac.abort(); off(); };
}

/** The ×: clears the chip only while `rev` is still the one the server holds. */
export async function clearContextChip(sessionId: string, rev: number): Promise<void> {
  try {
    await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/chip?rev=${rev}`, { method: 'DELETE' });
  } catch (e) {
    toast.error('Could not remove the context', e instanceof Error ? e.message : String(e));
  }
}
