// The UI modes: every cc boot runs in exactly one, chosen with `--ui`
// (src/headless/args.ts) and advertised as the top-level `uiMode` of
// GET /api/health. The single source of the mode names. DOM-free.
//
//   full     — the whole UI.
//   view     — read-only everywhere.
//   interact — read-only everywhere except the focused root session
//              (GET /api/health's `focus.sessionId`).

export const UI_MODES = ['full', 'view', 'interact'] as const;
export type UiMode = typeof UI_MODES[number];

/** The modes an ordinary (non-headless) server accepts: `interact` needs a focused session. */
export const SERVER_UI_MODES: readonly UiMode[] = ['full', 'view'];

export const isUiMode = (v: unknown): v is UiMode => (UI_MODES as readonly unknown[]).includes(v);

/** The `uiMode` key of a GET /api/health body; a missing or unknown value fails closed to 'view'. */
export function uiModeFromHealth(body: unknown): UiMode {
  const m = (body as { uiMode?: unknown } | null)?.uiMode;
  return isUiMode(m) ? m : 'view';
}
