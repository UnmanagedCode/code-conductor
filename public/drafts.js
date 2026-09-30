// Per-session composer drafts. The web UI has one composer; this module gives
// each session its own text and pending attachments, keyed by sessionId (stable
// across crash / resume / renew, unlike the transient instance id).
//
// Two pieces:
//   createDraftStore       — one localStorage key per session, in-memory mirror,
//                            age-based prune. Never throws.
//   installComposerDrafts  — glue between a composer handle and the store:
//                            debounced save on edit, immediate clear on send,
//                            save-outgoing / load-incoming on session switch,
//                            flush on pagehide / tab hidden; also keeps each
//                            session's pending attachments and delivers a
//                            dictation to the session it was started in.
//
// The text is persisted; attachments are not. They hold live objects (preview
// URLs, entries still being encoded), so they live in an in-memory map for the
// life of the page and a reload drops them.

import { joinDictation } from './composer.js';

export const DRAFT_KEY_PREFIX = 'code-conductor:draft:';
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DRAFT_SAVE_DEBOUNCE_MS = 400;

const EMPTY = Object.freeze({ text: '', transcribed: false });

function safeStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; }
  catch { return null; }
}

function parseRecord(raw) {
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || typeof obj.text !== 'string') return null;
    return {
      text: obj.text,
      transcribed: obj.transcribed === true,
      savedAt: Number.isFinite(obj.savedAt) ? obj.savedAt : null,
    };
  } catch {
    return null;
  }
}

// `storage` is resolved once, at construction. The mirror is written before
// storage on every mutation so a missing / full / throwing storage degrades to
// drafts that stay per-session for the life of the page rather than losing the
// outgoing session's text. A cleared session is a `null` tombstone so a failed
// removeItem cannot resurrect stale text through `load`.
export function createDraftStore({ storage = safeStorage(), now = Date.now, maxAgeMs = DRAFT_MAX_AGE_MS } = {}) {
  const mirror = new Map();
  const keyOf = (sid) => DRAFT_KEY_PREFIX + sid;

  function load(sid) {
    if (!sid) return null;
    if (mirror.has(sid)) return mirror.get(sid);
    if (!storage) return null;
    try {
      const raw = storage.getItem(keyOf(sid));
      if (raw == null) return null;
      const rec = parseRecord(raw);
      return rec ? { text: rec.text, transcribed: rec.transcribed } : null;
    } catch {
      return null;
    }
  }

  function clear(sid) {
    if (!sid) return;
    mirror.set(sid, null);
    if (!storage) return;
    try { storage.removeItem(keyOf(sid)); } catch { /* best effort */ }
  }

  // Text is stored raw (untrimmed) so a restore is exact.
  function save(sid, { text, transcribed }) {
    if (!sid) return;
    if (!text) { clear(sid); return; }
    const draft = { text, transcribed: !!transcribed };
    mirror.set(sid, draft);
    if (!storage) return;
    try { storage.setItem(keyOf(sid), JSON.stringify({ ...draft, savedAt: now() })); }
    catch { /* quota / private mode — the mirror still holds it */ }
  }

  // Drops draft keys older than maxAgeMs and draft keys whose value is
  // malformed. Keys without the prefix are never touched.
  function prune() {
    if (!storage) return;
    try {
      const doomed = [];
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

// `composer` needs getDraft() / setDraft() / swapAttachments() / discardAttachments(); it reports edits
// back through `noteChange` (attachComposer's onDraftChange) and asks for a
// dictation's destination through `claimTranscriptTarget` (its option of the
// same name). `currentSid` stays null until the first switchTo, so text the
// browser restores into the box on reload is never saved under a session.
export function installComposerDrafts({
  composer,
  store,
  debounceMs = DRAFT_SAVE_DEBOUNCE_MS,
  timers = { setTimeout, clearTimeout },
  win = window,
  doc = document,
}) {
  const { setTimeout: startTimer, clearTimeout: stopTimer } = timers;
  let currentSid = null;
  let timer = null;
  // Pending attachment lists of the sessions NOT showing; the showing session's
  // list is the composer's. Non-empty lists only, removed on restore.
  const attachments = new Map();

  function cancelTimer() {
    if (timer === null) return;
    stopTimer(timer);
    timer = null;
  }

  function noteChange(draft) {
    if (!currentSid) return;
    cancelTimer();
    if (!draft.text) { store.clear(currentSid); return; }
    const sid = currentSid;
    timer = startTimer(() => {
      timer = null;
      store.save(sid, draft);
    }, debounceMs);
  }

  function flush() {
    cancelTimer();
    if (currentSid) store.save(currentSid, composer.getDraft());
  }

  function switchTo(sid) {
    if (sid === currentSid) return;
    flush();
    const incoming = (sid && attachments.get(sid)) || [];
    if (sid) attachments.delete(sid);
    const outgoing = composer.swapAttachments(incoming);
    // With no session showing there is nothing to keep the list under, and
    // handing it to the next session could send it to the wrong one.
    if (outgoing.length) {
      if (currentSid) attachments.set(currentSid, outgoing);
      else composer.discardAttachments(outgoing);
    }
    currentSid = sid;
    composer.setDraft((sid && store.load(sid)) || EMPTY);
  }

  // Captures the session showing now; the returned deliverer is handed the
  // transcript when it lands. `false` leaves it to the composer's own box.
  function claimTranscriptTarget() {
    const sid = currentSid;
    return (text) => {
      if (!sid || sid === currentSid) return false;
      if (text?.trim()) {
        const d = store.load(sid) || EMPTY;
        store.save(sid, { text: joinDictation(d.text, text), transcribed: true });
      }
      return true;
    };
  }

  win.addEventListener('pagehide', flush);
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) flush(); });
  store.prune();

  return { switchTo, noteChange, flush, claimTranscriptTarget };
}
