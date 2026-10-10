import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const sent: [string, any][] = [];
vi.mock('@/lib/core/ws.js', () => ({ bus: new EventTarget(), connect: () => {}, send: (t: string, p: any) => { sent.push([t, p]); } }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { voiceStore } from '@/features/voice/store';
import { emit } from '@/app/events';
import { stickyPrompt } from '@/app/controller';
import type { Instance } from '@/state/types';
import { Composer } from './Composer';
import { createDraftStore, DRAFT_KEY_PREFIX, draftStore, joinDictation, prependTranscribedTag } from './drafts';
import { focusPromptAfterSelect } from '@/features/session/promptFocus';

const inst = (sessionId: string | null, extra: Partial<Instance> = {}): Instance => ({ id: `i-${sessionId}`, project: 'demo', status: 'idle', sessionId, mode: 'x', ...extra });

// ── Fakes: recording, transcription, previews ───────────────────────────
let transcript = 'dictated words';
let transcribeGate: Promise<void> = Promise.resolve();
class FakeRecorder extends EventTarget {
  mimeType = 'audio/webm';
  start() {}
  stop() {
    this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(['x'], { type: 'audio/webm' }) }));
    this.dispatchEvent(new Event('stop'));
  }
}
const revoked: string[] = [];
beforeEach(() => {
  sent.length = 0;
  revoked.length = 0;
  transcript = 'dictated words';
  transcribeGate = Promise.resolve();
  localStorage.clear();
  voiceStore.set({ supported: true, micAvailable: true });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
  let n = 0;
  URL.createObjectURL = () => `blob:preview-${++n}`;
  URL.revokeObjectURL = (u: string) => { revoked.push(u); };
  vi.stubGlobal('fetch', vi.fn(async () => { await transcribeGate; return { ok: true, json: async () => ({ text: transcript }) }; }));
});
afterEach(() => vi.useRealTimers());

function mount(i: Instance | null) {
  const r = render(<TooltipProvider><Composer inst={i} /></TooltipProvider>);
  return {
    ...r,
    box: () => screen.getByLabelText('Message') as HTMLTextAreaElement,
    button: () => (screen.queryByRole('button', { name: /^(Send|Dictate|Stop recording|Queue message)$/ }) as HTMLButtonElement),
    swap: (next: Instance | null) => r.rerender(<TooltipProvider><Composer inst={next} /></TooltipProvider>),
  };
}
const type = (box: HTMLTextAreaElement, v: string) => fireEvent.change(box, { target: { value: v } });
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });

async function addFile(container: HTMLElement, name: string, type = 'image/png') {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['abc'], name, { type });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  fireEvent.change(input);
  await settle();
}

