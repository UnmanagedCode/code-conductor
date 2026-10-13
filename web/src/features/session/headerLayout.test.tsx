// The session header's width-dependent layout (Sync in the bar from md up, in
// ⋮ below it), its title block, and its role as the sticky-prompt swipe zone.
// Width comes from a fake matchMedia: happy-dom's own evaluation misses the
// first narrowing change event.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

const sent: [string, any, any][] = [];
vi.mock('@shared/ws', () => ({
  bus: new EventTarget(),
  connect: () => {},
  send: (t: string, payload: any, opts: any = {}) => { sent.push([t, payload, opts]); return opts.ack ? Promise.resolve({ ok: true }) : undefined; },
}));
vi.mock('@/app/sessionActions', async (orig) => ({
  ...(await orig<typeof import('@/app/sessionActions')>()),
  respawnActive: vi.fn(),
  syncWorktree: vi.fn(),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { formatAutoResumeTime } from '@shared/usage';
import { CONDUCTOR_LABEL } from '@shared/conductors';
import { respawnActive, syncWorktree } from '@/app/sessionActions';
import { stickyPrompt } from '@/app/controller';
import { SWIPE_MIN_PX } from '@/conversation/stickyPrompt';
import type { Instance, InstanceWorktree } from '@/state/types';
import { SessionHeader } from './SessionHeader';

// ── fake viewport width ─────────────────────────────────────────────────────

type FakeList = { media: string; matches: boolean; listeners: Set<(e: { matches: boolean }) => void> };
let wide = true;
let lists = new Map<string, FakeList>();
const answer = (query: string) => /min-width/.test(query) && wide;

beforeEach(() => {
  wide = true;
  lists = new Map();
  sent.length = 0;
  vi.mocked(syncWorktree).mockClear();
  vi.mocked(respawnActive).mockClear();
  vi.stubGlobal('matchMedia', (query: string) => {
    let l = lists.get(query);
    if (!l) { l = { media: query, matches: answer(query), listeners: new Set() }; lists.set(query, l); }
    const list = l;
    return {
      media: query,
      get matches() { return list.matches; },
      onchange: null,
      addEventListener: (_t: string, fn: (e: { matches: boolean }) => void) => list.listeners.add(fn),
      removeEventListener: (_t: string, fn: (e: { matches: boolean }) => void) => list.listeners.delete(fn),
      addListener: (fn: (e: { matches: boolean }) => void) => list.listeners.add(fn),
      removeListener: (fn: (e: { matches: boolean }) => void) => list.listeners.delete(fn),
      dispatchEvent: () => true,
    };
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

/** Sets the width before a render (no listener yet) or crosses md under a mounted header. */
function setWide(v: boolean) {
  wide = v;
  act(() => {
    for (const l of lists.values()) {
      const next = answer(l.media);
      if (next === l.matches) continue;
      l.matches = next;
      for (const fn of [...l.listeners]) fn({ matches: next });
    }
  });
}

// ── fixtures ────────────────────────────────────────────────────────────────

const WORKTREE: InstanceWorktree = { worktreeName: 'mobile-compact-header', branch: 'code-conductor/mobile-compact-header', baseBranch: 'main', baseSha: 'abcdef012345', postWorktreeCreate: null };
const TITLE = 'Rework the compact session header so a long title never pushes the controls off a phone screen';

const base = (extra: Partial<Instance> = {}): Instance => ({
  id: 'inst-1', project: 'demo', status: 'idle', displayStatus: 'idle', sessionId: 'sess-1', mode: 'bypassPermissions',
  model: 'claude-opus-5-5', backend: 'claude', effort: 'high', contextWindowTokens: 200_000,
  title: TITLE, worktree: WORKTREE, ...extra,
});
const stopped = (status: 'crashed' | 'exited', extra: Partial<Instance> = {}) => base({ status, displayStatus: status, ...extra });

const tree = (inst: Instance) => <TooltipProvider><SessionHeader inst={inst} onMenu={() => {}} /></TooltipProvider>;
function mountHeader(inst: Instance) {
  const r = render(tree(inst));
  return { ...r, update: (next: Instance) => r.rerender(tree(next)) };
}

const header = () => document.querySelector('[data-session-header]') as HTMLElement;
const trigger = () => screen.queryByRole('button', { name: 'Session actions' });
const barSync = () => within(header()).queryAllByRole('button', { name: 'Sync' });
const menus = () => screen.queryAllByRole('menu');
const itemNames = (menu: HTMLElement) => [...menu.querySelectorAll('[role^="menuitem"]')].map((i) => i.textContent!.trim());

async function openMenu() {
  const t = trigger()!;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20)); // let a previous close settle
    t.focus();
    fireEvent.keyDown(t, { key: 'ArrowDown' });
  });
  return screen.getByRole('menu');
}

/** ⋮'s Sync worktree item: null when ⋮ lacks it, 'no menu' when there is no ⋮. Closes ⋮ again. */
async function menuSync(): Promise<{ disabled: boolean } | null | 'no menu'> {
  if (!trigger()) return 'no menu';
  const menu = await openMenu();
  const item = within(menu).queryByRole('menuitem', { name: 'Sync worktree' });
  const found = item ? { disabled: item.hasAttribute('data-disabled') } : null;
  await act(async () => { fireEvent.keyDown(menu, { key: 'Escape' }); });
  return found;
}

describe('Sync and ⋮ across md', () => {
  it('a stopped worktree session: below md ⋮ holds only Sync worktree; from md up there is no ⋮; without a worktree there is none at any width', async () => {
    for (const status of ['crashed', 'exited'] as const) {
      setWide(false);
      let r = render(tree(stopped(status)));
      expect(trigger(), `${status}, narrow: the trigger`).not.toBeNull();
      expect(itemNames(await openMenu()), `${status}, narrow: the items`).toEqual(['Sync worktree']);
      r.unmount();

      setWide(true);
      r = render(tree(stopped(status)));
      expect(trigger(), `${status}, wide`).toBeNull();
      r.unmount();

      for (const w of [false, true]) {
        setWide(w);
        r = render(tree(stopped(status, { worktree: null })));
        expect(trigger(), `${status}, no worktree, ${w ? 'wide' : 'narrow'}`).toBeNull();
        r.unmount();
      }
    }
  });

  it('Sync is offered exactly once and never disabled, for every status: in the bar from md up, in ⋮ below, and nowhere without a worktree', async () => {
    for (const status of ['idle', 'turn', 'spawning', 'crashed', 'exited']) {
      for (const hasWorktree of [true, false]) {
        const inst = base({ status, displayStatus: status, worktree: hasWorktree ? WORKTREE : null });
        const label = `${status}, ${hasWorktree ? 'worktree' : 'no worktree'}`;

        setWide(true);
        let r = render(tree(inst));
        const bar = barSync();
        expect(bar.length, `${label}, wide: bar Sync`).toBe(hasWorktree ? 1 : 0);
        if (bar.length) expect((bar[0] as HTMLButtonElement).disabled, `${label}, wide: bar Sync enabled`).toBe(false);
        const wideMenu = await menuSync();
        expect(wideMenu === null || wideMenu === 'no menu', `${label}, wide: no Sync worktree in ⋮`).toBe(true);
        r.unmount();

        setWide(false);
        r = render(tree(inst));
        expect(barSync().length, `${label}, narrow: no bar Sync`).toBe(0);
        const narrowMenu = await menuSync();
        if (hasWorktree) expect(narrowMenu, `${label}, narrow: an enabled Sync worktree in ⋮`).toEqual({ disabled: false });
        else expect(narrowMenu === null || narrowMenu === 'no menu', `${label}, narrow: no Sync worktree in ⋮`).toBe(true);
        r.unmount();
      }
    }
  });

  it('no Merge in the header or ⋮ at either width, and Sync runs the worktree sync; from ⋮ it also closes the menu', async () => {
    setWide(true);
    let r = render(tree(base()));
    expect(header().textContent).not.toMatch(/Merge/);
    expect(itemNames(await openMenu()).join('|')).not.toMatch(/Merge/);
    await act(async () => { fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' }); });
    fireEvent.click(barSync()[0]);
    expect(syncWorktree).toHaveBeenCalledTimes(1);
    r.unmount();

    vi.mocked(syncWorktree).mockClear();
    setWide(false);
    r = render(tree(base()));
    expect(header().textContent).not.toMatch(/Merge/);
    const menu = await openMenu();
    expect(itemNames(menu).join('|')).not.toMatch(/Merge/);
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: 'Sync worktree' })); });
    expect(syncWorktree).toHaveBeenCalledTimes(1);
    expect(menus()).toEqual([]);
  });

  it('crossing md moves Sync between the bar and ⋮ with no new session data', async () => {
    setWide(true);
    render(tree(base()));
    expect(barSync()).toHaveLength(1);
    setWide(false);
    expect(barSync()).toHaveLength(0);
    expect(await menuSync()).toEqual({ disabled: false });
    setWide(true);
    expect(barSync()).toHaveLength(1);
    expect(await menuSync()).toBeNull();
  });

  it('widening past md with a stopped worktree session\'s ⋮ open closes it', async () => {
    setWide(false);
    render(tree(stopped('crashed')));
    await openMenu();
    expect(menus()).toHaveLength(1);
    setWide(true);
    expect(menus()).toEqual([]);
    expect(trigger()).toBeNull();
  });

  it('below md an open ⋮ on a crashed worktree session survives a re-render', async () => {
    setWide(false);
    const h = mountHeader(stopped('crashed'));
    const menu = await openMenu();
    h.update(stopped('crashed', { lastResponseAt: 1 }));
    h.update(stopped('crashed', { lastResponseAt: 2 }));
    expect(menu.isConnected).toBe(true);
    expect(menus()).toEqual([menu]);
  });

  it('a dead conductor has no enforcement control at any width', async () => {
    for (const status of ['exited', 'crashed'] as const) {
      for (const worktree of [WORKTREE, null]) {
        for (const w of [false, true]) {
          const label = `${status}, ${worktree ? 'worktree' : 'no worktree'}, ${w ? 'wide' : 'narrow'}`;
          setWide(w);
          const r = render(tree(stopped(status, { project: '.conduct', playbookEnforcement: 'enforce', worktree })));
          if (trigger()) {
            const menu = await openMenu();
            expect(within(menu).queryByRole('menuitemcheckbox', { name: /Enforce playbooks/ }), label).toBeNull();
          }
          expect(screen.queryByText('Enforce playbooks'), label).toBeNull();
          r.unmount();
        }
      }
    }
  });
});

