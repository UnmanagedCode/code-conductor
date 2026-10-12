import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { uiStore } from '@/app/ui';
import { conductor, conductorRowOf, hand, labelOf, proj, rowOf, seed, stripEntryOf, stripLabelOf, worker } from '@/test/sidebarFleet';
import { selectOptions } from '@/test/radixSelect';
import { buildWakeStub } from '@/lib/core/wakeCallback.ts';
import { buildForwardFrame } from '@/lib/core/forwardFrame.ts';
import { buildRenewSeed } from '@/lib/core/renewSeed.ts';

vi.mock('@/app/controller', () => ({
  selectInstance: vi.fn(),
  send: vi.fn(),
  refreshProjects: vi.fn(),
  refreshInstances: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []),
  closeSession: vi.fn(),
  resumeSession: vi.fn(),
  promoteSession: vi.fn(),
  removeWorktree: vi.fn(),
}));
vi.mock('@/features/views/AppSwitcher', () => ({ AppSwitcher: () => null }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));

const { AppSidebar } = await import('./AppSidebar');
const { sidebarStore, invalidateSessions } = await import('./state');

const renderSidebar = () => render(<TooltipProvider><AppSidebar /></TooltipProvider>);
/** Lets the lazy session loads resolve and re-render. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** A first prompt as the server stores it: its head, cut by `Instance.prompt` and `readFirstPrompt`. */
const stored = (text: string) => text.slice(0, 200);
const WAKE = stored(buildWakeStub({ targetSessionId: 'labelwake', payloadText: '{"sessionId":"labelwake"}\nWAKE-LABEL prose' }));
const FORWARD = stored(buildForwardFrame({ messages: ['FWD-LABEL body'], instruction: 'FWD-LABEL instruction' }));
const RENEW = stored(buildRenewSeed({ summary: 'RENEW-LABEL summary' }));
/** A person's first prompt, and the label it has always had (whitespace collapsed). */
const HUMAN = 'human:   tidy the\n docs index';
const HUMAN_LABEL = 'human: tidy the docs index';

