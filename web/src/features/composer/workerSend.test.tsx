// The worker-identity cues in the composer (placeholder, owner-coloured accent) and the first-send
// check: what it covers, its three options, and what it leaves alone.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const sent: [string, any][] = [];
vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: (t: string, p: any) => { sent.push([t, p]); } }));
vi.mock('@/app/controller', async (orig) => ({ ...(await orig<typeof import('@/app/controller')>()), selectInstance: vi.fn() }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { selectInstance } from '@/app/controller';
import { conductorColor } from '@shared/conductorColor';
import { draftStore } from './drafts';
import { C1, C1_LABEL, C2, fleet, seedWorkerFleet, type Fleet } from '@/test/workerFleet';
import { Composer, composerPlaceholder } from './Composer';
import { WORKER_SEND_ACK_KEY, isWorkerSendAcked } from './workerSendAck';
import { workerOwnerOf } from '@/features/session/workerOwner';

let f: Fleet;
const SIDS = ['cond-a', 'cond-b', 'h-one', 'w-one', 'w-two', 'w-unknown', 'w-inactive', 'w-absent'];
beforeEach(() => {
  sent.length = 0;
  localStorage.clear();
  for (const s of SIDS) draftStore.clear(s);
  vi.mocked(selectInstance).mockClear();
  f = fleet();
});

const prompts = () => sent.filter(([t]) => t === 'prompt').map(([, p]) => p);
const box = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
const choice = () => document.querySelector('[data-send-choice]') as HTMLElement | null;
const composer = () => document.querySelector('[data-composer]') as HTMLElement;
const optionBtn = (name: RegExp) => screen.queryByRole('button', { name }) as HTMLButtonElement | null;
/** An assertion, so a missing element reads as a failed expectation and not a thrown lookup. */
const need = <T,>(x: T | null): T => { expect(x).not.toBeNull(); return x as T; };

function mount(inst: any, seed: Fleet = f) {
  seedWorkerFleet(seed);
  const tree = (i: any) => <TooltipProvider><Composer inst={i} /></TooltipProvider>;
  const r = render(tree(inst));
  return { ...r, swap: (i: any) => r.rerender(tree(i)) };
}
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const enter = () => fireEvent.keyDown(box(), { key: 'Enter' });
const typeAndEnter = (text: string) => { type(text); enter(); };

describe('placeholder', () => {
  it('W1 names W1 and C1 (idle and turn); WU says conducted worker; C1 and H keep today\'s text', () => {
    mount(f.w1);
    expect(box().placeholder).toContain('Wone');
    expect(box().placeholder).toContain(C1_LABEL);
    expect(box().placeholder).toContain('worker of');
    expect(box().placeholder).not.toBe('Message Wone…');
    const turn = composerPlaceholder({ ...f.w1, status: 'turn' }, workerOwnerOf(f.w1, { instances: Object.values(f), conductRows: [] }));
    expect(turn).toContain('Wone');
    expect(turn).toContain(C1_LABEL);
    expect(turn).toContain('steer');
  });

  it('WU and the unchanged sessions', () => {
    const { unmount } = mount(f.wu);
    expect(box().placeholder).toContain('Wunk');
    expect(box().placeholder).toContain('conducted worker');
    unmount();
    const c = mount(f.c1);
    expect(box().placeholder).toBe('Message Alpha…');
    c.unmount();
    mount(f.h);
    expect(box().placeholder).toBe('Message Hand…');
  });
});

describe('accent', () => {
  it('W1\'s composer carries data-owner=C1 and --owner-color=conductorColor(C1); W2\'s carries C2\'s; C1/H/WU carry none', () => {
    let m = mount(f.w1);
    expect(composer().getAttribute('data-owner')).toBe(C1);
    expect(composer().style.getPropertyValue('--owner-color')).toBe(conductorColor(C1));
    m.unmount();
    m = mount(f.w2);
    expect(composer().getAttribute('data-owner')).toBe(C2);
    expect(composer().style.getPropertyValue('--owner-color')).toBe(conductorColor(C2));
    for (const i of [f.c1, f.h, f.wu]) {
      m.unmount();
      m = mount(i);
      expect(composer().hasAttribute('data-owner')).toBe(false);
      expect(composer().style.getPropertyValue('--owner-color')).toBe('');
    }
  });
});

describe('focus ring', () => {
  const BASE_RING = 'focus-within:ring-ring/40';
  it('an owned worker\'s composer has the owner ring class and lacks the base ring colour; conductor, hand and unknown-owner keep the base', () => {
    let m = mount(f.w1);
    expect(composer().className).toContain('focus-within:ring-(color:--owner-color)/40');
    expect(composer().className).not.toContain(BASE_RING);
    for (const i of [f.c1, f.h, f.wu]) {
      m.unmount();
      m = mount(i);
      expect(composer().className).toContain(BASE_RING);
      expect(composer().className).not.toContain('--owner-color');
    }
  });
});

describe('first-send check', () => {
  it('the first Enter into W1 sends no prompt frame and shows the choice group', () => {
    mount(f.w1);
    typeAndEnter('hello');
    expect(prompts()).toEqual([]);
    expect(choice()).not.toBeNull();
    expect(box().value).toBe('hello');
  });

  it('the Send button is checked too', () => {
    mount(f.w1);
    type('via button');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(prompts()).toEqual([]);
    expect(choice()).not.toBeNull();
  });

  it('Send to this worker sends one prompt {id: W1.id, text} and acks; the next Enter sends at once; W2 still asks', () => {
    const m = mount(f.w1);
    typeAndEnter('first');
    fireEvent.click(need(optionBtn(/Send to this worker/)));
    expect(prompts()).toEqual([{ id: f.w1.id, text: 'first' }]);
    expect(box().value).toBe('');
    expect(choice()).toBeNull();
    expect(isWorkerSendAcked(f.w1.sessionId)).toBe(true);
    typeAndEnter('second');
    expect(prompts()).toEqual([{ id: f.w1.id, text: 'first' }, { id: f.w1.id, text: 'second' }]);
    expect(choice()).toBeNull();
    m.swap(f.w2);
    typeAndEnter('other');
    expect(prompts()).toHaveLength(2);
    expect(choice()).not.toBeNull();
  });

  it('after a module reset the W1 ack still holds', async () => {
    mount(f.w1);
    typeAndEnter('persist');
    fireEvent.click(need(optionBtn(/Send to this worker/)));
    expect(localStorage.getItem(WORKER_SEND_ACK_KEY)).toContain(f.w1.sessionId);
    vi.resetModules();
    const fresh = await import('./workerSendAck');
    expect(fresh.isWorkerSendAcked(f.w1.sessionId)).toBe(true);
  });

  it('Send to C1 instead sends one prompt {id: C1.id, text, attachments}, clears the box and W1\'s draft, selects C1, does not ack', async () => {
    mount(f.w1);
    const file = new File(['hi'], 'note.txt', { type: 'text/plain' });
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
    await waitFor(() => expect(document.querySelector('[aria-label="Remove note.txt"]')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    typeAndEnter('redirect me');
    fireEvent.click(need(optionBtn(/Send to .*Alpha.* instead/)));
    expect(prompts()).toEqual([{ id: f.c1.id, text: 'redirect me', attachments: [{ name: 'note.txt', mediaType: 'text/plain', dataBase64: btoa('hi') }] }]);
    expect(box().value).toBe('');
    expect(draftStore.load(f.w1.sessionId)).toBeFalsy();
    expect(document.querySelector('[aria-label="Remove note.txt"]')).toBeNull();
    expect(vi.mocked(selectInstance).mock.calls).toEqual([[f.c1.id, { push: true, userGesture: true }]]);
    expect(isWorkerSendAcked(f.w1.sessionId)).toBe(false);
    expect(choice()).toBeNull();
  });

  it('C1 mid-turn: the redirect is enabled and delivers (steer)', () => {
    f.c1.status = 'turn';
    mount(f.w1);
    typeAndEnter('steer the conductor');
    const btn = need(optionBtn(/Send to .*Alpha.* instead/));
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(prompts()).toEqual([{ id: f.c1.id, text: 'steer the conductor' }]);
  });

  it('owner not sendable (WI, WA, C1 spawning): the redirect is disabled with a description and nothing is sent', () => {
    const cases: [any, Fleet][] = [[f.wi, f], [f.wa, f]];
    const spawning = fleet();
    spawning.c1.status = 'spawning';
    cases.push([spawning.w1, spawning]);
    for (const [w, fl] of cases) {
      const m = mount(w, fl);
      typeAndEnter('stay put');
      const btn = need(optionBtn(/instead/));
      expect(btn).not.toBeNull();
      expect(btn.disabled).toBe(true);
      const why = document.getElementById(btn.getAttribute('aria-describedby') ?? '')!;
      expect(why?.textContent ?? '').not.toBe('');
      fireEvent.click(btn);
      expect(prompts()).toEqual([]);
      expect(box().value).toBe('stay put');
      expect(vi.mocked(selectInstance)).not.toHaveBeenCalled();
      m.unmount();
      draftStore.clear(w.sessionId);
    }
  });

  it('Enter while the choice is open sends nothing and editing keeps it open; Escape and Keep editing dismiss with the text kept', () => {
    mount(f.w1);
    typeAndEnter('hold');
    enter();
    enter();
    expect(prompts()).toEqual([]);
    expect(choice()).not.toBeNull();
    type('hold more');
    expect(choice()).not.toBeNull();
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(choice()).toBeNull();
    expect(box().value).toBe('hold more');
    enter();
    expect(choice()).not.toBeNull();
    fireEvent.click(need(optionBtn(/Keep editing/)));
    expect(choice()).toBeNull();
    expect(box().value).toBe('hold more');
    expect(prompts()).toEqual([]);
    expect(isWorkerSendAcked(f.w1.sessionId)).toBe(false);
  });

  it('with the box emptied, neither option acts: no send, no ack, no navigation', () => {
    mount(f.w1);
    typeAndEnter('about to clear');
    type('');
    expect(choice()).not.toBeNull();
    for (const name of [/Send to this worker/, /instead/]) {
      const btn = need(optionBtn(name));
      expect(btn.disabled).toBe(true);
      fireEvent.click(btn);
    }
    expect(prompts()).toEqual([]);
    expect(isWorkerSendAcked(f.w1.sessionId)).toBe(false);
    expect(vi.mocked(selectInstance)).not.toHaveBeenCalled();
  });

  it('Escape on the choice group dismisses it', () => {
    mount(f.w1);
    typeAndEnter('esc');
    fireEvent.keyDown(need(choice()), { key: 'Escape' });
    expect(choice()).toBeNull();
    expect(box().value).toBe('esc');
  });

  it('W1 mid-turn (steer) is checked too', () => {
    f.w1.status = 'turn';
    mount(f.w1);
    typeAndEnter('steer');
    expect(prompts()).toEqual([]);
    expect(choice()).not.toBeNull();
  });

  it('C1, H and WU send on the first Enter with no choice', () => {
    mount(f.w1);
    typeAndEnter('premise');
    expect(choice()).not.toBeNull(); // premise: the same fleet does check an owned worker
    cleanup();
    sent.length = 0;
    for (const i of [f.c1, f.h, f.wu]) {
      sent.length = 0;
      const m = mount(i);
      typeAndEnter(`go ${i.sessionId}`);
      expect(prompts()).toEqual([{ id: i.id, text: `go ${i.sessionId}` }]);
      expect(choice()).toBeNull();
      m.unmount();
    }
  });

  it('switching the composer to another session drops an open choice', () => {
    const m = mount(f.w1);
    typeAndEnter('a');
    expect(choice()).not.toBeNull();
    m.swap(f.w2);
    expect(choice()).toBeNull();
  });
});
