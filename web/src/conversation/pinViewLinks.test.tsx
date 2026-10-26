// A view link in the pinned prompt (a copy of a user bubble's rendered HTML) is followed in-app like one in the transcript.
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: () => {} }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { stickyPrompt } from '@/app/controller';
import { routeStore, syncRoute } from '@/state/route';
import { clickLink } from '@/test/linkClick';
import { ConversationView } from './ConversationView';
import { pinStore } from './stickyPrompt';

const HTML = '<p>see <a href="#plugin/code-review/?review=r-9">the review</a> and <a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a></p>';

beforeEach(() => {
  history.replaceState(null, '', '/#session=sess-1');
  syncRoute();
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => pinStore.set({ pin: { kind: 'hidden' }, gutter: 0 }));
});

function mountPinned() {
  const { container } = render(<TooltipProvider><ConversationView /></TooltipProvider>);
  act(() => pinStore.set({ pin: { kind: 'pinned', html: HTML, shift: 0, overflowing: false, pushedOff: false } }));
  return container.querySelector('[data-pin-body]') as HTMLElement;
}

describe('view links in the pinned prompt', () => {
  // Pins: a click on a view link in the pin opens the view in-app with one history entry, Back returns to the session, and the transcript is not jumped.
  it('opens in-app with one history entry, and does not jump the transcript', async () => {
    const jump = vi.spyOn(stickyPrompt, 'jumpToPinned').mockImplementation(() => {});
    const body = mountPinned();
    const before = history.length;
    expect(clickLink(body.querySelector('a[href^="#plugin/"]')!), 'the click is handled in-app').toBe(true);
    expect(routeStore.get().route).toMatchObject({ view: 'plugin', pluginId: 'code-review', pluginPath: '?review=r-9' });
    expect(history.length).toBe(before + 1);
    expect(jump).not.toHaveBeenCalled();
    act(() => { history.back(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(location.hash).toBe('#session=sess-1');
    expect(routeStore.get().route.view).toBe('session');
  });

  // Pins: any other click in the pin, an external link included, still jumps to the pinned prompt.
  it('a click on an external link or the text still jumps', () => {
    const jump = vi.spyOn(stickyPrompt, 'jumpToPinned').mockImplementation(() => {});
    const body = mountPinned();
    expect(clickLink(body.querySelector('a[href^="https:"]')!)).toBe(false);
    expect(clickLink(body.querySelector('p')!)).toBe(false);
    expect(jump).toHaveBeenCalledTimes(2);
    expect(routeStore.get().route.view).toBe('session');
  });
  // Pins: Enter on a link inside the pin is left to the browser (the keydown is not default-prevented, so the anchor's own click can follow the link) and does not jump; Enter on the pin itself still jumps. happy-dom synthesizes no click from a keydown, so the link's activation is pinned by the click tests above, not here.
  it('Enter on a link in the pin is not cancelled and does not jump; Enter on the pin still jumps', () => {
    const jump = vi.spyOn(stickyPrompt, 'jumpToPinned').mockImplementation(() => {});
    const body = mountPinned();
    const enter = (el: Element) => {
      let prevented = false;
      const listener = (e: Event) => { prevented = e.defaultPrevented; };
      document.addEventListener('keydown', listener);
      try { act(() => { fireEvent.keyDown(el, { key: 'Enter' }); }); } finally { document.removeEventListener('keydown', listener); }
      return prevented;
    };
    for (const a of body.querySelectorAll('a')) expect(enter(a), `Enter on ${a.getAttribute('href')} is not prevented`).toBe(false);
    expect(jump).not.toHaveBeenCalled();
    expect(enter(body.closest('[data-pinned-prompt]')!)).toBe(true);
    expect(jump).toHaveBeenCalledTimes(1);
  });
});
