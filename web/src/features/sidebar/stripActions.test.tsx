// The needs-you strip entry's own actions: the ×, what it is named and sends, and the armed auto-resume badge.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { uiStore } from '@/app/ui';
import { CLOSE_TITLES } from '@/lib/core/closeAction.js';
import { entryReason } from '@/lib/core/needsYou.js';
import { autoResumeBadge } from '@/lib/core/usage.js';
import { conductor, conductorRowOf, hand, proj, seed, stripBadgeOf, stripClosesOf, stripEntryOf, stripSids, wt } from '@/test/sidebarFleet';

const selectInstance = vi.fn();
vi.mock('@/app/controller', () => ({
  selectInstance: (...a: unknown[]) => selectInstance(...a),
  send: vi.fn(),
  refreshProjects: vi.fn(),
  refreshInstances: vi.fn(),
}));
const loadSessions = vi.fn((..._a: any[]): Promise<any[]> => Promise.resolve([]));
const closeSession = vi.fn();
const resumeSession = vi.fn();
const removeWorktree = vi.fn();
const promoteSession = vi.fn();
vi.mock('@/app/sessionActions', () => ({
  loadSessions: (...a: unknown[]) => loadSessions(...a),
  closeSession: (...a: unknown[]) => closeSession(...a),
  resumeSession: (...a: unknown[]) => resumeSession(...a),
  promoteSession: (...a: unknown[]) => promoteSession(...a),
  removeWorktree: (...a: unknown[]) => removeWorktree(...a),
}));
vi.mock('@/features/views/AppSwitcher', () => ({ AppSwitcher: () => null }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));

const { AppSidebar } = await import('./AppSidebar');
const { sidebarStore, invalidateSessions } = await import('./state');

const renderSidebar = () => render(<TooltipProvider><AppSidebar /></TooltipProvider>);
/** Lets the lazy session loads resolve and re-render. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const reseed = (over: Parameters<typeof seed>[0]) => act(() => seed(over));
const ask = (awaitingUser: 'question' | 'plan', awaitingUserSource: 'tool' | 'text') => ({ awaitingUser, awaitingUserSource });
/** A strip entry's ×: the one button in its row besides the entry. */
const closeOf = (sid: string) => {
  const xs = stripClosesOf(sid);
  expect(xs, `${sid}: one ×`).toHaveLength(1);
  return xs[0];
};
const T = 1_900_000_000;

beforeEach(() => {
  localStorage.clear();
  selectInstance.mockReset();
  closeSession.mockReset();
  resumeSession.mockReset();
  removeWorktree.mockReset();
  promoteSession.mockReset();
  loadSessions.mockReset().mockResolvedValue([]);
  invalidateSessions();
  sidebarStore.set({ collapsedSessions: [], expandedWorktrees: [], expandedWorkspaces: [], expandedConductors: [], inactiveOpen: false, filter: '' });
  uiStore.set({ lens: 'conductors' });
  location.hash = '';
  seed();
});

