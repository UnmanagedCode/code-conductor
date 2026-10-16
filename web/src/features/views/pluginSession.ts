// Parent side of the bridge's session awareness (optional host capability, see
// docs/plugins.md → Bridge protocol): tells plugin frames which session is
// active and carries out their `openSession` / `sendPrompt` calls. Frame
// attribution lives in PluginFrames; this module owns what the messages mean.
import { ApiError, apiFetch } from '@shared/http';
import { isLiveStatus } from '@shared/conductors';
import { selectInstance } from '@/app/controller';
import { activeInstance, appStore } from '@/state/app';
import type { Instance } from '@/state/types';
import { promptSendable, sendPrompt } from '@/features/composer/send';
import { pluginFrames } from './plugins';

export type BridgeSession = { sessionId: string; project: string; worktree: string | null };

/** The active session (`appStore.activeId`), or null when none is selected or it has no session id yet. */
export function activeSessionPayload(): BridgeSession | null {
  const inst = activeInstance(appStore.get());
  if (!inst?.sessionId) return null;
  return { sessionId: inst.sessionId, project: inst.project, worktree: inst.worktree?.worktreeName ?? null };
}

const sessionMsg = (session: BridgeSession | null) => ({ cc: 1, type: 'session', session });

/** Bound on the `locate` read; the same bound `shared/ws.ts` puts on a send's ack. */
const LOCATE_TIMEOUT_MS = 10_000;

class LocateTimeout extends Error {}

type Lookup = { inst: Instance } | { code: 'SESSION_UNKNOWN' | 'SESSION_NOT_LIVE' | 'LOOKUP_FAILED' };

/** A live instance carrying `sessionId`, else why there is none. */
async function lookup(sessionId: string): Promise<Lookup> {
  const s = appStore.get();
  const carrying = [...s.instances, ...(s.pristine ? [s.pristine] : [])].filter((i) => i.sessionId === sessionId);
  const live = carrying.find((i) => isLiveStatus(i.status));
  if (live) return { inst: live };
  if (carrying.length) return { code: 'SESSION_NOT_LIVE' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new LocateTimeout()), LOCATE_TIMEOUT_MS);
  try {
    // apiFetch may not honour the signal in every path, so the timeout also races the read.
    await Promise.race([
      apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/locate`, { signal: ctl.signal }),
      new Promise<never>((_, reject) => ctl.signal.addEventListener('abort', () => reject(new LocateTimeout()))),
    ]);
    return { code: 'SESSION_NOT_LIVE' };
  } catch (e) {
    return { code: e instanceof ApiError ? 'SESSION_UNKNOWN' : 'LOOKUP_FAILED' };
  } finally {
    clearTimeout(timer);
  }
}

type Reply = (m: unknown) => void;

async function handleCall(d: { type: string; id: string; sessionId?: unknown; text?: unknown }): Promise<{ ok: true } | { ok: false; code: string }> {
  const sendingText = d.type === 'sendPrompt';
  if (typeof d.sessionId !== 'string' || !d.sessionId) return { ok: false, code: 'INVALID_ARGUMENT' };
  if (sendingText && (typeof d.text !== 'string' || !d.text.trim())) return { ok: false, code: 'INVALID_ARGUMENT' };
  const found = await lookup(d.sessionId);
  if ('code' in found) return { ok: false, code: found.code };
  if (!sendingText) {
    selectInstance(found.inst.id, { userGesture: true });
    return { ok: true };
  }
  if (!promptSendable(found.inst)) return { ok: false, code: 'SESSION_NOT_READY' };
  try {
    await sendPrompt(found.inst, { text: (d.text as string).trim() }, { ack: true });
    return { ok: true };
  } catch {
    return { ok: false, code: 'SEND_FAILED' };
  }
}

/** Registers the bridge handler and broadcasts the active session on change; the returned function undoes both. */
export function startPluginSessionBridge(): () => void {
  let lastKey = JSON.stringify(activeSessionPayload());
  const offStore = appStore.subscribe(() => {
    const payload = activeSessionPayload();
    const key = JSON.stringify(payload);
    if (key === lastKey) return;
    lastKey = key;
    pluginFrames.broadcast(sessionMsg(payload));
  });
  pluginFrames.setBridgeHandler({
    ready: (reply: Reply) => reply(sessionMsg(activeSessionPayload())),
    call: (d, reply: Reply) => {
      // Exactly one reply per received call: an unexpected throw is HOST_ERROR.
      handleCall(d)
        .catch((e): { ok: false; code: string } => {
          console.error('plugin bridge call failed', e);
          return { ok: false, code: 'HOST_ERROR' };
        })
        .then((r) => reply({ cc: 1, type: 'result', id: d.id, ...r }));
    },
  });
  return () => {
    offStore();
    pluginFrames.setBridgeHandler(null);
  };
}
