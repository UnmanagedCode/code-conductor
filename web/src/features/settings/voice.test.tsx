import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { mockFetch, type Call } from './test/fetchMock';

vi.mock('@/app/sessionActions', () => ({ resumeSession: vi.fn(async () => {}) }));
vi.mock('@/app/controller', () => ({ refreshProjects: vi.fn(async () => {}), refreshInstances: vi.fn(async () => {}) }));
vi.mock('@/app/models', () => ({ applyModels: vi.fn() }));
vi.mock('@/features/sidebar/restart', () => ({ performRestart: vi.fn(async () => {}) }));

import { voiceStore } from '@/features/voice/store';
import { SpeakButton } from '@/features/voice/SpeakButton';
import { VoiceSection } from './VoiceSection';

type Item = { name: string; label: string; sizeLabel: string; installed: boolean };
const MODELS: Item[] = [
  { name: 'base', label: 'Base', sizeLabel: '142 MB', installed: true },
  { name: 'small', label: 'Small', sizeLabel: '466 MB', installed: true },
  { name: 'large', label: 'Large', sizeLabel: '1.1 GB', installed: false },
];
const VOICES: Item[] = [
  { name: 'amy', label: 'Amy', sizeLabel: '63 MB', installed: true },
  { name: 'ryan', label: 'Ryan', sizeLabel: '63 MB', installed: true },
  { name: 'lessac', label: 'Lessac', sizeLabel: '63 MB', installed: false },
];
const transcribe = (over: object = {}) => ({ available: true, activeModel: 'base', models: MODELS, install: { running: false }, ...over });
const tts = (over: object = {}) => ({ available: true, activeVoice: 'amy', voices: VOICES, enabled: false, rate: 1, install: { running: false }, ...over });

const card = (title: 'Dictation' | 'Speech') => screen.getByText(title, { selector: '[data-slot="card-title"]' }).closest('[data-slot="card"]') as HTMLElement;
const statusLine = (title: 'Dictation' | 'Speech') => within(card(title)).getAllByRole('status')[0].textContent;
const badge = (title: 'Dictation' | 'Speech', item: string) => card(title).querySelector(`[data-item="${item}"] [data-slot="badge"]`)?.textContent?.trim();
const gets = (calls: Call[], url: string) => calls.filter((c) => c.method === 'GET' && c.url === url).length;
const posts = (calls: Call[], url: string) => calls.filter((c) => c.method === 'POST' && c.url === url);

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

function show(extra?: React.ReactNode) {
  return render(<TooltipProvider><VoiceSection />{extra}</TooltipProvider>);
}

