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
vi.mock('@/conversation/ConversationView', () => ({ ConversationView: ({ empty }: { empty: React.ReactNode }) => <div data-conversation-empty>{empty}</div> }));
vi.mock('@/features/composer/Composer', () => ({ Composer: ({ usageSlot }: { usageSlot: React.ReactNode }) => <div>{usageSlot}</div> }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { accountUsageStore, refreshAccountUsage } from '@/app/accountUsage';
import { rateLimits } from '@/app/trackers';
import type { Instance, InstanceWorktree } from '@/state/types';
import { SessionView } from './SessionView';
import { CONDUCTOR_LABEL } from '@shared/conductors';

const WORKTREE: InstanceWorktree = { worktreeName: 'wt-a', branch: 'code-conductor/wt-a', baseBranch: 'main', baseSha: 'abcdef012345', postWorktreeCreate: null };
const inst = (id: string, extra: Partial<Instance> = {}): Instance => ({
  id, project: `proj-${id}`, status: 'idle', displayStatus: 'idle', sessionId: `sess-${id}`, mode: 'bypassPermissions',
  model: 'claude-opus-5-5', backend: 'claude', effort: 'high', contextWindowTokens: 200_000, ...extra,
});

function seed(over: Partial<ReturnType<typeof appStore.get>> = {}) {
  appStore.set({
    connection: 'open', everDropped: false, activeId: null, sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [], ended: null,
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
  // Invariant: an ended pane's header offers nothing that addresses its (gone)
  // instance — no Resume (respawn), no Sync in the bar or in ⋮ — while the same
  // exited instance still listed offers them.
  it.each([true, false])('an ended instance\'s header has no Resume, Sync or ⋮; a listed exited one has them (wide: %s)', (wide) => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      media: query, matches: wide, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => true,
    }));
    try {
      const exited = inst('A', { status: 'exited', displayStatus: 'exited', worktree: WORKTREE });
      seed({ instances: [exited], activeId: 'A' });
      const r = renderView();
      expect(screen.getByRole('button', { name: 'Resume' }), 'control: a listed exited session offers Resume').toBeTruthy();
      if (wide) expect(screen.getByRole('button', { name: 'Sync' }), 'control: Sync in the bar').toBeTruthy();
      else expect(trigger(), 'control: ⋮ holds Sync').not.toBeNull();
      r.unmount();
      seed({ instances: [], ended: { ...exited, ended: { source: 'instance', worktreeName: 'wt-a' } }, activeId: 'A' });
      renderView();
      expect(header()).not.toBeNull();
      expect(document.querySelector('[data-session-ended]')).not.toBeNull();
      for (const name of ['Resume', 'Sync', 'Session actions']) {
        expect(within(header()!).queryByRole('button', { name }), name).toBeNull();
      }
    } finally { vi.unstubAllGlobals(); }
  });

  it('an active id with no backing instance renders no header: no ⋮, mode toggle, Sync, Change model or Change effort, and nothing is sent', () => {
    seed({ instances: [inst('A', { worktree: WORKTREE })], activeId: 'A' });
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
    const a = inst('A', { worktree: WORKTREE });
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
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(CONDUCTOR_LABEL);
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

describe('the logo', () => {
  /** What would hide `el` or an ancestor, as far as happy-dom can see: the `hidden` attribute, a hiding computed style or presentation attribute, or a hiding Tailwind utility (no stylesheet is loaded). */
  const hiders = (el: Element) => {
    const out: string[] = [];
    for (let e: Element | null = el; e; e = e.parentElement) {
      const style = getComputedStyle(e);
      const name = `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}`;
      if (e.hasAttribute('hidden')) out.push(`${name}[hidden]`);
      if (style.display === 'none' || e.getAttribute('display') === 'none') out.push(`${name} display:none`);
      if (style.visibility === 'hidden' || e.getAttribute('visibility') === 'hidden') out.push(`${name} visibility:hidden`);
      for (const prop of ['opacity', 'fill-opacity']) {
        if (Number(style.getPropertyValue(prop) || 1) === 0 || Number(e.getAttribute(prop) ?? 1) === 0) out.push(`${name} ${prop}:0`);
      }
      for (const c of e.classList) if (/^(hidden|invisible|opacity-0|fill-transparent|sr-only)$/.test(c)) out.push(`${name}.${c}`);
    }
    return out;
  };
  /** Whether the mark in `scope` blinks; its cursor is drawn and nothing hides it, either way. */
  const blinks = (scope: Element | null) => {
    const cursor = scope?.querySelector('svg[data-logo="mark"] [data-logo-cursor]');
    expect(cursor, 'the mark draws its cursor').toBeTruthy();
    expect(hiders(cursor!), 'nothing hides the cursor').toEqual([]);
    return cursor!.classList.contains('animate-cursor-blink');
  };
  /** Steps the connection under the mounted view, asserting `scope`'s mark blinks only while it is open. */
  const followsConnection = (scope: () => Element | null) => {
    for (const [connection, blinking] of [['connecting', false], ['open', true], ['reconnecting', false], ['open', true]] as const) {
      act(() => appStore.set({ connection }));
      expect(blinks(scope()), connection).toBe(blinking);
    }
  };

  it('control: the visibility probe sees every hiding form it checks', () => {
    // Invariant (of the helper): each form `hiders` lists is one happy-dom reports, on the element or an ancestor; a plain one reports none.
    const host = document.createElement('div');
    host.innerHTML = '<svg><g id="plain"><rect/></g><g style="display:none"><rect/></g><g display="none"><rect/></g><g style="visibility:hidden"><rect/></g>'
      + '<g visibility="hidden"><rect/></g><g style="opacity:0"><rect/></g><g opacity="0"><rect/></g><g fill-opacity="0"><rect/></g><g hidden><rect/></g>'
      + '<g class="hidden"><rect/></g><g class="invisible"><rect/></g><g class="opacity-0"><rect/></g></svg>';
    document.body.append(host);
    try {
      const rects = [...host.querySelectorAll('rect')];
      expect(hiders(rects[0])).toEqual([]);
      expect(rects.slice(1).filter((r) => hiders(r).length === 0).map((r) => r.parentElement!.outerHTML.slice(0, 40))).toEqual([]);
    } finally { host.remove(); }
  });

  it('on the landing the cursor blinks while the socket is open and holds still while it connects or reconnects', () => {
    // Invariant: the landing mark's blink follows connection === 'open', live, under the mounted view, and its cursor stays drawn and visible in every state.
    seed({ connection: 'connecting' });
    renderView();
    followsConnection(() => document.querySelector('[data-empty-state]'));
  });

  it('in an empty chat the cursor follows the connection the same way', () => {
    // Invariant: the empty-conversation mark blinks only while the socket is open, its cursor drawn and visible in every state.
    seed({ connection: 'connecting', instances: [inst('A')], activeId: 'A' });
    renderView();
    expect(document.querySelector('[data-empty-state]'), 'fixture check: a session, not the landing').toBeNull();
    followsConnection(() => document.querySelector('[data-conversation-empty]'));
  });
});
