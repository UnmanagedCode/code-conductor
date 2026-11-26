// The composer's context chip: shown live from the server's frames, removed by its ×, and consumed by
// the composer's own Send only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const sent: [string, any][] = [];
vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: (t: string, p: any) => { sent.push([t, p]); } }));

vi.mock('@/app/controller', async (orig) => ({ ...(await orig<typeof import('@/app/controller')>()), selectInstance: vi.fn() }));

import { bus } from '@shared/ws';
import { emit } from '@/app/events';
import { TooltipProvider } from '@/components/ui/tooltip';
import { routeFetch } from '@/test/routeFetch';
import { settle } from '@/test/settle';
import { fleet, seedWorkerFleet, type Fleet } from '@/test/workerFleet';
import { draftStore } from './drafts';
import { Composer } from './Composer';
import { contextChipStore, startContextChips } from './contextChipStore';

const frame = (type: string, detail: unknown) => act(() => { bus.dispatchEvent(new CustomEvent(type, { detail })); });
const chip = (rev: number, title = 'main.ts · 6 lines', data = 'const a = 1;\nconst b = 2;') => ({ title, data, rev });
const prompts = () => sent.filter(([t]) => t === 'prompt').map(([, p]) => p);
const box = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
const chipEl = () => document.querySelector('[data-context-chip]') as HTMLElement | null;
const sendBtn = () => screen.getByRole('button', { name: /^(Send|Queue|Tap to dictate)/ }) as HTMLButtonElement;

let f: Fleet;
let stop: () => void;
beforeEach(() => {
  sent.length = 0;
  localStorage.clear();
  contextChipStore.set({ chips: new Map() });
  f = fleet();
  seedWorkerFleet(f);
  stop = startContextChips();
  routeFetch({});
});
afterEach(() => { stop(); cleanup(); draftStore.clear('h-one'); vi.unstubAllGlobals(); });

function mount(inst: any) {
  return render(<TooltipProvider><Composer inst={inst} /></TooltipProvider>);
}

describe('the chip row', () => {
  // Invariant (3): the chip a `chip` frame names is shown with its title and a ×, a replacing frame
  // updates it, and `chip: null` removes it; hover or focus shows its data.
  it('a chip frame shows title and ×, a replacing frame updates it, chip:null removes it; focus shows the data', async () => {
    mount(f.h);
    expect(chipEl()).toBeNull();
    frame('chip', { t: 'chip', id: f.h.id, chip: chip(1, 'first', 'DATA-ONE') });
    expect(chipEl()!.textContent).toContain('first');
    expect(screen.getByRole('button', { name: 'Remove context first' })).toBeTruthy();
    fireEvent.focus(chipEl()!.querySelector('button')!);
    await settle();
    expect((await screen.findAllByText('DATA-ONE')).length).toBeGreaterThan(0);
    frame('chip', { t: 'chip', id: f.h.id, chip: chip(2, 'second', 'DATA-TWO') });
    expect(chipEl()!.textContent).toContain('second');
    expect(chipEl()!.textContent).not.toContain('first');
    frame('chip', { t: 'chip', id: f.h.id, chip: null });
    expect(chipEl()).toBeNull();
  });

  // Invariant: a tap (no hover or focus on touch) toggles the data.
  it('a tap on the chip toggles its data', async () => {
    mount(f.h);
    frame('chip', { t: 'chip', id: f.h.id, chip: chip(1, 'tap me', 'TAPPED-DATA') });
    const trigger = chipEl()!.querySelector('button')!;
    fireEvent.click(trigger);
    await settle();
    expect((await screen.findAllByText('TAPPED-DATA')).length).toBeGreaterThan(0);
    fireEvent.click(trigger);
    await settle();
    expect(screen.queryAllByText('TAPPED-DATA')).toHaveLength(0);
  });

  // Invariant: another session's chip is not shown on this composer.
  it("a chip for another instance is not shown here", () => {
    mount(f.h);
    frame('chip', { t: 'chip', id: 'someone-else', chip: chip(1) });
    expect(chipEl()).toBeNull();
  });

  // Invariant: a snapshot sets the chip for its instance (a late subscriber sees it), and a snapshot
  // without one clears it.
  it('a snapshot carries the chip in, and one without a chip clears it', () => {
    mount(f.h);
    frame('snapshot', { t: 'snapshot', id: f.h.id, chip: chip(4, 'from snapshot') });
    expect(chipEl()!.textContent).toContain('from snapshot');
    frame('snapshot', { t: 'snapshot', id: f.h.id, chip: null });
    expect(chipEl()).toBeNull();
  });

  // Invariant: selecting another session hides the previous chip until its snapshot arrives; a dropped
  // socket drops every chip.
  it('selecting another session, or a closed socket, drops the held chips', () => {
    mount(f.h);
    frame('chip', { t: 'chip', id: f.h.id, chip: chip(1) });
    expect(chipEl()).not.toBeNull();
    act(() => emit('select', { id: 'other', sessionId: 'x', userGesture: false }));
    expect(chipEl()).toBeNull();
    frame('chip', { t: 'chip', id: f.h.id, chip: chip(2) });
    expect(chipEl()).not.toBeNull();
    act(() => { bus.dispatchEvent(new Event('close')); });
    expect(chipEl()).toBeNull();
  });
});

