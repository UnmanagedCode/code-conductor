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

let available = false;
let enabled = false;
let rate = 1.0;
let userHasInteracted = false;
let audioCtx = null;
let session = null; // current playback session (so a new speak() cancels it)

// First user gesture unlocks auto-speak + lets us resume the AudioContext.
function markInteracted() { userHasInteracted = true; }
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', markInteracted, { capture: true });
  document.addEventListener('keydown', markInteracted, { capture: true });
}

export function isTtsAvailable() { return available; }
export function setTtsAvailable(v) { available = !!v; }
export function setTtsEnabled(v) { enabled = !!v; }
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

export function stop() {
  if (!session) return;
  session.aborted = true;
  try { session.controller.abort(); } catch { /* ignore */ }
  for (const src of session.sources) { try { src.stop(); } catch { /* ignore */ } }
  session = null;
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
}

// POST the text and stream-play the framed WAV response.
export async function speak(text) {
  if (!available || typeof text !== 'string' || !text.trim()) return;
  stop();
  const ctx = ensureCtx();
  if (!ctx) return;
  try { await ctx.resume(); } catch { /* ignore */ }

  const s = { aborted: false, controller: new AbortController(), sources: [], playhead: ctx.currentTime + 0.05 };
  session = s;

  let res;
  try {
    res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: text,
      signal: s.controller.signal,
    });
  } catch { return; }
  if (!res.ok || !res.body) return;

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
        if (s.aborted) return;
        await scheduleWav(ctx, s, wav);
      }
      if (done) break;
    }
  } catch { /* aborted or network error — stop quietly */ }
}

// Tap-driven playback (the 🔊 button). The tap is a user gesture.
export function requestSpeak(text) {
  markInteracted();
  return speak(text);
}

// Auto-speak a finalized assistant message — only when enabled, available, and
// the user has already interacted (else the browser blocks audio).
export function maybeAutoSpeak(text) {
  if (!enabled || !available || !userHasInteracted) return;
  return speak(text);
}