/** The meaningful head of the wake stub's label. */
const WAKE_LABEL = 'Wake: Worker `labelwake` finished its turn.';
/** Raw machine-prompt syntax no label may carry: the marker, and the forward frame's header. */
const RAW = /\[\[cc:|FORWARDED WORKER OUTPUT/;

/** The buttons whose accessible name contains `text`. */
const named = (text: string) => screen.getAllByRole('button', { name: (n) => n.includes(text) });
const rawNamed = () => screen.queryAllByRole('button', { name: (n) => RAW.test(n) });

beforeEach(() => {
  localStorage.clear();
  invalidateSessions();
  sidebarStore.set({ collapsedSessions: [], expandedConductors: [], inactiveOpen: false, filter: '' });
  uiStore.set({ lens: 'projects' });
  seed();
});

describe('a machine-written first prompt in a sidebar label', () => {
  it('a conductor whose first prompt is a wake stub reads its wake summary, and no button is named with the marker', async () => {
    // Invariant: the Conductors-lens row's text and accessible name carry the wake summary, never the marker.
    uiStore.set({ lens: 'conductors' });
    seed({
      instances: [conductor('cond-wake', { temp: false, firstPrompt: WAKE })],
      conductSessions: [{ sessionId: 'cond-wake', firstPrompt: WAKE, lastActivity: 1 }],
    });
    renderSidebar();
    await settle();
    expect(conductorRowOf('cond-wake').textContent).toContain(WAKE_LABEL);
    expect(conductorRowOf('cond-wake').textContent).not.toMatch(RAW);
    expect(named(WAKE_LABEL).includes(conductorRowOf('cond-wake'))).toBe(true);
    expect(rawNamed()).toHaveLength(0);
  });

  it('a needs-you entry for a hand-spawned session whose first prompt is a wake stub carries the wake summary and no marker in its label or accessible name', async () => {
    // Invariant: the strip entry's visible label, aria-label and tooltip render the wake stub by its summary.
    seed({ projects: [proj('labels')], instances: [hand('h-wake', 'labels', null, { firstPrompt: WAKE })] });
    renderSidebar();
    await settle();
    expect(stripLabelOf('h-wake')!.textContent).toMatch(/^Wake: Worker `labelwake` finished its turn\./);
    expect(stripEntryOf('h-wake').title).not.toMatch(RAW);
    expect(named(WAKE_LABEL).includes(stripEntryOf('h-wake'))).toBe(true);
    expect(rawNamed()).toHaveLength(0);
  });

  it('a Projects-lens session row whose first prompt is a wake stub reads its wake summary, with no marker in its label, tooltip or accessible name', async () => {
    // Invariant: sessionLabel renders the wake stub by its summary; a titled row's tooltip preview does too.
    seed({
      projects: [proj('labels')],
      instances: [
        hand('h-wake', 'labels', null, { firstPrompt: WAKE }),
        hand('h-wake-titled', 'labels', null, { firstPrompt: WAKE, title: 'Titled wake' }),
      ],
    });
    renderSidebar();
    await settle();
    expect(labelOf('h-wake').textContent).toMatch(/^Wake: Worker `labelwake` finished its turn\./);
    expect(named(WAKE_LABEL).includes(rowOf('h-wake'))).toBe(true);
    expect(labelOf('h-wake-titled').textContent).toBe('Titled wake');
    expect(rowOf('h-wake-titled').title).toContain(WAKE_LABEL);
    expect(rowOf('h-wake-titled').title).not.toMatch(RAW);
    expect(rawNamed()).toHaveLength(0);
  });

  it('a session row whose first prompt is a forward frame reads Forwarded worker output', async () => {
    // Invariant: the forward frame is recognised on the server's stored cut, which ends inside its header.
    seed({ projects: [proj('labels')], instances: [hand('h-fwd', 'labels', null, { firstPrompt: FORWARD })] });
    renderSidebar();
    await settle();
    expect(labelOf('h-fwd').textContent).toBe('Forwarded worker output');
    expect(named('Forwarded worker output').includes(rowOf('h-fwd'))).toBe(true);
    expect(rawNamed()).toHaveLength(0);
  });

  it('a session row whose first prompt is a renew seed reads Context renewed', async () => {
    // Invariant: the renew seed is recognised on the server's stored cut, which ends inside its preamble.
    seed({ projects: [proj('labels')], instances: [hand('h-renew', 'labels', null, { firstPrompt: RENEW })] });
    renderSidebar();
    await settle();
    expect(labelOf('h-renew').textContent).toBe('Context renewed');
    expect(named('Context renewed').includes(rowOf('h-renew'))).toBe(true);
    expect(screen.queryAllByRole('button', { name: (n) => n.includes('Your context was just renewed') })).toHaveLength(0);
  });

  it('the conductor filter names a hand-spawned owner whose first prompt is a wake stub by its wake summary', async () => {
    // Invariant: ownerLabel's live-instance branch renders the wake stub by its summary.
    seed({
      projects: [proj('labels')],
      instances: [hand('h-owner', 'labels', null, { firstPrompt: WAKE }), worker('w-owned', 'h-owner', 'labels')],
    });
    renderSidebar();
    await settle();
    selectOptions(screen.getByRole('combobox', { name: 'Filter by conductor' }));
    expect(screen.getAllByRole('option', { name: (n) => n.startsWith(WAKE_LABEL) })).toHaveLength(1);
    expect(screen.queryAllByRole('option', { name: (n) => RAW.test(n) })).toHaveLength(0);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
  });

  it('a human first prompt shows unchanged in the session row, the conductor row and the strip entry', async () => {
    // Invariant (negative control): a person's prompt keeps the label it always had, whitespace collapsed and nothing renamed.
    seed({
      projects: [proj('labels')],
      instances: [hand('h-human', 'labels', null, { firstPrompt: HUMAN }), conductor('cond-human', { temp: false, firstPrompt: HUMAN })],
      conductSessions: [{ sessionId: 'cond-human', firstPrompt: HUMAN, lastActivity: 1 }],
    });
    const { unmount } = renderSidebar();
    await settle();
    expect(labelOf('h-human').textContent).toBe(HUMAN_LABEL);
    expect(stripLabelOf('h-human')!.textContent).toBe(HUMAN_LABEL);
    expect(named(HUMAN_LABEL).includes(rowOf('h-human'))).toBe(true);
    unmount();
    uiStore.set({ lens: 'conductors' });
    renderSidebar();
    await settle();
    expect(named(HUMAN_LABEL).includes(conductorRowOf('cond-human'))).toBe(true);
  });
});
