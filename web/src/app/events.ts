// In-app events features hook into, so the controller stays ignorant of them.
type Events = {
  /** A session became active (or none). `userGesture` gates focus-stealing. */
  select: { id: string | null; sessionId: string | null; userGesture: boolean };
  /** The instances list was refreshed. */
  instances: void;
  /** Prefill the composer (rewind / fork drop the prompt back in). */
  prefill: { text: string };
  /** An outer assistant text block finalized (TTS auto-speak). */
  assistantText: { text: string; nodeId: string };
};

type Handler<T> = (payload: T) => void;
const handlers = new Map<keyof Events, Set<Handler<any>>>();

export function on<K extends keyof Events>(name: K, fn: Handler<Events[K]>): () => void {
  let set = handlers.get(name);
  if (!set) handlers.set(name, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

export function emit<K extends keyof Events>(name: K, ...payload: Events[K] extends void ? [] : [Events[K]]) {
  for (const fn of handlers.get(name) ?? []) {
    try {
      fn(payload[0]);
    } catch (e) {
      console.error(`app event ${name} handler failed`, e);
    }
  }
}
