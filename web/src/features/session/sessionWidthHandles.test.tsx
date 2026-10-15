// The session column's edge drag handles: pointer-only, mirrored, live on all
// three column boxes, committed once on release. ConversationView is real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

vi.mock('@shared/ws', () => ({
  bus: new EventTarget(),
  connect: () => {},
  send: () => undefined,
}));
vi.mock('@/features/composer/Composer', () => ({ Composer: () => <div /> }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { setSessionFull, setSessionWidth } from '@/app/sessionWidth';
import { SESSION_WIDTH_MIN } from '@/app/sessionWidthScale';
import type { Instance } from '@/state/types';
import { SessionView } from './SessionView';

const KEY = 'code-conductor:session-column';
const inst: Instance = {
  id: 'A', project: 'proj-A', status: 'idle', displayStatus: 'idle', sessionId: 'sess-A', mode: 'bypassPermissions',
  model: 'claude-opus-5-5', backend: 'claude', effort: 'high', contextWindowTokens: 200_000,
};

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  act(() => { setSessionWidth(768); setSessionFull(false); });
  localStorage.clear();
  appStore.set({
    connection: 'open', everDropped: false, activeId: 'A', sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [inst],
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const ROOM = 1400;
const layer = () => document.querySelector<HTMLElement>('[data-session-handles]');
const handle = (edge: 'left' | 'right') => document.querySelector<HTMLElement>(`[data-session-handle="${edge}"]`);
const boxes = () => [...document.querySelectorAll<HTMLElement>('[data-session-width]')];
const storedWidth = () => JSON.parse(localStorage.getItem(KEY)!).width as number;

/** The transcript scroller's client width is the drag's room; happy-dom lays nothing out, so stub it. */
function stubRoom(client: number) {
  const scroller = document.querySelector<HTMLElement>('[data-conversation]');
  if (scroller) Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: client });
}

function mount() {
  render(<TooltipProvider><SessionView /></TooltipProvider>);
  stubRoom(ROOM);
}

const X0 = 500;
function down(edge: 'left' | 'right') {
  fireEvent.pointerDown(handle(edge)!, { pointerId: 1, clientX: X0, button: 0 });
}
function move(edge: 'left' | 'right', dx: number) {
  fireEvent.pointerMove(handle(edge)!, { pointerId: 1, clientX: X0 + dx });
}
function up(edge: 'left' | 'right') {
  fireEvent.pointerUp(handle(edge)!, { pointerId: 1 });
}
function drag(edge: 'left' | 'right', dx: number) {
  down(edge); move(edge, dx); up(edge);
}

describe('the session width handles', () => {
  it('are two pointer-only handles inside an aria-hidden layer', () => {
    // Invariant: the handles are hidden from assistive tech and not focusable, since they cannot be operated by keyboard.
    mount();
    expect(layer()).not.toBeNull();
    expect(layer()!.getAttribute('aria-hidden')).toBe('true');
    expect(layer()!.querySelectorAll('[data-session-handle]')).toHaveLength(2);
    for (const edge of ['left', 'right'] as const) expect(handle(edge)!.hasAttribute('tabindex')).toBe(false);
  });

  it('a right-handle drag mirrors at 2x, shows live on every box, and commits once on release', () => {
    // Invariant: dragging an edge by dx changes the width by 2dx; all three boxes move live while the setting is untouched; release writes once.
    mount();
    expect(handle('right')).not.toBeNull();
    const setItem = vi.spyOn(localStorage, 'setItem');
    down('right');
    move('right', 40);
    expect(boxes()).toHaveLength(3);
    for (const b of boxes()) {
      expect(b.style.maxWidth).toContain('848px');
      expect(b.dataset.sessionWidth).toBe('768');
    }
    expect(setItem).not.toHaveBeenCalled();
    up('right');
    expect(storedWidth()).toBe(848);
    expect(setItem).toHaveBeenCalledTimes(1);
    for (const b of boxes()) expect(b.dataset.sessionWidth).toBe('848');
  });

  it('the left handle mirrors the right: outward is wider', () => {
    // Invariant: the left edge grows with -dx and shrinks with +dx.
    mount();
    expect(handle('left')).not.toBeNull();
    drag('left', -40);
    expect(storedWidth()).toBe(848);
    act(() => setSessionWidth(768));
    drag('left', 40);
    expect(storedWidth()).toBe(688);
  });

  it('snaps to Wide only within the radius, during a drag', () => {
    // Invariant: the raw width within the snap radius lands on the snap point; beyond it stays raw.
    mount();
    expect(handle('right')).not.toBeNull();
    drag('right', 120);
    expect(storedWidth()).toBe(1024);
    act(() => setSessionWidth(768));
    drag('right', 140);
    expect(storedWidth()).toBe(1024);
    act(() => setSessionWidth(768));
    drag('right', 150);
    expect(storedWidth()).toBe(1068);
  });

  it('never drags below the floor', () => {
    // Invariant: a long inward drag stops at the minimum width.
    mount();
    expect(handle('right')).not.toBeNull();
    drag('right', -1000);
    expect(storedWidth()).toBe(SESSION_WIDTH_MIN);
  });

  it('a click without movement never overwrites a stored width', () => {
    // Invariant: pointerdown+up without a move writes nothing, so a hidden preference survives.
    act(() => setSessionWidth(2400));
    localStorage.clear();
    mount();
    expect(handle('right')).not.toBeNull();
    const setItem = vi.spyOn(localStorage, 'setItem');
    down('right');
    up('right');
    expect(setItem).not.toHaveBeenCalled();
    expect(boxes().map((b) => b.dataset.sessionWidth)).toEqual(['2400', '2400', '2400']);
  });

  it('a drag that loses pointer capture reverts like a cancel', () => {
    // Invariant: lostpointercapture mid-drag (no pointerup) clears the body flag and the live width and writes nothing.
    mount();
    expect(handle('right')).not.toBeNull();
    const setItem = vi.spyOn(localStorage, 'setItem');
    down('right');
    move('right', 40);
    expect(boxes()[0].style.maxWidth).toContain('848px');
    expect('resizing' in document.body.dataset).toBe(true);
    fireEvent.lostPointerCapture(handle('right')!, { pointerId: 1 });
    expect('resizing' in document.body.dataset).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
    for (const b of boxes()) expect(b.style.maxWidth).toContain('768px');
  });

  it('a cancelled drag commits nothing and the boxes revert', () => {
    // Invariant: pointercancel ends the drag without writing, and the live width is dropped.
    mount();
    expect(handle('right')).not.toBeNull();
    const setItem = vi.spyOn(localStorage, 'setItem');
    down('right');
    move('right', 40);
    expect(boxes()[0].style.maxWidth).toContain('848px');
    fireEvent.pointerCancel(handle('right')!, { pointerId: 1 });
    expect(setItem).not.toHaveBeenCalled();
    for (const b of boxes()) expect(b.style.maxWidth).toContain('768px');
  });

  it('a double-click on either handle resets to Normal', () => {
    // Invariant: double-click returns the width to the default, from either edge.
    mount();
    expect(handle('left')).not.toBeNull();
    for (const edge of ['left', 'right'] as const) {
      act(() => setSessionWidth(896));
      fireEvent.doubleClick(handle(edge)!);
      expect(boxes().map((b) => b.dataset.sessionWidth), edge).toEqual(['768', '768', '768']);
    }
  });

  it('are absent under Full', () => {
    // Invariant: Full has no handles; leaving Full brings them back.
    mount();
    expect(handle('right')).not.toBeNull();
    act(() => setSessionFull(true));
    expect(document.querySelector('[data-session-handle]')).toBeNull();
    act(() => setSessionFull(false));
    expect(document.querySelector('[data-session-handle]')).not.toBeNull();
  });

  it('are absent on drawer viewports', () => {
    // Invariant: below md there are no handles.
    mount();
    expect(handle('right')).not.toBeNull();
    cleanup();
    vi.stubGlobal('matchMedia', (query: string) => ({
      media: query, matches: false, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => true,
    }));
    render(<TooltipProvider><SessionView /></TooltipProvider>);
    expect(document.querySelector('[data-session-width]')).not.toBeNull();
    expect(document.querySelector('[data-session-handle]')).toBeNull();
  });

  it('a drag ended by unmount leaves no resize flag on the body', () => {
    // Invariant: switching to Full mid-drag cannot strand body[data-resizing].
    mount();
    expect(handle('right')).not.toBeNull();
    down('right');
    move('right', 40);
    expect('resizing' in document.body.dataset).toBe(true);
    act(() => setSessionFull(true));
    expect('resizing' in document.body.dataset).toBe(false);
  });
});
