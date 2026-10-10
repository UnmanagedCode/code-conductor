// Read-aloud: auto-speak of finished replies when Settings → Voice → Speech has
// it on, and stopping playback the moment it is switched off. Availability is
// probed by probeVoice() (./store.ts), which main.tsx runs at boot.
import { on } from '@/app/events';
import { voiceStore } from './store';
import { maybeAutoSpeak, stop } from './tts';

let started = false;

export function startVoice() {
  if (started) return;
  started = true;
  on('assistantText', ({ text, nodeId }) => maybeAutoSpeak(text, nodeId));
  let enabled = voiceStore.get().ttsEnabled;
  voiceStore.subscribe(() => {
    const next = voiceStore.get().ttsEnabled;
    if (enabled && !next) stop();
    enabled = next;
  });
}