describe('title block', () => {
  const line1 = () => screen.getByRole('heading', { level: 1 }).parentElement!;
  const subline = () => line1().nextElementSibling as HTMLElement | null;
  /** Line 1's elements besides the title (a badge under a tooltip carries the trigger's data-slot, not "badge"). */
  const lineBadges = () => {
    const h1 = screen.getByRole('heading', { level: 1 });
    return [...line1().children].filter((el) => el !== h1) as HTMLElement[];
  };

  it('no TEMP or DEBUG badge at either width; debug capture shows only as the ⋮ item', async () => {
    // Invariant: at either width the header shows no TEMP or DEBUG badge, and a debug session's ⋮ debug-capture item says capture is on, which a non-debug session's does not.
    let seen = 0;
    for (const w of [false, true]) {
      setWide(w);
      const r = render(tree(base({ temp: true, debug: true, debugDir: '/tmp/d' })));
      const where = w ? 'wide' : 'narrow';
      expect([...header().querySelectorAll('*')].filter((el) => /^(temp|debug)$/i.test(el.textContent!.trim())), where).toEqual([]);
      const menu = await openMenu();
      expect(within(menu).getByRole('menuitem', { name: /debug capture/i }).textContent!.trim(), where).toMatch(/debug capture.*\bon\b/i);
      r.unmount();
      seen++;
    }
    expect(seen).toBe(2);
    const off = render(tree(base({ debug: false })));
    const menu = await openMenu();
    expect(within(menu).getByRole('menuitem', { name: /debug capture/i }).textContent!.trim(), 'not debugging').not.toMatch(/\bon\b/i);
    off.unmount();
  });

  it('line 1 holds the title, else the project, and its status badges; the subline holds the project only when titled, and the worktree; no subline without either', () => {
    // Invariant: the h1 names the title, else the project; the status badge is on line 1 and not the subline; the subline names the project only under a title, plus the worktree and its base branch, and is absent with neither.
    const cases = [
      { name: 'title + worktree', inst: stopped('crashed'), lead: TITLE, sub: ['demo', 'mobile-compact-header', 'main'], absent: [] },
      { name: 'no title + worktree', inst: stopped('crashed', { title: null }), lead: 'demo', sub: ['mobile-compact-header', 'main'], absent: ['demo'] },
      { name: 'no title, no worktree', inst: stopped('crashed', { title: null, worktree: null }), lead: 'demo', sub: null, absent: [] },
      { name: 'title, no worktree', inst: stopped('crashed', { worktree: null }), lead: TITLE, sub: ['demo'], absent: ['mobile-compact-header'] },
    ];
    let seen = 0;
    for (const c of cases) {
      const r = render(tree(c.inst));
      const h1 = screen.getByRole('heading', { level: 1 });
      expect(h1.textContent, c.name).toBe(c.lead);
      expect(lineBadges().some((el) => el.textContent!.includes('crashed')), `${c.name}: the status badge is on line 1`).toBe(true);
      const sub = subline()?.textContent ?? null;
      if (c.sub === null) {
        expect(sub, `${c.name}: no subline`).toBeNull();
      } else {
        expect(sub, `${c.name}: a subline`).not.toBeNull();
        for (const s of c.sub) expect(sub, `${c.name}: the subline names ${s}`).toContain(s);
        for (const s of [...c.absent, 'crashed']) expect(sub, `${c.name}: the subline leaves out ${s}`).not.toContain(s);
      }
      r.unmount();
      seen++;
    }
    expect(seen).toBe(cases.length);
  });

  it('a conductor reads Conductor, never .conduct, in line 1 or the subline; a regular project keeps its own name', () => {
    // Invariant: a `.conduct` instance shows CONDUCTOR_LABEL as its project name (line 1 when untitled, the subline when titled) and `.conduct` appears nowhere in the header; a regular project still shows its own name.
    const untitled = render(tree(stopped('crashed', { project: '.conduct', title: null, worktree: null })));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(CONDUCTOR_LABEL);
    expect(header().textContent).not.toContain('.conduct');
    untitled.unmount();
    const titled = render(tree(stopped('crashed', { project: '.conduct', worktree: null })));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(TITLE);
    expect(subline()!.textContent).toContain(CONDUCTOR_LABEL);
    expect(header().textContent).not.toContain('.conduct');
    titled.unmount();
    render(tree(stopped('crashed', { title: null, worktree: null })));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('demo');
  });

  it('Stopping… and the overage auto-resume badge show on line 1, not on the subline', () => {
    // Invariant: an interrupting turn with an armed resume shows a Stopping badge and a resume badge with its full time and queued count on line 1, and neither on the subline.
    const T = 1_900_000_000;
    render(tree(base({ status: 'turn', displayStatus: 'turn', interrupting: true, autoResumeAt: T, queuedCount: 2 })));
    const texts = lineBadges().map((el) => el.textContent ?? '');
    expect(texts.some((t) => /Stopping/.test(t))).toBe(true);
    expect(texts.find((t) => t.includes(formatAutoResumeTime(T)!))).toMatch(/\b2 queued\b/);
    expect(subline()!.textContent).not.toMatch(/Stopping|resumes|queued/);
  });

  it('an armed session\'s badge reads its full resume time and queued count with its tooltip; clearing the resume removes it', async () => {
    // Invariant: an armed resume puts a line-1 badge with the full resume time; with messages queued the badge and its tooltip count them, with none neither mentions a queue; the tooltip says it will resume; clearing the resume removes the badge.
    const T = 1_900_000_000;
    const resumeBadge = () => lineBadges().find((el) => el.textContent!.includes(formatAutoResumeTime(T)!));
    const tooltip = async () => {
      await act(async () => { fireEvent.focus(resumeBadge()!); });
      return (await screen.findByRole('tooltip')).textContent;
    };
    let r = render(tree(base({ autoResumeAt: T, queuedCount: 3 })));
    expect(resumeBadge()!.textContent).toMatch(/\b3 queued\b/);
    const queued = await tooltip();
    expect(queued).toMatch(/3 messages queued/);
    expect(queued).toMatch(/resume/i);
    r.unmount();

    const h = mountHeader(base({ autoResumeAt: T, queuedCount: 0 }));
    expect(resumeBadge()!.textContent).not.toMatch(/queued/);
    const empty = await tooltip();
    expect(empty).not.toMatch(/queued/);
    expect(empty).toMatch(/resume/i);
    h.update(base({ autoResumeAt: null, queuedCount: 0 }));
    expect(resumeBadge()).toBeUndefined();
    expect(header().textContent).not.toContain('resumes at');
  });

  it('the title block\'s DOM is identical below and above md', () => {
    const html = (w: boolean) => {
      setWide(w);
      const r = render(tree(base({ autoResumeAt: 1_900_000_000, queuedCount: 1 })));
      const out = screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.innerHTML;
      r.unmount();
      return out;
    };
    const narrow = html(false);
    expect(narrow).toContain(TITLE);
    expect(html(true)).toBe(narrow);
  });
});

