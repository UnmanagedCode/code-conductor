// Voice availability, shared by the composer (dictation) and the transcript
// (read aloud). Settings → Voice updates it after an install or a model switch.
import { createStore } from '@/state/createStore';
import { loadCapabilities } from '@/lib/core/capabilities.js';

export const voiceStore = createStore({
  /** The platform has voice at all (GET /api/health capabilities.voice). */
  supported: false,
  /** whisper.cpp + a model are installed (GET /api/transcribe/status). */
  micAvailable: false,
  /** Piper + a voice are installed (GET /api/tts/status). */
  ttsAvailable: false,
  /** Settings → Voice → Speech: speak finished replies automatically. */
  ttsEnabled: false,
  ttsRate: 1,
});

export async function probeMic() {
  try {
    const r = await fetch('/api/transcribe/status', { cache: 'no-store' });
    if (!r.ok) return;
    const { available } = await r.json();
    voiceStore.set({ micAvailable: !!available });
  } catch { /* leave the mic off */ }
}

/** Piper availability, then the auto-speak preference and rate (Settings → Voice → Speech). */
export async function probeTts() {
  try {
    const r = await fetch('/api/tts/status', { cache: 'no-store' });
    if (r.ok) voiceStore.set({ ttsAvailable: !!(await r.json()).available });
  } catch { /* leave TTS off */ }
  try {
    const r = await fetch('/api/settings/tts', { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      const rate = Number(d.rate);
      voiceStore.set({ ttsEnabled: !!d.enabled, ...(Number.isFinite(rate) && rate > 0 ? { ttsRate: rate } : {}) });
    }
  } catch { /* preferences default off */ }
}

const VOICE_PROBE_RETRY_MS = 5000;

/** Probe voice where the platform has it; a failed capabilities load retries. */
export function probeVoice() {
  loadCapabilities().then((caps: { voice?: boolean } | null) => {
    if (!caps) { setTimeout(probeVoice, VOICE_PROBE_RETRY_MS); return; }
    if (!caps.voice) return;
    voiceStore.set({ supported: true });
    void probeMic();
    void probeTts();
  });
}
