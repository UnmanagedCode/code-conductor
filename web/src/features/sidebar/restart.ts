// The power menu's actions. Restart: POST /api/admin/restart, which prepares
// the relaunch in the running server first (installs dependencies on drift,
// builds the interface), drains every session and streams its phases. Once its
// result is ok, wait until a *new* server process answers /api/health (a
// different bootId), then reload so the fresh bundle loads. Shut down: POST
// /api/admin/shutdown, which drains the same way and exits with nothing to
// replace it; the page then says cc has stopped and reloads only once cc is
// started again (the WebSocket reopens). A refused restart or shutdown leaves
// the running server as it was: nothing reloads, and the status and a toast say
// why.
import { createStore } from '@/state/createStore';
import { appStore } from '@/state/app';
import { toast } from '@/ui/feedback';
import { ApiError, apiResponse } from '@shared/http';
import { bus } from '@shared/ws';
import { streamAction } from '@/features/settings/api';

export const powerStore = createStore({ inProgress: false, stopped: false });

export type RestartOutcome = { ok: true } | { ok: false; error: string; tail?: string };

export const STOPPED_STATUS = 'cc has stopped — start it again to continue';

const setStatus = (text: string) => appStore.set({ sidebarStatus: text ? { text, warn: true } : null });

// The sidebar status for each streamed phase.
const PHASE_STATUS: Record<string, string> = {
  deps: 'Installing dependencies…',
  npm: 'Installing dependencies…',
  build: 'Building the interface…',
  drain: 'Draining sessions…',
};

async function getBootId(fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const r = await apiResponse('/api/health', { signal: AbortSignal.timeout(2000) }, fetchImpl);
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
      const r = await apiResponse('/api/health', { signal: AbortSignal.timeout(2000) }, fetchImpl);
      if (r.ok) {
        const bootId = (await r.json().catch(() => null))?.bootId ?? null;
        if (priorBootId == null || (bootId && bootId !== priorBootId)) return true;
      }
    } catch { /* still down */ }
    await sleep(delayMs);
  }
  return false;
}

// Stream one power action. Resolves to the refusal when the server answered
// one; to null when the action went ahead or the connection dropped (the old
// process going down).
async function streamPower(
  path: string, body: unknown, label: string, fetchImpl: typeof fetch,
): Promise<{ error: string; tail?: string } | null> {
  try {
    await streamAction(path, (_text, phase) => {
      const status = phase && PHASE_STATUS[phase];
      if (status) setStatus(status);
    }, 'POST', { body, fetchImpl });
    return null;
  } catch (e) {
    // Only an answer from the server (an ApiError) is a refusal; a dropped
    // connection (a NetworkError, or a stream cut mid-read) is the old process
    // going down.
    if (!(e instanceof ApiError)) return null;
    setStatus(`${label} refused: ${e.message} — cc is still running`);
    toast.error(`${label} refused — cc is still running`, e.message);
    powerStore.set({ inProgress: false });
    return { error: e.message, ...(e.tail ? { tail: e.tail } : {}) };
  }
}

/** Restart; `autoContinue` (self-update) has the next boot continue each busy session at once instead of through the resume banner. */
export async function performRestart(
  { autoContinue = false }: { autoContinue?: boolean } = {},
  { fetchImpl = fetch, reload = () => location.reload() }: { fetchImpl?: typeof fetch; reload?: () => void } = {},
): Promise<RestartOutcome> {
  if (powerStore.get().inProgress) return { ok: false, error: 'a restart is already in progress' };
  powerStore.set({ inProgress: true });
  setStatus('Preparing the restart…');
  const prior = await getBootId(fetchImpl);
  const refused = await streamPower('/api/admin/restart', autoContinue ? { autoContinue: true } : {}, 'Restart', fetchImpl);
  if (refused) return { ok: false, ...refused };
  setStatus('Waiting for the server…');
  // Every restart drains, which can take minutes: the wide budget.
  await waitForReplacement(prior, { tries: 480, delayMs: 250, fetchImpl });
  setStatus('Reloading…');
  reload();
  return { ok: true };
}

/** Shut down; the page reloads once cc is started again. */
export async function performShutdown(
  { fetchImpl = fetch, reload = () => location.reload() }: { fetchImpl?: typeof fetch; reload?: () => void } = {},
): Promise<RestartOutcome> {
  if (powerStore.get().inProgress) return { ok: false, error: 'a restart is already in progress' };
  powerStore.set({ inProgress: true });
  setStatus('Preparing the shutdown…');
  const refused = await streamPower('/api/admin/shutdown', {}, 'Shut down', fetchImpl);
  if (refused) return { ok: false, ...refused };
  powerStore.set({ stopped: true });
  setStatus(STOPPED_STATUS);
  bus.addEventListener('open', () => reload(), { once: true });
  return { ok: true };
}
