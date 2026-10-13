// The session column's three boxes (transcript list, sticky pin, bottom column)
// share one width preset; ConversationView is real here.
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
import { cycleSessionWidth, sessionWidthStore } from '@/app/sessionWidth';
import type { Instance } from '@/state/types';
import { SessionView } from './SessionView';

const inst: Instance = {
  id: 'A', project: 'proj-A', status: 'idle', displayStatus: 'idle', sessionId: 'sess-A', mode: 'bypassPermissions',
  model: 'claude-opus-5-5', backend: 'claude', effort: 'high', contextWindowTokens: 200_000,
};

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionWidthStore.set({ preset: 'normal' });
  appStore.set({
    connection: 'open', everDropped: false, activeId: 'A', sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [inst],
  });
});

const boxes = () => [...document.querySelectorAll<HTMLElement>('[data-session-width]')];

describe('the session column', () => {
  it('every column box follows the preset together', () => {
    // Invariant: transcript, pin and composer column are exactly three boxes and all report the same preset after each cycle.
    render(<TooltipProvider><SessionView /></TooltipProvider>);
    expect(boxes().map((b) => b.dataset.sessionWidth)).toEqual(['normal', 'normal', 'normal']);
    for (const want of ['wide', 'full', 'normal']) {
      act(() => cycleSessionWidth());
      expect(boxes().map((b) => b.dataset.sessionWidth), want).toEqual([want, want, want]);
    }
  });

  it('a preset change re-measures the sticky pin', () => {
    // Invariant: changing the preset alone (no new items, no session switch) refreshes the pin.
    render(<TooltipProvider><SessionView /></TooltipProvider>);
    const refresh = vi.spyOn(stickyPrompt, 'refresh');
    act(() => cycleSessionWidth());
    expect(refresh).toHaveBeenCalled();
  });
});