beforeEach(() => {
  voiceStore.set({ micAvailable: false, ttsAvailable: false, ttsEnabled: false, ttsRate: 1 });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Voice → Dictation', () => {
  // The status line names whisper's availability and the active model; each model's badge reflects active / installed / missing, and a missing whisper says how to get it.
  it('shows whisper availability with the active model, and badges each model active, installed or not installed', async () => {
    mockFetch({ 'GET /api/settings/transcribe': () => transcribe(), 'GET /api/settings/tts': () => tts() });
    const view = show();
    await waitFor(() => expect(statusLine('Dictation')).toBe('Whisper available · active model: Base'));
    expect(within(card('Dictation')).getByRole('listbox', { name: 'model catalog' })).toBeTruthy();
    expect(badge('Dictation', 'base')).toBe('active');
    expect(badge('Dictation', 'small')).toBe('installed');
    expect(badge('Dictation', 'large')).toBe('not installed');
    view.unmount();

    mockFetch({ 'GET /api/settings/transcribe': () => transcribe({ available: false, activeModel: null }), 'GET /api/settings/tts': () => tts() });
    show();
    await waitFor(() => expect(statusLine('Dictation')).toBe('Whisper not installed. Pick a model and install it.'));
  });

  // Picking an installed model switches it immediately from the server's answer and publishes mic availability; a refused switch reports the reason.
  it('picking an installed model makes it active at once and reveals the mic; a failed switch says so', async () => {
    let fail = false;
    const calls = mockFetch({
      'GET /api/settings/transcribe': () => transcribe(),
      'GET /api/settings/tts': () => tts(),
      'POST /api/settings/transcribe/model': (c) => (fail ? { status: 500, json: { error: 'busy' } } : transcribe({ activeModel: c.body.model })),
    });
    show();
    await waitFor(() => expect(badge('Dictation', 'base')).toBe('active'));
    fireEvent.click(card('Dictation').querySelector('[data-item="small"]')!);
    await waitFor(() => expect(badge('Dictation', 'small')).toBe('active'));
    expect(posts(calls, '/api/settings/transcribe/model').map((c) => c.body)).toEqual([{ model: 'small' }]);
    expect(badge('Dictation', 'base')).toBe('installed');
    expect(voiceStore.get().micAvailable).toBe(true);
    fail = true;
    fireEvent.click(card('Dictation').querySelector('[data-item="base"]')!);
    expect(await within(card('Dictation')).findByText('Switch failed: busy')).toBeTruthy();
    expect(posts(calls, '/api/settings/transcribe/model').map((c) => c.body)).toEqual([{ model: 'small' }, { model: 'base' }]);
  });

  // Picking a model that is not on disk only offers its install (named and sized) with the build note; nothing is sent.
  it('picking a missing model offers its Install with the build note and sends nothing', async () => {
    const calls = mockFetch({ 'GET /api/settings/transcribe': () => transcribe(), 'GET /api/settings/tts': () => tts() });
    show();
    await waitFor(() => expect(badge('Dictation', 'large')).toBe('not installed'));
    fireEvent.click(card('Dictation').querySelector('[data-item="large"]')!);
    expect(within(card('Dictation')).getByRole('button', { name: 'Install Large (1.1 GB)' })).toBeTruthy();
    expect(within(card('Dictation')).getByText(/^The first install also builds whisper\.cpp from source/)).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  // While the server installs, its log is shown and the catalog is locked; when it ends the catalog reloads from the server and the mic is published.
  it('Install streams the server log while it runs, then reloads: the installed model is active and the mic is revealed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let installed = false;
    let status = { running: true, log: 'building whisper' };
    const calls = mockFetch({
      'GET /api/settings/transcribe': () => (installed
        ? transcribe({ activeModel: 'large', models: MODELS.map((m) => (m.name === 'large' ? { ...m, installed: true } : m)) })
        : transcribe()),
      'GET /api/settings/tts': () => tts(),
      'POST /api/settings/transcribe/install': () => ({ ok: true }),
      'GET /api/settings/transcribe/install/status': () => status,
    });
    show();
    await waitFor(() => expect(badge('Dictation', 'large')).toBe('not installed'));
    fireEvent.click(card('Dictation').querySelector('[data-item="large"]')!);
    fireEvent.click(within(card('Dictation')).getByRole('button', { name: 'Install Large (1.1 GB)' }));
    await waitFor(() => expect(card('Dictation').querySelector('pre')?.textContent).toBe('building whisper'));
    expect(posts(calls, '/api/settings/transcribe/install').map((c) => c.body)).toEqual([{ model: 'large' }]);
    const buttons = Array.from(card('Dictation').querySelectorAll<HTMLButtonElement>('[data-item]'));
    expect(buttons.map((b) => b.disabled)).toEqual([true, true, true]);
    expect(within(card('Dictation')).getByText('Installing…')).toBeTruthy();
    expect(voiceStore.get().micAvailable).toBe(false);

    status = { running: false, log: 'done' };
    installed = true;
    await advance(1500);
    await waitFor(() => expect(badge('Dictation', 'large')).toBe('active'));
    expect(gets(calls, '/api/settings/transcribe')).toBe(2);
    expect(voiceStore.get().micAvailable).toBe(true);
    expect(within(card('Dictation')).queryByRole('button', { name: /^Install/ })).toBeNull();
  });

  // A refused install start is reported with the server's reason and no status poll begins.
  it('an install the server refuses to start says why and polls nothing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = mockFetch({
      'GET /api/settings/transcribe': () => transcribe(),
      'GET /api/settings/tts': () => tts(),
      'POST /api/settings/transcribe/install': () => ({ status: 500, json: { error: 'no compiler' } }),
    });
    show();
    await waitFor(() => expect(badge('Dictation', 'large')).toBe('not installed'));
    fireEvent.click(card('Dictation').querySelector('[data-item="large"]')!);
    fireEvent.click(within(card('Dictation')).getByRole('button', { name: 'Install Large (1.1 GB)' }));
    expect(await within(card('Dictation')).findByText('Install failed to start: no compiler')).toBeTruthy();
    await advance(7500);
    expect(gets(calls, '/api/settings/transcribe/install/status')).toBe(0);
  });

  // An install already running server-side is picked up on open: polled without a click, its log shown, and the catalog reloaded when it ends.
  it('opening the panel while an install runs shows its log and polls it to the end', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let status = { running: true, log: 'resuming build' };
    let reads = 0;
    const calls = mockFetch({
      'GET /api/settings/transcribe': () => transcribe({ install: { running: ++reads === 1 } }),
      'GET /api/settings/tts': () => tts(),
      'GET /api/settings/transcribe/install/status': () => status,
    });
    show();
    await waitFor(() => expect(card('Dictation').querySelector('pre')?.textContent).toBe('resuming build'));
    expect(gets(calls, '/api/settings/transcribe/install/status')).toBe(1);
    expect(gets(calls, '/api/settings/transcribe')).toBe(1);
    status = { running: false, log: 'done' };
    await advance(1500);
    await waitFor(() => expect(gets(calls, '/api/settings/transcribe')).toBe(2));
    expect(gets(calls, '/api/settings/transcribe/install/status')).toBe(2);
    await waitFor(() => expect(Array.from(card('Dictation').querySelectorAll<HTMLButtonElement>('[data-item]')).every((b) => !b.disabled)).toBe(true));
  });
});