describe('send and mic modes', () => {
  it('an empty box is a mic (disabled without whisper); typing flips to Send; clearing flips back', () => {
    voiceStore.set({ micAvailable: false });
    const c = mount(inst('s1'));
    expect(c.button().getAttribute('aria-label')).toBe('Dictate');
    expect(c.button().disabled).toBe(true);
    act(() => voiceStore.set({ micAvailable: true }));
    expect(c.button().disabled).toBe(false);
    type(c.box(), 'hi');
    expect(c.button().getAttribute('aria-label')).toBe('Send');
    type(c.box(), '');
    expect(c.button().getAttribute('aria-label')).toBe('Dictate');
  });

  it('Send submits the typed message and clears the box; Enter sends, Shift+Enter does not', () => {
    const c = mount(inst('s1'));
    type(c.box(), 'hello');
    fireEvent.click(c.button());
    expect(sent).toEqual([['prompt', { id: 'i-s1', text: 'hello' }]]);
    expect(c.box().value).toBe('');
    type(c.box(), 'two');
    fireEvent.keyDown(c.box(), { key: 'Enter', shiftKey: true });
    expect(sent).toHaveLength(1);
    fireEvent.keyDown(c.box(), { key: 'Enter' });
    expect(sent.at(-1)).toEqual(['prompt', { id: 'i-s1', text: 'two' }]);
  });

  it('tap the mic to record, tap again to transcribe; the text is inserted and sent with the transcribed tag', async () => {
    const c = mount(inst('s1'));
    await act(async () => { fireEvent.click(c.button()); });
    expect(c.button().getAttribute('aria-label')).toBe('Stop recording');
    await act(async () => { fireEvent.click(c.button()); });
    await waitFor(() => expect(c.box().value).toBe('dictated words'));
    fireEvent.click(c.button());
    expect(sent).toEqual([['prompt', { id: 'i-s1', text: '<transcribed>\ndictated words' }]]);
    type(c.box(), 'typed only');
    fireEvent.click(c.button());
    expect(sent.at(-1)![1].text).toBe('typed only');
  });

  it('a dictation into a non-empty box inserts exactly one separating space', async () => {
    const c = mount(inst('s1'));
    type(c.box(), 'before');
    act(() => voiceStore.set({ micAvailable: true }));
    // Content present: the button is Send, so dictate with the hold gesture's code path via the mic in an empty box instead.
    expect(joinDictation('before', 'after')).toBe('before after');
    expect(joinDictation('before ', 'after')).toBe('before after');
    expect(joinDictation('', 'after')).toBe('after');
    expect(c.box().value).toBe('before');
  });

  it('a dead or switching session cannot send', () => {
    const c = mount(inst('s1', { status: 'exited' }));
    expect(c.box().disabled).toBe(true);
    c.swap(inst('s1', { modelSwitch: { from: 'a', to: 'b' } }));
    type(c.box(), 'x');
    expect(c.button().disabled).toBe(true);
  });

  it('overage: paused sessions queue; an unarmed stop cannot send', () => {
    const c = mount(inst('s1', { autoResumeAt: 2_000_000_000 }));
    type(c.box(), 'later please');
    expect(c.button().getAttribute('aria-label')).toBe('Queue message');
    expect(c.container.textContent).toMatch(/New messages are queued/);
    c.swap(inst('s1', { overageStoppedUnarmed: true }));
    expect(c.button().disabled).toBe(true);
    expect(c.container.textContent).toMatch(/can't be queued here/);
  });
});

describe('drafts', () => {
  it('a draft is per session, restores byte-exact, and the button follows it', async () => {
    vi.useFakeTimers();
    const c = mount(inst('s1'));
    type(c.box(), '  spaced\ntext  ');
    c.swap(inst('s2'));
    expect(c.box().value).toBe('');
    c.swap(inst('s1'));
    expect(c.box().value).toBe('  spaced\ntext  ');
    expect(c.button().getAttribute('aria-label')).toBe('Send');
  });

  it('saves are debounced; switching away saves at once; no session empties the box', () => {
    vi.useFakeTimers();
    const c = mount(inst('s1'));
    type(c.box(), 'draft');
    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}s1`)).toBeNull();
    vi.advanceTimersByTime(500);
    expect(JSON.parse(localStorage.getItem(`${DRAFT_KEY_PREFIX}s1`)!).text).toBe('draft');
    type(c.box(), 'draft 2');
    c.swap(null);
    expect(JSON.parse(localStorage.getItem(`${DRAFT_KEY_PREFIX}s1`)!).text).toBe('draft 2');
    expect(c.box().value).toBe('');
  });

  it('pagehide and a hidden tab flush the pending text', () => {
    vi.useFakeTimers();
    const c = mount(inst('s7'));
    type(c.box(), 'flush me');
    dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(localStorage.getItem(`${DRAFT_KEY_PREFIX}s7`)!).text).toBe('flush me');
  });

  it('sending clears the stored draft and a pending save cannot bring it back', () => {
    vi.useFakeTimers();
    const c = mount(inst('s3'));
    type(c.box(), 'gone soon');
    fireEvent.click(c.button());
    vi.advanceTimersByTime(1000);
    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}s3`)).toBeNull();
  });

  it('a stored draft (with its transcribed flag) is restored on load and reaches the sent text', () => {
    localStorage.setItem(`${DRAFT_KEY_PREFIX}s4`, JSON.stringify({ text: 'spoken', transcribed: true, savedAt: Date.now() }));
    draftStore.clear('nothing');
    const fresh = createDraftStore();
    expect(fresh.load('s4')).toEqual({ text: 'spoken', transcribed: true });
  });

  it('prefill (rewind / fork) replaces the box and attachments and focuses the end', async () => {
    const c = mount(inst('s5'));
    await addFile(c.container, 'a.png');
    await act(async () => { emit('prefill', { text: 'resend me' }); await new Promise((r) => requestAnimationFrame(() => r(null))); });
    expect(c.box().value).toBe('resend me');
    expect(c.container.textContent).not.toContain('a.png');
    expect(revoked).toContain('blob:preview-1');
  });

  it('prune drops expired and malformed draft keys and nothing else; a throwing storage keeps drafts in memory', () => {
    const now = 1_000_000_000_000;
    const store: Record<string, string> = {
      [`${DRAFT_KEY_PREFIX}fresh`]: JSON.stringify({ text: 'a', savedAt: now - 1000 }),
      [`${DRAFT_KEY_PREFIX}old`]: JSON.stringify({ text: 'b', savedAt: now - 40 * 86_400_000 }),
      [`${DRAFT_KEY_PREFIX}bad`]: 'not json',
      other: 'keep',
    };
    const storage = {
      get length() { return Object.keys(store).length; },
      key: (i: number) => Object.keys(store)[i] ?? null,
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    } as unknown as Storage;
    createDraftStore({ storage, now: () => now }).prune();
    expect(Object.keys(store).sort()).toEqual([`${DRAFT_KEY_PREFIX}fresh`, 'other'].sort());
    const throwing = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } } as unknown as Storage;
    const mem = createDraftStore({ storage: throwing });
    mem.save('s', { text: 'kept', transcribed: false });
    expect(mem.load('s')).toEqual({ text: 'kept', transcribed: false });
  });

  it('the transcribed tag applies only to dictated, non-empty text', () => {
    expect(prependTranscribedTag('hi', true)).toBe('<transcribed>\nhi');
    expect(prependTranscribedTag('hi', false)).toBe('hi');
    expect(prependTranscribedTag('', true)).toBe('');
  });
});

