// Holding Send with text in the box: the hold threshold, a recording that keeps running after the
// release until a tap, focus kept in the box, a cancelled press, the tooltip naming the gesture; a
// recording that keeps running while the composer is unmounted (the user left the session view);
// a transcript with no words; the transcription in flight, and one that fails; and a recorder that
// fails to start.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

type Sent = { type: string; payload: { id?: string; text?: string } };
const sent: Sent[] = [];
vi.mock('@/lib/core/ws.js', () => ({
  bus: new EventTarget(),
  connect: () => {},
  send: (type: string, payload: Sent['payload']) => { sent.push({ type, payload }); },
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { voiceStore } from '@/features/voice/store';
import { toast } from '@/ui/feedback';
import type { Instance } from '@/state/types';
import { Composer } from './Composer';
import { DRAFT_KEY_PREFIX, DRAFT_SAVE_DEBOUNCE_MS } from './drafts';

/** Holding Send this long with text in the box starts a recording. */
const HOLD_MS = 500;

// Each test uses session ids no other test uses, because drafts live at module scope. Each test ends
// with no recording running and no transcription pending: a recording outlives its composer, so one
// left running would show in the next test.
const inst = (sessionId: string): Instance => ({ id: `i-${sessionId}`, project: 'demo', status: 'idle', sessionId, mode: 'x' });

function mount(first: Instance) {
  const tree = (i: Instance) => <TooltipProvider><Composer inst={i} /></TooltipProvider>;
  const view = render(tree(first));
  return { unmount: view.unmount, swap: (next: Instance) => view.rerender(tree(next)) };
}

// ── Fakes: the microphone, a recorder, a held transcription ────────────────
/** How many of the next recorders throw from `start()`. */
let recorderStartFailures = 0;
class FakeRecorder extends EventTarget {
  mimeType = 'audio/webm';
  start() {
    if (recorderStartFailures > 0) { recorderStartFailures--; throw new Error('the recorder refused to start'); }
  }
  stop() {
    this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(['x'], { type: 'audio/webm' }) }));
    this.dispatchEvent(new Event('stop'));
  }
}
let transcript = 'spoken';
/** Lets the held transcription answer. */
let releaseTranscript: () => void = () => {};
let microphone = { opened: 0, released: 0 };
let transcriptions = 0;

beforeEach(() => {
  sent.length = 0;
  localStorage.clear();
  transcript = 'spoken';
  microphone = { opened: 0, released: 0 };
  transcriptions = 0;
  recorderStartFailures = 0;
  voiceStore.set({ supported: true, micAvailable: true });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => { microphone.opened++; return { getTracks: () => [{ stop() { microphone.released++; } }] }; } },
  });
  const held = new Promise<void>((resolve) => { releaseTranscript = resolve; });
  vi.stubGlobal('fetch', vi.fn(async () => { transcriptions++; await held; return { ok: true, json: async () => ({ text: transcript }) }; }));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Reading and driving the composer ─────────────────────────────────────
const box = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
const button = () => screen.getByRole('button', { name: /^(Send|Dictate|Stop recording|Transcribing)$/ }) as HTMLButtonElement;
const label = () => button().getAttribute('aria-label');
const type = (value: string) => fireEvent.change(box(), { target: { value } });
const sentTexts = () => sent.map((s) => s.payload.text);
const storedDraft = (sid: string) => {
  const raw = localStorage.getItem(DRAFT_KEY_PREFIX + sid);
  if (raw === null) return null;
  const { text, transcribed } = JSON.parse(raw) as { text: string; transcribed: boolean };
  return { text, transcribed };
};
/** Lets the recorder → transcription → delivery chain land; it runs on microtasks. */
const flushMicrotasks = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
/** Lets `ms` of fake time pass, then whatever it started land. */
async function wait(ms: number) {
  await act(async () => { vi.advanceTimersByTime(ms); });
  await flushMicrotasks();
}
/** Puts the pointer down on the button; returns false when the press's default action is prevented. */
const pressDown = () => fireEvent.pointerDown(button(), { pointerId: 1 });
/** Lifts a mouse: the click follows in the same task. */
function release() {
  fireEvent.pointerUp(button(), { pointerId: 1 });
  fireEvent.click(button());
}
/** Lifts a finger: the click arrives in a later task, after the timers due now have run. */
async function releaseTouch() {
  fireEvent.pointerUp(button(), { pointerId: 1 });
  await act(async () => { vi.advanceTimersByTime(0); });
  fireEvent.click(button());
}
/** A tap, a while after whatever came before: down, up and click with no time between. */
async function tap() {
  await wait(HOLD_MS);
  pressDown();
  release();
  await flushMicrotasks();
}
/** Holds the button to the threshold. */
async function holdToRecord() {
  pressDown();
  await wait(HOLD_MS);
}

