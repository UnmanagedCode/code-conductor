// Per-session drafts beyond composer.test.tsx: a re-render of the session already showing, the
// debounce restarting, leaving the session view (the composer unmounts), a hidden tab, a reload's
// restore with its transcribed flag, a restore that writes nothing and takes no focus, a prefill as
// the draft, prune's edges, and storage that throws or is missing.
import { StrictMode } from 'react';
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
import { emit } from '@/app/events';
import type { Instance } from '@/state/types';
import { Composer } from './Composer';
import { DRAFT_KEY_PREFIX, DRAFT_MAX_AGE_MS, DRAFT_SAVE_DEBOUNCE_MS, createDraftStore } from './drafts';

// Each test uses session ids no other test uses: the draft store's in-memory mirror outlives
// localStorage.clear(), so a shared id could carry one test's draft into another.
const inst = (sessionId: string | null, extra: Partial<Instance> = {}): Instance =>
  ({ id: `i-${sessionId}`, project: 'demo', status: 'idle', sessionId, mode: 'x', ...extra });
const KEY = (sid: string) => DRAFT_KEY_PREFIX + sid;

function mount(first: Instance | null, { strict = false } = {}) {
  const tree = (i: Instance | null) => <TooltipProvider><Composer inst={i} /></TooltipProvider>;
  const view = render(strict ? <StrictMode>{tree(first)}</StrictMode> : tree(first));
  return {
    unmount: view.unmount,
    swap: (next: Instance | null) => view.rerender(strict ? <StrictMode>{tree(next)}</StrictMode> : tree(next)),
  };
}
const box = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
const sendButton = () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
const type = (value: string) => fireEvent.change(box(), { target: { value } });
const seed = (sid: string, draft: { text: string; transcribed: boolean }) =>
  localStorage.setItem(KEY(sid), JSON.stringify({ ...draft, savedAt: Date.now() }));
const storedText = (sid: string): string | null => {
  const raw = localStorage.getItem(KEY(sid));
  return raw === null ? null : (JSON.parse(raw) as { text: string }).text;
};
/** Calls a localStorage spy received for one session's draft key. */
const callsFor = (spy: { mock: { calls: unknown[][] } }, sid: string) =>
  spy.mock.calls.filter(([key]) => key === KEY(sid)).length;
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

beforeEach(() => {
  sent.length = 0;
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the session already showing', () => {
  it('a re-render of the showing session keeps a pending save pending: nothing is written early, and it still lands', () => {
    fakeTimers();
    const writes = vi.spyOn(localStorage, 'setItem');
    const c = mount(inst('same-a'));
    type('keep me');
    c.swap(inst('same-a', { id: 'i-same-a-resumed' }));
    expect(box().value).toBe('keep me');
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS - 1);
    expect(callsFor(writes, 'same-a'), 'nothing is written before the debounce').toBe(0);
    vi.advanceTimersByTime(1);
    expect(storedText('same-a'), 'the pending save still lands').toBe('keep me');
  });

  it('text typed while the session has no id yet stays in the box through a re-render and is saved under no session', () => {
    fakeTimers();
    const writes = vi.spyOn(localStorage, 'setItem');
    const c = mount(inst(null, { status: 'spawning' }));
    type('early text');
    c.swap(inst(null, { status: 'spawning' }));
    expect(box().value).toBe('early text');
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS * 2);
    dispatchEvent(new Event('pagehide'));
    expect(writes).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
});

