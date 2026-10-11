// Per-session pending attachments and dictation delivery beyond composer.test.tsx: restored chips
// with their previews and Remove buttons, a send or a removal touching only its own session's list,
// which actions revoke a preview, a spawning instance's list, an encode landing in the session it was
// added to, leaving the session view (the composer unmounts), and a dictation landing in the session
// it was spoken to, joined to the box text with one space.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

type Attachment = { name: string; mediaType: string; dataBase64: string };
type Sent = { type: string; payload: { id?: string; text?: string; attachments?: Attachment[] } };
const sent: Sent[] = [];
vi.mock('@/lib/core/ws.js', () => ({
  bus: new EventTarget(),
  connect: () => {},
  send: (type: string, payload: Sent['payload']) => { sent.push({ type, payload }); },
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { emit } from '@/app/events';
import { voiceStore } from '@/features/voice/store';
import type { Instance } from '@/state/types';
import { Composer } from './Composer';
import { DRAFT_KEY_PREFIX, DRAFT_SAVE_DEBOUNCE_MS } from './drafts';

// Each test uses session ids no other test uses: pending lists and drafts live at module scope and
// outlive a test's unmount. A test that gives a spawning instance (no session id) a list ends by
// showing a session, which drops that list.
const inst = (sessionId: string | null, extra: Partial<Instance> = {}): Instance =>
  ({ id: `i-${sessionId}`, project: 'demo', status: 'idle', sessionId, mode: 'x', ...extra });
const spawning = (id: string): Instance => inst(null, { id, status: 'spawning' });

function mount(first: Instance, { strict = false } = {}) {
  const tree = (i: Instance) => <TooltipProvider><Composer inst={i} /></TooltipProvider>;
  const wrap = (i: Instance) => (strict ? <StrictMode>{tree(i)}</StrictMode> : tree(i));
  const view = render(wrap(first));
  return { unmount: view.unmount, swap: (next: Instance) => view.rerender(wrap(next)) };
}

// ── Fakes: recording, a held transcription, previews ──────────────────────
class FakeRecorder extends EventTarget {
  mimeType = 'audio/webm';
  start() {}
  stop() {
    this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(['x'], { type: 'audio/webm' }) }));
    this.dispatchEvent(new Event('stop'));
  }
}
let transcript = 'spoken';
/** Lets the held transcription answer. */
let releaseTranscript: () => void = () => {};
let revoke: MockInstance<(url: string) => void>;

