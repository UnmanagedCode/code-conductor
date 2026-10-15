// The session column's three boxes (transcript list, sticky pin, bottom column)
// share one width setting; ConversationView is real here.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

vi.mock('@shared/ws', () => ({
  bus: new EventTarget(),
  connect: () => {},
  send: () => undefined,
}));
vi.mock('@/features/composer/Composer', () => ({ Composer: () => <div /> }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { stickyPrompt } from '@/app/controller';
import { setSessionFull, setSessionWidth } from '@/app/sessionWidth';
import type { Instance } from '@/state/types';
import { SessionView } from './SessionView';

const inst: Instance = {
  id: 'A', project: 'proj-A', status: 'idle', displayStatus: 'idle', sessionId: 'sess-A', mode: 'bypassPermissions',
  model: 'claude-opus-5-5', backend: 'claude', effort: 'high', contextWindowTokens: 200_000,
};

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  act(() => { setSessionWidth(768); setSessionFull(false); });
  appStore.set({
    connection: 'open', everDropped: false, activeId: 'A', sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [inst],
  });
});

const boxes = () => [...document.querySelectorAll<HTMLElement>('[data-session-width]')];

describe('the session column', () => {
  it('every column box follows the setting together', () => {
    // Invariant: transcript, pin and composer column are exactly three boxes sharing one setting, and Full removes the cap.
    render(<TooltipProvider><SessionView /></TooltipProvider>);
    expect(boxes().map((b) => b.dataset.sessionWidth)).toEqual(['768', '768', '768']);
    const steps: [() => void, string, string][] = [
      [() => setSessionWidth(896), '896', '896px'],
      [() => setSessionFull(true), 'full', 'none'],
      [() => setSessionFull(false), '896', '896px'],
    ];
    for (const [apply, key, cap] of steps) {
      act(apply);
      expect(boxes().map((b) => b.dataset.sessionWidth), key).toEqual([key, key, key]);
      const caps = boxes().map((b) => b.style.maxWidth);
      expect(new Set(caps).size, key).toBe(1);
      if (cap === 'none') expect(caps[0], key).toBe('none');
      else expect(caps[0], key).toContain(cap);
    }
  });

  it('a width change alone, and a Full toggle alone, each re-measure the sticky pin', () => {
    // Invariant: changing the width or Full alone (no new items, no session switch) refreshes the pin.
    render(<TooltipProvider><SessionView /></TooltipProvider>);
    const refresh = vi.spyOn(stickyPrompt, 'refresh');
    act(() => setSessionWidth(896));
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => setSessionFull(true));
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