describe('attachments', () => {
  it('are per session: switching away hides them, back restores them; send ships only the showing session\'s', async () => {
    const c = mount(inst('s1'));
    await addFile(c.container, 'one.png');
    expect(c.container.textContent).toContain('one.png');
    c.swap(inst('s2'));
    expect(c.container.textContent).not.toContain('one.png');
    expect(revoked).toEqual([]);
    await addFile(c.container, 'two.txt', 'text/plain');
    fireEvent.click(c.button());
    expect(sent.at(-1)![1].attachments.map((a: any) => a.name)).toEqual(['two.txt']);
    c.swap(inst('s1'));
    expect(c.container.textContent).toContain('one.png');
  });

  it('removing a chip in one session leaves the other\'s; a list dropped at a null-session switch is revoked', async () => {
    const c = mount(inst('s1'));
    await addFile(c.container, 'keep.png');
    c.swap(inst('s2'));
    await addFile(c.container, 'drop.png');
    fireEvent.click(screen.getByRole('button', { name: 'Remove drop.png' }));
    c.swap(inst('s1'));
    expect(c.container.textContent).toContain('keep.png');
    const d = mount(null);
    await addFile(d.container, 'orphan.png');
    d.swap(inst('s9'));
    expect(revoked.length).toBeGreaterThan(0);
  });

  it('a too-large file is refused inline and not sent', async () => {
    const c = mount(inst('s1'));
    const input = c.container.querySelector('input[type="file"]') as HTMLInputElement;
    const big = new File(['x'], 'huge.bin');
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    Object.defineProperty(input, 'files', { configurable: true, value: [big] });
    fireEvent.change(input);
    await settle();
    expect(c.container.textContent).toMatch(/huge\.bin · too large/);
    type(c.box(), 'x');
    fireEvent.click(c.button());
    expect(sent.at(-1)![1].attachments).toBeUndefined();
  });
});

describe('dictation routing', () => {
  // Session ids no other test uses: a draft typed and not sent is saved by a
  // debounce timer (DRAFT_SAVE_DEBOUNCE_MS) that outlives its composer, and the
  // draft store's in-memory mirror survives localStorage.clear(), so a shared
  // id could carry an earlier test's text into this one at any moment.
  it('a dictation is delivered to the session it was started in, never the one showing', async () => {
    let release!: () => void;
    transcribeGate = new Promise((r) => { release = r; });
    const c = mount(inst('dictation-from'));
    await act(async () => { fireEvent.click(c.button()); });
    await act(async () => { fireEvent.click(c.button()); });
    c.swap(inst('dictation-to'));
    release();
    await waitFor(() => expect(draftStore.load('dictation-from')).toEqual({ text: 'dictated words', transcribed: true }));
    expect(c.box().value).toBe('');
  });
});

