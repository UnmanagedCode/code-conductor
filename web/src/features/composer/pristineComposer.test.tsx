// The composer's part in a pristine conductor's presence: leaving it carries
// the box's live text (blank discards it here and on the server, text lists it
// and keeps it as the draft), typing syncs the draft once debounced, a second
// visit to one listed under its draft is a visit like the first, and a send
// right before leaving never reads as abandoning it.
// First: the full-page view's history push must not resync the route through a hashchange a browser never fires.
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

type Sent = [string, any];
const sent: Sent[] = [];
vi.mock('@shared/ws', () => ({
  bus: new EventTarget(),
  connect: () => {},
  send: (t: string, payload: unknown) => { sent.push([t, payload]); },
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { adoptInstance, selectInstance, startController, stopController } from '@/app/controller';
import { appStore, activeInstance } from '@/state/app';
import { useStore } from '@/state/createStore';
import { useRoute } from '@/state/route';
import { openSettings } from '@/features/views/api';
import type { Instance } from '@/state/types';
import { routeFetch } from '@/test/routeFetch';
import { Composer } from './Composer';
import { DRAFT_SAVE_DEBOUNCE_MS, draftStore } from './drafts';

// The draft store's in-memory mirror outlives a test, so every test has its own session ids.
let n = 0;
const conductor = (extra: Partial<Instance> = {}): Instance => {
  n++;
  return { id: `i-pc-${n}`, sessionId: `s-pc-${n}`, project: '.conduct', status: 'idle', mode: 'bypassPermissions', ...extra };
};

/** The session view's composer: mounted while the session view shows, on the active session. */
function Shown() {
  const inst = useStore(appStore, activeInstance);
  const route = useRoute();
  return route.view === 'session' ? <Composer inst={inst} /> : null;
}

const box = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
const type = (value: string) => fireEvent.change(box(), { target: { value } });
const presence = () => sent.filter(([t]) => t.startsWith('pristine_'));
const pick = (id: string) => act(() => { selectInstance(id, { userGesture: true }); });

/** A pristine P adopted and shown, plus a listed plain Q, with the composer mounted. */
function showPristine() {
  const P = conductor({ pristine: true });
  const Q = conductor();
  appStore.set({ instances: [Q] });
  adoptInstance(P);
  selectInstance(P.id, { userGesture: true });
  render(<TooltipProvider><Shown /></TooltipProvider>);
  return { P, Q };
}

beforeEach(() => {
  sent.length = 0;
  localStorage.clear();
  history.replaceState(null, '', '/');
  routeFetch({ 'GET /api/instances': () => ({ json: appStore.get().instances }) });
  appStore.set({ instances: [], activeId: null, pristine: null });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  startController();
});
afterEach(() => {
  cleanup();
  stopController();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('leaving a pristine conductor', () => {
  it('with only whitespace typed: the leave carries it, and the slot is cleared', () => {
    const { P, Q } = showPristine();
    type('   \n ');
    pick(Q.id);
    expect(presence()).toContainEqual(['pristine_leave', { id: P.id, text: '   \n ' }]);
    expect(appStore.get().pristine).toBeNull();
    expect(appStore.get().activeId).toBe(Q.id);
  });

  it('with text, for a full-page view: the leave carries the text, it stays active, and the draft is kept', () => {
    const { P } = showPristine();
    type('Plan the release');
    act(() => { openSettings(); });
    expect(presence()).toContainEqual(['pristine_leave', { id: P.id, text: 'Plan the release' }]);
    expect(appStore.get().activeId).toBe(P.id);
    expect(draftStore.load(P.sessionId!)?.text).toBe('Plan the release');
    cleanup();
    render(<TooltipProvider><Composer inst={P} /></TooltipProvider>);
    expect(box().value).toBe('Plan the release');
  });

  it('blank, for a full-page view: nothing is left active', () => {
    const { P } = showPristine();
    act(() => { openSettings(); });
    expect(presence()).toContainEqual(['pristine_leave', { id: P.id, text: '' }]);
    expect(appStore.get().activeId).toBeNull();
  });
});

describe('a second visit to one listed under its draft', () => {
  function showListed() {
    const P = conductor({ pristine: true, title: 'first draft' });
    const Q = conductor();
    appStore.set({ instances: [P, Q] });
    draftStore.save(P.sessionId!, { text: 'first draft', transcribed: false });
    render(<TooltipProvider><Shown /></TooltipProvider>);
    pick(P.id);
    expect(presence(), 'control: showing it announces it').toEqual([['pristine_view', { id: P.id }]]);
    expect(box().value, 'control: the composer shows its draft').toBe('first draft');
    return { P, Q };
  }

  it('cleared, then left: the leave is blank', () => {
    const { P, Q } = showListed();
    type('');
    pick(Q.id);
    expect(presence()).toContainEqual(['pristine_leave', { id: P.id, text: '' }]);
  });

  it('edited, then left: the leave carries the new text', () => {
    const { P, Q } = showListed();
    type('second draft');
    pick(Q.id);
    expect(presence()).toContainEqual(['pristine_leave', { id: P.id, text: 'second draft' }]);
    expect(presence()).not.toContainEqual(['pristine_leave', { id: P.id, text: 'first draft' }]);
  });
});

describe('draft sync', () => {
  it('typing on a pristine conductor syncs the draft once debounced', () => {
    const { P } = showPristine();
    type('abc');
    act(() => { vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS); });
    expect(presence()).toContainEqual(['pristine_draft', { id: P.id, text: 'abc' }]);
  });

  it('typing on a plain conductor syncs nothing', () => {
    const Q = conductor();
    appStore.set({ instances: [Q] });
    render(<TooltipProvider><Shown /></TooltipProvider>);
    pick(Q.id);
    type('abc');
    act(() => { vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS); });
    expect(presence()).toEqual([]);
  });
});

describe('a send right before leaving', () => {
  it('(guard) the prompt goes out and no leave follows it', () => {
    const { P, Q } = showPristine();
    type('hello');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    pick(Q.id);
    expect(sent).toContainEqual(['prompt', { id: P.id, text: 'hello' }]);
    expect(presence().filter(([t, p]) => t === 'pristine_leave' && p.id === P.id)).toEqual([]);
  });
});
