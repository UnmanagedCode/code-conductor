// Tells the server which pristine conductor this tab shows (src/pristine.ts):
// `pristine_view` when one is shown, `pristine_draft` as its draft settles,
// `pristine_leave` with the composer's live text when it stops being shown. A
// blank leave discards it here too. A store observer rather than a composer
// unmount: StrictMode's dev double-unmount would send a reaping leave, and a
// plugin docked beside the session keeps it shown.
import { bus, send } from '@shared/ws';
import { appStore, activeInstance, findInstance } from '@/state/app';
import { routeStore } from '@/state/route';
import type { Instance } from '@/state/types';

type DraftSource = () => { sessionId: string | null; text: string };

let draftSource: DraftSource | null = null;
/** Pristine conductors this tab sent a prompt to: never left, since the server no longer holds them pristine. */
const sentTo = new Set<string>();
let shown: { id: string; sessionId: string | null } | null = null;

/** The composer registers what its box holds; the returned function unregisters it. */
export function setPristineDraftSource(fn: DraftSource): () => void {
  draftSource = fn;
  return () => { if (draftSource === fn) draftSource = null; };
}

export function reportPristineDraft(inst: Instance | null, text: string) {
  if (!inst?.pristine || sentTo.has(inst.id)) return;
  send('pristine_draft', { id: inst.id, text });
}

/** Called before the prompt is sent, so a leave right after it cannot reap the conductor. */
export function notePristineSent(id: string) {
  if (!findInstance(appStore.get(), id)?.pristine) return;
  sentTo.add(id);
  check();
}

function shownNow(): Instance | null {
  if (routeStore.get().route.view !== 'session') return null;
  const inst = activeInstance(appStore.get());
  return inst?.pristine && !sentTo.has(inst.id) ? inst : null;
}

function leave(prev: { id: string; sessionId: string | null }) {
  if (sentTo.has(prev.id)) return;
  const src = draftSource?.();
  const text = src && prev.sessionId && src.sessionId === prev.sessionId ? src.text : undefined;
  send('pristine_leave', text === undefined ? { id: prev.id } : { id: prev.id, text });
  if (text === undefined || text.trim() !== '') return;
  const s = appStore.get();
  if (s.pristine?.id === prev.id || s.activeId === prev.id) {
    appStore.set({
      ...(s.pristine?.id === prev.id ? { pristine: null } : {}),
      ...(s.activeId === prev.id ? { activeId: null } : {}),
    });
  }
}

function check() {
  const next = shownNow();
  if ((next?.id ?? null) === (shown?.id ?? null)) return;
  const prev = shown;
  shown = next ? { id: next.id, sessionId: next.sessionId } : null;
  if (prev) leave(prev);
  if (next) send('pristine_view', { id: next.id });
}

export function startPristineWatch(signal: AbortSignal) {
  const offApp = appStore.subscribe(check);
  const offRoute = routeStore.subscribe(check);
  // A new socket holds no presence: announce the one shown again.
  bus.addEventListener('open', () => { if (shown) send('pristine_view', { id: shown.id }); }, { signal });
  signal.addEventListener('abort', () => {
    offApp();
    offRoute();
    shown = null;
    sentTo.clear();
  });
  check();
}
