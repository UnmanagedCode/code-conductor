import * as React from 'react';
import { toast } from '@/ui/feedback';

export type MicState = 'idle' | 'recording' | 'transcribing';

/**
 * Record → POST /api/transcribe → hand the text back. Holds a screen wake lock
 * while recording. `onText` returns where the text goes; the composer routes a
 * transcript back to the session the recording started in.
 */
export function useDictation() {
  const [state, setState] = React.useState<MicState>('idle');
  const rec = React.useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; cancelled: boolean; deliver: (t: string) => void } | null>(null);
  const wakeLock = React.useRef<any>(null);

  const acquireWakeLock = async () => {
    try { wakeLock.current = await (navigator as any).wakeLock?.request('screen'); } catch { /* unavailable */ }
  };
  const releaseWakeLock = () => {
    try { wakeLock.current?.release(); } catch { /* ignore */ }
    wakeLock.current = null;
  };

  React.useEffect(() => {
    const onVis = () => { if (!document.hidden && rec.current) void acquireWakeLock(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const stopTracks = (stream: MediaStream) => { for (const t of stream.getTracks()) try { t.stop(); } catch { /* ignore */ } };

  async function start(deliver: (text: string) => void) {
    if (rec.current || state !== 'idle') return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e: any) {
      toast.error('Microphone access denied', e?.message || String(e));
      return;
    }
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream);
    } catch (e: any) {
      stopTracks(stream);
      toast.error('Recording unavailable', e?.message || String(e));
      return;
    }
    const entry = { recorder, stream, chunks: [] as Blob[], cancelled: false, deliver };
    rec.current = entry;
    recorder.addEventListener('dataavailable', (ev) => { if (ev.data?.size) entry.chunks.push(ev.data); });
    recorder.addEventListener('stop', () => {
      const blob = new Blob(entry.chunks, { type: recorder.mimeType || 'audio/webm' });
      stopTracks(stream);
      rec.current = null;
      if (entry.cancelled) return;
      void transcribe(blob, entry.deliver);
    });
    recorder.start();
    void acquireWakeLock();
    setState('recording');
  }

  function stop() {
    const r = rec.current;
    if (!r || state !== 'recording') return;
    setState('transcribing');
    try { r.recorder.stop(); } catch { /* cleanup below */ }
  }

  function abort() {
    const r = rec.current;
    if (!r) return;
    r.cancelled = true;
    releaseWakeLock();
    setState('idle');
    try { r.recorder.stop(); } catch { /* ignore */ }
  }

  async function transcribe(blob: Blob, deliver: (t: string) => void) {
    try {
      const res = await fetch('/api/transcribe', { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const { text } = await res.json();
      deliver(text ?? '');
    } catch (e: any) {
      toast.error('Transcription failed', e?.message || String(e));
    } finally {
      releaseWakeLock();
      setState('idle');
    }
  }

  return { state, start, stop, abort };
}
