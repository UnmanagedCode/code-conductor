import { createSignal } from '@/state/createStore';

/** Bumped on a fixed beat so every "ago" label re-renders. */
export const agoTick = createSignal();

const AGO_TICK_MS = 15_000;

/** Beats `agoTick` until `signal` aborts. */
export function startAgoTick(signal: AbortSignal) {
  const timer = setInterval(() => agoTick.bump(), AGO_TICK_MS);
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
}
