// Read-aloud through the server's Piper TTS (POST /api/tts). The response is a
// stream of [4-byte little-endian length][WAV] frames, one per sentence, each
// decoded and scheduled back to back on one AudioContext so speech starts
// after the first sentence instead of the whole reply. Segments queue in a
// TtsQueue: auto-speak appends, a tap on a message's speak button replaces.
//
// `speakStore.activeNodeId` names the message whose button shows "stop": the
// one the user tapped, or the auto-spoken one once its segment starts playing.
import { apiResponse } from '@shared/http';
import { mdToSpeech } from '@shared/md-to-speech';
import { TtsQueue } from '@shared/tts-queue';
import { createStore } from '@/state/createStore';
import { voiceStore } from './store';

type Session = {
  aborted: boolean;
  controller: AbortController;
  sources: AudioBufferSourceNode[];
  playhead: number;
  streamDone: boolean;
  activeSourceCount: number;
  resolve: (() => void) | null;
};

export const speakStore = createStore<{ activeNodeId: string | null }>({ activeNodeId: null });

let userHasInteracted = false;
let audioCtx: AudioContext | null = null;
let session: Session | null = null;
let speakToken = 0;
let currentSpeakToken: number | null = null;
// The button tracking: which node is active, and the playback token it owns.
let activeNode: string | null = null;
let activeNodeToken: number | null = null;

export const getCurrentSpeakToken = () => currentSpeakToken;

function markInteracted() { userHasInteracted = true; }
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', markInteracted, { capture: true });
  document.addEventListener('keydown', markInteracted, { capture: true });
}

/** Re-derive the active button after any playback change (start, stop, natural end, takeover). */
function speakingChanged() {
  const token = currentSpeakToken;
  if (activeNode) {
    if (token === null) { activeNode = null; activeNodeToken = null; }
    else if (activeNodeToken === null) activeNodeToken = token;
    else if (activeNodeToken !== token) { activeNode = null; activeNodeToken = null; }
  }
  if (speakStore.get().activeNodeId !== activeNode) speakStore.set({ activeNodeId: activeNode });
}

function ensureCtx(): AudioContext | null {
  if (!audioCtx) {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  return audioCtx;
}

function stopSilent() {
  if (!session) return;
  const s = session;
  s.aborted = true;
  try { s.controller.abort(); } catch { /* ignore */ }
  for (const src of s.sources) { try { src.stop(); } catch { /* ignore */ } }
  session = null;
  currentSpeakToken = null;
  s.resolve?.();
}

/** Stop playback and drop everything queued. */
export function stop() {
  queue.flush();
  if (!session) return;
  stopSilent();
  speakingChanged();
}

function naturalEnd(s: Session) {
  if (session !== s) return;
  session = null;
  currentSpeakToken = null;
  speakingChanged();
  s.resolve?.();
}

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

async function scheduleWav(ctx: AudioContext, s: Session, wav: Uint8Array) {
  if (s.aborted) return;
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer);
  } catch { return; }
  if (s.aborted) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  const startAt = Math.max(s.playhead, ctx.currentTime + 0.02);
  try { src.start(startAt); } catch { return; }
  s.playhead = startAt + buf.duration;
  s.sources.push(src);
  s.activeSourceCount++;
  src.onended = () => {
    s.activeSourceCount--;
    if (s.streamDone && s.activeSourceCount === 0 && !s.aborted) naturalEnd(s);
  };
}

async function playSingle(text: string): Promise<void> {
  const ctx = ensureCtx();
  if (!ctx) return;
  const token = ++speakToken;
  const s: Session = { aborted: false, controller: new AbortController(), sources: [], playhead: ctx.currentTime + 0.05, streamDone: false, activeSourceCount: 0, resolve: null };
  const done = new Promise<void>((res) => { s.resolve = res; });
  session = s;
  currentSpeakToken = token;
  // Synchronously, before the first await, so a tapped button learns its token.
  speakingChanged();
  try { await ctx.resume(); } catch { /* ignore */ }
  let res: Response;
  try {
    res = await apiResponse('/api/tts', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: text, signal: s.controller.signal });
  } catch { s.resolve?.(); return done; }
  if (!res.ok || !res.body) { s.resolve?.(); return done; }
  const reader = res.body.getReader();
  let buf = new Uint8Array(0);
  try {
    for (;;) {
      const { done: end, value } = await reader.read();
      if (value?.length) buf = concat(buf, value);
      while (buf.length >= 4) {
        const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, true);
        if (buf.length < 4 + len) break;
        const wav = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        if (s.aborted) { s.resolve?.(); return done; }
        await scheduleWav(ctx, s, wav);
      }
      if (end) break;
    }
  } catch { s.resolve?.(); return done; }
  s.streamDone = true;
  if (s.activeSourceCount === 0 && !s.aborted) naturalEnd(s);
  return done;
}

const queue = new TtsQueue(playSingle);

function speak(text: string, { onStart }: { onStart?: () => void } = {}) {
  if (!voiceStore.get().ttsAvailable || typeof text !== 'string') return;
  const spoken = mdToSpeech(text);
  if (!spoken.trim()) return;
  queue.enqueue({ text: spoken, onStart });
}

/** A tap on a message's speak button: replace whatever is playing or queued. */
export function requestSpeak(text: string, nodeId: string) {
  markInteracted();
  queue.flush();
  stopSilent();
  queue.interruptDrain();
  activeNode = nodeId;
  activeNodeToken = null;
  speakStore.set({ activeNodeId: nodeId });
  speak(text);
  // Nothing started (e.g. empty after markdown stripping): don't leave the button on "stop".
  if (currentSpeakToken === null) { activeNode = null; speakStore.set({ activeNodeId: null }); }
}

/** Toggle for a message's button: stop if it is the one speaking, else speak it. */
export function toggleSpeak(text: string, nodeId: string) {
  if (activeNode === nodeId && currentSpeakToken !== null) stop();
  else requestSpeak(text, nodeId);
}

/**
 * Auto-speak a finished reply when enabled. Browsers refuse audio before a user
 * gesture, so nothing plays until the user has interacted with the page. The
 * node's button flips to "stop" when its segment actually starts.
 */
export function maybeAutoSpeak(text: string, nodeId: string) {
  const v = voiceStore.get();
  if (!v.ttsEnabled || !v.ttsAvailable || !userHasInteracted) return;
  speak(text, {
    onStart: () => {
      activeNode = nodeId;
      activeNodeToken = null;
      speakStore.set({ activeNodeId: nodeId });
    },
  });
}

/** Test seam: reset module state between tests. */
export function __resetTtsForTests() {
  queue.flush();
  queue.interruptDrain();
  session = null;
  currentSpeakToken = null;
  activeNode = null;
  activeNodeToken = null;
  audioCtx = null;
  userHasInteracted = false;
  speakStore.set({ activeNodeId: null });
}
export const __markInteractedForTests = markInteracted;
