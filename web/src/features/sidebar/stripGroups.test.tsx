// The needs-you strip's groups and entries: which live top-level sessions it lists and where, what an entry
// reads and says, what a click opens, and that the conductor filter leaves it alone.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { uiStore } from '@/app/ui';
import { entryReason, needsYouTitle } from '@shared/needsYou';
import { chooseOption } from '@/test/radixSelect';
import {
  conductor, conductorRowOf, hand, proj, seed, stripEntryOf, stripGroups, stripHeadCounts, stripLabelOf, stripSids, worker,
} from '@/test/sidebarFleet';

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
const strip = () => document.querySelector('[data-strip]');
/** Every group the strip lists `sid` in. */
const groupsOf = (sid: string) => stripGroups().filter((g) => stripSids(g!).includes(sid));
const dotOf = (sid: string) => stripEntryOf(sid).querySelector('[data-dot]') as HTMLElement;
const projectNames = () => [...document.querySelectorAll('[data-project-list] [data-project-row]')].map((e) => e.getAttribute('data-project-row'));

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

describe('which sessions the strip lists', () => {
  it('the strip shows for an idle or a busy top-level session and renders nothing for no session or conducted workers only', async () => {
    // Invariant: the strip exists while any live top-level session (a conductor or a hand-spawned one, in any state) sits in a group; a conducted worker, even one asking, never does.
    seed({ projects: [proj('p')], instances: [hand('h0', 'p')] });
    renderSidebar();
    await settle();
    expect(stripSids('finished')).toEqual(['h0']);
    reseed({ projects: [proj('p')], instances: [] });
    expect(strip()).toBeNull();
    reseed({ projects: [proj('p')], instances: [worker('w1', 'X', 'p'), worker('w2', 'X', 'p', null, { status: 'turn', ...ask('question', 'tool') })] });
    expect(strip()).toBeNull();
    reseed({ projects: [proj('p')], instances: [hand('h1', 'p', null, { status: 'turn' }), hand('h2', 'p', null, { status: 'spawning' })] });
    expect(strip()).not.toBeNull();
    expect(stripGroups()).toEqual(['running']);
    expect([...stripSids('running')].sort()).toEqual(['h1', 'h2']);
    expect(groupsOf('h1')).toEqual(['running']);
    reseed({ projects: [proj('p')], instances: [worker('w', 'X', 'p', null, { status: 'turn' }), hand('h3', 'p', null, { status: 'turn' })] });
    expect(stripSids('running')).toEqual(['h3']);
  });

  it('groups render Waiting → Running → Finished with their counts, each entry in exactly one group, and a group that empties is omitted', async () => {
    // Invariant: the group order is fixed whatever order the sessions arrive in; each live top-level session is in one group only; a head counts its group; an empty group is not rendered.
    seed({
      projects: [proj('p')],
      instances: [
        hand('g', 'p'),
        conductor('F', { title: 'F' }),
        hand('h', 'p', null, { title: 'h', ...ask('question', 'text') }),
        conductor('R', { title: 'R', status: 'turn' }),
        conductor('F2', { title: 'F2' }),
        conductor('W', { title: 'W', ...ask('plan', 'tool') }),
      ],
    });
    renderSidebar();
    await settle();
    expect(stripGroups()).toEqual(['waiting', 'running', 'finished']);
    expect(stripSids('waiting')).toEqual(['W', 'h']);
    expect(stripSids('running')).toEqual(['R']);
    expect([...stripSids('finished')].sort()).toEqual(['F', 'F2', 'g']);
    for (const sid of ['g', 'F', 'h', 'R', 'F2', 'W']) expect(groupsOf(sid), sid).toHaveLength(1);
    expect(stripHeadCounts('waiting')).toEqual([2]);
    expect(stripHeadCounts('running')).toEqual([1]);
    expect(stripHeadCounts('finished')).toEqual([3]);
    reseed({ projects: [proj('p')], instances: [conductor('F', { title: 'F' })] });
    expect(stripGroups()).toEqual(['finished']);
    expect(stripHeadCounts('finished')).toEqual([1]);
  });

  it('a conductor entry takes its merged title from the disk row over its live first prompt', async () => {
    // Invariant: a conductor's strip label is its merged title; one with no disk row keeps its own first prompt.
    seed({
      projects: [proj('p')],
      conductSessions: [{ sessionId: 'A', title: 'Disk title', lastActivity: 1 }],
      instances: [conductor('A', { firstPrompt: 'live prompt A' }), conductor('B', { firstPrompt: 'live prompt B' })],
    });
    renderSidebar();
    await settle();
    expect(stripLabelOf('A')!.textContent).toBe('Disk title');
    expect(stripLabelOf('B')!.textContent).toBe('live prompt B');
  });

  it('the strip ignores the conductor filter: Hand-spawned only and a selected conductor narrow the Projects lens and leave the strip unchanged', async () => {
    // Invariant: the filter narrows the project list (positive control) while every strip group keeps the same entries.
    uiStore.set({ lens: 'projects' });
    seed({
      projects: [proj('p'), proj('q')],
      instances: [conductor('A', ask('plan', 'tool')), conductor('B', { title: 'Bravo', status: 'turn' }), worker('w', 'B', 'q'), hand('h', 'p')],
    });
    renderSidebar();
    await settle();
    const snapshot = () => ({ w: stripSids('waiting'), r: stripSids('running'), f: stripSids('finished') });
    expect(snapshot()).toEqual({ w: ['A'], r: ['B'], f: ['h'] });
    expect(projectNames()).toEqual(['p', 'q']);
    const trigger = () => screen.getByRole('combobox', { name: 'Filter by conductor' });
    chooseOption(trigger(), 'Hand-spawned only');
    await settle();
    expect(sidebarStore.get().filter).toBe('hand');
    expect(projectNames()).toEqual(['p']);
    expect(snapshot()).toEqual({ w: ['A'], r: ['B'], f: ['h'] });
    chooseOption(trigger(), 'Bravo');
    await settle();
    expect(sidebarStore.get().filter).toBe('B');
    expect(projectNames()).toEqual(['q']);
    expect(snapshot()).toEqual({ w: ['A'], r: ['B'], f: ['h'] });
  });
});

