// The UI modes in the session view. `view`: no composer, no mutating header
// control, no ⋮ menu and no Interrupt; every arm has a `full` control.
// `interact`: the focused root's own controls (Composer, Interrupt, the
// crashed-root Resume, the Ended pane's Resume) come back for that session
// only, while the app-wide ones (ModeToggle, Sync, ⋮) stay hidden.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: vi.fn() }));
vi.mock('@/conversation/ConversationView', () => ({ ConversationView: () => <div /> }));
vi.mock('@/features/composer/Composer', () => ({ Composer: () => <div data-composer /> }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { setUiMode } from '@shared/viewOnly';
import { setFocus } from '@shared/focus';
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
afterEach(() => { cleanup(); setUiMode('full'); setFocus(null); });

// The workers panel reads the session's spawned sessions; answer it (and any other read) with `{}`.
beforeEach(() => { routeFetch({}); });

describe('view-only session view', () => {
  it('no composer', () => {
    // Invariant: an active instance shows no Composer in view-only; the flag off shows it.
    seed({ instances: [inst('A')], activeId: 'A' });
    setUiMode('view');
    const r = renderView();
    expect(document.querySelector('[data-composer]')).toBeNull();
    r.unmount();
    setUiMode('full');
    renderView();
    expect(document.querySelector('[data-composer]')).not.toBeNull();
  });

  it('empty state offers no Start conducting / New project', () => {
    // Invariant: with nothing selected, a spectator gets no button that starts anything; normal mode does.
    setUiMode('view');
    const r = renderView();
    expect(document.querySelector('[data-empty-state]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Start conducting/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /New project/ })).toBeNull();
    r.unmount();
    setUiMode('full');
    renderView();
    expect(screen.getByRole('button', { name: /Start conducting/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /New project/ })).toBeTruthy();
  });

  it('header: no mutating inline controls', () => {
    // Invariant: no Permission mode group, no Sync, no Resume (crashed instance); flag off has all three.
    const crashed = inst('A', { status: 'crashed', displayStatus: 'crashed', worktree: WORKTREE });
    seed({ instances: [crashed], activeId: 'A' });
    setUiMode('view');
    const r = renderView();
    expect(screen.queryByRole('group', { name: 'Permission mode' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sync' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    r.unmount();
    setUiMode('full');
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
        setUiMode('view');
        const r = renderView();
        expect(trigger(), `${c.name}, view-only`).toBeNull();
        r.unmount();
        setUiMode('full');
        renderView();
        expect(trigger(), `${c.name}, flag off`).not.toBeNull();
        cleanup();
      } finally { vi.unstubAllGlobals(); routeFetch({}); }
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
    } finally { vi.unstubAllGlobals(); routeFetch({}); }
  });

  it('turn indicator: Working shown, no Interrupt', () => {
    // Invariant: a running turn still reads "Working…", with no Interrupt / Interrupt now; flag off offers Interrupt.
    seed({ instances: [inst('A', { status: 'turn', displayStatus: 'turn' })], activeId: 'A' });
    setUiMode('view');
    const r = renderView();
    expect(screen.getByText('Working…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Interrupt/ })).toBeNull();
    r.unmount();
    seed({ instances: [inst('A', { status: 'turn', displayStatus: 'turn', interrupting: true })], activeId: 'A' });
    const r2 = renderView();
    expect(screen.queryByRole('button', { name: /Interrupt now/ })).toBeNull();
    r2.unmount();
    setUiMode('full');
    seed({ instances: [inst('A', { status: 'turn', displayStatus: 'turn' })], activeId: 'A' });
    renderView();
    expect(screen.getByRole('button', { name: /Interrupt/ })).toBeTruthy();
  });

  it('ended pane hides Resume', () => {
    // Invariant: an ended session's banner offers no Resume in view-only; with the flag off it does while its place exists.
    const project: Project = { name: 'proj-A', path: '/p', system: 'local', remoteId: null, worktrees: [] } as Project;
    const ended: Instance = { ...inst('A', { status: 'exited', displayStatus: 'exited' }), ended: { source: 'session', worktreeName: null } };
    seed({ projects: [project], ended, activeId: 'A' });
    setUiMode('view');
    const r = renderView();
    const banner = () => within(document.querySelector('[data-session-ended]') as HTMLElement);
    expect(banner().queryByRole('button', { name: 'Resume' })).toBeNull();
    r.unmount();
    setUiMode('full');
    renderView();
    expect(banner().getByRole('button', { name: 'Resume' })).toBeTruthy();
  });
});

describe('interact session view', () => {
  const interact = (sessionId: string) => { setFocus({ sessionId }); setUiMode('interact'); };

  it('the focused root keeps its own controls; the app-wide ones stay hidden', () => {
    // Invariant: under interact the focused session shows the Composer, the
    // crashed-instance Resume and (mid-turn) Interrupt, but no Permission mode
    // group, no Sync and no ⋮.
    const crashed = inst('A', { status: 'crashed', displayStatus: 'crashed', worktree: WORKTREE });
    seed({ instances: [crashed], activeId: 'A' });
    interact('sess-A');
    const r = renderView();
    expect(document.querySelector('[data-composer]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Permission mode' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sync' })).toBeNull();
    r.unmount();
    seed({ instances: [inst('A', { status: 'turn', displayStatus: 'turn', worktree: WORKTREE })], activeId: 'A' });
    renderView();
    expect(screen.getByRole('button', { name: /Interrupt/ })).toBeTruthy();
    expect(trigger()).toBeNull();
  });

  it('any other session stays read-only', () => {
    // Invariant: under interact a session that is not the focused one (a
    // worker) shows no Composer, no Resume and no Interrupt.
    const crashed = inst('W', { status: 'crashed', displayStatus: 'crashed' });
    seed({ instances: [crashed], activeId: 'W' });
    interact('sess-A');
    const r = renderView();
    expect(document.querySelector('[data-composer]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    r.unmount();
    seed({ instances: [inst('W', { status: 'turn', displayStatus: 'turn' })], activeId: 'W' });
    renderView();
    expect(screen.queryByRole('button', { name: /Interrupt/ })).toBeNull();
  });

  it('the controls follow the focus: nothing is interactive while it is null', () => {
    // Invariant: under interact with a null focus (a live run before its root
    // spawned) no session's Composer shows; setting the focus brings it back
    // without a remount.
    seed({ instances: [inst('A')], activeId: 'A' });
    setFocus({ sessionId: null });
    setUiMode('interact');
    renderView();
    expect(document.querySelector('[data-composer]')).toBeNull();
    act(() => { setFocus({ sessionId: 'sess-A' }); });
    expect(document.querySelector('[data-composer]')).not.toBeNull();
  });

  it('the Ended pane offers Resume for the focused root only, and Resume restores then resumes it', async () => {
    // Invariant: under interact the ended focused root's banner offers Resume,
    // which POSTs its restore and then /api/instances with resume = that
    // session; another ended session's banner offers none.
    const project: Project = { name: 'proj-A', path: '/p', system: 'local', remoteId: null, worktrees: [] } as Project;
    const ended: Instance = { ...inst('A', { status: 'exited', displayStatus: 'exited' }), ended: { source: 'session', worktreeName: null } };
    seed({ projects: [project], ended, activeId: 'A' });
    interact('sess-other');
    const r = renderView();
    const banner = () => within(document.querySelector('[data-session-ended]') as HTMLElement);
    expect(banner().queryByRole('button', { name: 'Resume' })).toBeNull();
    r.unmount();
    interact('sess-A');
    const calls = routeFetch({
      'POST /api/projects/proj-A/sessions/sess-A/restore': () => ({ json: { ok: true } }),
      'POST /api/instances': () => ({ json: { id: 'i-new', project: 'proj-A', sessionId: 'sess-A', status: 'idle', mode: 'plan', worktree: null } }),
      'GET /api/': () => ({ json: {} }),
    });
    renderView();
    await act(async () => { fireEvent.click(banner().getByRole('button', { name: 'Resume' })); await new Promise((res) => setTimeout(res, 20)); });
    const posted = calls.filter((c) => c.method === 'POST').map((c) => c.url);
    expect(posted).toEqual(['/api/projects/proj-A/sessions/sess-A/restore', '/api/instances']);
    const resume = calls.find((c) => c.method === 'POST' && c.url === '/api/instances');
    expect(resume?.body).toMatchObject({ project: 'proj-A', resume: 'sess-A' });
  });
});
