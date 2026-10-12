// The session view mounts the header only for a live active instance, keyed by
// it: what the header shows (and whether its ⋮ stays open) as the active
// session and its data change.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

const sent: [string, any, any][] = [];
vi.mock('@shared/ws', () => ({
  bus: new EventTarget(),
  connect: () => {},
  send: (t: string, payload: any, opts: any = {}) => { sent.push([t, payload, opts]); return opts.ack ? Promise.resolve({ ok: true }) : undefined; },
}));
vi.mock('@/conversation/ConversationView', () => ({ ConversationView: () => null }));
vi.mock('@/features/composer/Composer', () => ({ Composer: ({ usageSlot }: { usageSlot: React.ReactNode }) => <div>{usageSlot}</div> }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { accountUsageStore, refreshAccountUsage } from '@/app/accountUsage';
import { rateLimits } from '@/app/trackers';
import type { Instance } from '@/state/types';
import { SessionView } from './SessionView';

const WORKTREE = { worktreeName: 'wt-a', baseBranch: 'main' };
const inst = (id: string, extra: Partial<Instance> = {}): Instance => ({
  id, project: `proj-${id}`, status: 'idle', displayStatus: 'idle', sessionId: `sess-${id}`, mode: 'bypassPermissions',
  model: 'claude-opus-5-5', backend: 'claude', effort: 'high', contextWindowTokens: 200_000, ...extra,
});

function seed(over: Partial<ReturnType<typeof appStore.get>> = {}) {
  appStore.set({
    connection: 'open', everDropped: false, activeId: null, sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [],
    ...over,
  });
}
/** Replaces instance `id` with a new object carrying `extra`. */
const patch = (id: string, extra: Partial<Instance>) => act(() => {
  appStore.set((s) => ({ instances: s.instances.map((i) => (i.id === id ? { ...i, ...extra } : i)) }));
});

const renderView = () => render(<TooltipProvider><SessionView /></TooltipProvider>);
const header = () => document.querySelector('[data-session-header]') as HTMLElement | null;
const trigger = () => screen.queryByRole('button', { name: 'Session actions' });
const menus = () => screen.queryAllByRole('menu');
async function openMenu() {
  const t = trigger()!;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20)); // let a previous close settle
    t.focus();
    fireEvent.keyDown(t, { key: 'ArrowDown' });
  });
  return screen.getByRole('menu');
}

beforeEach(() => {
  sent.length = 0;
  seed();
});

describe('SessionView', () => {
  it('an active id with no backing instance renders no header: no ⋮, mode toggle, Sync, Change model or Change effort, and nothing is sent', () => {
    seed({ instances: [inst('A', { worktree: WORKTREE as any })], activeId: 'A' });
    renderView();
    expect(header()).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Sync' })).toBeTruthy();
    act(() => appStore.set({ instances: [] }));
    expect(appStore.get().activeId).toBe('A');
    expect(header()).toBeNull();
    for (const name of ['Session actions', 'Plan', 'Code', 'Sync']) expect(screen.queryByRole('button', { name }), name).toBeNull();
    expect(screen.queryByText(/Change model|Change effort/)).toBeNull();
    expect(sent).toEqual([]);
  });

  it('selecting the live instance again brings the header back with an enabled ⋮ and Change model', async () => {
    const a = inst('A', { worktree: WORKTREE as any });
    seed({ instances: [a], activeId: 'A' });
    renderView();
    act(() => appStore.set({ instances: [] }));
    expect(header()).toBeNull();
    act(() => appStore.set({ instances: [a] }));
    expect(header()).not.toBeNull();
    expect((trigger() as HTMLButtonElement).disabled).toBe(false);
    const model = within(await openMenu()).getByRole('menuitem', { name: /Change model/ });
    expect(model.hasAttribute('data-disabled')).toBe(false);
  });

  it('an open ⋮ survives session-data updates for the same session', async () => {
    seed({ instances: [inst('A')], activeId: 'A' });
    renderView();
    const menu = await openMenu();
    patch('A', { lastResponseAt: 1 });
    patch('A', { status: 'turn', displayStatus: 'turn' });
    patch('A', { status: 'idle', displayStatus: 'idle', lastResponseAt: 2 });
    expect(menu.isConnected).toBe(true);
    expect(menus()).toEqual([menu]);
  });

  it('an open ⋮ closes when its session stops being menu-eligible, and opens fresh afterwards', async () => {
    seed({ instances: [inst('A')], activeId: 'A' });
    renderView();
    await openMenu();
    patch('A', { status: 'exited', displayStatus: 'exited' });
    expect(menus()).toEqual([]);
    expect(trigger()).toBeNull();
    patch('A', { status: 'idle', displayStatus: 'idle' });
    expect(menus()).toEqual([]);
    const menu = await openMenu();
    expect(within(menu).getByRole('menuitem', { name: /Change model/ })).toBeTruthy();
  });

  it('switching the active session under an open ⋮ closes it; the new session\'s ⋮ opens and survives updates', async () => {
    seed({ instances: [inst('A'), inst('B', { project: '.conduct' })], activeId: 'A' });
    renderView();
    await openMenu();
    act(() => appStore.set({ activeId: 'B' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('.conduct');
    expect(menus()).toEqual([]);
    const menu = await openMenu();
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Enforce playbooks/ })).toBeTruthy();
    patch('B', { lastResponseAt: 1 });
    expect(menu.isConnected).toBe(true);
    expect(menus()).toEqual([menu]);
  });

  it('the usage chip exists only with an active session; a fetch landing without one stores the value and renders no chip', async () => {
    rateLimits.reset();
    accountUsageStore.set({ usage: null, stale: false });
    const usage = { five_hour: { utilization: 45 } };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ usage, stale: false }) })));
    try {
      seed({ instances: [inst('A')], activeId: null });
      renderView();
      await act(async () => { await refreshAccountUsage(); });
      expect(accountUsageStore.get()).toEqual({ usage, stale: false });
      expect(screen.queryByRole('button', { name: 'Usage details' })).toBeNull();
      act(() => appStore.set({ activeId: 'A' }));
      expect(screen.getByRole('button', { name: 'Usage details' }).textContent).toContain('45%');
    } finally {
      vi.unstubAllGlobals();
      rateLimits.reset();
      accountUsageStore.set({ usage: null, stale: false });
    }
  });
});
