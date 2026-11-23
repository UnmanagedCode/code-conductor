// View-only: the session view carries no composer, no mutating header control and
// no Interrupt; the read-only items stay. Every arm has a flag-off control.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: vi.fn() }));
vi.mock('@/conversation/ConversationView', () => ({ ConversationView: () => <div /> }));
vi.mock('@/features/composer/Composer', () => ({ Composer: () => <div data-composer /> }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { setViewOnly } from '@shared/viewOnly';
import type { Instance, InstanceWorktree, Project } from '@/state/types';
import { SessionView } from './SessionView';

const WORKTREE: InstanceWorktree = { worktreeName: 'wt-a', branch: 'code-conductor/wt-a', baseBranch: 'main', baseSha: 'abcdef012345', postWorktreeCreate: null };
const inst = (id: string, extra: Partial<Instance> = {}): Instance => ({
  id, project: `proj-${id}`, status: 'idle', displayStatus: 'idle', sessionId: `sess-${id}`, mode: 'plan',
  model: 'claude-opus-5-5', backend: 'claude', effort: 'high', contextWindowTokens: 200_000, ...extra,
});
function seed(over: Partial<ReturnType<typeof appStore.get>> = {}) {
  appStore.set({
    connection: 'open', everDropped: false, activeId: null, sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [], ended: null,
    ...over,
  });
}
const renderView = () => render(<TooltipProvider><SessionView /></TooltipProvider>);
const trigger = () => screen.queryByRole('button', { name: 'Session actions' });
async function openMenu() {
  const t = trigger()!;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
    t.focus();
    fireEvent.keyDown(t, { key: 'ArrowDown' });
  });
  return screen.getByRole('menu');
}
const items = (menu: HTMLElement) => within(menu).queryAllByRole('menuitem').concat(within(menu).queryAllByRole('menuitemcheckbox')).map((e) => e.textContent ?? '');
const has = (menu: HTMLElement, re: RegExp) => items(menu).some((t) => re.test(t));

beforeEach(() => seed());
afterEach(() => { cleanup(); setViewOnly(false); });

describe('view-only session view', () => {
  it('no composer', () => {
    // Invariant: an active instance shows no Composer in view-only; the flag off shows it.
    seed({ instances: [inst('A')], activeId: 'A' });
    setViewOnly(true);
    const r = renderView();
    expect(document.querySelector('[data-composer]')).toBeNull();
    r.unmount();
    setViewOnly(false);
    renderView();
    expect(document.querySelector('[data-composer]')).not.toBeNull();
  });

  it('empty state offers no Start conducting / New project', () => {
    // Invariant: with nothing selected, a spectator gets no button that starts anything; normal mode does.
    setViewOnly(true);
    const r = renderView();
    expect(document.querySelector('[data-empty-state]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Start conducting/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /New project/ })).toBeNull();
    r.unmount();
    setViewOnly(false);
    renderView();
    expect(screen.getByRole('button', { name: /Start conducting/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /New project/ })).toBeTruthy();
  });

  it('header: no mutating inline controls', () => {
    // Invariant: no Permission mode group, no Sync, no Resume (crashed instance); flag off has all three.
    const crashed = inst('A', { status: 'crashed', displayStatus: 'crashed', worktree: WORKTREE });
    seed({ instances: [crashed], activeId: 'A' });
    setViewOnly(true);
    const r = renderView();
    expect(screen.queryByRole('group', { name: 'Permission mode' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sync' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    r.unmount();
    setViewOnly(false);
    renderView();
    expect(screen.getByRole('group', { name: 'Permission mode' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sync' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
  });

  it('header menu keeps read items only', async () => {
    // Invariant: ⋮ holds Summarize, Statistics, mid-turn statistics and Mute; none of the mutating items. Flag off holds them all.
    seed({ instances: [inst('A', { project: '.conduct' })], activeId: 'A' });
    setViewOnly(true);
    const r = renderView();
    let menu = await openMenu();
    for (const re of [/Summarize session/, /Statistics/, /Show mid-turn statistics/, /Mute notifications/]) expect(has(menu, re), String(re)).toBe(true);
    for (const re of [/Rename/, /Change model/, /Change effort/, /Prune context/, /Fork session/, /Auto-approve plans/, /Enforce playbooks/, /debug capture/, /Interrupt|Terminate/]) {
      expect(has(menu, re), String(re)).toBe(false);
    }
    r.unmount();
    cleanup();
    setViewOnly(false);
    renderView();
    menu = await openMenu();
    for (const re of [/Rename/, /Change model/, /Change effort/, /Prune context/, /Fork session/, /Auto-approve plans/, /Enforce playbooks/, /debug capture/, /Terminate/]) {
      expect(has(menu, re), String(re)).toBe(true);
    }
  });

  it('a stopped worktree session on a narrow screen has no ⋮ in view-only', () => {
    // Invariant: the worktree-only ⋮ exists for Sync alone, so it is absent in view-only and present otherwise.
    vi.stubGlobal('matchMedia', (query: string) => ({
      media: query, matches: false, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => true,
    }));
    try {
      seed({ instances: [inst('A', { status: 'exited', displayStatus: 'exited', worktree: WORKTREE })], activeId: 'A' });
      setViewOnly(true);
      const r = renderView();
      expect(trigger()).toBeNull();
      r.unmount();
      setViewOnly(false);
      renderView();
      expect(trigger()).not.toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });

  it('turn indicator: Working shown, no Interrupt', () => {
    // Invariant: a running turn still reads "Working…", with no Interrupt / Interrupt now; flag off offers Interrupt.
    seed({ instances: [inst('A', { status: 'turn', displayStatus: 'turn' })], activeId: 'A' });
    setViewOnly(true);
    const r = renderView();
    expect(screen.getByText('Working…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Interrupt/ })).toBeNull();
    r.unmount();
    seed({ instances: [inst('A', { status: 'turn', displayStatus: 'turn', interrupting: true })], activeId: 'A' });
    const r2 = renderView();
    expect(screen.queryByRole('button', { name: /Interrupt now/ })).toBeNull();
    r2.unmount();
    setViewOnly(false);
    seed({ instances: [inst('A', { status: 'turn', displayStatus: 'turn' })], activeId: 'A' });
    renderView();
    expect(screen.getByRole('button', { name: /Interrupt/ })).toBeTruthy();
  });

  it('ended pane hides Resume', () => {
    // Invariant: an ended session's banner offers no Resume in view-only; with the flag off it does while its place exists.
    const project: Project = { name: 'proj-A', path: '/p', system: 'local', remoteId: null, worktrees: [] } as Project;
    const ended: Instance = { ...inst('A', { status: 'exited', displayStatus: 'exited' }), ended: { source: 'session', worktreeName: null } };
    seed({ projects: [project], ended, activeId: 'A' });
    setViewOnly(true);
    const r = renderView();
    const banner = () => within(document.querySelector('[data-session-ended]') as HTMLElement);
    expect(banner().queryByRole('button', { name: 'Resume' })).toBeNull();
    r.unmount();
    setViewOnly(false);
    renderView();
    expect(banner().getByRole('button', { name: 'Resume' })).toBeTruthy();
  });
});