describe('holding Send with text in the box', () => {
  it('a press released before the threshold sends the text and never opens the microphone', async () => {
    mount(inst('short'));
    type('hello');
    expect(label(), 'positive control: with text in the box the button is Send').toBe('Send');
    pressDown();
    await wait(HOLD_MS - 1);
    release();
    await wait(HOLD_MS * 2);
    expect(microphone.opened, 'the microphone never opened').toBe(0);
    expect(sent.map((s) => s.payload)).toEqual([{ id: 'i-short', text: 'hello' }]);
  });

  it('holding to the threshold starts a recording that keeps running after the release; a tap stops it and the transcript is appended', async () => {
    mount(inst('hold'));
    type('hello');
    pressDown();
    await wait(HOLD_MS - 1);
    expect(microphone.opened, 'not recording a millisecond before the threshold').toBe(0);
    await wait(1);
    expect(label(), 'recording from the threshold on').toBe('Stop recording');
    expect(microphone.opened).toBe(1);
    release();
    await wait(HOLD_MS * 2);
    expect(label(), 'the release leaves it recording').toBe('Stop recording');
    expect(sent, 'and sends nothing').toEqual([]);
    expect(transcriptions, 'nothing is transcribed yet').toBe(0);
    await tap();
    expect(transcriptions, 'a tap stops it and sends the audio for transcription').toBe(1);
    releaseTranscript();
    await flushMicrotasks();
    expect(box().value, 'the transcript is appended with one space').toBe('hello spoken');
    expect(microphone.released, 'the microphone is released').toBe(1);
    await tap();
    expect(sentTexts()).toEqual(['<transcribed>\nhello spoken']);
  });

  it('a touch release, whose click arrives a task later, leaves the recording running, and the next tap stops it', async () => {
    mount(inst('touch'));
    type('hello ');
    await holdToRecord();
    expect(label(), 'positive control: the hold started a recording').toBe('Stop recording');
    await releaseTouch();
    await flushMicrotasks();
    expect(label(), 'the touch release leaves it recording').toBe('Stop recording');
    expect(transcriptions, 'nothing is transcribed yet').toBe(0);
    await tap();
    expect(transcriptions, 'the next tap stops it').toBe(1);
    releaseTranscript();
    await flushMicrotasks();
    expect(box().value, 'after a trailing space, no second space').toBe('hello spoken');
  });

  it('after a hold, Stop recording works from the keyboard too', async () => {
    mount(inst('keys'));
    type('hello');
    await holdToRecord();
    release();
    await wait(HOLD_MS);
    expect(label(), 'positive control: the hold is recording').toBe('Stop recording');
    fireEvent.click(button());
    await flushMicrotasks();
    expect(transcriptions, 'a keyboard activation, a click with no pointer, stops it').toBe(1);
    releaseTranscript();
    await flushMicrotasks();
    expect(box().value).toBe('hello spoken');
  });

  it('a release that fires no click still lets the next tap stop the recording', async () => {
    mount(inst('no-click'));
    type('hello');
    await holdToRecord();
    fireEvent.pointerUp(button(), { pointerId: 1 });
    await wait(HOLD_MS);
    expect(label(), 'positive control: the release left it recording').toBe('Stop recording');
    await tap();
    expect(transcriptions, 'the next tap stops it').toBe(1);
    releaseTranscript();
    await flushMicrotasks();
    expect(box().value).toBe('hello spoken');
  });

  it('a press cancelled before the threshold does nothing', async () => {
    mount(inst('cancelled'));
    type('hello');
    pressDown();
    await wait(HOLD_MS - 200);
    fireEvent.pointerCancel(button(), { pointerId: 1 });
    await wait(HOLD_MS * 2);
    expect(microphone.opened, 'the microphone never opened').toBe(0);
    expect(sent, 'nothing is sent').toEqual([]);
    expect(box().value).toBe('hello');
    expect(label()).toBe('Send');
  });

  it('a cancel after the recording started leaves it running until a tap', async () => {
    mount(inst('cancel-late'));
    type('hello');
    await holdToRecord();
    expect(label(), 'positive control: the hold started a recording').toBe('Stop recording');
    fireEvent.pointerCancel(button(), { pointerId: 1 });
    await wait(HOLD_MS * 2);
    expect(label(), 'the cancel leaves it recording').toBe('Stop recording');
    expect(transcriptions).toBe(0);
    await tap();
    releaseTranscript();
    await flushMicrotasks();
    expect(box().value).toBe('hello spoken');
  });

  it('after a hold that recorded and a cancel, Stop recording works from the keyboard', async () => {
    mount(inst('cancel-keys'));
    type('hello');
    await holdToRecord();
    expect(label(), 'positive control: the hold started a recording').toBe('Stop recording');
    fireEvent.pointerCancel(button(), { pointerId: 1 });
    await wait(HOLD_MS);
    expect(label(), 'the cancel leaves it recording').toBe('Stop recording');
    fireEvent.click(button());
    await flushMicrotasks();
    expect(transcriptions, 'a keyboard activation, a click with no pointer, stops it').toBe(1);
    releaseTranscript();
    await flushMicrotasks();
    expect(label(), 'the control returns to Send').toBe('Send');
    expect(box().value).toBe('hello spoken');
  });

  it('pressing Dictate, Send to hold, or Stop recording keeps the focus in the message box', async () => {
    mount(inst('focus'));
    box().focus();
    expect(pressDown(), 'positive control: pressing Dictate on the empty box does not move focus').toBe(false);
    fireEvent.pointerUp(button(), { pointerId: 1 });
    type('hello');
    expect(document.activeElement === box(), 'the box has focus').toBe(true);
    expect(pressDown(), 'pressing Send to hold does not move focus out of the box').toBe(false);
    await wait(HOLD_MS);
    release();
    expect(label()).toBe('Stop recording');
    expect(pressDown(), 'pressing Stop recording does not either').toBe(false);
    release();
    await flushMicrotasks();
    releaseTranscript();
    await flushMicrotasks();
    expect(box().value).toBe('hello spoken');
  });

  it("the Send button's tooltip names the hold gesture while dictation is available, and not without it", async () => {
    mount(inst('tooltip'));
    type('hello');
    act(() => button().focus());
    const tooltip = () => screen.getByRole('tooltip');
    expect(button().getAttribute('aria-describedby'), 'the tooltip describes the button').toBe(tooltip().id);
    expect(tooltip().textContent).toMatch(/hold/i);
    act(() => voiceStore.set({ micAvailable: false }));
    expect(tooltip().textContent, 'without dictation it offers no hold').not.toMatch(/hold/i);
  });
  it('a recorder that fails to start releases the microphone, says so, and the next hold records', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
    recorderStartFailures = 1;
    mount(inst('start-fails'));
    type('hello');
    await holdToRecord();
    expect(microphone.opened, 'positive control: the hold opened the microphone').toBe(1);
    release();
    await wait(HOLD_MS);
    expect(microphone.released, 'the microphone is released').toBe(1);
    expect(error, 'the failure is shown to the user').toHaveBeenCalledTimes(1);
    expect(label(), 'the composer is idle').toBe('Send');
    expect(sent, 'the release sends nothing').toEqual([]);
    await holdToRecord();
    expect(label(), 'the next hold records').toBe('Stop recording');
    expect(microphone.opened).toBe(2);
    release();
    await tap();
    releaseTranscript();
    await flushMicrotasks();
    expect(box().value).toBe('hello spoken');
    expect(microphone.released, 'each microphone opened is released').toBe(2);
  });
});