describe('the debounce', () => {
  it('further typing restarts the debounce rather than stacking a second save', () => {
    fakeTimers();
    const writes = vi.spyOn(localStorage, 'setItem');
    mount(inst('restart-a'));
    type('a');
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS - 100);
    type('ab');
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS - 100);
    expect(callsFor(writes, 'restart-a'), "the first keystroke's save was dropped, not run").toBe(0);
    vi.advanceTimersByTime(100);
    expect(storedText('restart-a')).toBe('ab');
    expect(callsFor(writes, 'restart-a')).toBe(1);
  });

  it('switching to another session writes the draft at once and leaves no save behind', () => {
    fakeTimers();
    const writes = vi.spyOn(localStorage, 'setItem');
    const c = mount(inst('away-a'));
    type('abc');
    c.swap(inst('away-b'));
    expect(storedText('away-a')).toBe('abc');
    expect(callsFor(writes, 'away-a')).toBe(1);
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS * 2);
    expect(callsFor(writes, 'away-a'), 'no stale save fires after the switch').toBe(1);
  });

  it('leaving the session view (the composer unmounts) writes the pending draft at once and leaves no save behind', () => {
    fakeTimers();
    const writes = vi.spyOn(localStorage, 'setItem');
    const c = mount(inst('leave-a'));
    type('first');
    c.swap(inst('leave-b'));
    expect(storedText('leave-a'), 'positive control: a switch writes at once').toBe('first');
    type('second');
    c.unmount();
    expect(storedText('leave-b'), 'the unmount wrote the pending draft').toBe('second');
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS * 2);
    expect(callsFor(writes, 'leave-b'), 'no save fires after the unmount').toBe(1);
  });

  it('unmounting with nothing pending writes nothing, whichever way the save stopped being pending', () => {
    fakeTimers();
    seed('quiet-restored', { text: 'stored', transcribed: false });
    seed('quiet-other', { text: 'other stored', transcribed: false });
    const writes = vi.spyOn(localStorage, 'setItem');
    const removals = vi.spyOn(localStorage, 'removeItem');
    const touched = (sid: string) => callsFor(writes, sid) + callsFor(removals, sid);

    // A restored draft, under StrictMode's doubled mount and then a real unmount.
    const restored = mount(inst('quiet-restored'), { strict: true });
    expect(box().value, 'positive control: the stored draft is in the box').toBe('stored');
    restored.unmount();
    expect(touched('quiet-restored'), 'a restored draft is never written back').toBe(0);

    // A save the debounce already ran.
    const fired = mount(inst('quiet-fired'));
    type('saved');
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);
    expect(callsFor(writes, 'quiet-fired'), 'positive control: the debounce wrote it').toBe(1);
    fired.unmount();
    expect(touched('quiet-fired'), 'the save that ran is not repeated').toBe(1);

    // A save a switch already wrote, then the other session unmounts showing its restored draft.
    const switched = mount(inst('quiet-switched'));
    type('switched away');
    switched.swap(inst('quiet-other'));
    expect(storedText('quiet-switched'), 'positive control: the switch wrote it').toBe('switched away');
    switched.unmount();
    expect(touched('quiet-other'), "the restored session's draft is not written").toBe(0);

    // A box emptied by hand: the clear is immediate.
    const emptied = mount(inst('quiet-emptied'));
    type('gone');
    type('');
    expect(callsFor(removals, 'quiet-emptied'), 'positive control: emptying the box cleared the draft').toBe(1);
    emptied.unmount();
    expect(touched('quiet-emptied'), 'the clear is not repeated').toBe(1);
  });
});

describe('hiding the page', () => {
  const setHidden = (hidden: boolean) => Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  afterEach(() => { Reflect.deleteProperty(document, 'hidden'); });

  it('a tab going hidden writes the pending draft at once; a tab becoming visible does not', () => {
    fakeTimers();
    mount(inst('hide-a'));
    type('pending');
    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(storedText('hide-a'), 'a tab becoming visible writes nothing early').toBeNull();
    setHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(storedText('hide-a')).toBe('pending');
  });
});

describe('restoring', () => {
  it('a reload restores the stored draft into the box, and its transcribed flag reaches the sent text', () => {
    seed('reload-a', { text: 'dictated words', transcribed: true });
    mount(inst('reload-a'));
    expect(box().value).toBe('dictated words');
    fireEvent.click(sendButton());
    expect(sent).toEqual([{ type: 'prompt', payload: { id: 'i-reload-a', text: '<transcribed>\ndictated words' } }]);
  });

  it("the transcribed flag belongs to its own session's draft", () => {
    seed('flag-a', { text: 'spoken', transcribed: true });
    const c = mount(inst('flag-a'));
    c.swap(inst('flag-b'));
    type('typed');
    fireEvent.click(sendButton());
    c.swap(inst('flag-a'));
    fireEvent.click(sendButton());
    expect(sent.map((s) => s.payload.text), "B never inherits A's flag").toEqual(['typed', '<transcribed>\nspoken']);
  });

  it('restoring a draft writes nothing back and leaves focus where it was', () => {
    fakeTimers();
    seed('restore-b', { text: 'stored', transcribed: false });
    const c = mount(inst('restore-a'));
    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    const writes = vi.spyOn(localStorage, 'setItem');
    const removals = vi.spyOn(localStorage, 'removeItem');
    c.swap(inst('restore-b'));
    expect(box().value, 'positive control: the stored draft is in the box').toBe('stored');
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS * 2);
    expect(callsFor(writes, 'restore-b') + callsFor(removals, 'restore-b'), 'the restored draft is not written').toBe(0);
    expect(document.activeElement === elsewhere, 'focus stays where it was').toBe(true);
    elsewhere.remove();
  });

  it("a prefill (rewind / fork) becomes the session's draft, as typed rather than dictated text", () => {
    fakeTimers();
    seed('prefill-a', { text: 'old spoken', transcribed: true });
    mount(inst('prefill-a'));
    expect(box().value, 'positive control: the dictated draft is in the box').toBe('old spoken');
    act(() => emit('prefill', { text: 'dropped prompt' }));
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);
    const raw = localStorage.getItem(KEY('prefill-a'));
    expect(raw === null ? null : JSON.parse(raw)).toMatchObject({ text: 'dropped prompt', transcribed: false });
  });
});

