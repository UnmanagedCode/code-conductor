// Server restart: POST /api/admin/restart, wait until a *new* server process
// answers /api/health (a different bootId), then reload so the fresh bundle
// loads. `resume` drains live turns first and resurrects sessions after, which
// can take minutes, so the wait is longer.
import { createStore } from '@/state/createStore';
import { appStore } from '@/state/app';

export const restartStore = createStore({ inProgress: false });

const setStatus = (text: string) => appStore.set({ sidebarStatus: text ? { text, warn: true } : null });

async function getBootId(fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const r = await fetchImpl('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    return (await r.json())?.bootId ?? null;
  } catch {
    return null;
  }
}

export async function waitForReplacement(
  priorBootId: string | null,
  { tries = 60, delayMs = 250, fetchImpl = fetch, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) } = {},
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchImpl('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const bootId = (await r.json().catch(() => null))?.bootId ?? null;
        if (priorBootId == null || (bootId && bootId !== priorBootId)) return true;
      }
    } catch { /* still down */ }
    await sleep(delayMs);
  }
  return false;
}

export async function performRestart(
  { resume }: { resume: boolean },
  { fetchImpl = fetch, reload = () => location.reload() }: { fetchImpl?: typeof fetch; reload?: () => void } = {},
): Promise<void> {
  if (restartStore.get().inProgress) return;
  restartStore.set({ inProgress: true });
  setStatus(resume ? 'Draining sessions…' : 'Restarting…');
  const prior = await getBootId(fetchImpl);
  await fetchImpl('/api/admin/restart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resume }),
  }).catch(() => {});
  setStatus('Waiting for the server…');
  await waitForReplacement(prior, resume ? { tries: 480, delayMs: 250, fetchImpl } : { fetchImpl });
  setStatus('Reloading…');
  reload();
}