describe('removing and sending', () => {
  // Invariant (4): the × asks the server to clear THAT rev, and does not clear it locally — only the
  // server's `chip: null` frame does.
  it('× sends DELETE /api/sessions/<sid>/chip?rev=<rev> and leaves the chip until the server says so', async () => {
    const calls = routeFetch({});
    mount(f.h);
    frame('chip', { t: 'chip', id: f.h.id, chip: chip(7, 'sel') });
    fireEvent.click(screen.getByRole('button', { name: 'Remove context sel' }));
    await settle();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE /api/sessions/${encodeURIComponent(f.h.sessionId!)}/chip?rev=7`]);
    expect(chipEl()).not.toBeNull();
  });

  // Invariant (5): Send carries the chip's rev with the typed text, and the composer does not clear the
  // chip itself (the server's frame does).
  it('Send with a chip carries chip:rev and the typed text', () => {
    mount(f.h);
    frame('chip', { t: 'chip', id: f.h.id, chip: chip(3) });
    fireEvent.change(box(), { target: { value: 'explain this' } });
    fireEvent.click(sendBtn());
    expect(prompts()).toEqual([{ id: f.h.id, text: 'explain this', chip: 3 }]);
    expect(chipEl()).not.toBeNull();
  });

  // Invariant (5): a chip alone is a send — the button reads Send, not the mic — with empty text.
  it('empty text + chip shows Send, not the mic, and sends {text:"", chip}', () => {
    mount(f.h);
    expect(screen.queryByRole('button', { name: /^Send/ })).not.toBeNull();
    frame('chip', { t: 'chip', id: f.h.id, chip: chip(5) });
    expect(sendBtn().disabled).toBe(false);
    expect(sendBtn().getAttribute('aria-label') ?? sendBtn().title).toMatch(/^Send/);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(prompts()).toEqual([{ id: f.h.id, text: '', chip: 5 }]);
  });

  // Invariant: with no chip, a send names none.
  it('a send without a chip carries no chip field', () => {
    mount(f.h);
    fireEvent.change(box(), { target: { value: 'plain' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(prompts()).toEqual([{ id: f.h.id, text: 'plain' }]);
  });
});

describe('send to the owner (decision 3)', () => {
  // Invariant: the chip belongs to the session it was set on — a send to the owner carries none, and the
  // worker's chip stays (selectInstance is stubbed: really opening the owner drops the held chips until
  // the worker's next snapshot); a chip alone cannot be sent to the owner.
  it('send-to-owner carries no chip; the worker keeps its chip', async () => {
    mount(f.w1);
    frame('chip', { t: 'chip', id: f.w1.id, chip: chip(9, 'worker chip') });
    fireEvent.change(box(), { target: { value: 'for the conductor' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    const toOwner = await screen.findByRole('button', { name: /Send to conductor/ });
    expect((toOwner as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(toOwner);
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]).toMatchObject({ id: C1_ID(f), text: 'for the conductor' });
    expect(prompts()[0]).not.toHaveProperty('chip');
    expect(chipEl()).not.toBeNull();
  });

  it('with only a chip held, Send to conductor is disabled', async () => {
    mount(f.w1);
    frame('chip', { t: 'chip', id: f.w1.id, chip: chip(9, 'worker chip') });
    fireEvent.keyDown(box(), { key: 'Enter' });
    const toOwner = await screen.findByRole('button', { name: /Send to conductor/ });
    expect((toOwner as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Send to worker/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(prompts()).toEqual([]);
  });
});

function C1_ID(fl: Fleet): string { return fl.c1.id; }
