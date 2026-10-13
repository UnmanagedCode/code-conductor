// Session column width preset. One browser-local choice widens the whole session
// column (transcript, sticky pin, panels, composer) together.
import { createStore } from '@/state/createStore';

export const SESSION_WIDTHS = ['normal', 'wide', 'full'] as const;
export type SessionWidth = (typeof SESSION_WIDTHS)[number];

export const SESSION_WIDTH_LABEL: Record<SessionWidth, string> = { normal: 'Normal', wide: 'Wide', full: 'Full' };

// Literal class strings so Tailwind's scanner emits them.
export const SESSION_COLUMN_MAX_W: Record<SessionWidth, string> = {
  normal: 'max-w-3xl',
  wide: 'max-w-5xl',
  full: 'max-w-none',
};

const KEY = 'code-conductor:session-width';

function read(): SessionWidth {
  try {
    const v = localStorage.getItem(KEY);
    return (SESSION_WIDTHS as readonly string[]).includes(v ?? '') ? (v as SessionWidth) : 'normal';
  } catch {
    return 'normal';
  }
}

export const sessionWidthStore = createStore({ preset: read() });

export function cycleSessionWidth() {
  const cur = sessionWidthStore.get().preset;
  const next = SESSION_WIDTHS[(SESSION_WIDTHS.indexOf(cur) + 1) % SESSION_WIDTHS.length];
  try { localStorage.setItem(KEY, next); } catch { /* storage unavailable */ }
  sessionWidthStore.set({ preset: next });
}