describe('what an entry says', () => {
  it('an entry shows its label alone; its title and accessible name carry the label and its reason, and the three asks read distinctly', async () => {
    // Invariant: no run or ask state is visible text; the tooltip and accessible name name the label and the group's reason, and question, plan approval and a text ask give three different reasons.
    seed({
      projects: [proj('p')],
      instances: [
        conductor('Q', { title: 'Qm', ...ask('question', 'tool') }),
        conductor('P', { title: 'Pm', ...ask('plan', 'tool') }),
        conductor('T', { title: 'Tm', ...ask('question', 'text') }),
        conductor('R', { title: 'Rm', status: 'turn' }),
        conductor('F', { title: 'Fm' }),
      ],
    });
    renderSidebar();
    await settle();
    const want: [string, string, string][] = [
      ['Q', 'Qm', entryReason({ status: 'idle', ...ask('question', 'tool') }, 'waiting')],
      ['P', 'Pm', entryReason({ status: 'idle', ...ask('plan', 'tool') }, 'waiting')],
      ['T', 'Tm', entryReason({ status: 'idle', ...ask('question', 'text') }, 'waiting')],
      ['R', 'Rm', entryReason({ status: 'turn' }, 'running')],
      ['F', 'Fm', entryReason({ status: 'idle' }, 'finished')],
    ];
    expect(new Set(want.map(([, , r]) => r)).size, 'fixture: five different reasons').toBe(5);
    for (const [sid, label, reason] of want) {
      const e = stripEntryOf(sid);
      expect(e.textContent, sid).toBe(label);
      expect(e.textContent, sid).not.toContain(reason);
      expect(e.getAttribute('aria-label'), sid).toContain(label);
      expect(e.getAttribute('aria-label'), sid).toContain(reason);
      expect(e.title, sid).toContain(label);
      expect(e.title, sid).toContain(reason);
    }
    expect(new Set(['Q', 'P', 'T'].map((s) => stripEntryOf(s).getAttribute('aria-label'))).size).toBe(3);
  });

  it('Waiting dots are marked as needing you over their run state — idle, in a turn or on a worker — and Running and Finished dots are not, an idle wait on a worker or a job still reading as one', async () => {
    // Invariant: a Waiting entry's dot carries the needs-you mark and still reads its own run state; no Running or Finished dot carries the mark, and an idle Running dot says what it waits on.
    seed({
      projects: [proj('p')],
      instances: [
        conductor('WI', ask('question', 'tool')),
        conductor('WT', { status: 'turn', ...ask('question', 'text') }),
        conductor('WA', { awaitingWake: true, ...ask('plan', 'tool') }),
        conductor('RT', { status: 'turn' }),
        conductor('RA', { awaitingWake: true }),
        conductor('RJ', { waitingOnJob: true }),
        conductor('F'),
      ],
    });
    renderSidebar();
    await settle();
    expect([...stripSids('waiting')].sort()).toEqual(['WA', 'WI', 'WT']);
    expect([...stripSids('running')].sort()).toEqual(['RA', 'RJ', 'RT']);
    expect(stripSids('finished')).toEqual(['F']);
    const marks = (sid: string) => ({ state: dotOf(sid).getAttribute('data-dot'), needsYou: dotOf(sid).getAttribute('data-needs-you') });
    expect(marks('WI')).toEqual({ state: 'idle', needsYou: 'true' });
    expect(marks('WT')).toEqual({ state: 'turn', needsYou: 'true' });
    expect(marks('WA')).toEqual({ state: 'idle', needsYou: 'true' });
    expect(dotOf('WA').title).toBe(needsYouTitle({ status: 'idle', awaitingWake: true, waitingOnJob: false, ...ask('plan', 'tool') }));
    expect(dotOf('WT').title).toBe(needsYouTitle({ status: 'turn', awaitingWake: false, waitingOnJob: false, ...ask('question', 'text') }));
    expect(marks('RT')).toEqual({ state: 'turn', needsYou: null });
    expect(marks('RA')).toEqual({ state: 'idle', needsYou: null });
    expect(marks('RJ')).toEqual({ state: 'idle', needsYou: null });
    expect(marks('F')).toEqual({ state: 'idle', needsYou: null });
    // An idle dot waiting on a worker or a job reads differently from a plain idle one, and from each other.
    expect(new Set(['RA', 'RJ', 'F'].map((s) => dotOf(s).title)).size).toBe(3);
    expect(stripEntryOf('RA').getAttribute('aria-label')).toContain(entryReason({ status: 'idle', awaitingWake: true }, 'running'));
    expect(stripEntryOf('RJ').getAttribute('aria-label')).toContain(entryReason({ status: 'idle', waitingOnJob: true }, 'running'));
  });

  it('a hand-spawned session in a turn is a Running entry like a conductor\'s, without the needs-you mark and without the owner bar', async () => {
    // Invariant: a busy hand-spawned session renders in Running with its turn dot and the Running reason, and only the conductor entry carries the owner colour.
    seed({ projects: [proj('p')], instances: [conductor('CT', { status: 'turn' }), hand('HT', 'p', null, { status: 'turn' })] });
    renderSidebar();
    await settle();
    expect(stripSids('running')).toEqual(['CT', 'HT']);
    expect(groupsOf('HT')).toEqual(['running']);
    expect(dotOf('HT').getAttribute('data-dot')).toBe('turn');
    expect(dotOf('HT').hasAttribute('data-needs-you')).toBe(false);
    expect(stripEntryOf('HT').getAttribute('aria-label')).toContain(entryReason({ status: 'turn' }, 'running'));
    expect(stripEntryOf('CT').style.getPropertyValue('--owner-color')).not.toBe('');
    expect(stripEntryOf('HT').style.getPropertyValue('--owner-color')).toBe('');
  });
});

