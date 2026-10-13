// Per-session composer drafts: one localStorage record per sessionId (stable
// across crash / resume / renew), an in-memory mirror, debounced saves, and a
// 30-day prune. Attachments are kept per session in memory only.
export const DRAFT_KEY_PREFIX = 'code-conductor:draft:';
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DRAFT_SAVE_DEBOUNCE_MS = 400;

export type Draft = { text: string; transcribed: boolean };
export const EMPTY_DRAFT: Draft = Object.freeze({ text: '', transcribed: false }) as Draft;

function safeStorage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

function parseRecord(raw: string | null) {
  try {
    const obj = JSON.parse(raw ?? '');
    if (!obj || typeof obj !== 'object' || typeof obj.text !== 'string') return null;
    return { text: obj.text as string, transcribed: obj.transcribed === true, savedAt: Number.isFinite(obj.savedAt) ? (obj.savedAt as number) : null };
  } catch {
    return null;
  }
}

/** Join dictated text onto what is already typed, with one separating space. */
export function joinDictation(before: string, text: string) {
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before) && !/^\s/.test(text);
  return before + (needsLeadingSpace ? ' ' : '') + text;
}

/** The text a transcribed prompt carries: the agent learns it came from speech. */
export function prependTranscribedTag(text: string, hasTranscript: boolean) {
  if (!hasTranscript || !text) return text;
  return `<transcribed>\n${text}`;
}

export function createDraftStore({ storage = safeStorage(), now = Date.now, maxAgeMs = DRAFT_MAX_AGE_MS } = {}) {
  const mirror = new Map<string, Draft | null>();
  const keyOf = (sid: string) => DRAFT_KEY_PREFIX + sid;
  function load(sid: string | null): Draft | null {
    if (!sid) return null;
    if (mirror.has(sid)) return mirror.get(sid) ?? null;
    if (!storage) return null;
    try {
      const rec = parseRecord(storage.getItem(keyOf(sid)));
      return rec ? { text: rec.text, transcribed: rec.transcribed } : null;
    } catch {
      return null;
    }
  }
  function clear(sid: string | null) {
    if (!sid) return;
    mirror.set(sid, null);
    try { storage?.removeItem(keyOf(sid)); } catch { /* best effort */ }
  }
  function save(sid: string | null, { text, transcribed }: Draft) {
    if (!sid) return;
    if (!text) { clear(sid); return; }
    const draft = { text, transcribed: !!transcribed };
    mirror.set(sid, draft);
    try { storage?.setItem(keyOf(sid), JSON.stringify({ ...draft, savedAt: now() })); } catch { /* the mirror still holds it */ }
  }
  function prune() {
    if (!storage) return;
    try {
      const doomed: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (typeof k !== 'string' || !k.startsWith(DRAFT_KEY_PREFIX)) continue;
        const rec = parseRecord(storage.getItem(k));
        if (!rec || rec.savedAt === null || now() - rec.savedAt > maxAgeMs) doomed.push(k);
      }
      for (const k of doomed) storage.removeItem(k);
    } catch { /* best effort */ }
  }
  return { load, save, clear, prune };
}

export const draftStore = createDraftStore();
draftStore.prune();