describe('leaving the session view (the composer unmounts)', () => {
  it('a recording keeps running: the composer shows Stop recording when it comes back, and a tap there lands the transcript in the box', async () => {
    const first = mount(inst('leave-rec'));
    type('hello ');
    await holdToRecord();
    release();
    expect(label(), 'positive control: the hold is recording').toBe('Stop recording');
    first.unmount();
    expect(microphone.released, 'leaving the session view does not release the microphone').toBe(0);
    mount(inst('leave-rec'));
    expect(label(), 'the recording is still running after the composer comes back').toBe('Stop recording');
    expect(box().value).toBe('hello ');
    await tap();
    releaseTranscript();
    await flushMicrotasks();
    expect(box().value).toBe('hello spoken');
    expect(microphone, 'one microphone, released once').toEqual({ opened: 1, released: 1 });
    await wait(DRAFT_SAVE_DEBOUNCE_MS);
    expect(storedDraft('leave-rec'), 'saved flagged as dictated').toEqual({ text: 'hello spoken', transcribed: true });
  });

  it("a transcript that lands while the composer is unmounted becomes its session's draft, flagged, and shows when the composer comes back", async () => {
    const first = mount(inst('leave-land'));
    type('hello');
    await holdToRecord();
    release();
    await tap();
    expect(transcriptions, 'positive control: the audio went for transcription').toBe(1);
    first.unmount();
    releaseTranscript();
    await flushMicrotasks();
    expect(storedDraft('leave-land'), "the words are the session's draft, flagged as dictated").toEqual({ text: 'hello spoken', transcribed: true });
    mount(inst('leave-land'));
    expect(box().value).toBe('hello spoken');
    await tap();
    expect(sentTexts()).toEqual(['<transcribed>\nhello spoken']);
  });

  it('a composer that comes back on another session shows the recording, and the transcript still lands in the session it was spoken to', async () => {
    const first = mount(inst('leave-from'));
    type('from text');
    await holdToRecord();
    release();
    expect(label(), 'positive control: the hold is recording').toBe('Stop recording');
    first.unmount();
    const second = mount(inst('leave-to'));
    expect(label(), 'the other session shows the running recording').toBe('Stop recording');
    await tap();
    releaseTranscript();
    await flushMicrotasks();
    expect(box().value, "the other session's box stays empty").toBe('');
    expect(storedDraft('leave-to'), 'the other session has no draft').toBeNull();
    expect(storedDraft('leave-from'), "the words are the starting session's draft, flagged").toEqual({ text: 'from text spoken', transcribed: true });
    second.swap(inst('leave-from'));
    expect(box().value).toBe('from text spoken');
  });

  it('Cancel on the composer that came back discards the recording: nothing is transcribed and the microphone is released', async () => {
    const first = mount(inst('leave-cancel'));
    type('keep');
    await holdToRecord();
    release();
    first.unmount();
    mount(inst('leave-cancel'));
    expect(label(), 'the recording is still running after the composer comes back').toBe('Stop recording');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await wait(HOLD_MS);
    expect(label(), 'the button is Send again').toBe('Send');
    expect(transcriptions, 'nothing is transcribed').toBe(0);
    expect(microphone).toEqual({ opened: 1, released: 1 });
    expect(box().value).toBe('keep');
  });
});

