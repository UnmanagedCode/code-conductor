import { apiFetch } from '@shared/http';
import { createStore, useStore } from '@/state/createStore';
import { toast } from '@/ui/feedback';
import { EMPTY_DRAFT, draftStore, joinDictation } from './drafts';

export type MicState = 'idle' | 'recording' | 'transcribing';

/**
 * Offers a transcript to the composer's box. `startedIn` is the session the recording started in,
 * or null when it started before its instance had a session id. Returns whether the box took it.
 */
export type BoxDelivery = (startedIn: string | null, text: string) => boolean;

// One recording at a time, at module scope: leaving the session view (Settings or another full-page
// view) unmounts the composer, and the recording must run on and its transcript still land in the
// session it was spoken to. Holds a screen wake lock while recording.
const store = createStore<{ state: MicState }>({ state: 'idle' });
let rec: { recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; cancelled: boolean } | null = null;
let box: BoxDelivery | null = null;
let wakeLock: any = null;

async function acquireWakeLock() {
  try { wakeLock = await (navigator as any).wakeLock?.request('screen'); } catch { /* unavailable */ }
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
}
const onVisible = () => { if (!document.hidden && rec) void acquireWakeLock(); };
const stopTracks = (stream: MediaStream) => { for (const t of stream.getTracks()) try { t.stop(); } catch { /* ignore */ } };

function finish() {
  releaseWakeLock();
  document.removeEventListener('visibilitychange', onVisible);
  store.set({ state: 'idle' });
}

/** The box, when it takes the transcript; otherwise the stored draft of the session it was started in. */
function deliver(startedIn: string | null, text: string) {
  if (box?.(startedIn, text)) return;
  if (startedIn && text.trim()) {
    const d = draftStore.load(startedIn) || EMPTY_DRAFT;
    draftStore.save(startedIn, { text: joinDictation(d.text, text), transcribed: true });
  }
}

async function transcribe(blob: Blob, startedIn: string | null) {
  try {
    const answer = await apiFetch<{ text?: string } | null>('/api/transcribe', { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob });
    deliver(startedIn, answer?.text ?? '');
  } catch (e: any) {
    toast.error('Transcription failed', e?.message || String(e));
  } finally {
    finish();
  }
}

/** Record → POST /api/transcribe → deliver the text to the session the recording started in. */
async function start(startedIn: string | null) {
  if (rec || store.get().state !== 'idle') return;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e: any) {
    toast.error('Microphone access denied', e?.message || String(e));
    return;
  }
  // `rec` is set only once the recorder runs: one that fails to construct or start releases the
  // microphone and leaves the next start free.
  try {
    const recorder = new MediaRecorder(stream);
    const entry = { recorder, stream, chunks: [] as Blob[], cancelled: false };
    recorder.addEventListener('dataavailable', (ev) => { if (ev.data?.size) entry.chunks.push(ev.data); });
    recorder.addEventListener('stop', () => {
      const blob = new Blob(entry.chunks, { type: recorder.mimeType || 'audio/webm' });
      stopTracks(stream);
      rec = null;
      if (entry.cancelled) return;
      void transcribe(blob, startedIn);
    });
    recorder.start();
    rec = entry;
  } catch (e: any) {
    stopTracks(stream);
    toast.error('Recording unavailable', e?.message || String(e));
    return;
  }
  void acquireWakeLock();
  document.addEventListener('visibilitychange', onVisible);
  store.set({ state: 'recording' });
}

function stop() {
  if (!rec || store.get().state !== 'recording') return;
  store.set({ state: 'transcribing' });
  try { rec.recorder.stop(); } catch { /* ignore */ }
}

function abort() {
  const r = rec;
  if (!r) return;
  r.cancelled = true;
  finish();
  try { r.recorder.stop(); } catch { /* ignore */ }
}

/** The mounted composer takes transcripts into its box until the returned cleanup runs. */
function offerBox(deliverToBox: BoxDelivery) {
  box = deliverToBox;
  return () => { if (box === deliverToBox) box = null; };
}

/** The recording state, and the controls every composer shares. */
export function useDictation() {
  const state = useStore(store, (s) => s.state);
  return { state, start, stop, abort, offerBox };
}