describe('Voice → Speech', () => {
  // The Speech status names Piper's availability and active voice; auto-speak can only be switched on once Piper is installed.
  it('shows Piper availability and the active voice; auto-speak is unavailable until Piper is installed', async () => {
    mockFetch({ 'GET /api/settings/transcribe': () => transcribe(), 'GET /api/settings/tts': () => tts({ available: false, activeVoice: null }) });
    const view = show();
    await waitFor(() => expect(statusLine('Speech')).toBe('Piper not installed. Pick a voice and install it.'));
    expect(screen.getByRole('switch', { name: 'Auto-speak assistant replies' })).toHaveProperty('disabled', true);
    view.unmount();

    mockFetch({ 'GET /api/settings/transcribe': () => transcribe(), 'GET /api/settings/tts': () => tts() });
    show();
    await waitFor(() => expect(statusLine('Speech')).toBe('Speech available · active voice: Amy'));
    expect(screen.getByRole('switch', { name: 'Auto-speak assistant replies' })).toHaveProperty('disabled', false);
  });

  // Auto-speak and the committed rate are each saved to the prefs route and the server's answer reaches the voice store; a failed save is reported.
  it('auto-speak and the rate save to the speech prefs and reach the voice store; a failed save says so', async () => {
    let fail = false;
    let prefs = { enabled: false, rate: 1 };
    const calls = mockFetch({
      'GET /api/settings/transcribe': () => transcribe(),
      'GET /api/settings/tts': () => tts(),
      'POST /api/settings/tts/prefs': (c) => (fail ? { status: 500, json: { error: 'disk' } } : (prefs = { ...prefs, ...c.body })),
    });
    show();
    const sw = await screen.findByRole('switch', { name: 'Auto-speak assistant replies' });
    await waitFor(() => expect(sw).toHaveProperty('disabled', false));
    fireEvent.click(sw);
    await waitFor(() => expect(voiceStore.get().ttsEnabled).toBe(true));
    const rate = screen.getByLabelText('Rate');
    fireEvent.change(rate, { target: { value: '1.5' } });
    expect(posts(calls, '/api/settings/tts/prefs').map((c) => c.body)).toEqual([{ enabled: true }]);
    fireEvent.keyUp(rate, { key: 'ArrowRight' });
    await waitFor(() => expect(voiceStore.get().ttsRate).toBe(1.5));
    expect(posts(calls, '/api/settings/tts/prefs').map((c) => c.body)).toEqual([{ enabled: true }, { rate: 1.5 }]);
    fail = true;
    fireEvent.keyUp(rate, { key: 'ArrowRight' });
    expect(await within(card('Speech')).findByText('Save failed: disk')).toBeTruthy();
  });

  // Picking an installed voice is one POST to the voice route, and the badge follows the server's answer.
  it('picking an installed voice switches it at once', async () => {
    const calls = mockFetch({
      'GET /api/settings/transcribe': () => transcribe(),
      'GET /api/settings/tts': () => tts(),
      'POST /api/settings/tts/voice': (c) => tts({ activeVoice: c.body.voice }),
    });
    show();
    await waitFor(() => expect(badge('Speech', 'amy')).toBe('active'));
    fireEvent.click(card('Speech').querySelector('[data-item="ryan"]')!);
    await waitFor(() => expect(badge('Speech', 'ryan')).toBe('active'));
    expect(posts(calls, '/api/settings/tts/voice').map((c) => c.body)).toEqual([{ voice: 'ryan' }]);
    expect(badge('Speech', 'amy')).toBe('installed');
    expect(voiceStore.get().ttsAvailable).toBe(true);
  });

  // The read-aloud button appears only once a finished install's reload reports Piper available.
  it('a clean Piper install reveals the read-aloud button', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const none = VOICES.map((v) => ({ ...v, installed: false }));
    let installed = false;
    let status = { running: true, log: 'building piper' };
    mockFetch({
      'GET /api/settings/transcribe': () => transcribe(),
      'GET /api/settings/tts': () => (installed
        ? tts({ activeVoice: 'lessac', voices: none.map((v) => (v.name === 'lessac' ? { ...v, installed: true } : v)) })
        : tts({ available: false, activeVoice: null, voices: none })),
      'POST /api/settings/tts/install': () => ({ ok: true }),
      'GET /api/settings/tts/install/status': () => status,
    });
    show(<SpeakButton text="hi" nodeId="n1" />);
    await waitFor(() => expect(badge('Speech', 'lessac')).toBe('not installed'));
    fireEvent.click(card('Speech').querySelector('[data-item="lessac"]')!);
    fireEvent.click(within(card('Speech')).getByRole('button', { name: 'Install Lessac (63 MB)' }));
    await waitFor(() => expect(card('Speech').querySelector('pre')?.textContent).toBe('building piper'));
    expect(screen.queryByRole('button', { name: 'Read aloud' })).toBeNull();
    installed = true;
    status = { running: false, log: 'done' };
    await advance(1500);
    expect(await screen.findByRole('button', { name: 'Read aloud' })).toBeTruthy();
    expect(voiceStore.get().ttsAvailable).toBe(true);
  });
});
