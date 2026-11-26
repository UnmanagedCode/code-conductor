// The context chip lives in the Composer, so the UI modes decide it: no chip under `view`, and under
// `interact` only for the focused session. (viewOnlySession.test.tsx stubs the Composer out, so the chip
// is checked here against the real one.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: vi.fn() }));
vi.mock('@/conversation/ConversationView', () => ({ ConversationView: () => <div /> }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { setUiMode, setInstanceSessionLookup } from '@shared/viewOnly';
import { setFocus } from '@shared/focus';
import type { Instance } from '@/state/types';
import { routeFetch } from '@/test/routeFetch';
import { contextChipStore } from '@/features/composer/contextChipStore';
import { SessionView } from './SessionView';

const inst = (id: string): Instance => ({
  id, project: `proj-${id}`, status: 'idle', displayStatus: 'idle', sessionId: `sess-${id}`, mode: 'plan',
  model: 'claude-opus-5-5', backend: 'claude', effort: 'high', contextWindowTokens: 200_000,
});
function show(activeId: string) {
  appStore.set({
    connection: 'open', everDropped: false, activeId, sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [inst('A'), inst('B')], ended: null,
  });
  contextChipStore.set({ chips: new Map([[activeId, { title: 'held chip', data: 'd', rev: 1 }]]) });
  return render(<TooltipProvider><SessionView /></TooltipProvider>);
}
const chip = () => document.querySelector('[data-context-chip]');

beforeEach(() => { routeFetch({}); });
afterEach(() => {
  cleanup();
  setUiMode('full');
  setFocus(null);
  setInstanceSessionLookup(null);
  contextChipStore.set({ chips: new Map() });
});

describe('the context chip under the UI modes', () => {
  // Invariant (8): a chip held for the active session is shown in `full`, and gone under `view`.
  it('is shown in full mode and absent under view', () => {
    const r = show('A');
    expect(chip()).not.toBeNull();
    r.unmount();
    setUiMode('view');
    show('A');
    expect(chip()).toBeNull();
  });

  // Invariant (8): under `interact` the chip is shown for the focused session only.
  it('under interact is shown for the focused session and absent for another', () => {
    setInstanceSessionLookup((id) => appStore.get().instances.find((i) => i.id === id)?.sessionId ?? null);
    setFocus({ sessionId: 'sess-A' });
    setUiMode('interact');
    const r = show('A');
    expect(chip()).not.toBeNull();
    r.unmount();
    show('B');
    expect(chip()).toBeNull();
  });
});