describe('prune', () => {
  const NOW = 1_800_000_000_000;
  const rec = (savedAt: number) => JSON.stringify({ text: 't', transcribed: false, savedAt });
  function mapStorage(seeded: Record<string, string>): Storage & { map: Map<string, string> } {
    const map = new Map(Object.entries(seeded));
    return {
      map,
      get length() { return map.size; },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v); },
      removeItem: (k: string) => { map.delete(k); },
      clear: () => map.clear(),
    };
  }

  it('keeps a draft exactly at the age cap and removes one a millisecond older', () => {
    const storage = mapStorage({ [KEY('edge')]: rec(NOW - DRAFT_MAX_AGE_MS), [KEY('past')]: rec(NOW - DRAFT_MAX_AGE_MS - 1) });
    createDraftStore({ storage, now: () => NOW }).prune();
    expect([...storage.map.keys()]).toEqual([KEY('edge')]);
  });

  it('removes a record without string text, and one without savedAt even when the clock reads 0; a dated record at clock 0 stays', () => {
    const storage = mapStorage({
      [KEY('notext')]: JSON.stringify({ savedAt: NOW }),
      [KEY('numtext')]: JSON.stringify({ text: 5, savedAt: NOW }),
      [KEY('nosaved')]: JSON.stringify({ text: 't', transcribed: false }),
      [KEY('dated')]: rec(0),
    });
    // At clock 0 the age of a record with no savedAt computes as 0, so only the missing-savedAt rule removes it.
    createDraftStore({ storage, now: () => 0 }).prune();
    expect([...storage.map.keys()]).toEqual([KEY('dated')]);
  });

  it('loading the drafts module prunes the stored drafts', async () => {
    localStorage.setItem(KEY('load-old'), rec(Date.now() - DRAFT_MAX_AGE_MS - 60_000));
    localStorage.setItem(KEY('load-fresh'), rec(Date.now()));
    localStorage.setItem('code-conductor:other', 'kept');
    vi.resetModules();
    await import('./drafts');
    expect(localStorage.getItem(KEY('load-old'))).toBeNull();
    expect(localStorage.getItem(KEY('load-fresh')), 'a fresh draft is kept').not.toBeNull();
    expect(localStorage.getItem('code-conductor:other'), 'a key outside the draft prefix is untouched').toBe('kept');
  });
});

describe('storage that fails', () => {
  it('when removeItem throws, a draft stays per session in memory and a sent draft does not come back', () => {
    const removals = vi.spyOn(localStorage, 'removeItem').mockImplementation(() => { throw new Error('storage refused'); });
    const c = mount(inst('rm-a'));
    type('in memory');
    c.swap(inst('rm-b'));
    expect(box().value).toBe('');
    c.swap(inst('rm-a'));
    expect(box().value).toBe('in memory');
    fireEvent.click(sendButton());
    expect(callsFor(removals, 'rm-a'), 'positive control: the send tried to remove the stored draft').toBeGreaterThan(0);
    expect(storedText('rm-a'), 'the failed removal left the stored copy behind').toBe('in memory');
    c.swap(inst('rm-b'));
    c.swap(inst('rm-a'));
    expect(box().value, 'a sent draft does not come back').toBe('');
  });

  it('with no storage at all, drafts stay per session in memory and a cleared draft does not come back', () => {
    const store = createDraftStore({ storage: null });
    store.save('mem-a', { text: 'alpha', transcribed: true });
    store.save('mem-b', { text: 'bravo', transcribed: false });
    expect(store.load('mem-a')).toEqual({ text: 'alpha', transcribed: true });
    expect(store.load('mem-b')).toEqual({ text: 'bravo', transcribed: false });
    store.clear('mem-a');
    expect(store.load('mem-a')).toBeNull();
    expect(store.load('mem-b'), "clearing one session leaves the other's").toEqual({ text: 'bravo', transcribed: false });
    expect(() => store.prune()).not.toThrow();
  });
});
