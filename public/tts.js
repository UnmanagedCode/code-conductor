// Client-side Piper TTS playback. The inverse of the composer's mic
// dictation: POSTs assistant text to /api/tts and plays the streamed audio.
//
// The server streams a sequence of [4-byte LE length][WAV] frames, one per
// sentence, flushed as Piper synthesizes them. We read the response as a
// stream, decode each sentence's WAV with the Web Audio API, and schedule the
// AudioBufferSourceNodes back-to-back on a running playhead — so the first
// sentence starts playing (~0.3s) while later sentences are still synthesizing.
//
// Module-level singleton state (availability / auto-speak enabled / rate) is
// seeded by app.js from /api/tts/status + /api/settings/tts and flipped live by
// the Settings page. Browsers block audio without a prior user gesture, so we
// track whether the user has interacted: a 🔊 tap is itself a gesture (always
// works), but auto-speak no-ops until the first interaction.
//
// speak() enqueues a normalized segment onto a FIFO TtsQueue. The drain loop
// plays one segment at a time — so fast-generating blocks queue up instead of
// cutting each other off. requestSpeak() (tap) flushes the queue and interrupts
// the current audio before starting the new segment, since a tap is deliberate.

import { mdToSpeech } from './md-to-speech.js';
import { TtsQueue } from './tts-queue.js';

let available = false;
let enabled = false;
let rate = 1.0;
let userHasInteracted = false;
let audioCtx = null;
let session = null; // current playback session

// Speaking-state change notification. blocks.js sets one listener at module
// load time to drive the play/stop button toggle. Fires on _playSingle() start,
// explicit stop(), and natural end (all audio finished + stream drained).
let speakToken = 0;           // monotonic; incremented on each new _playSingle()
let currentSpeakToken = null; // null when idle

let _speakingChangeListener = null;
export function getCurrentSpeakToken() { return currentSpeakToken; }
export function onSpeakingChange(fn) { _speakingChangeListener = fn; }

// First user gesture unlocks auto-speak + lets us resume the AudioContext.
function markInteracted() { userHasInteracted = true; }
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', markInteracted, { capture: true });
  document.addEventListener('keydown', markInteracted, { capture: true });
}

export function isTtsAvailable() { return available; }
export function setTtsAvailable(v) { available = !!v; }
export function setTtsEnabled(v) {
  enabled = !!v;
  if (!enabled) stop(); // flush queue + kill audio when auto-speak is turned off
}
export function setTtsRate(v) { const n = Number(v); if (Number.isFinite(n) && n > 0) rate = n; }
export function getTtsRate() { return rate; }

function ensureCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  return audioCtx;
}

// Internal stop: aborts the current session without firing the change listener.
// Also calls session.resolve() so the drain loop can advance or exit.
function _stopSilent() {
  if (!session) return;
  session.aborted = true;
  try { session.controller.abort(); } catch { /* ignore */ }
  for (const src of session.sources) { try { src.stop(); } catch { /* ignore */ } }
  const s = session;
  session = null;
  currentSpeakToken = null;
  s.resolve?.(); // unblock the drain loop waiting on this segment
}

export function stop() {
  _queue.flush(); // clear all pending segments
  if (!session) return;
  _stopSilent();
  if (_speakingChangeListener) _speakingChangeListener();
}

// Called when the fetch stream is fully drained AND no scheduled sources
// remain. Guards against stale callbacks from a replaced session.
function _naturalEnd(s) {
  if (session !== s) return;
  session = null;
  currentSpeakToken = null;
  if (_speakingChangeListener) _speakingChangeListener();
  s.resolve?.(); // unblock the drain loop
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

// Decode one sentence's WAV and schedule it at the running playhead. Awaited
// per frame so sentences play in order (decode time ≪ audio duration).
async function scheduleWav(ctx, s, wavBytes) {
  if (s.aborted) return;
  let audioBuf;
  try {
    const ab = wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength);
    audioBuf = await ctx.decodeAudioData(ab);
  } catch { return; }
  if (s.aborted) return;
  const src = ctx.createBufferSource();
  src.buffer = audioBuf;
  src.connect(ctx.destination);
  const startAt = Math.max(s.playhead, ctx.currentTime + 0.02);
  try { src.start(startAt); } catch { return; }
  s.playhead = startAt + audioBuf.duration;
  s.sources.push(src);
  // Track active sources so _naturalEnd fires only after all audio has played.
  s.activeSourceCount++;
  src.onended = () => {
    s.activeSourceCount--;
    if (s.streamDone && s.activeSourceCount === 0 && !s.aborted) _naturalEnd(s);
  };
}