describe('swipe zone', () => {
  let reveal: ReturnType<typeof vi.spyOn>;
  let conceal: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    reveal = vi.spyOn(stickyPrompt, 'reveal').mockImplementation(() => {});
    conceal = vi.spyOn(stickyPrompt, 'conceal').mockImplementation(() => {});
  });
  afterEach(() => { reveal.mockRestore(); conceal.mockRestore(); });

  /** A touch event as stickyPrompt.test.ts dispatches one; cancelable, so a preventDefault would show. */
  function touch(target: Element, type: string, points: { x: number; y: number }[]) {
    const ev = new Event(type, { bubbles: true, cancelable: true }) as any;
    Object.defineProperty(ev, 'touches', { value: points.map((p) => ({ clientX: p.x, clientY: p.y })) });
    target.dispatchEvent(ev);
    return ev as Event;
  }
  function swipe(target: Element, dir: 'down' | 'up') {
    const dy = (SWIPE_MIN_PX + 20) * (dir === 'down' ? 1 : -1);
    touch(target, 'touchstart', [{ x: 0, y: 0 }]);
    touch(target, 'touchmove', [{ x: 0, y: dy }]);
    touch(target, 'touchend', []);
  }
  const calls = () => [reveal.mock.calls.length, conceal.mock.calls.length];

  it('a vertical swipe starting on any bar element reveals (down) or conceals (up)', () => {
    render(tree(base()));
    const targets: [string, Element][] = [
      ['the title', screen.getByRole('heading', { level: 1 })],
      ['the worktree name', screen.getByText('mobile-compact-header')],
      ['Code', screen.getByRole('button', { name: 'Code' })],
      ['the ⋮ trigger', trigger()!],
      ['the header itself', header()],
    ];
    for (const [name, el] of targets) {
      reveal.mockClear();
      conceal.mockClear();
      swipe(el, 'down');
      expect(calls(), `${name}: down`).toEqual([1, 0]);
      swipe(el, 'up');
      expect(calls(), `${name}: up`).toEqual([1, 1]);
    }
  });

  it('a swipe starting on a ⋮ item never reaches the header', async () => {
    setWide(false);
    render(tree(base()));
    const menu = await openMenu();
    const item = within(menu).getByRole('menuitem', { name: 'Sync worktree' });
    swipe(item, 'down');
    swipe(item, 'up');
    expect(calls()).toEqual([0, 0]);
  });

  it('a tap on a bar button neither reveals nor is blocked', async () => {
    render(tree(base()));
    const plan = screen.getByRole('button', { name: 'Plan' });
    const start = touch(plan, 'touchstart', [{ x: 0, y: 0 }]);
    touch(plan, 'touchend', []);
    expect(calls()).toEqual([0, 0]);
    expect(start.defaultPrevented).toBe(false);
    await act(async () => { fireEvent.click(plan); });
    expect(sent).toEqual([['mode', { id: 'inst-1', mode: 'plan' }, { ack: true }]]);
  });

  it('with ⋮ open, a swipe on the bar still reveals', async () => {
    render(tree(base()));
    await openMenu();
    swipe(screen.getByRole('heading', { level: 1 }), 'down');
    expect(menus()).toHaveLength(1);
    expect(calls()).toEqual([1, 0]);
  });
});

describe('Resume', () => {
  it('a crashed or exited session offers Resume, which calls respawnActive; a live or switching session does not', () => {
    for (const status of ['crashed', 'exited'] as const) {
      vi.mocked(respawnActive).mockClear();
      const r = render(tree(stopped(status)));
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
      expect(respawnActive, status).toHaveBeenCalledTimes(1);
      r.unmount();
    }
    for (const [name, inst] of [
      ['idle', base()],
      ['exited mid-switch', stopped('exited', { modelSwitch: { from: 'a', to: 'b' } })],
    ] as const) {
      const r = render(tree(inst));
      expect(screen.queryByRole('button', { name: 'Resume' }), name).toBeNull();
      r.unmount();
    }
  });
});
