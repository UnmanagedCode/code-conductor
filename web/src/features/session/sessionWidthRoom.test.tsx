// The room bounds on a handle drag, and the gutter on the rendered cap.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';

vi.mock('@shared/ws', () => ({
  bus: new EventTarget(),
  connect: () => {},
  send: () => undefined,
}));
vi.mock('@/features/composer/Composer', () => ({ Composer: () => <div /> }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { setSessionFull, setSessionWidth } from '@/app/sessionWidth';
import { SESSION_WIDTH_GUTTER } from '@/app/sessionWidthScale';
import type { Instance } from '@/state/types';
import { SessionView } from './SessionView';

const KEY = 'code-conductor:session-column';
const inst: Instance = {
  id: 'A', project: 'proj-A', status: 'idle', displayStatus: 'idle', sessionId: 'sess-A', mode: 'bypassPermissions',
  model: 'claude-opus-5-5', backend: 'claude', effort: 'high', contextWindowTokens: 200_000,
};

beforeEach(() => {
  vi.restoreAllMocks();
  act(() => { setSessionWidth(768); setSessionFull(false); });
  localStorage.clear();
  appStore.set({
    connection: 'open', everDropped: false, activeId: 'A', sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [inst],
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const ROOM = 1400;
const LIMIT = ROOM - 2 * SESSION_WIDTH_GUTTER;
const boxes = () => [...document.querySelectorAll<HTMLElement>('[data-session-width]')];
const handle = () => document.querySelector<HTMLElement>('[data-session-handle="right"]')!;
const stored = () => JSON.parse(localStorage.getItem(KEY)!).width as number;

/** The transcript scroller's client width, which a classic scrollbar makes narrower than main. */
function mount(client = ROOM) {
  render(<TooltipProvider><SessionView /></TooltipProvider>);
  Object.defineProperty(document.querySelector('[data-conversation]')!, 'clientWidth', { configurable: true, value: client });
  document.querySelector<HTMLElement>('[data-session-handles]')!.getBoundingClientRect =
    () => ({ left: 0, right: ROOM, width: ROOM, top: 0, bottom: 800, height: 800, x: 0, y: 0, toJSON: () => ({}) });
}
const press = () => fireEvent.pointerDown(handle(), { pointerId: 1, clientX: 500, button: 0 });
const moveBy = (dx: number) => fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 500 + dx });
const release = () => fireEvent.pointerUp(handle(), { pointerId: 1 });

describe('the room bounds on a session width drag', () => {
  it('a drag stops at the room less a gutter per side, live and committed', () => {
    // Invariant: the drag is bounded by the room, and the limit stores the clamped px.
    mount();
    press();
    moveBy(1000);
    for (const b of boxes()) expect(b.style.maxWidth).toContain(`${LIMIT}px`);
    release();
    expect(stored()).toBe(LIMIT);
  });

  it('a drag starts from the shown width, not a hidden wider preference', () => {
    // Invariant: a stored width wider than the room drags from the clamped width.
    act(() => setSessionWidth(2400));
    mount();
    press();
    moveBy(-10);
    release();
    expect(stored()).toBe(LIMIT - 20);
  });

  it('the room is the scroller\'s client width, so a scrollbar narrows the limit', () => {
    // Invariant: with a scrollbar (scroller clientWidth < layer width) a drag to the limit commits the narrower basis less a gutter per side.
    const SCROLLBAR = 15;
    mount(ROOM - SCROLLBAR);
    press();
    moveBy(1000);
    release();
    expect(stored()).toBe(ROOM - SCROLLBAR - 2 * SESSION_WIDTH_GUTTER);
  });

  it('the gutter caps the column on desktop only', () => {
    // Invariant: every box carries the gutter cap on desktop and a plain px cap below md.
    mount();
    expect(boxes()).toHaveLength(3);
    for (const b of boxes()) expect(b.style.maxWidth).toContain(`100% - ${2 * SESSION_WIDTH_GUTTER}px`);
    document.body.innerHTML = '';
    vi.stubGlobal('matchMedia', (query: string) => ({
      media: query, matches: false, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => true,
    }));
    render(<TooltipProvider><SessionView /></TooltipProvider>);
    expect(boxes()).toHaveLength(3);
    for (const b of boxes()) {
      expect(b.style.maxWidth).toContain('768px');
      expect(b.style.maxWidth).not.toContain('100%');
    }
  });
});
