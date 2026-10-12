import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const sent: [string, any][] = [];
vi.mock('@/lib/core/ws.js', () => ({ bus: new EventTarget(), connect: () => {}, send: (t: string, p: any) => { sent.push([t, p]); } }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { voiceStore } from '@/features/voice/store';
import type { Instance } from '@/state/types';
import { Composer } from './Composer';

const inst = (extra: Partial<Instance> = {}): Instance => ({ id: 'i-mode', project: 'demo', status: 'idle', sessionId: 'sess-mode', mode: 'x', ...extra });

class FakeRecorder extends EventTarget {
  mimeType = 'audio/webm';
  start() {}
  stop() {}
}
let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sent.length = 0;
  localStorage.clear();
  getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop() {} }] }));
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  URL.createObjectURL = () => 'blob:x';
  URL.revokeObjectURL = () => {};
});
afterEach(() => { vi.restoreAllMocks(); });

function mount(i: Instance) {
  const r = render(<TooltipProvider><Composer inst={i} /></TooltipProvider>);
  return { ...r, box: () => screen.getByLabelText('Message') as HTMLTextAreaElement };
}
const type = (box: HTMLTextAreaElement, v: string) => fireEvent.change(box, { target: { value: v } });
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const root = (c: HTMLElement) => c.querySelector('[data-composer]') as HTMLElement;
const dropOf = (files: File[]) => ({ dataTransfer: { files, types: ['Files'] } });

describe('composer mode follows the voice capability', () => {
  it('an empty composer is Send without the voice capability and Dictate with it', () => {
    // Invariant: the mic mode needs voiceStore.supported; without it an empty box stays a plain Send button.
    voiceStore.set({ supported: false, micAvailable: true });
    const c = mount(inst());
    expect(screen.queryByRole('button', { name: 'Dictate' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    expect(c.box().value).toBe('');
    act(() => voiceStore.set({ supported: true }));
    expect(screen.getByRole('button', { name: 'Dictate' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });
});

describe('a click in Send mode', () => {
  it('sends the typed text and never starts a recording', async () => {
    // Invariant: only the mic mode starts dictation; clicking Send with content submits and never touches the microphone.
    voiceStore.set({ supported: true, micAvailable: true });
    const c = mount(inst());
    type(c.box(), 'typed words');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    await settle();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Stop recording' })).toBeNull();
    expect(sent).toEqual([['prompt', { id: 'i-mode', text: 'typed words' }]]);
  });

  it('control: the same click on an empty composer (Dictate mode) does record', async () => {
    // Invariant: the microphone call is mode-driven, so the empty-box click is the contrast to the Send-mode click.
    voiceStore.set({ supported: true, micAvailable: true });
    mount(inst());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dictate' })); });
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Stop recording' })).toBeTruthy();
    expect(sent).toEqual([]);
    // A recording outlives its composer: cancel it, so the next test starts with none.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Dictate' })).toBeTruthy();
  });
});

describe('attaching files', () => {
  it('dropping files on the composer attaches them as removable chips', async () => {
    // Invariant: a Files drop on a typeable composer adds one chip per file, each removable by its own Remove button.
    voiceStore.set({ supported: true, micAvailable: true });
    const c = mount(inst());
    const a = new File(['aaa'], 'notes-a.txt', { type: 'text/plain' });
    const b = new File(['bbb'], 'notes-b.txt', { type: 'text/plain' });
    fireEvent.drop(root(c.container), dropOf([a, b]));
    await settle();
    expect(screen.getByRole('button', { name: 'Remove notes-a.txt' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove notes-b.txt' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove notes-a.txt' }));
    expect(screen.queryByRole('button', { name: 'Remove notes-a.txt' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove notes-b.txt' })).toBeTruthy();
    // the attachment alone makes the composer sendable
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0][1].attachments.map((x: any) => x.name)).toEqual(['notes-b.txt']);
  });

  it('control: a drop on a composer that cannot take input attaches nothing', async () => {
    // Invariant: the drop handler is gated on canType, so an exited session ignores dropped files.
    const c = mount(inst({ status: 'exited' }));
    fireEvent.drop(root(c.container), dropOf([new File(['z'], 'ignored.txt', { type: 'text/plain' })]));
    await settle();
    expect(screen.queryByRole('button', { name: 'Remove ignored.txt' })).toBeNull();
  });

  // Own session ids: pending attachments live at module scope and outlive the composer.
  it('pasting files into the message box attaches them as removable chips; pasting text attaches nothing', async () => {
    // Invariant: a paste carrying files on a typeable composer adds one chip per file; a text-only paste adds none.
    voiceStore.set({ supported: true, micAvailable: true });
    const c = mount(inst({ sessionId: 'sess-paste' }));
    fireEvent.paste(c.box(), { clipboardData: { files: [], types: ['text/plain'], getData: () => 'just words' } });
    await settle();
    expect(screen.queryAllByRole('button', { name: /^Remove / }), 'control: a text-only paste attaches nothing').toEqual([]);
    fireEvent.paste(c.box(), { clipboardData: { files: [new File(['pasted'], 'pasted.txt', { type: 'text/plain' })], types: ['Files'] } });
    await settle();
    expect(screen.queryByRole('button', { name: 'Remove pasted.txt' }), 'the pasted file is a chip').not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove pasted.txt' }));
    expect(screen.queryByRole('button', { name: 'Remove pasted.txt' })).toBeNull();
  });

  it('control: a paste on a composer that cannot take input attaches nothing', async () => {
    // Invariant: the paste handler is gated on canType, so an exited session ignores pasted files.
    const c = mount(inst({ sessionId: 'sess-paste-exited', status: 'exited' }));
    fireEvent.paste(c.box(), { clipboardData: { files: [new File(['z'], 'ignored-paste.txt', { type: 'text/plain' })], types: ['Files'] } });
    await settle();
    expect(screen.queryByRole('button', { name: 'Remove ignored-paste.txt' })).toBeNull();
  });

  it('the Attach files button opens the file picker; it is disabled when the session cannot take input', () => {
    // Invariant: the paperclip button clicks the hidden file input (the picker) and is inert for a dead session.
    const click = vi.spyOn(HTMLInputElement.prototype, 'click');
    const c = mount(inst());
    const input = c.container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.multiple).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }));
    expect(click.mock.contexts).toContain(input);
    c.unmount();
    click.mockClear();
    mount(inst({ status: 'crashed' }));
    const btn = screen.getByRole('button', { name: 'Attach files' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(click).not.toHaveBeenCalled();
  });
});