describe('a transcript with no words', () => {
  it('an empty transcript into the box leaves the typed text as it was, not flagged as dictated', async () => {
    transcript = '';
    mount(inst('words-empty'));
    type('typed');
    await holdToRecord();
    release();
    await tap();
    releaseTranscript();
    await flushMicrotasks();
    expect(button().disabled, 'positive control: the transcription finished').toBe(false);
    await wait(DRAFT_SAVE_DEBOUNCE_MS);
    expect(storedDraft('words-empty'), 'the typed text is not flagged as dictated').toEqual({ text: 'typed', transcribed: false });
    expect(box().value).toBe('typed');
    await tap();
    expect(sentTexts()).toEqual(['typed']);
  });

  it('a whitespace-only transcript into the box leaves the typed text as it was, not flagged as dictated', async () => {
    transcript = ' \n ';
    const c = mount(inst('words-blank'));
    type('typed');
    await holdToRecord();
    release();
    await tap();
    releaseTranscript();
    await flushMicrotasks();
    expect(button().disabled, 'positive control: the transcription finished').toBe(false);
    await wait(DRAFT_SAVE_DEBOUNCE_MS);
    expect(storedDraft('words-blank'), 'the typed text is not flagged as dictated').toEqual({ text: 'typed', transcribed: false });
    expect(box().value).toBe('typed');
    c.swap(inst('words-blank-other'));
    c.swap(inst('words-blank'));
    await tap();
    expect(sentTexts(), 'it sends untagged after a switch away and back').toEqual(['typed']);
  });

  it("an empty transcript stopped from another session leaves the starting session's draft as it was", async () => {
    transcript = '';
    const c = mount(inst('words-empty-a'));
    type('typed in A');
    await holdToRecord();
    release();
    c.swap(inst('words-empty-b'));
    expect(storedDraft('words-empty-a'), "positive control: A's text is stored").toEqual({ text: 'typed in A', transcribed: false });
    await tap();
    releaseTranscript();
    await flushMicrotasks();
    expect(label(), "the transcription finished; B's box is still empty").toBe('Dictate');
    expect(storedDraft('words-empty-a')).toEqual({ text: 'typed in A', transcribed: false });
    c.swap(inst('words-empty-a'));
    await tap();
    expect(sentTexts()).toEqual(['typed in A']);
  });

  it("a whitespace-only transcript stopped from another session leaves the starting session's draft as it was", async () => {
    transcript = ' \n ';
    const c = mount(inst('words-blank-a'));
    type('typed in A');
    await holdToRecord();
    release();
    c.swap(inst('words-blank-b'));
    expect(storedDraft('words-blank-a'), "positive control: A's text is stored").toEqual({ text: 'typed in A', transcribed: false });
    await tap();
    releaseTranscript();
    await flushMicrotasks();
    expect(label(), "the transcription finished; B's box is still empty").toBe('Dictate');
    expect(storedDraft('words-blank-a')).toEqual({ text: 'typed in A', transcribed: false });
    c.swap(inst('words-blank-a'));
    await tap();
    expect(sentTexts()).toEqual(['typed in A']);
  });
});