describe('the strip ×', () => {
  it('every strip entry, conductor or hand-spawned and in every group, has exactly one × outside its entry button', async () => {
    // Invariant: each entry row carries one close action, named for stop or archive, and it is not part of the entry button that opens the session.
    seed({
      projects: [proj('p')],
      instances: [conductor('C1'), conductor('C2', { status: 'turn' }), conductor('C3', ask('plan', 'tool')), hand('h1', 'p'), hand('h2', 'p', null, ask('question', 'text'))],
    });
    renderSidebar();
    await settle();
    expect([...stripSids('waiting'), ...stripSids('running'), ...stripSids('finished')].sort()).toEqual(['C1', 'C2', 'C3', 'h1', 'h2']);
    for (const sid of ['C1', 'C2', 'C3', 'h1', 'h2']) {
      const x = closeOf(sid);
      expect(Object.values(CLOSE_TITLES), sid).toContain(x.getAttribute('aria-label'));
      expect(stripEntryOf(sid).contains(x), sid).toBe(false);
    }
  });

  it('the strip × is named Stop session on a live persistent entry and Archive session on a live temp one, for conductors and hand-spawned sessions', async () => {
    // Invariant: the × names the action the session's state maps to, for both entry kinds.
    seed({
      projects: [proj('p')],
      instances: [conductor('Cp', { temp: false }), conductor('Ct', { temp: true }), hand('hp', 'p', null, { temp: false }), hand('ht', 'p', null, { temp: true })],
    });
    renderSidebar();
    await settle();
    expect(closeOf('Cp').getAttribute('aria-label')).toBe(CLOSE_TITLES.stop);
    expect(closeOf('hp').getAttribute('aria-label')).toBe(CLOSE_TITLES.stop);
    expect(closeOf('Ct').getAttribute('aria-label')).toBe(CLOSE_TITLES.archive);
    expect(closeOf('ht').getAttribute('aria-label')).toBe(CLOSE_TITLES.archive);
  });

  it('making a session persistent re-names the same × node and keeps the same entry node', async () => {
    // Invariant: a temp flip re-labels the × in place, for a conductor and a hand-spawned entry, and neither the × nor the entry is re-created.
    seed({ projects: [proj('p')], instances: [conductor('A', { temp: true }), hand('h', 'p', null, { temp: true })] });
    renderSidebar();
    await settle();
    const x = { A: closeOf('A'), h: closeOf('h') };
    const entry = { A: stripEntryOf('A'), h: stripEntryOf('h') };
    expect(x.A.getAttribute('aria-label')).toBe(CLOSE_TITLES.archive);
    expect(x.h.getAttribute('aria-label')).toBe(CLOSE_TITLES.archive);
    reseed({ projects: [proj('p')], instances: [conductor('A', { temp: false }), hand('h', 'p', null, { temp: false })] });
    for (const sid of ['A', 'h'] as const) {
      expect(closeOf(sid), sid).toBe(x[sid]);
      expect(stripEntryOf(sid), sid).toBe(entry[sid]);
      expect(x[sid].getAttribute('aria-label'), sid).toBe(CLOSE_TITLES.stop);
    }
  });

  it('a strip × after a crash and resume closes the new instance id from the same × node', async () => {
    // Invariant: the × reads its entry's current instance at click time.
    seed({ projects: [proj('p')], instances: [conductor('C1')] });
    renderSidebar();
    await settle();
    const node = closeOf('C1');
    reseed({ projects: [proj('p')], instances: [conductor('C1', { id: 'i-C1-b' })] });
    expect(closeOf('C1')).toBe(node);
    fireEvent.click(node);
    expect(closeSession.mock.calls.map((c) => (c[0] as { instanceId: string }).instanceId)).toEqual(['i-C1-b']);
  });
});

