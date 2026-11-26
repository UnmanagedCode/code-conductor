// The bridge's `setChip` / `clearChip` calls (docs/plugins/runtime.md → Bridge
// protocol): the plugin page's side of PUT / DELETE /api/sessions/:sid/chip, the
// route a plugin backend calls through CONDUCTOR_URL. The chip itself — one
// pending per live session, shown in the composer — lives on the server.
import { ApiError, NetworkError, apiFetch } from '@shared/http';
import { ViewOnlyError } from '@shared/viewOnly';

/** Bound on the request, so a hung server cannot leave a plugin's promise open. */
const CHIP_TIMEOUT_MS = 10_000;

class ChipTimeout extends Error {}

export type ChipResult = { ok: true } | { ok: false; code: string };

/** The route's own refusal code (`INVALID_ARGUMENT`, `SESSION_NOT_LIVE`), else a code for what went wrong. */
function codeOf(e: unknown): string {
  if (e instanceof ApiError) {
    const code = e.body && typeof e.body === 'object' ? (e.body as { code?: unknown }).code : undefined;
    return typeof code === 'string' ? code : 'HOST_ERROR';
  }
  if (e instanceof ViewOnlyError) return 'VIEW_ONLY';
  if (e instanceof NetworkError || e instanceof ChipTimeout) return 'REQUEST_FAILED';
  return 'HOST_ERROR';
}

export async function handleChipCall(d: { type: string; sessionId?: unknown; title?: unknown; data?: unknown }): Promise<ChipResult> {
  if (typeof d.sessionId !== 'string' || !d.sessionId) return { ok: false, code: 'INVALID_ARGUMENT' };
  const url = `/api/sessions/${encodeURIComponent(d.sessionId)}/chip`;
  const init: RequestInit = d.type === 'setChip'
    ? { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: d.title, data: d.data }) }
    : { method: 'DELETE' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new ChipTimeout()), CHIP_TIMEOUT_MS);
  try {
    // apiFetch may not honour the signal in every path, so the timeout also races the request.
    await Promise.race([
      apiFetch(url, { ...init, signal: ctl.signal }),
      new Promise<never>((_, reject) => ctl.signal.addEventListener('abort', () => reject(new ChipTimeout()))),
    ]);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: codeOf(e) };
  } finally {
    clearTimeout(timer);
  }
}