describe('prompt focus after a selection', () => {
  const setup = () => {
    document.body.innerHTML = '<textarea id="p"></textarea><input id="other" /><input id="cb" type="checkbox" /><div id="ce" contenteditable="true"></div>';
    const p = document.getElementById('p') as HTMLTextAreaElement;
    const win = { matchMedia: () => ({ matches: false }) } as unknown as Window & typeof globalThis;
    return { p, win };
  };

  it('only a real user gesture focuses an enabled prompt', () => {
    const { p, win } = setup();
    focusPromptAfterSelect(undefined, p, { win });
    focusPromptAfterSelect(false, p, { win });
    focusPromptAfterSelect('yes', p, { win });
    expect(document.activeElement).not.toBe(p);
    p.disabled = true;
    focusPromptAfterSelect(true, p, { win });
    expect(document.activeElement).not.toBe(p);
    p.disabled = false;
    focusPromptAfterSelect(true, p, { win });
    expect(document.activeElement).toBe(p);
  });

  it('an open dialog, typing elsewhere, or a touch device keeps focus where it is; a checkbox or button does not block', () => {
    const { p, win } = setup();
    const dlg = document.createElement('div');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('data-state', 'open');
    document.body.appendChild(dlg);
    focusPromptAfterSelect(true, p, { win });
    expect(document.activeElement).not.toBe(p);
    dlg.setAttribute('data-state', 'closed');
    for (const id of ['other', 'ce']) {
      (document.getElementById(id) as HTMLElement).focus();
      focusPromptAfterSelect(true, p, { win });
      expect(document.activeElement).not.toBe(p);
    }
    (document.getElementById('cb') as HTMLElement).focus();
    focusPromptAfterSelect(true, p, { win });
    expect(document.activeElement).toBe(p);
    (document.getElementById('other') as HTMLElement).focus();
    const touch = { matchMedia: () => ({ matches: true }) } as unknown as Window & typeof globalThis;
    (document.getElementById('cb') as HTMLElement).focus();
    focusPromptAfterSelect(true, p, { win: touch });
    expect(document.activeElement).not.toBe(p);
  });
});

describe('sticky prompt keys', () => {
  let reveal: ReturnType<typeof vi.spyOn>;
  let conceal: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    reveal = vi.spyOn(stickyPrompt, 'reveal').mockImplementation(() => {});
    conceal = vi.spyOn(stickyPrompt, 'conceal').mockImplementation(() => {});
  });
  afterEach(() => {
    reveal.mockRestore();
    conceal.mockRestore();
  });
  const press = (box: HTMLTextAreaElement, key: string, at: [number, number], init: object = {}) => {
    box.setSelectionRange(at[0], at[1]);
    return fireEvent.keyDown(box, { key, ...init });
  };

  it('Down reveals the pinned prompt only with the caret at the very end of the text', () => {
    const c = mount(inst('s1'));
    type(c.box(), 'hello');
    press(c.box(), 'ArrowDown', [5, 5]);
    expect(reveal).toHaveBeenCalledTimes(1);
    press(c.box(), 'ArrowDown', [4, 4]);
    expect(reveal).toHaveBeenCalledTimes(1);
    press(c.box(), 'ArrowDown', [0, 0]);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it('Up conceals it only with the caret at the very start of the text', () => {
    const c = mount(inst('s1'));
    type(c.box(), 'hello');
    press(c.box(), 'ArrowUp', [0, 0]);
    expect(conceal).toHaveBeenCalledTimes(1);
    press(c.box(), 'ArrowUp', [1, 1]);
    expect(conceal).toHaveBeenCalledTimes(1);
    press(c.box(), 'ArrowUp', [5, 5]);
    expect(conceal).toHaveBeenCalledTimes(1);
  });

  it('an empty box satisfies both caret rules', () => {
    const c = mount(inst('s1'));
    type(c.box(), '');
    press(c.box(), 'ArrowDown', [0, 0]);
    expect(reveal).toHaveBeenCalledTimes(1);
    press(c.box(), 'ArrowUp', [0, 0]);
    expect(conceal).toHaveBeenCalledTimes(1);
  });

  it('a modifier, a non-collapsed selection or IME composition makes Down and Up do nothing', () => {
    const c = mount(inst('s1'));
    type(c.box(), '');
    for (const flag of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey', 'isComposing']) {
      press(c.box(), 'ArrowDown', [0, 0], { [flag]: true });
      press(c.box(), 'ArrowUp', [0, 0], { [flag]: true });
    }
    type(c.box(), 'hello');
    press(c.box(), 'ArrowDown', [0, 5]);
    press(c.box(), 'ArrowUp', [0, 5]);
    expect(reveal).not.toHaveBeenCalled();
    expect(conceal).not.toHaveBeenCalled();
  });

  it('Down and Up are never prevented, whether or not they act', () => {
    const c = mount(inst('s1'));
    for (const [text, at] of [['', 0], ['hello', 5], ['hello', 0], ['hello', 2]] as const) {
      type(c.box(), text);
      for (const key of ['ArrowDown', 'ArrowUp']) expect(press(c.box(), key, [at, at]), `${key} in '${text}' at ${at}`).toBe(true);
    }
    expect(reveal.mock.calls.length + conceal.mock.calls.length).toBeGreaterThan(0);
  });
});