beforeEach(() => {
  sent.length = 0;
  localStorage.clear();
  transcript = 'spoken';
  voiceStore.set({ supported: true, micAvailable: true });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
  const held = new Promise<void>((resolve) => { releaseTranscript = resolve; });
  vi.stubGlobal('fetch', vi.fn(async () => { await held; return { ok: true, json: async () => ({ text: transcript }) }; }));
  let n = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:preview-${++n}`);
  revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── Reading and driving the composer ─────────────────────────────────────
const box = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
const sendButton = () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
const micButton = () => screen.getByRole('button', { name: /^(Dictate|Stop recording)$/ }) as HTMLButtonElement;
const type = (value: string) => fireEvent.change(box(), { target: { value } });
/** The chips showing, as their Remove buttons' accessible names, in order. */
const chips = () => screen.queryAllByRole('button', { name: /^Remove / }).map((b) => b.getAttribute('aria-label'));
/** The preview images showing, as [alt, src]. */
const previews = () => screen.queryAllByRole('img').map((i) => [i.getAttribute('alt'), i.getAttribute('src')]);
/** Every URL revoked so far, in order. */
const revoked = () => revoke.mock.calls.map(([url]) => url);
const sentAttachments = (i: number) => sent[i].payload.attachments?.map((a) => [a.name, a.dataBase64]);
const storedDraft = (sid: string) => {
  const raw = localStorage.getItem(DRAFT_KEY_PREFIX + sid);
  if (raw === null) return null;
  const { text, transcribed } = JSON.parse(raw) as { text: string; transcribed: boolean };
  return { text, transcribed };
};

/** Chooses files through the Attach files picker's input. */
function attach(files: File[]) {
  const input = document.querySelector('[data-composer] input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  fireEvent.change(input);
}
const png = (name: string, body = name) => new File([body], name, { type: 'image/png' });
const txt = (name: string) => new File([name], name, { type: 'text/plain' });
/** A file past the per-file size cap: refused inline, never encoded. */
function tooLarge(name: string) {
  const file = new File(['x'], name, { type: 'application/octet-stream' });
  Object.defineProperty(file, 'size', { value: 11 * 1024 * 1024 });
  return file;
}
/** An image whose encode waits until `open()`. */
function heldImage(name: string, body: string) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const file = png(name, body);
  Object.defineProperty(file, 'arrayBuffer', { value: async () => { await gate; return new TextEncoder().encode(body).buffer; } });
  return { file, open };
}
/** Lets encodes and React updates land (real timers). */
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
/** Lets the recorder → transcription → delivery chain land; it runs on microtasks, so timers may be fake. */
const flushMicrotasks = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
/** Taps the mic to record, then again to stop: the transcription is held until `releaseTranscript()`. */
async function recordAndStop() {
  await act(async () => { fireEvent.click(micButton()); });
  await act(async () => { fireEvent.click(micButton()); });
}

describe('per-session lists', () => {
  it("a switch shows the other session's list, and switching back restores this one with its previews and working Remove buttons", async () => {
    const c = mount(inst('per-a'));
    attach([png('a1.png')]);
    attach([tooLarge('huge.bin')]);
    await settle();
    expect(previews(), 'positive control: A shows its preview').toEqual([['a1.png', 'blob:preview-1']]);
    c.swap(inst('per-b'));
    expect(chips(), "B does not show A's chips").toEqual([]);
    expect(screen.queryByRole('button', { name: 'Send' }), 'B has nothing to send').toBeNull();
    attach([txt('b1.txt')]);
    await settle();
    c.swap(inst('per-a'));
    expect(chips(), "A's list is back, the refused file included").toEqual(['Remove a1.png', 'Remove huge.bin']);
    expect(previews(), 'with its preview').toEqual([['a1.png', 'blob:preview-1']]);
    expect(sendButton().disabled, 'an attachment alone is sendable').toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Remove a1.png' }));
    expect(chips(), 'a restored Remove button works').toEqual(['Remove huge.bin']);
    c.swap(inst('per-b'));
    expect(chips(), "B's list is intact").toEqual(['Remove b1.txt']);
  });

  it("a send ships only the showing session's attachments and clears only its list", async () => {
    const c = mount(inst('send-a'));
    attach([png('a1.png', 'A1')]);
    await settle();
    c.swap(inst('send-b'));
    attach([png('b1.png', 'B1')]);
    await settle();
    type('hi');
    fireEvent.click(sendButton());
    expect(sent.map((s) => s.payload)).toEqual([{ id: 'i-send-b', text: 'hi', attachments: [{ name: 'b1.png', mediaType: 'image/png', dataBase64: btoa('B1') }] }]);
    expect(chips(), "B's list is cleared").toEqual([]);
    c.swap(inst('send-a'));
    expect(chips(), "A's chip survived B's send").toEqual(['Remove a1.png']);
    fireEvent.click(sendButton());
    expect(sent[1].payload).toEqual({ id: 'i-send-a', text: '', attachments: [{ name: 'a1.png', mediaType: 'image/png', dataBase64: btoa('A1') }] });
  });

  it("removing a chip in one session leaves the other session's list and previews alone", async () => {
    const c = mount(inst('rm-a'));
    attach([png('a1.png'), png('a2.png')]);
    await settle();
    c.swap(inst('rm-b'));
    attach([png('b1.png'), png('b2.png')]);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Remove b2.png' }));
    expect(revoked(), "only B's removed preview is revoked").toEqual(['blob:preview-4']);
    expect(chips()).toEqual(['Remove b1.png']);
    c.swap(inst('rm-a'));
    expect(previews(), 'A keeps both chips and previews').toEqual([['a1.png', 'blob:preview-1'], ['a2.png', 'blob:preview-2']]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove a1.png' }));
    expect(revoked(), "only A's removed preview is revoked").toEqual(['blob:preview-4', 'blob:preview-1']);
    expect(chips()).toEqual(['Remove a2.png']);
    c.swap(inst('rm-b'));
    expect(previews(), "B's remaining chip and preview are intact").toEqual([['b1.png', 'blob:preview-3']]);
  });

  it('a re-render of the session already showing keeps its attachments and revokes nothing', async () => {
    const c = mount(inst('same-a'), { strict: true });
    attach([png('a1.png')]);
    await settle();
    c.swap(inst('same-a', { id: 'i-same-a-resumed' }));
    expect(chips()).toEqual(['Remove a1.png']);
    expect(previews()).toEqual([['a1.png', 'blob:preview-1']]);
    expect(revoked()).toEqual([]);
  });

  it('restoring a list writes nothing to the text draft and leaves focus where it was', async () => {
    const c = mount(inst('restore-a'));
    attach([png('a1.png')]);
    await settle();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    type('kept text');
    c.swap(inst('restore-b'));
    expect(storedDraft('restore-a'), 'positive control: leaving A stored its text').toEqual({ text: 'kept text', transcribed: false });
    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    const writes = vi.spyOn(localStorage, 'setItem');
    const removals = vi.spyOn(localStorage, 'removeItem');
    c.swap(inst('restore-a'));
    expect(chips(), 'positive control: the list is back').toEqual(['Remove a1.png']);
    expect(box().value).toBe('kept text');
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS * 2);
    const touched = [...writes.mock.calls, ...removals.mock.calls].filter(([key]) => key === DRAFT_KEY_PREFIX + 'restore-a');
    expect(touched, "nothing writes or removes A's draft").toEqual([]);
    expect(document.activeElement === elsewhere, 'focus stays where it was').toBe(true);
    elsewhere.remove();
  });
});

describe('previews', () => {
  it('a switch never revokes a preview; a send revokes exactly the sent previews, and a prefill the showing ones', async () => {
    const c = mount(inst('rev-a'));
    attach([png('a1.png'), txt('a2.txt')]);
    await settle();
    c.swap(inst('rev-b'));
    attach([png('b1.png'), png('b2.png')]);
    await settle();
    c.swap(inst('rev-a'));
    c.swap(inst('rev-b'));
    expect(revoked(), 'no switch revoked a preview').toEqual([]);
    expect(previews(), 'positive control: B shows its previews').toEqual([['b1.png', 'blob:preview-2'], ['b2.png', 'blob:preview-3']]);
    fireEvent.click(sendButton());
    expect(revoked(), "the send revoked B's previews, and only those").toEqual(['blob:preview-2', 'blob:preview-3']);
    c.swap(inst('rev-a'));
    expect(previews(), "A's preview is still live").toEqual([['a1.png', 'blob:preview-1']]);
    act(() => emit('prefill', { text: 'rewound' }));
    expect(revoked(), "the prefill revoked A's preview").toEqual(['blob:preview-2', 'blob:preview-3', 'blob:preview-1']);
    expect(chips()).toEqual([]);
  });

  it("a spawning instance's list is dropped, its previews revoked once, when a session shows, and does not come back", async () => {
    const c = mount(spawning('i-drop'));
    attach([png('early.png')]);
    await settle();
    expect(chips(), 'positive control: the spawning instance took the file').toEqual(['Remove early.png']);
    c.swap(inst('drop-a'));
    expect(chips(), 'the list is not handed to the session').toEqual([]);
    expect(revoked()).toEqual(['blob:preview-1']);
    c.swap(inst('drop-b'));
    c.swap(inst('drop-a'));
    c.swap(spawning('i-drop'));
    expect(chips(), 'and it does not come back').toEqual([]);
    expect(revoked(), 'revoked once').toEqual(['blob:preview-1']);
  });

  it('a prefill revokes and clears the list of the session showing now, and leaves the session the composer mounted on alone', async () => {
    const c = mount(inst('pre-mount'));
    attach([png('m1.png')]);
    await settle();
    c.swap(inst('pre-shown'));
    attach([png('s1.png'), txt('s2.txt')]);
    await settle();
    expect(chips(), 'positive control: the session showing now has its own list').toEqual(['Remove s1.png', 'Remove s2.txt']);
    act(() => emit('prefill', { text: 'rewound' }));
    expect(chips(), "the prefill cleared the showing session's list").toEqual([]);
    expect(revoked(), "only the showing session's preview is revoked").toEqual(['blob:preview-2']);
    c.swap(inst('pre-mount'));
    expect(previews(), "the mount session's chip and preview are intact").toEqual([['m1.png', 'blob:preview-1']]);
    expect(revoked(), 'and nothing more is revoked').toEqual(['blob:preview-2']);
  });
});

describe('encodes', () => {
  it('a multi-file add still encoding when the user switches finishes into its own session', async () => {
    const one = heldImage('one.png', 'ONE');
    const two = heldImage('two.png', 'TWO');
    const c = mount(inst('enc-a'));
    attach([one.file, two.file]);
    await settle();
    one.open();
    await settle();
    c.swap(inst('enc-b'));
    two.open();
    await settle();
    expect(chips(), 'the second file does not land in B').toEqual([]);
    type('for B');
    fireEvent.click(sendButton());
    expect(sent[0].payload, 'B sends no attachments').toEqual({ id: 'i-enc-b', text: 'for B' });
    c.swap(inst('enc-a'));
    expect(chips()).toEqual(['Remove one.png', 'Remove two.png']);
    fireEvent.click(sendButton());
    expect(sentAttachments(1), 'A ships both files, each encoded').toEqual([['one.png', btoa('ONE')], ['two.png', btoa('TWO')]]);
  });

  it('a file that cannot be read shows the failure on its chip, is nothing to send, and is never shipped', async () => {
    const unreadable = png('bad.png');
    Object.defineProperty(unreadable, 'arrayBuffer', { value: async () => { throw new Error('disk gone'); } });
    mount(inst('enc-fail'));
    attach([unreadable]);
    await settle();
    expect(chips(), 'positive control: the file shows as a chip').toEqual(['Remove bad.png']);
    const chipText = screen.getByRole('button', { name: 'Remove bad.png' }).parentElement!.textContent ?? '';
    expect(chipText, 'the chip names its file').toContain('bad.png');
    expect(chipText, 'the chip names the read failure').toMatch(/read failed/i);
    expect(chipText, 'the chip carries the reason').toContain('disk gone');
    expect(screen.queryByRole('button', { name: 'Send' }), 'a failed file alone is nothing to send').toBeNull();
    attach([png('good.png', 'GOOD')]);
    await settle();
    fireEvent.click(sendButton());
    expect(sentAttachments(0), 'only the readable file is shipped').toEqual([['good.png', btoa('GOOD')]]);
  });
});

describe('leaving the session view (the composer unmounts)', () => {
  it("keeps the showing session's attachments and previews, revokes nothing, and a send then ships and revokes them", async () => {
    const first = mount(inst('leave-a'));
    attach([png('keep.png', 'KEEP'), txt('keep-notes.txt')]);
    await settle();
    first.swap(inst('leave-b'));
    first.swap(inst('leave-a'));
    expect(chips(), 'positive control: a switch away and back keeps them').toEqual(['Remove keep.png', 'Remove keep-notes.txt']);
    first.unmount();
    expect(revoked(), 'leaving the session view revokes no preview').toEqual([]);
    mount(inst('leave-a'));
    expect(chips(), 'the chips are back after leaving the session view').toEqual(['Remove keep.png', 'Remove keep-notes.txt']);
    expect(previews(), 'with the same preview').toEqual([['keep.png', 'blob:preview-1']]);
    fireEvent.click(sendButton());
    expect(sentAttachments(0)).toEqual([['keep.png', btoa('KEEP')], ['keep-notes.txt', btoa('keep-notes.txt')]]);
    expect(revoked(), 'the send revokes the kept preview, once').toEqual(['blob:preview-1']);
  });

  it("keeps a spawning instance's attachments until a session shows, then drops them and revokes their previews", async () => {
    const first = mount(spawning('i-leave-spawn'));
    attach([png('early.png')]);
    await settle();
    expect(chips(), 'positive control: the spawning instance took the file').toEqual(['Remove early.png']);
    first.unmount();
    const again = mount(spawning('i-leave-spawn'));
    expect(chips(), "the spawning instance's chip is back after leaving the session view").toEqual(['Remove early.png']);
    expect(revoked(), 'nothing is revoked while it is kept').toEqual([]);
    again.swap(inst('leave-spawned', { id: 'i-leave-spawn' }));
    expect(chips(), 'the list is not handed to the session').toEqual([]);
    expect(revoked(), 'its preview is revoked once').toEqual(['blob:preview-1']);
  });

  it('an encode still running when the composer unmounts lands in its own session', async () => {
    const one = heldImage('one.png', 'ONE');
    const two = heldImage('two.png', 'TWO');
    const first = mount(inst('leave-enc'));
    attach([one.file, two.file]);
    await settle();
    one.open();
    await settle();
    expect(chips(), 'positive control: both chips show').toEqual(['Remove one.png', 'Remove two.png']);
    first.unmount();
    two.open();
    await settle();
    mount(inst('leave-enc'));
    expect(chips(), 'both chips are back after leaving the session view').toEqual(['Remove one.png', 'Remove two.png']);
    fireEvent.click(sendButton());
    expect(sentAttachments(0), 'both files are encoded').toEqual([['one.png', btoa('ONE')], ['two.png', btoa('TWO')]]);
  });
});

describe('dictation delivery', () => {
  it('a recording started in A and stopped from B lands in A, never in B', async () => {
    const c = mount(inst('rec-a'));
    await act(async () => { fireEvent.click(micButton()); });
    c.swap(inst('rec-b'));
    expect(micButton().getAttribute('aria-label'), 'positive control: the recording runs on in B').toBe('Stop recording');
    await act(async () => { fireEvent.click(micButton()); });
    releaseTranscript();
    await settle();
    expect(box().value, "B's box stays empty").toBe('');
    expect(storedDraft('rec-b'), 'B has no draft').toBeNull();
    expect(storedDraft('rec-a'), "the words are A's draft, flagged as dictated").toEqual({ text: 'spoken', transcribed: true });
    c.swap(inst('rec-a'));
    expect(box().value).toBe('spoken');
    fireEvent.click(sendButton());
    expect(sent.map((s) => s.payload.text)).toEqual(['<transcribed>\nspoken']);
  });

  it("a transcript landing after a switch to B joins A's typed text and the words with one space in A's draft", async () => {
    const c = mount(inst('join-away-a'));
    await recordAndStop();
    type('earlier');
    c.swap(inst('join-away-b'));
    expect(storedDraft('join-away-a'), 'positive control: leaving A stored its text').toEqual({ text: 'earlier', transcribed: false });
    releaseTranscript();
    await settle();
    expect(storedDraft('join-away-a'), "A's draft is its text and the words, one space apart, flagged as dictated").toEqual({ text: 'earlier spoken', transcribed: true });
    expect(box().value, "B's box stays empty").toBe('');
    expect(storedDraft('join-away-b'), 'B has no draft').toBeNull();
    c.swap(inst('join-away-a'));
    expect(box().value).toBe('earlier spoken');
  });

  it('back in the starting session before the transcript lands, it goes into the box once, not into the stored draft', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const c = mount(inst('back-a'));
    await recordAndStop();
    type('earlier');
    c.swap(inst('back-b'));
    c.swap(inst('back-a'));
    expect(box().value, 'positive control: A shows its draft again').toBe('earlier');
    const writes = vi.spyOn(localStorage, 'setItem');
    releaseTranscript();
    await flushMicrotasks();
    expect(box().value, 'joined into the box once').toBe('earlier spoken');
    expect(writes.mock.calls.filter(([key]) => key === DRAFT_KEY_PREFIX + 'back-a'), 'the delivery does not write the draft directly').toEqual([]);
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);
    expect(storedDraft('back-a'), "the box's debounced save stores it, flagged").toEqual({ text: 'earlier spoken', transcribed: true });
    fireEvent.click(sendButton());
    expect(sent.map((s) => s.payload.text)).toEqual(['<transcribed>\nearlier spoken']);
  });

  it('a dictation started while the instance has no session id lands in the box once the id arrives', async () => {
    const c = mount(spawning('i-rec-spawn'));
    await recordAndStop();
    c.swap(inst('rec-spawned', { id: 'i-rec-spawn' }));
    releaseTranscript();
    await settle();
    expect(box().value).toBe('spoken');
    fireEvent.click(sendButton());
    expect(sent.map((s) => s.payload.text)).toEqual(['<transcribed>\nspoken']);
  });
});

describe('a dictation joins the box text with exactly one space', () => {
  it('after a word', async () => {
    mount(inst('join-word'));
    await recordAndStop();
    type('hello');
    expect(box().selectionStart, 'positive control: the caret is at the end').toBe(5);
    releaseTranscript();
    await settle();
    expect(box().value).toBe('hello spoken');
  });

  it('after a trailing space', async () => {
    mount(inst('join-space'));
    await recordAndStop();
    type('hello ');
    expect(box().selectionStart, 'positive control: the caret is at the end').toBe(6);
    releaseTranscript();
    await settle();
    expect(box().value).toBe('hello spoken');
  });

  it('when the transcript itself starts with a space', async () => {
    transcript = ' spoken';
    mount(inst('join-lead'));
    await recordAndStop();
    type('hello');
    releaseTranscript();
    await settle();
    expect(box().value).toBe('hello spoken');
  });
});