// Play one segment end-to-end. Returns a Promise that resolves when the
// segment finishes naturally OR when _stopSilent() aborts it — so the drain
// loop can await this and advance to the next item either way.
async function _playSingle(text) {
  const ctx = ensureCtx();
  if (!ctx) return;

  // Allocate a resolve for the drain loop before any await.
  const token = ++speakToken;
  const s = {
    aborted: false,
    controller: new AbortController(),
    sources: [],
    playhead: ctx.currentTime + 0.05,
    streamDone: false,
    activeSourceCount: 0,
    resolve: null,
  };
  const p = new Promise(res => { s.resolve = res; });
  session = s;
  currentSpeakToken = token;
  // Fire the change listener synchronously before the first await so
  // blocks.js's _activeBtn is already set when the listener runs.
  if (_speakingChangeListener) _speakingChangeListener();

  try { await ctx.resume(); } catch { /* ignore */ }

  let res;
  try {
    res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: text,
      signal: s.controller.signal,
    });
  } catch { s.resolve?.(); return p; }
  if (!res.ok || !res.body) { s.resolve?.(); return p; }

  const reader = res.body.getReader();
  let buf = new Uint8Array(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value && value.length) buf = concat(buf, value);
      // Drain whole frames: [4-byte LE length][WAV].
      while (buf.length >= 4) {
        const view = new DataView(buf.buffer, buf.byteOffset, 4);
        const len = view.getUint32(0, true);
        if (buf.length < 4 + len) break;
        const wav = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        if (s.aborted) { s.resolve?.(); return p; }
        await scheduleWav(ctx, s, wav);
      }
      if (done) break;
    }
  } catch { s.resolve?.(); return p; }

  // Stream fully drained. If no sources are still playing, end immediately;
  // otherwise _naturalEnd fires from the last source's onended handler.
  s.streamDone = true;
  if (s.activeSourceCount === 0 && !s.aborted) _naturalEnd(s);

  return p;
}

// Module-level queue — drives sequential playback.
const _queue = new TtsQueue(_playSingle);

// Normalize markdown, then enqueue the segment. The drain loop plays it after
// any currently-playing segment finishes. onStart (optional) fires just before
// this segment begins playing, used by autoSpeakBlock to flip the button.
export async function speak(text, { onStart } = {}) {
  if (!available || typeof text !== 'string') return;
  text = mdToSpeech(text);
  if (!text.trim()) return;
  _queue.enqueue({ text, onStart });
}

// Tap-driven playback (the 🔊 button). The tap is a user gesture.
// Flushes any queued auto-speak segments and interrupts the current audio,
// then starts the tapped message immediately — synchronously firing the
// speaking-change listener before returning (same contract as the old code).
export function requestSpeak(text) {
  markInteracted();
  _queue.flush();           // clear pending auto-speak segments
  _stopSilent();            // kill current audio (sets currentSpeakToken=null, schedules microtask)
  _queue.interruptDrain();  // reset _draining so enqueue() calls _startDrain() synchronously
  return speak(text);       // _startDrain fires → _playSingle fires listener before first await
}

// Auto-speak a finalized assistant message — only when enabled, available, and
// the user has already interacted (else the browser blocks audio).
// onStart fires when this segment actually begins playing (which may be after
// earlier segments in the queue finish), so the button flips at the right time.
export function maybeAutoSpeak(text, { onStart } = {}) {
  if (!enabled || !available || !userHasInteracted) return;
  return speak(text, { onStart });
}
