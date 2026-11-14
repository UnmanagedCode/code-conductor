// The stored form of a session title. A leaf `src/sessionStore.ts` imports.

export const MAX_TITLE_LEN = 100;

// Trimmed and capped; '' means "no title".
export function normalizeTitle(title: unknown): string {
  if (typeof title !== 'string') return '';
  return title.trim().slice(0, MAX_TITLE_LEN);
}