describe('the transcription', () => {
  it('while the recording is being transcribed the button is disabled, offers neither Stop recording nor Cancel, and a press does nothing', async () => {
    mount(inst('in-flight'));
    type('hello');
    await holdToRecord();
    release();
    expect(screen.queryByRole('button', { name: 'Cancel' }), 'positive control: the recording offers Cancel').not.toBeNull();
    await tap();
    expect(transcriptions, 'the tap sent the audio for transcription').toBe(1);
    expect(button().disabled, 'the button is disabled while it transcribes').toBe(true);
    expect(label(), 'it is named as transcribing, not Send and not Stop recording').toBe('Transcribing');
    expect(screen.queryByRole('button', { name: 'Cancel' }), 'nor to cancel it').toBeNull();
    await tap();
    expect(transcriptions, 'a press while it transcribes posts nothing more').toBe(1);
    expect(sent, 'and sends nothing').toEqual([]);
    releaseTranscript();
    await flushMicrotasks();
    expect(button().disabled).toBe(false);
    expect(box().value).toBe('hello spoken');
  });

  it('a failed transcription returns the composer to idle: the typed text stays, and Send works again', async () => {
    // The server's error body is JSON, as `errorBody` in src/routes.ts sends it.
    const body = { error: 'whisper failed' };
    vi.stubGlobal('fetch', vi.fn(async () => { transcriptions++; return { ok: false, status: 503, json: async () => body, text: async () => JSON.stringify(body) }; }));
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
    mount(inst('failed'));
    type('hello');
    await holdToRecord();
    release();
    await tap();
    expect(transcriptions, 'positive control: the audio went for transcription').toBe(1);
    await flushMicrotasks();
    expect(error, 'the failure is shown to the user').toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][1]), "with the server's reason").toMatch(/whisper failed/);
    expect(button().disabled, 'the button is usable again').toBe(false);
    expect(label()).toBe('Send');
    expect(box().value, 'the typed text is unchanged').toBe('hello');
    await tap();
    expect(sentTexts(), 'and sends the typed text, untagged').toEqual(['hello']);
  });
});
