// The per-call usage lines and the Statistics box that shows them: hidden by default,
// shown and hidden again by the box, per session, following the session to a new
// instance, landing on the session the dialog was opened on, and never shown by
// debug capture or for a session with no id yet.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/core/ws.js', () => ({ bus: new EventTarget(), connect: () => {}, send: () => {} }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { bus } from '@/lib/core/ws.js';
import { conversation, lazyHistory, selectInstance, startController, stopController } from '@/app/controller';
import { isCallUsageShown, setCallUsageShown } from '@/app/ui';
import { appStore } from '@/state/app';
import type { Instance, UiEvent } from '@/state/types';
import { closeDialog, openStatsDialog } from '@/features/dialogs/api';
import { StatsDialog } from '@/features/dialogs/SessionDialogs';
import { ConversationView } from './ConversationView';
import { flush } from './renderModel';
import { text, tool } from './testkit';

const SESSIONS = ['sA', 'sB'];
const inst = (id: string, sessionId: string | null, extra: Partial<Instance> = {}): Instance =>
  ({ id, project: 'p', status: 'idle', sessionId, mode: 'default', ...extra });

/** A turn with two API calls, each followed by its usage line: one in the action group, one after the reply. */
const TURN: UiEvent[] = [
  { kind: 'user_echo', text: 'go', userIndex: 0 },
  ...tool('m1', 0, 'tu1', 'Read'),
  { kind: 'call_usage', msgId: 'm1', promptTokens: 40_000, growthTokens: 1_000, outputTokens: 200 },
  ...text('m2', 0, 'reply'),
  { kind: 'call_usage', msgId: 'm2', promptTokens: 41_000, growthTokens: 1_000, outputTokens: 90 },
];

async function frame(type: string, detail: object) {
  act(() => { bus.dispatchEvent(new CustomEvent(type, { detail })); });
  await flush();
}
const mount = () => {
  const r = render(<TooltipProvider><ConversationView /><StatsDialog /></TooltipProvider>);
  return r.container.querySelector('[data-conversation]') as HTMLElement;
};
/** Whether the transcript shows its per-call lines, after a fixture check that it has some to show. */
function shown(root: HTMLElement): string | null {
  expect(root.querySelectorAll('[data-call-usage-line]').length, 'fixture check: the per-call lines are rendered').toBeGreaterThan(0);
  return root.getAttribute('data-call-usage');
}
async function select(id: string, events: UiEvent[] = TURN) {
  act(() => { selectInstance(id); });
  await frame('snapshot', { id, events });
}
const box = () => screen.getByRole('checkbox', { name: 'Show mid-turn statistics' });
async function openStats(sessionId: string) {
  act(() => { openStatsDialog(sessionId); });
  await flush();
}
async function clickBox() {
  fireEvent.click(box());
  await flush();
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ own: {}, rolled: {} }) })));
  act(() => { appStore.set({ instances: [inst('iA', 'sA'), inst('iB', 'sB')], activeId: null }); });
  startController();
});

afterEach(() => {
  act(() => { closeDialog('stats'); });
  stopController();
  vi.unstubAllGlobals();
  act(() => {
    for (const s of SESSIONS) setCallUsageShown(s, false);
    appStore.set({ instances: [], activeId: null });
    conversation.clear();
    lazyHistory.reset();
  });
});

describe('the Statistics box', () => {
  it('opens unticked with the lines hidden; ticking it shows the lines already on screen, unticking hides them again', async () => {
    const root = mount();
    await select('iA');
    expect(shown(root)).toBe('hidden');
    await openStats('sA');
    expect(box().getAttribute('aria-checked')).toBe('false');
    await clickBox();
    expect(box().getAttribute('aria-checked')).toBe('true');
    expect(shown(root)).toBe('shown');
    await clickBox();
    expect(shown(root)).toBe('hidden');
  });

  it('is per session: each session keeps its own tick, whichever is shown', async () => {
    const root = mount();
    await select('iA');
    act(() => { setCallUsageShown('sA', true); });
    expect(shown(root), 'A ticked').toBe('shown');
    await select('iB');
    expect(shown(root), 'B opens unticked').toBe('hidden');
    act(() => { setCallUsageShown('sB', true); });
    act(() => { setCallUsageShown('sA', false); });
    expect(shown(root), 'B ticked alone').toBe('shown');
    await select('iA');
    expect(shown(root), 'back on A: its own untick').toBe('hidden');
    expect([isCallUsageShown('sA'), isCallUsageShown('sB')]).toEqual([false, true]);
  });

  it('a tick made in the dialog opened on A lands on A, even after B became the session shown', async () => {
    const root = mount();
    await select('iA');
    await openStats('sA');
    await select('iB');
    await clickBox();
    expect([isCallUsageShown('sA'), isCallUsageShown('sB')]).toEqual([true, false]);
    expect(shown(root), 'B, on screen, stays hidden').toBe('hidden');
    await select('iA');
    expect(shown(root)).toBe('shown');
  });

  it('follows the session to a new instance with the same session id', async () => {
    const root = mount();
    await select('iA');
    act(() => { setCallUsageShown('sA', true); });
    act(() => { appStore.set({ instances: [inst('iA2', 'sA'), inst('iB', 'sB')] }); });
    await select('iA2');
    expect(appStore.get().activeId, 'fixture check: a new instance is shown').toBe('iA2');
    expect(shown(root)).toBe('shown');
  });
});

describe('what never shows the lines', () => {
  it('debug capture: a session that starts with it on, and one that turns it on mid-session', async () => {
    const root = mount();
    act(() => { appStore.set({ instances: [inst('iA', 'sA', { debug: true }), inst('iB', 'sB')] }); });
    await select('iA');
    expect(shown(root), 'started with debug on').toBe('hidden');
    await select('iB');
    act(() => { appStore.set({ instances: [inst('iA', 'sA', { debug: true }), inst('iB', 'sB', { debug: true })] }); });
    await flush();
    expect(shown(root), 'debug turned on mid-session').toBe('hidden');
    act(() => { setCallUsageShown('sB', true); });
    expect(shown(root), 'positive control: the tick still shows them').toBe('shown');
  });

  it('a session with no id yet, even with a tick recorded for no id', async () => {
    const root = mount();
    act(() => { appStore.set({ instances: [inst('iN', null)] }); });
    await select('iN');
    act(() => { setCallUsageShown(null, true); });
    expect(isCallUsageShown(null)).toBe(false);
    expect(shown(root)).toBe('hidden');
  });
});