describe('opening from the strip', () => {
  it('a click selects the live instance with a user gesture and never resumes a session', async () => {
    // Invariant: an entry click selects its live instance; the resume spy, proven live by an inactive conductor row, records nothing from the strip.
    sidebarStore.set({ inactiveOpen: true });
    seed({
      projects: [proj('p')],
      conductSessions: [{ sessionId: 'D', title: 'Done', lastActivity: 1 }],
      instances: [conductor('C1', ask('plan', 'tool')), hand('h1', 'p')],
    });
    renderSidebar();
    await settle();
    fireEvent.click(conductorRowOf('D'));
    expect(resumeSession).toHaveBeenCalledTimes(1);
    resumeSession.mockReset();
    selectInstance.mockReset();
    fireEvent.click(stripEntryOf('C1'));
    fireEvent.click(stripEntryOf('h1'));
    expect(selectInstance.mock.calls).toEqual([['i-C1', { userGesture: true }], ['i-h1', { userGesture: true }]]);
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it('a click after a crash and resume selects the new instance id from the same entry node', async () => {
    // Invariant: the entry survives its instance changing and its click reads the current instance id, never the first render's.
    seed({ projects: [proj('p')], instances: [conductor('C1')] });
    renderSidebar();
    await settle();
    const node = stripEntryOf('C1');
    reseed({ projects: [proj('p')], instances: [conductor('C1', { id: 'i-C1-b' })] });
    expect(stripEntryOf('C1')).toBe(node);
    fireEvent.click(node);
    expect(selectInstance.mock.calls).toEqual([['i-C1-b', { userGesture: true }]]);
  });
});

describe('live changes', () => {
  it('a live flip moves an entry Waiting → Running → Finished, one group at a time, and the strip goes when its last session dies', async () => {
    // Invariant: the entry follows its session's state into exactly one group each time; the needs-you mark goes with the ask; a dead last session empties the strip.
    seed({ projects: [proj('p')], instances: [conductor('A', ask('question', 'text'))] });
    renderSidebar();
    await settle();
    expect(groupsOf('A')).toEqual(['waiting']);
    expect(dotOf('A').getAttribute('data-needs-you')).toBe('true');
    reseed({ projects: [proj('p')], instances: [conductor('A', { status: 'turn', awaitingUser: null, awaitingUserSource: null })] });
    expect(groupsOf('A')).toEqual(['running']);
    reseed({ projects: [proj('p')], instances: [conductor('A')] });
    expect(groupsOf('A')).toEqual(['finished']);
    expect(dotOf('A').hasAttribute('data-needs-you')).toBe(false);
    reseed({ projects: [proj('p')], instances: [conductor('A', { status: 'exited' })] });
    expect(strip()).toBeNull();
  });

  it('unread Finished entries are marked, counted in the head and say so in their reason; a read entry is not; viewing clears the mark and the count', async () => {
    // Invariant: a Finished entry with an unseen turn end carries the unread mark and the unread reason and is counted; a read one has neither; the count follows viewing and goes at zero.
    const fixture = (u: Record<string, unknown> = {}) => [
      conductor('U', { title: 'Um', turnEndSeq: 2, viewedSeq: 1, ...u }),
      hand('h', 'p', null, { title: 'hm', turnEndSeq: 1, viewedSeq: 0 }),
      conductor('S', { title: 'Sm', turnEndSeq: 2, viewedSeq: 2 }),
    ];
    const unreadReason = entryReason({ status: 'idle' }, 'finished', true);
    expect(unreadReason, 'fixture: the unread reason differs').not.toBe(entryReason({ status: 'idle' }, 'finished', false));
    seed({ projects: [proj('p')], instances: fixture() });
    renderSidebar();
    await settle();
    expect(stripEntryOf('U').getAttribute('data-unread')).toBe('true');
    expect(stripEntryOf('h').getAttribute('data-unread')).toBe('true');
    expect(stripEntryOf('S').hasAttribute('data-unread')).toBe(false);
    expect(stripHeadCounts('finished')).toEqual([3, 2]);
    expect(stripEntryOf('U').getAttribute('aria-label')).toContain(unreadReason);
    expect(stripEntryOf('U').title).toContain(unreadReason);
    expect(stripEntryOf('S').getAttribute('aria-label')).not.toContain(unreadReason);
    reseed({ projects: [proj('p')], instances: fixture({ viewedSeq: 2 }) });
    expect(stripEntryOf('U').hasAttribute('data-unread')).toBe(false);
    expect(stripEntryOf('U').getAttribute('aria-label')).not.toContain(unreadReason);
    expect(stripHeadCounts('finished')).toEqual([3, 1]);
    reseed({ projects: [proj('p')], instances: fixture({ viewedSeq: 2 }).filter((i) => i.sessionId !== 'h') });
    expect(stripHeadCounts('finished')).toEqual([2]);
  });

  it('unread counters on Waiting and Running entries mark nothing, while a Finished one is marked', async () => {
    // Invariant: only Finished reads unread; a Waiting or Running entry with an unseen turn end carries no mark and its head only its count.
    seed({
      projects: [proj('p')],
      instances: [
        conductor('W', { title: 'Wm', turnEndSeq: 3, viewedSeq: 0, ...ask('question', 'tool') }),
        conductor('R', { title: 'Rm', status: 'turn', turnEndSeq: 3, viewedSeq: 0 }),
        conductor('F', { title: 'Fm', turnEndSeq: 3, viewedSeq: 0 }),
      ],
    });
    renderSidebar();
    await settle();
    expect(stripEntryOf('F').getAttribute('data-unread')).toBe('true');
    expect(stripEntryOf('W').hasAttribute('data-unread')).toBe(false);
    expect(stripEntryOf('R').hasAttribute('data-unread')).toBe(false);
    expect(stripHeadCounts('waiting')).toEqual([1]);
    expect(stripHeadCounts('running')).toEqual([1]);
    expect(stripHeadCounts('finished')).toEqual([1, 1]);
  });
});
