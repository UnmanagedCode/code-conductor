// Holding Send with text in the box: the hold threshold, a recording that keeps running after the
// release until a tap, focus kept in the box, a cancelled press, the tooltip naming the gesture; a
// recording that keeps running while the composer is unmounted (the user left the session view);
// a transcript with no words; the transcription in flight, and one that fails; a recorder that
// fails to start; the same hold from Space or Enter on the focused button (short press, auto-repeat,
// Escape, blur); and the Alt+Enter shortcut in the message box.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

type Sent = { type: string; payload: { id?: string; text?: string } };
const sent: Sent[] = [];
vi.mock('@shared/ws', () => ({
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

// ── Keys: happy-dom performs no keyboard activation, so these model the browser's ──
// Enter clicks a button on an unprevented keydown (each auto-repeat included); Space clicks on its
// keyup, unless that keydown or keyup was prevented.
let spaceArmed = false;
function keyDown(key: 'Enter' | ' ', { repeat = false } = {}) {
  const proceeded = fireEvent.keyDown(button(), { key, repeat });
  if (key === ' ' && !repeat) spaceArmed = proceeded;
  if (key === 'Enter' && proceeded) fireEvent.click(button());
  return proceeded;
}
function keyUp(key: 'Enter' | ' ') {
  const proceeded = fireEvent.keyUp(button(), { key });
  if (key === ' ' && proceeded && spaceArmed) fireEvent.click(button());
  spaceArmed = false;
  return proceeded;
}
const chord = ({ repeat = false } = {}) => fireEvent.keyDown(box(), { key: 'Enter', altKey: true, repeat });

describe('holding Space or Enter on Send with text in the box', () => {
  it('a short press of Enter on Send sends once, on the release', async () => {
    mount(inst('key-enter-short'));
    type('hello');
    act(() => button().focus());
    keyDown('Enter');
    expect(sent, 'the keydown sends nothing yet').toEqual([]);
    await wait(HOLD_MS - 1);
    keyUp('Enter');
    await wait(HOLD_MS * 2);
    expect(microphone.opened, 'the microphone never opened').toBe(0);
    expect(sent.map((s) => s.payload)).toEqual([{ id: 'i-key-enter-short', text: 'hello' }]);
  });

  it('a short press of Space on Send sends once', async () => {
    mount(inst('key-space-short'));
    type('hello');
    act(() => button().focus());
    keyDown(' ');
    await wait(HOLD_MS - 1);
    keyUp(' ');
    await wait(HOLD_MS * 2);
    expect(microphone.opened, 'the microphone never opened').toBe(0);
    expect(sentTexts()).toEqual(['hello']);
  });

  it('holding Enter on Send to the threshold starts a recording that keeps running after the release; Space then stops it and the transcript is appended', async () => {
    mount(inst('key-enter-hold'));
    type('hello');
    act(() => button().focus());
    keyDown('Enter');
    await wait(HOLD_MS - 1);
    expect(microphone.opened, 'not recording a millisecond before the threshold').toBe(0);
    await wait(1);
    expect(label(), 'recording from the threshold on').toBe('Stop recording');
    keyUp('Enter');
    await wait(HOLD_MS * 2);
    expect(label(), 'the release leaves it recording').toBe('Stop recording');
    expect(sent, 'and sends nothing').toEqual([]);
    expect(transcriptions, 'nothing is transcribed yet').toBe(0);
    keyDown(' ');
    keyUp(' ');
    await flushMicrotasks();
    expect(transcriptions, 'a Space press stops it and sends the audio for transcription').toBe(1);
    releaseTranscript();
    await flushMicrotasks();
    expect(box().value, 'the transcript is appended with one space').toBe('hello spoken');
    expect(sent).toEqual([]);
  });

  it('holding Space on Send to the threshold starts a recording; its release sends nothing and leaves it running, and Enter stops it', async () => {
    mount(inst('key-space-hold'));
    type('hello');
    act(() => button().focus());
    keyDown(' ');
    await wait(HOLD_MS);
    expect(label(), 'positive control: the hold started a recording').toBe('Stop recording');
    keyUp(' ');
    await wait(HOLD_MS * 2);
    expect(label(), 'the release leaves it recording').toBe('Stop recording');
    expect(sent, 'and sends nothing').toEqual([]);
    expect(transcriptions).toBe(0);
    keyDown('Enter');
    keyUp('Enter');
    await flushMicrotasks();
    expect(transcriptions, 'an Enter press stops it').toBe(1);
    releaseTranscript();
    await flushMicrotasks();
    expect(box().value).toBe('hello spoken');
  });

  it('auto-repeats of a held key send nothing more: a short press with repeats sends once, and repeats neither send nor stop the recording a hold started', async () => {
    mount(inst('key-repeat'));
    type('one');
    act(() => button().focus());
    keyDown('Enter');
    for (let i = 0; i < 3; i++) { await wait(100); keyDown('Enter', { repeat: true }); }
    keyUp('Enter');
    await flushMicrotasks();
    expect(sentTexts(), 'a short press with repeats sends once').toEqual(['one']);
    type('two');
    keyDown('Enter');
    for (let i = 0; i < 4; i++) { await wait(100); keyDown('Enter', { repeat: true }); }
    expect(sentTexts(), 'repeats before the threshold send nothing').toEqual(['one']);
    await wait(100);
    expect(label(), 'positive control: the hold started a recording').toBe('Stop recording');
    for (let i = 0; i < 5; i++) { await wait(100); keyDown('Enter', { repeat: true }); }
    await flushMicrotasks();
    expect(label(), 'repeats after the threshold leave it recording').toBe('Stop recording');
    expect(transcriptions).toBe(0);
    keyUp('Enter');
    expect(sentTexts(), 'nor send').toEqual(['one']);
    keyDown(' ');
    keyUp(' ');
    await flushMicrotasks();
    releaseTranscript();
    await flushMicrotasks();
    expect(box().value).toBe('two spoken');
  });

  it('an auto-repeat of Enter on Dictate opens the microphone once', async () => {
    mount(inst('key-repeat-mic'));
    act(() => button().focus());
    expect(label(), 'positive control: the empty box offers Dictate').toBe('Dictate');
    keyDown('Enter');
    keyDown('Enter', { repeat: true });
    keyDown('Enter', { repeat: true });
    await flushMicrotasks();
    expect(label()).toBe('Stop recording');
    keyDown('Enter', { repeat: true });
    keyUp('Enter');
    await flushMicrotasks();
    expect(microphone.opened, 'one microphone').toBe(1);
    expect(transcriptions, 'a repeat does not stop it').toBe(0);
    keyDown('Enter');
    keyUp('Enter');
    await flushMicrotasks();
    expect(transcriptions, 'a fresh press stops it').toBe(1);
    releaseTranscript();
    await flushMicrotasks();
    expect(box().value).toBe('spoken');
    expect(microphone).toEqual({ opened: 1, released: 1 });
  });

  it('focus leaving Send before the threshold cancels the hold: nothing is recorded and nothing is sent', async () => {
    mount(inst('key-blur'));
    type('hello');
    act(() => button().focus());
    keyDown('Enter');
    await wait(HOLD_MS - 100);
    act(() => box().focus());
    await wait(HOLD_MS * 2);
    fireEvent.keyUp(box(), { key: 'Enter' });
    await flushMicrotasks();
    expect(microphone.opened, 'the microphone never opened').toBe(0);
    expect(sent, 'nothing is sent').toEqual([]);
    expect(box().value).toBe('hello');
    expect(label()).toBe('Send');
  });

  it("Escape before the threshold cancels the hold, and the key's release sends nothing", async () => {
    mount(inst('key-escape'));
    type('hello');
    act(() => button().focus());
    keyDown(' ');
    await wait(HOLD_MS - 200);
    fireEvent.keyDown(button(), { key: 'Escape' });
    await wait(HOLD_MS * 2);
    keyUp(' ');
    await flushMicrotasks();
    expect(microphone.opened, 'the microphone never opened').toBe(0);
    expect(sent, 'the release sends nothing').toEqual([]);
    expect(label()).toBe('Send');
    keyDown('Enter');
    keyUp('Enter');
    expect(sentTexts(), 'the next short press sends').toEqual(['hello']);
  });

  it('Escape or a focus loss after the recording started leaves it running until a press', async () => {
    mount(inst('key-late-cancel'));
    type('hello');
    act(() => button().focus());
    keyDown('Enter');
    await wait(HOLD_MS);
    expect(label(), 'positive control: the hold started a recording').toBe('Stop recording');
    fireEvent.keyDown(button(), { key: 'Escape' });
    await wait(HOLD_MS);
    expect(label(), 'Escape leaves it recording').toBe('Stop recording');
    act(() => box().focus());
    fireEvent.keyUp(box(), { key: 'Enter' });
    await wait(HOLD_MS);
    expect(label(), 'the focus loss leaves it recording').toBe('Stop recording');
    expect(transcriptions).toBe(0);
    expect(sent).toEqual([]);
    act(() => button().focus());
    keyDown(' ');
    keyUp(' ');
    await flushMicrotasks();
    expect(transcriptions, 'the next press stops it').toBe(1);
    releaseTranscript();
    await flushMicrotasks();
    expect(box().value).toBe('hello spoken');
  });

  it('after a pointer release with no click, a key press on Stop recording stops it', async () => {
    mount(inst('key-after-no-click'));
    type('hello');
    await holdToRecord();
    fireEvent.pointerUp(button(), { pointerId: 1 });
    await wait(HOLD_MS);
    expect(label(), 'positive control: the release left it recording').toBe('Stop recording');
    act(() => button().focus());
    keyDown('Enter');
    keyUp('Enter');
    await flushMicrotasks();
    expect(transcriptions, 'the key press stops it').toBe(1);
    releaseTranscript();
    await flushMicrotasks();
    expect(box().value).toBe('hello spoken');
  });

  it('without whisper, Enter on Send sends at once and Space on its release, and a held key records nothing', async () => {
    voiceStore.set({ micAvailable: false });
    mount(inst('key-no-whisper'));
    type('one');
    act(() => button().focus());
    keyDown('Enter');
    expect(sentTexts(), 'Enter sends on its keydown').toEqual(['one']);
    keyUp('Enter');
    type('two');
    keyDown(' ');
    await wait(HOLD_MS * 2);
    expect(sentTexts(), 'a held Space sends nothing before its release').toEqual(['one']);
    keyUp(' ');
    await flushMicrotasks();
    expect(sentTexts(), 'and sends on its release').toEqual(['one', 'two']);
    expect(microphone.opened, 'the microphone never opened').toBe(0);
  });
});

// At most one hold is pending: a gesture that starts a hold supersedes the pending one, and the
// superseded gesture's release neither sends nor cancels the newer hold.
describe('interleaved holds on Send: the newest gesture wins', () => {
  it("a pointer tap during a key hold sends once; the key's later release neither sends nor records, and the next key press works", async () => {
    mount(inst('mix-key-then-tap'));
    type('one');
    act(() => button().focus());
    keyDown('Enter');
    await wait(100);
    pressDown();
    release();
    await flushMicrotasks();
    expect(sentTexts(), 'the tap sends').toEqual(['one']);
    await wait(100);
    expect(keyUp('Enter'), "the key's release is still swallowed").toBe(false);
    await wait(HOLD_MS * 2);
    expect(sentTexts(), 'the release sends nothing').toEqual(['one']);
    expect(microphone.opened, 'and no recording starts').toBe(0);
    type('two');
    keyDown('Enter');
    keyUp('Enter');
    expect(sentTexts(), 'a later short key press sends once').toEqual(['one', 'two']);
    await wait(HOLD_MS * 2);
    expect(microphone.opened).toBe(0);
  });

  it("a key press during a pointer hold supersedes it: the pointer's release neither sends nor cancels, and the key's short release sends once", async () => {
    mount(inst('mix-pointer-then-key'));
    type('hello');
    act(() => button().focus());
    pressDown();
    await wait(200);
    keyDown('Enter');
    await wait(100);
    release();
    await flushMicrotasks();
    expect(sent, "the superseded pointer's release sends nothing").toEqual([]);
    await wait(HOLD_MS - 200);
    expect(microphone.opened, "nor does the pointer's hold complete").toBe(0);
    keyUp('Enter');
    expect(sentTexts(), "the key's short release sends").toEqual(['hello']);
    await wait(HOLD_MS * 2);
    expect(sentTexts(), 'once').toEqual(['hello']);
    expect(microphone.opened, 'and nothing records').toBe(0);
  });

  it('a key hold and a pointer hold started together open the microphone once', async () => {
    mount(inst('mix-together'));
    type('hello');
    act(() => button().focus());
    keyDown('Enter');
    pressDown();
    await wait(HOLD_MS);
    expect(label(), 'positive control: the hold started a recording').toBe('Stop recording');
    release();
    keyUp('Enter');
    await wait(HOLD_MS);
    expect(label(), 'both releases leave it recording').toBe('Stop recording');
    expect(sent).toEqual([]);
    expect(microphone.opened, 'one microphone').toBe(1);
    await tap();
    releaseTranscript();
    await flushMicrotasks();
    expect(box().value).toBe('hello spoken');
    expect(microphone).toEqual({ opened: 1, released: 1 });
  });

  it("a second finger's hold supersedes the first: the first finger's release does not cancel it, and it completes on its own threshold", async () => {
    mount(inst('mix-two-fingers'));
    type('hello');
    fireEvent.pointerDown(button(), { pointerId: 1 });
    await wait(200);
    fireEvent.pointerDown(button(), { pointerId: 2 });
    await wait(100);
    fireEvent.pointerUp(button(), { pointerId: 1 });
    await wait(HOLD_MS - 101);
    expect(microphone.opened, "the first finger's hold never completes").toBe(0);
    await wait(1);
    expect(label(), "the second finger's hold completes at its own threshold").toBe('Stop recording');
    fireEvent.pointerUp(button(), { pointerId: 2 });
    fireEvent.click(button());
    await wait(HOLD_MS);
    expect(label(), 'its release leaves it recording').toBe('Stop recording');
    expect(sent).toEqual([]);
    expect(microphone.opened).toBe(1);
    await tap();
    releaseTranscript();
    await flushMicrotasks();
    expect(box().value).toBe('hello spoken');
  });
});

describe('Escape on Send cancels whatever hold is pending', () => {
  it("after a pointer supersedes a held key, Escape cancels the pointer's hold: nothing records, neither release sends, and the next gestures work", async () => {
    mount(inst('esc-superseded'));
    type('hello');
    act(() => button().focus());
    keyDown('Enter');
    await wait(100);
    pressDown();
    await wait(100);
    fireEvent.keyDown(button(), { key: 'Escape' });
    await wait(HOLD_MS * 2);
    expect(microphone.opened, 'nothing records').toBe(0);
    release();
    await flushMicrotasks();
    expect(sent, "the pointer's release and click send nothing").toEqual([]);
    expect(keyUp('Enter'), "the key's release is swallowed").toBe(false);
    expect(sent, 'and sends nothing').toEqual([]);
    expect(label()).toBe('Send');
    keyDown('Enter');
    keyUp('Enter');
    expect(sentTexts(), 'the next key press sends').toEqual(['hello']);
    type('again');
    await tap();
    expect(sentTexts(), 'and the next tap sends').toEqual(['hello', 'again']);
    expect(microphone.opened).toBe(0);
  });

  it('Escape on a focused Send cancels a pointer hold: nothing records and its release sends nothing', async () => {
    mount(inst('esc-pointer'));
    type('hello');
    act(() => button().focus());
    pressDown();
    await wait(HOLD_MS - 100);
    fireEvent.keyDown(button(), { key: 'Escape' });
    await wait(HOLD_MS * 2);
    expect(microphone.opened, 'nothing records').toBe(0);
    release();
    await flushMicrotasks();
    expect(sent, 'the release sends nothing').toEqual([]);
    await tap();
    expect(sentTexts(), 'the next tap sends').toEqual(['hello']);
  });
});

describe('the Alt+Enter shortcut in the message box', () => {
  it('with text in the box, Alt+Enter starts a recording and keeps the focus in the box; Alt+Enter again stops it and appends the transcript', async () => {
    mount(inst('chord-text'));
    type('hello');
    act(() => box().focus());
    expect(chord(), 'the chord is consumed').toBe(false);
    await flushMicrotasks();
    expect(label()).toBe('Stop recording');
    expect(document.activeElement === box(), 'the box keeps the focus').toBe(true);
    expect(sent, 'nothing is sent').toEqual([]);
    chord();
    await flushMicrotasks();
    expect(transcriptions, 'the second chord stops it').toBe(1);
    releaseTranscript();
    await flushMicrotasks();
    expect(box().value).toBe('hello spoken');
    expect(sent).toEqual([]);
  });

  it('on an empty box Alt+Enter starts a recording, and while it transcribes Alt+Enter does nothing', async () => {
    mount(inst('chord-empty'));
    act(() => box().focus());
    chord();
    await flushMicrotasks();
    expect(label(), 'the chord records on an empty box').toBe('Stop recording');
    chord();
    await flushMicrotasks();
    expect(label(), 'positive control: it is transcribing').toBe('Transcribing');
    expect(chord(), 'the chord is still consumed').toBe(false);
    await flushMicrotasks();
    expect(microphone.opened, 'no second recording').toBe(1);
    expect(transcriptions, 'no second transcription').toBe(1);
    expect(label()).toBe('Transcribing');
    releaseTranscript();
    await flushMicrotasks();
    expect(box().value).toBe('spoken');
    expect(sent).toEqual([]);
  });

  it('an auto-repeat of Alt+Enter neither stops the recording nor starts a second', async () => {
    mount(inst('chord-repeat'));
    type('hello');
    act(() => box().focus());
    chord();
    chord({ repeat: true });
    await flushMicrotasks();
    expect(label()).toBe('Stop recording');
    chord({ repeat: true });
    chord({ repeat: true });
    await flushMicrotasks();
    expect(label(), 'repeats leave it recording').toBe('Stop recording');
    expect(microphone.opened, 'one microphone').toBe(1);
    expect(transcriptions).toBe(0);
    chord();
    await flushMicrotasks();
    releaseTranscript();
    await flushMicrotasks();
    expect(box().value).toBe('hello spoken');
    expect(microphone).toEqual({ opened: 1, released: 1 });
  });

  it('without whisper, Alt+Enter sends the text as Enter does, and the box names no shortcut', async () => {
    voiceStore.set({ micAvailable: false });
    mount(inst('chord-no-whisper'));
    type('typed');
    expect(box().getAttribute('aria-keyshortcuts')).toBeNull();
    chord();
    await wait(HOLD_MS);
    expect(microphone.opened, 'the microphone never opened').toBe(0);
    expect(sentTexts()).toEqual(['typed']);
  });

  it('the message box announces Alt+Enter in aria-keyshortcuts and the Send tooltip names it, only while dictation is available and the box is enabled', async () => {
    const c = mount({ ...inst('chord-announce'), status: 'exited' });
    expect(box().disabled, 'positive control: an exited session disables the box').toBe(true);
    expect(box().getAttribute('aria-keyshortcuts'), 'a disabled box names no shortcut').toBeNull();
    c.swap(inst('chord-announce'));
    expect(box().getAttribute('aria-keyshortcuts')).toBe('Alt+Enter');
    act(() => button().focus());
    const tooltip = () => screen.getByRole('tooltip');
    expect(tooltip().textContent, 'Dictate names it').toMatch(/Alt\+Enter/);
    type('hello');
    expect(tooltip().textContent, 'Send names it beside the hold').toMatch(/hold.*Alt\+Enter/i);
    act(() => voiceStore.set({ micAvailable: false }));
    expect(box().getAttribute('aria-keyshortcuts'), 'without dictation the box names no shortcut').toBeNull();
    expect(tooltip().textContent).not.toMatch(/Alt\+Enter/);
  });
});
