// View-only: the session view carries no composer, no mutating header control, no ⋮ menu
// and no Interrupt. Every arm has a flag-off control.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: vi.fn() }));
vi.mock('@/conversation/ConversationView', () => ({ ConversationView: () => <div /> }));
vi.mock('@/features/composer/Composer', () => ({ Composer: () => <div data-composer /> }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { setViewOnly } from '@shared/viewOnly';
import type { Instance, InstanceWorktree, Project } from '@/state/types';
import { routeFetch } from '@/test/routeFetch';
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
const narrowMatchMedia = (query: string) => ({
  media: query, matches: false, onchange: null,
  addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => true,
});
const items = (menu: HTMLElement) => within(menu).queryAllByRole('menuitem').concat(within(menu).queryAllByRole('menuitemcheckbox')).map((e) => e.textContent ?? '');
const has = (menu: HTMLElement, re: RegExp) => items(menu).some((t) => re.test(t));

beforeEach(() => seed());
afterEach(() => { cleanup(); setViewOnly(false); });

// The workers panel reads the session's spawned sessions; answer it (and any other read) with `{}`.
beforeEach(() => { routeFetch({}); });

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

  it('no ⋮ in view-only, for a live, a running and a narrow-screen worktree session', () => {
    // Invariant: view-only renders no "Session actions" trigger whichever arm would show one (idle, running, stopped
    // worktree below md); the flag off renders it in each of those arms.
    const cases: { name: string; instance: Instance; narrow: boolean }[] = [
      { name: 'live idle session', instance: inst('A'), narrow: false },
      { name: 'running turn', instance: inst('A', { status: 'turn', displayStatus: 'turn' }), narrow: false },
      { name: 'stopped worktree session below md', instance: inst('A', { status: 'exited', displayStatus: 'exited', worktree: WORKTREE }), narrow: true },
    ];
    for (const c of cases) {
      if (c.narrow) vi.stubGlobal('matchMedia', narrowMatchMedia);
      try {
        seed({ instances: [c.instance], activeId: 'A' });
        setViewOnly(true);
        const r = renderView();
        expect(trigger(), `${c.name}, view-only`).toBeNull();
        r.unmount();
        setViewOnly(false);
        renderView();
        expect(trigger(), `${c.name}, flag off`).not.toBeNull();
        cleanup();
      } finally { vi.unstubAllGlobals(); }
    }
  });

  it('flag off: ⋮ offers its full item set', async () => {
    // Invariant: with view-only off, the ⋮ of an idle .conduct plan-mode worktree session on a narrow screen lists every
    // item that view-only gates, plus the read items. Guards against the menu losing an item when its gates were removed.
    vi.stubGlobal('matchMedia', narrowMatchMedia);
    try {
      seed({ instances: [inst('A', { project: '.conduct', worktree: WORKTREE })], activeId: 'A' });
      const r = renderView();
      const menu = await openMenu();
      for (const re of [
        /Rename/, /Change model/, /Change effort/, /Prune context/, /Fork session/, /Auto-approve plans/,
        /Enforce playbooks/, /debug capture/, /Sync worktree/, /Terminate/,
        /Summarize session/, /Statistics/, /Show mid-turn statistics/, /Mute notifications/,
      ]) expect(has(menu, re), String(re)).toBe(true);
      r.unmount();
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