describe("a strip × closes through closeSession with the entry's facts and never selects or resumes", () => {
  /** Clicks the entry (the select spy fires), clears the spies, then clicks the ×. */
  function closeVia(sid: string) {
    fireEvent.click(stripEntryOf(sid));
    expect(selectInstance, 'positive control: the entry selects').toHaveBeenCalledTimes(1);
    selectInstance.mockReset();
    fireEvent.click(closeOf(sid));
  }

  it('a live persistent conductor', async () => {
    // Invariant: the close payload names the conductor's .conduct place, its live instance and its titled preview; no disk row makes it synthetic.
    sidebarStore.set({ inactiveOpen: true });
    seed({
      projects: [proj('p')],
      conductSessions: [{ sessionId: 'D', title: 'Done', lastActivity: 1 }],
      instances: [conductor('A', { title: 'Alpha', temp: false })],
    });
    renderSidebar();
    await settle();
    fireEvent.click(conductorRowOf('D'));
    expect(resumeSession, 'positive control: an inactive conductor resumes').toHaveBeenCalledTimes(1);
    resumeSession.mockReset();
    closeVia('A');
    expect(closeSession.mock.calls).toEqual([[
      { projectName: '.conduct', worktreeName: null, sessionId: 'A', instanceId: 'i-A', status: 'idle', temp: false, preview: 'Alpha', synthetic: true },
    ]]);
    expect(selectInstance).not.toHaveBeenCalled();
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it('a live temp conductor with a transcript on disk', async () => {
    // Invariant: a conductor listed on disk is not synthetic, and its busy status and merged title travel in the payload.
    seed({
      projects: [proj('p')],
      conductSessions: [{ sessionId: 'B', title: 'Beta', lastActivity: 1 }],
      instances: [conductor('B', { status: 'turn' })],
    });
    renderSidebar();
    await settle();
    closeVia('B');
    expect(closeSession.mock.calls).toEqual([[
      { projectName: '.conduct', worktreeName: null, sessionId: 'B', instanceId: 'i-B', status: 'turn', temp: true, preview: 'Beta', synthetic: false },
    ]]);
    expect(selectInstance).not.toHaveBeenCalled();
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it('a hand-spawned session in a worktree', async () => {
    // Invariant: a hand-spawned entry closes in its own project and worktree, as a persistent non-synthetic session.
    seed({ projects: [proj('p', { worktrees: [wt('wt')] })], instances: [hand('h', 'p', 'wt', { title: 'Hand', temp: false })] });
    renderSidebar();
    await settle();
    closeVia('h');
    expect(closeSession.mock.calls).toEqual([[
      { projectName: 'p', worktreeName: 'wt', sessionId: 'h', instanceId: 'i-h', status: 'idle', temp: false, preview: 'Hand', synthetic: false },
    ]]);
    expect(selectInstance).not.toHaveBeenCalled();
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it('a hand-spawned temp session is synthetic: its transcript is never listed while it lives', async () => {
    // Invariant: a live temp hand-spawned session closes as temp and synthetic, in its main checkout.
    seed({ projects: [proj('p')], instances: [hand('ht', 'p', null, { title: 'HT', temp: true })] });
    renderSidebar();
    await settle();
    closeVia('ht');
    expect(closeSession.mock.calls).toEqual([[
      { projectName: 'p', worktreeName: null, sessionId: 'ht', instanceId: 'i-ht', status: 'idle', temp: true, preview: 'HT', synthetic: true },
    ]]);
    expect(selectInstance).not.toHaveBeenCalled();
    expect(resumeSession).not.toHaveBeenCalled();
  });
});

describe('the armed auto-resume badge', () => {
  it('an armed entry shows the compact auto-resume badge, updated in place and dropped on clear while the entry stays', async () => {
    // Invariant: the badge renders the compact resume form with the queued count while armed, follows the count on the same node, and goes with the armed resume; an unarmed entry has none.
    const compact = (queuedCount: number) => autoResumeBadge({ autoResumeAt: T, queuedCount }, { compact: true })!;
    expect(compact(2).text, 'fixture: the count shows in the compact form').not.toBe(compact(0).text);
    seed({ projects: [proj('p')], instances: [conductor('A', { title: 'Am', autoResumeAt: T, queuedCount: 2 }), conductor('B', { title: 'Bm' })] });
    renderSidebar();
    await settle();
    const entry = stripEntryOf('A');
    const badge = stripBadgeOf('A')!;
    expect(badge.textContent).toBe(compact(2).text);
    expect(badge.title).toBe(compact(2).title);
    expect(stripBadgeOf('B')).toBeNull();
    reseed({ projects: [proj('p')], instances: [conductor('A', { title: 'Am', autoResumeAt: T, queuedCount: 0 })] });
    expect(stripBadgeOf('A')).toBe(badge);
    expect(badge.textContent).toBe(compact(0).text);
    reseed({ projects: [proj('p')], instances: [conductor('A', { title: 'Am', autoResumeAt: null, queuedCount: 0 })] });
    expect(stripBadgeOf('A')).toBeNull();
    expect(stripEntryOf('A')).toBe(entry);
  });

  it('an armed hand-spawned strip entry carries the badge too', async () => {
    // Invariant: hand-spawned entries carry the badge as conductor entries do; an unarmed one does not.
    seed({ projects: [proj('p')], instances: [hand('h', 'p', null, { autoResumeAt: T, queuedCount: 1 }), hand('g', 'p')] });
    renderSidebar();
    await settle();
    expect([...stripSids('finished')].sort()).toEqual(['g', 'h']);
    expect(stripBadgeOf('h')!.textContent).toBe(autoResumeBadge({ autoResumeAt: T, queuedCount: 1 }, { compact: true })!.text);
    expect(stripBadgeOf('g')).toBeNull();
  });

  it("an armed entry's accessible name carries the full resume wording, and an unarmed one's does not", async () => {
    // Invariant: the accessible name replaces the entry's content, so it carries the full resume form while armed and stays the label and reason otherwise.
    const full = autoResumeBadge({ autoResumeAt: T, queuedCount: 2 })!.text;
    seed({ projects: [proj('p')], instances: [conductor('A', { title: 'Am', autoResumeAt: T, queuedCount: 2 }), conductor('B', { title: 'Bm' })] });
    renderSidebar();
    await settle();
    expect(stripEntryOf('A').getAttribute('aria-label')).toContain('Am');
    expect(stripEntryOf('A').getAttribute('aria-label')).toContain(full);
    expect(stripEntryOf('B').getAttribute('aria-label')).toContain('Bm');
    expect(stripEntryOf('B').getAttribute('aria-label')).not.toContain(full);
    expect(stripEntryOf('B').getAttribute('aria-label')!.endsWith(entryReason({ status: 'idle' }, 'finished')), 'the unarmed name ends at its reason').toBe(true);
  });
});
