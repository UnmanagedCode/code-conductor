import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { voiceStore } from './store';
import { __markInteractedForTests, __resetTtsForTests, getCurrentSpeakToken, maybeAutoSpeak, requestSpeak, speakStore, stop, toggleSpeak } from './tts';

type FakeSource = { buffer: unknown; started: number | null; stopped: boolean; onended: (() => void) | null; connect: () => void; start: (t: number) => void; stop: () => void };

let sources: FakeSource[] = [];
let ttsBodies: string[] = [];

class FakeAudioContext {
  currentTime = 0;
  destination = {};
  resume = vi.fn(async () => {});
  decodeAudioData = vi.fn(async () => ({ duration: 1 }));
  createBufferSource() {
    const s: FakeSource = {
      buffer: null, started: null, stopped: false, onended: null,
      connect() {}, start(t) { s.started = t; }, stop() { s.stopped = true; },
    };
    sources.push(s);
    return s;
  }
}

/** One [u32 little-endian length][payload] frame per sentence, as the server streams them. */
function framed(...payloads: number[]) {
  const parts = payloads.map((n) => {
    const out = new Uint8Array(4 + n);
    new DataView(out.buffer).setUint32(0, n, true);
    return out;
  });
  const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return all;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  __resetTtsForTests();
  sources = [];
  ttsBodies = [];
  (window as any).AudioContext = FakeAudioContext;
  voiceStore.set({ ttsAvailable: true, ttsEnabled: false });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('/api/tts');
    ttsBodies.push(String(init.body));
    return new Response(framed(8, 8), { status: 200 });
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe('read aloud', () => {
  it('speaks a tapped message: posts the markdown-stripped text and schedules one source per frame', async () => {
    requestSpeak('**Hello** `world`', 'n1');
    expect(speakStore.get().activeNodeId).toBe('n1');
    await flush(); await flush();
    expect(ttsBodies).toHaveLength(1);
    expect(ttsBodies[0]).not.toMatch(/[*`]/);
    expect(sources).toHaveLength(2);
    expect(sources[1].started).toBeGreaterThan(sources[0].started!);
  });

  it('turns the button back off when playback ends naturally', async () => {
    requestSpeak('Hello there.', 'n1');
    await flush(); await flush();
    for (const s of sources) s.onended?.();
    expect(getCurrentSpeakToken()).toBeNull();
    expect(speakStore.get().activeNodeId).toBeNull();
  });

  it('a second tap on the speaking message stops it', async () => {
    toggleSpeak('Hello there.', 'n1');
    await flush(); await flush();
    toggleSpeak('Hello there.', 'n1');
    expect(sources.every((s) => s.stopped)).toBe(true);
    expect(speakStore.get().activeNodeId).toBeNull();
  });

  it('tapping another message switches to it', async () => {
    requestSpeak('First.', 'n1');
    await flush(); await flush();
    const first = [...sources];
    requestSpeak('Second.', 'n2');
    expect(first.every((s) => s.stopped)).toBe(true);
    expect(speakStore.get().activeNodeId).toBe('n2');
  });

  it('does nothing while TTS is unavailable', async () => {
    voiceStore.set({ ttsAvailable: false });
    requestSpeak('Hello.', 'n1');
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(speakStore.get().activeNodeId).toBeNull();
  });
});

describe('auto-speak', () => {
  it('waits for a user gesture and the Speech setting', async () => {
    voiceStore.set({ ttsEnabled: true });
    maybeAutoSpeak('Finished the task.', 'n1');
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    __markInteractedForTests();
    voiceStore.set({ ttsEnabled: false });
    maybeAutoSpeak('Finished the task.', 'n1');
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('queues replies in order and lights each button as its segment starts', async () => {
    __markInteractedForTests();
    voiceStore.set({ ttsEnabled: true });
    maybeAutoSpeak('One.', 'n1');
    maybeAutoSpeak('Two.', 'n2');
    expect(speakStore.get().activeNodeId).toBe('n1');
    await flush(); await flush();
    expect(ttsBodies).toEqual(['One.']);
    for (const s of sources) s.onended?.();
    await flush(); await flush();
    expect(ttsBodies).toEqual(['One.', 'Two.']);
    expect(speakStore.get().activeNodeId).toBe('n2');
    stop();
    expect(speakStore.get().activeNodeId).toBeNull();
  });
});
