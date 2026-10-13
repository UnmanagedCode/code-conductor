// Server restart: POST /api/admin/restart, which prepares the relaunch in the
// running server first (installs dependencies on drift, builds the interface,
// drains sessions on a resume) and streams its phases. Once its result is ok,
// wait until a *new* server process answers /api/health (a different bootId),
// then reload so the fresh bundle loads. A refused restart leaves the running
// server as it was: nothing reloads, and the status and a toast say why.
import { createStore } from '@/state/createStore';
import { appStore } from '@/state/app';
import { toast } from '@/ui/feedback';
import { ApiError, apiResponse } from '@shared/http';
import { streamAction } from '@/features/settings/api';

export const restartStore = createStore({ inProgress: false });

export type RestartOutcome = { ok: true } | { ok: false; error: string; tail?: string };

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

export async function performRestart(
  { resume }: { resume: boolean },
  { fetchImpl = fetch, reload = () => location.reload() }: { fetchImpl?: typeof fetch; reload?: () => void } = {},
): Promise<RestartOutcome> {
  if (restartStore.get().inProgress) return { ok: false, error: 'a restart is already in progress' };
  restartStore.set({ inProgress: true });
  setStatus('Preparing the restart…');
  const prior = await getBootId(fetchImpl);
  try {
    await streamAction('/api/admin/restart', (_text, phase) => {
      const status = phase && PHASE_STATUS[phase];
      if (status) setStatus(status);
    }, 'POST', { body: { resume }, fetchImpl });
  } catch (e) {
    // Only an answer from the server (an ApiError) is a refusal; a dropped
    // connection (a NetworkError, or a stream cut mid-read) is the old process
    // going down, so the wait below still applies.
    if (e instanceof ApiError) {
      setStatus(`Restart refused: ${e.message} — cc is still running`);
      toast.error('Restart refused — cc is still running', e.message);
      restartStore.set({ inProgress: false });
      return { ok: false, error: e.message, ...(e.tail ? { tail: e.tail } : {}) };
    }
  }
  setStatus('Waiting for the server…');
  await waitForReplacement(prior, resume ? { tries: 480, delayMs: 250, fetchImpl } : { fetchImpl });
  setStatus('Reloading…');
  reload();
  return { ok: true };
}
