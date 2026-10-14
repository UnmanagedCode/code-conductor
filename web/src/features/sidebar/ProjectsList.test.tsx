import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { uiStore } from '@/app/ui';
import { formatAutoResumeTime } from '@shared/usage';

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
const { sidebarStore, invalidateSessions, agoTick } = await import('./state');
const { closeDialog, dialogStore } = await import('@/features/dialogs/api');
const { viewStore } = await import('@/features/views/api');

const inst = (o: Record<string, any>): any => ({ id: `i-${o.sessionId}`, status: 'idle', mode: 'plan', ...o });

function seed(over: Partial<ReturnType<typeof appStore.get>> = {}) {
  appStore.set({
    connection: 'open', everDropped: false, activeId: null, sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [],
    ...over,
  });
}

const renderSidebar = () => render(<TooltipProvider><AppSidebar /></TooltipProvider>);
const proj = (name: string, over: Record<string, any> = {}): any => ({
  name, path: `/p/${name}`, workspace: null, system: 'local', remoteId: null, isGitRepo: false, worktrees: [],
  sessions: { count: 0, archivedCount: 0, handCount: 0, lastActivity: 0 }, ...over,
}) as any;
const wt = (name: string, over: Record<string, any> = {}): any => ({
  worktreeName: name, branch: `cc/${name}`, baseBranch: 'main', baseSha: 'deadbeef0000', sessions: { count: 0, lastActivity: 0 }, ...over,
});
const disk = (sessionId: string, firstPrompt: string, over: Record<string, any> = {}) => ({ sessionId, firstPrompt, lastActivity: 1, ...over });
/** Disk rows per place: `''` is the main checkout, otherwise the worktree name. */
const byPlace = (rows: Record<string, any[]>) =>
  loadSessions.mockImplementation(async (_project: string, worktree: string | null) => rows[worktree ?? ''] ?? []);

const el = (sel: string) => document.querySelector(sel) as HTMLElement;
const rowOf = (sid: string) => el(`[data-session-row="${sid}"] > [data-row]`);
const labelOf = (sid: string) => rowOf(sid).querySelector('span.truncate') as HTMLElement;
const dotOf = (sid: string) => rowOf(sid).querySelector('[data-dot]') as HTMLElement;
const list = (key: string) => el(`[data-sessions="${key}"]`);
const summaryOf = (key: string) => el(`[data-sessions-summary="${key}"]`);
const wsHeader = (name: string) => el(`section[data-workspace="${name}"] button[aria-expanded]`);
const items = (key: string) => [...list(key).children].map((li) => li.getAttribute('data-session-row') ?? li.textContent);
/** Lets the lazy session loads resolve and re-render. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

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
  uiStore.set({ lens: 'projects' });
  seed();
  closeDialog('workspace');
  viewStore.set({ review: null, commits: null });
  location.hash = '';
});

describe('Projects tree', () => {
  it('a live session row opens its instance with a gesture; a disk-only row resumes in its own place, main checkout or worktree', async () => {
    // Invariant: a live row selects its instance as a user gesture; a disk-only row resumes with its own place's project and worktree.
    sidebarStore.set({ expandedWorktrees: ['demo'] });
    byPlace({ '': [disk('sid-live', 'live'), disk('sid-old', 'old')], wt: [disk('wt-old', 'in worktree')] });
    seed({
      projects: [proj('demo', { sessions: { count: 2, archivedCount: 0, handCount: 2, lastActivity: 1 }, worktrees: [wt('wt', { sessions: { count: 1, lastActivity: 1 } })] })],
      instances: [inst({ sessionId: 'sid-live', project: 'demo' })],
    });
    renderSidebar();
    await screen.findByText('in worktree');
    await screen.findByText('old');
    fireEvent.click(rowOf('sid-live'));
    expect(selectInstance).toHaveBeenCalledTimes(1);
    expect(selectInstance).toHaveBeenCalledWith('i-sid-live', { userGesture: true });
    expect(resumeSession).not.toHaveBeenCalled();
    fireEvent.click(rowOf('sid-old'));
    expect(resumeSession).toHaveBeenCalledWith({ projectName: 'demo', worktreeName: null, sessionId: 'sid-old' });
    fireEvent.click(rowOf('wt-old'));
    expect(resumeSession).toHaveBeenCalledWith({ projectName: 'demo', worktreeName: 'wt', sessionId: 'wt-old' });
    expect(selectInstance).toHaveBeenCalledTimes(1);
  });

  it('a worktree has its own Sessions list, and the main checkout list never shows the worktree sessions', async () => {
    // Invariant: each place lists only its own sessions, live and on disk.
    sidebarStore.set({ expandedWorktrees: ['demo'] });
    byPlace({ '': [disk('root-sid', 'at root')], wt: [disk('wt-sid', 'in worktree')] });
    seed({
      projects: [proj('demo', { sessions: { count: 1, archivedCount: 0, handCount: 1, lastActivity: 1 }, worktrees: [wt('wt', { sessions: { count: 1, lastActivity: 1 } })] })],
      instances: [
        inst({ sessionId: 'root-sid', project: 'demo' }),
        inst({ sessionId: 'wt-sid', project: 'demo', status: 'turn', worktree: { worktreeName: 'wt' } }),
      ],
    });
    renderSidebar();
    await screen.findByText('in worktree');
    await screen.findByText('at root');
    expect(list('demo').querySelector('[data-session-row="root-sid"]')).not.toBeNull();
    expect(list('demo').querySelector('[data-session-row="wt-sid"]')).toBeNull();
    expect(items('demo:wt')).toEqual(['wt-sid']);
    expect(loadSessions).toHaveBeenCalledWith('demo', null);
    expect(loadSessions).toHaveBeenCalledWith('demo', 'wt');
  });

  it('the dot names an idle wait: a held wake reads waiting on a worker and beats a background job, a job alone names the job, and both clear when consumed', async () => {
    // Invariant: the dot's name follows the wait flags both ways (the wake wins) while its run-state stays idle, and a wait never sticks.
    const four = (wake: boolean) => [
      inst({ sessionId: 'sid-wait', project: 'demo', awaitingWake: wake, waitingOnJob: false }),
      inst({ sessionId: 'sid-job', project: 'demo', awaitingWake: false, waitingOnJob: wake }),
      inst({ sessionId: 'sid-both', project: 'demo', awaitingWake: wake, waitingOnJob: wake }),
      inst({ sessionId: 'sid-done', project: 'demo', awaitingWake: false, waitingOnJob: false }),
    ];
    seed({ projects: [proj('demo')], instances: four(true) });
    renderSidebar();
    await settle();
    expect(dotOf('sid-wait').title).toBe('idle — waiting on a worker');
    expect(dotOf('sid-both').title).toBe('idle — waiting on a worker');
    expect(dotOf('sid-job').title).toBe('idle — waiting on a background job');
    expect(dotOf('sid-done').title).toBe('idle');
    for (const sid of ['sid-wait', 'sid-job', 'sid-both', 'sid-done']) expect(dotOf(sid).getAttribute('data-dot')).toBe('idle');
    act(() => appStore.set({ instances: four(false) }));
    await settle();
    for (const sid of ['sid-wait', 'sid-job', 'sid-both', 'sid-done']) {
      expect(dotOf(sid).title).toBe('idle');
    }
  });

  it('a live instance waiting on a job merges onto its disk row, which shows the awaiting dot', async () => {
    // Invariant: the merge copies waitingOnJob onto the disk row.
    loadSessions.mockResolvedValue([{ sessionId: 'sid-job', firstPrompt: 'ran a turn', lastActivity: Date.now() - 60_000 }]);
    seed({
      projects: [proj('demo', { sessions: { count: 1, archivedCount: 0, handCount: 1, lastActivity: 1 } })],
      instances: [inst({ sessionId: 'sid-job', project: 'demo', waitingOnJob: true })],
    });
    renderSidebar();
    await screen.findByText('ran a turn');
    expect(items('demo')).toEqual(['sid-job']);
    expect(labelOf('sid-job').textContent).toBe('ran a turn');
    expect(dotOf('sid-job').title).toBe('idle — waiting on a background job');
  });

  it('a synthetic (new session) row takes the real first prompt once its turn ends; a turn starting refetches nothing', async () => {
    // Invariant: leaving a non-idle status for idle refetches the place's list; entering a turn does not.
    let calls = 0;
    loadSessions.mockImplementation(async () => (calls++ === 0 ? [] : [{ sessionId: 'sid-fresh', firstPrompt: 'hello world', lastActivity: Date.now() }]));
    const at = (status: string) => [inst({ sessionId: 'sid-fresh', project: 'demo', status })];
    seed({ projects: [proj('demo', { sessions: { count: 1, archivedCount: 0, handCount: 1, lastActivity: 1 } })], instances: at('spawning') });
    renderSidebar();
    await settle();
    expect(labelOf('sid-fresh').textContent).toBe('(new session)');
    expect(loadSessions).toHaveBeenCalledTimes(1);
    act(() => appStore.set({ instances: at('idle') }));
    await waitFor(() => expect(labelOf('sid-fresh').textContent).toBe('hello world'));
    expect(loadSessions).toHaveBeenCalledTimes(2);
    act(() => appStore.set({ instances: at('turn') }));
    await settle();
    expect(loadSessions).toHaveBeenCalledTimes(2);
    act(() => appStore.set({ instances: at('idle') }));
    await settle();
    expect(loadSessions).toHaveBeenCalledTimes(3);
  });

  it('a worktree session ending its turn refetches only the worktree list, never the main checkout list', async () => {
    // Invariant: the turn-end refetch is keyed to the instance's own place.
    sidebarStore.set({ expandedWorktrees: ['demo'] });
    let wtCalls = 0;
    loadSessions.mockImplementation(async (_project: string, worktree: string | null) => {
      if (worktree === null) return [disk('root-sid', 'root-prompt')];
      return wtCalls++ === 0 ? [] : [{ sessionId: 'wt-sid', firstPrompt: 'fresh-prompt', lastActivity: Date.now() }];
    });
    const callsFor = (w: string | null) => loadSessions.mock.calls.filter((c) => c[1] === w).length;
    const at = (status: string) => [inst({ sessionId: 'wt-sid', project: 'demo', status, worktree: { worktreeName: 'wt' } })];
    seed({
      projects: [proj('demo', { sessions: { count: 1, archivedCount: 0, handCount: 1, lastActivity: 1 }, worktrees: [wt('wt', { sessions: { count: 1, lastActivity: 1 } })] })],
      instances: at('turn'),
    });
    renderSidebar();
    await screen.findByText('root-prompt');
    await settle();
    const main = callsFor(null);
    const inWt = callsFor('wt');
    act(() => appStore.set({ instances: at('idle') }));
    await waitFor(() => expect(labelOf('wt-sid').textContent).toBe('fresh-prompt'));
    expect(callsFor(null)).toBe(main);
    expect(callsFor('wt')).toBe(inWt + 1);
  });

  it('a session row pills turnEndSeq minus viewedSeq, a live instance beats its disk row, and viewing clears the pill', async () => {
    // Invariant: unread = turnEndSeq − viewedSeq, a live instance's marks win over its disk row's, and viewing clears the pill.
    loadSessions.mockResolvedValue([
      disk('sid-a', 'a', { turnEndSeq: 3, viewedSeq: 1 }),
      disk('sid-b', 'b', { turnEndSeq: 1, viewedSeq: 1 }),
      disk('sid-c', 'c', { turnEndSeq: 5, viewedSeq: 3 }),
    ]);
    const live = (bViewed: number) => [
      inst({ sessionId: 'sid-a', project: 'demo', turnEndSeq: 1, viewedSeq: 1 }),
      inst({ sessionId: 'sid-b', project: 'demo', turnEndSeq: 4, viewedSeq: bViewed }),
    ];
    seed({ projects: [proj('demo', { sessions: { count: 3, archivedCount: 0, handCount: 3, lastActivity: 1 } })], instances: live(1) });
    renderSidebar();
    await screen.findByText('c');
    expect(rowOf('sid-b').querySelector('[data-unread]')?.textContent).toBe('3');
    expect(rowOf('sid-a').querySelector('[data-unread]')).toBeNull();
    expect(rowOf('sid-c').querySelector('[data-unread]')?.textContent).toBe('2');
    act(() => appStore.set({ instances: live(4) }));
    expect(rowOf('sid-b').querySelector('[data-unread]')).toBeNull();
  });

  it('a paused live session row in the Projects lens carries no auto-resume badge', async () => {
    // Invariant: the paused instance's auto-resume badge is shown by the strip and never by its Projects-lens session row.
    const T = 1_900_000_000;
    loadSessions.mockResolvedValue([disk('sid-p', 'paused')]);
    seed({
      projects: [proj('demo', { sessions: { count: 1, archivedCount: 0, handCount: 1, lastActivity: 1 } })],
      instances: [inst({ sessionId: 'sid-p', project: 'demo', autoResumeAt: T, queuedCount: 1 })],
    });
    renderSidebar();
    await settle();
    expect(dotOf('sid-p').getAttribute('data-dot')).toBe('idle');
    const clock = formatAutoResumeTime(T)!.replace(/^resumes at /, '');
    // Invariant: the badge is found by its tooltip, which leads with the full resume time; the strip has one and the project list none.
    const badge = `[title^="${formatAutoResumeTime(T)}"]`;
    const inStrip = el('[data-strip]').querySelector(badge) as HTMLElement;
    expect(inStrip.textContent).toMatch(/^1 ·/);
    expect(inStrip.textContent).toContain(clock);
    expect(el('[data-project-list]').querySelector(badge)).toBeNull();
  });

  it('a Sessions list is open by default and stays collapsed across re-renders once collapsed', async () => {
    // Invariant: a subnode opens by default, and a manual collapse survives re-renders.
    const sessions = { count: 1, archivedCount: 0, handCount: 1, lastActivity: Date.now() };
    loadSessions.mockResolvedValue([disk('s', 'one row')]);
    seed({ projects: [proj('p', { sessions })] });
    renderSidebar();
    await screen.findByText('one row');
    const chev = within(el('[data-project-row="p"]')).getByRole('button', { name: 'Sessions' });
    expect(chev.getAttribute('aria-expanded')).toBe('true');
    expect(list('p')).not.toBeNull();
    fireEvent.click(chev);
    expect(chev.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-sessions="p"]')).toBeNull();
    act(() => appStore.set({ projects: [proj('p', { sessions })] }));
    expect(within(el('[data-project-row="p"]')).getByRole('button', { name: 'Sessions' }).getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-sessions="p"]')).toBeNull();
  });

  it('an empty registered workspace shows (0) and, opened, its empty hint', () => {
    // Invariant: a registered workspace with no members renders, with a zero count and its hint.
    seed({ workspaces: ['Lonely'], projects: [proj('alpha')] });
    renderSidebar();
    expect(wsHeader('Lonely').textContent).toBe('Lonely(0)');
    expect(wsHeader('Lonely').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(wsHeader('Lonely'));
    expect(within(el('section[data-workspace="Lonely"]')).getByText('No projects in this workspace · use the pencil to add some')).toBeTruthy();
  });

  it('the workspace pencil opens that workspace editor without toggling the workspace', () => {
    // Invariant: the pencil opens that workspace's editor and never expands it.
    seed({ projects: [proj('a', { workspace: 'Stuff' })] });
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Edit workspace Stuff' }));
    expect(dialogStore.get().workspace).toEqual({ name: 'Stuff' });
    expect(wsHeader('Stuff').getAttribute('aria-expanded')).toBe('false');
    expect(sidebarStore.get().expandedWorkspaces).toEqual([]);
  });

  it('the open workspaces are read from storage when the sidebar state loads, and exactly those render open', async () => {
    // Invariant: the initial expansion comes from code-conductor:workspaces-expanded, and only those workspaces render open.
    vi.resetModules();
    localStorage.setItem('code-conductor:workspaces-expanded', JSON.stringify(['Visible']));
    const fresh = await import('./state');
    expect(fresh.sidebarStore.get().expandedWorkspaces).toEqual(['Visible']);
    sidebarStore.set({ expandedWorkspaces: fresh.sidebarStore.get().expandedWorkspaces });
    seed({ projects: [proj('a', { workspace: 'Hidden' }), proj('b', { workspace: 'Visible' })] });
    renderSidebar();
    expect(wsHeader('Visible').getAttribute('aria-expanded')).toBe('true');
    expect(wsHeader('Hidden').getAttribute('aria-expanded')).toBe('false');
  });

  it('temp and conducted sessions sit under their own counted labels after the unlabelled normal rows; a conducted temp session groups as conducted and keeps its Make persistent button', async () => {
    // Invariant: with two or more groups the order is normal (unlabelled), then a `Temp · n` label and its rows, then a `Conducted · n` label and its rows, n counting that group's rows, and the summary keeps the noun Sessions; conducted wins the grouping while a temp row, conducted or not, keeps its Make persistent button and a non-temp row never has one.
    seed({
      projects: [proj('demo')],
      instances: [
        inst({ sessionId: 'sid-normal', project: 'demo', firstPrompt: 'Normal', lastResponseAt: 4000 }),
        inst({ sessionId: 'sid-temp', project: 'demo', temp: true, firstPrompt: 'Temp one', lastResponseAt: 3000 }),
        inst({ sessionId: 'sid-cond', project: 'demo', conducted: true, firstPrompt: 'Cond one', lastResponseAt: 2000 }),
        inst({ sessionId: 'sid-ct', project: 'demo', temp: true, conducted: true, firstPrompt: 'Cond temp', lastResponseAt: 1000 }),
      ],
    });
    renderSidebar();
    await settle();
    expect(items('demo')).toEqual(['sid-normal', 'Temp · 1', 'sid-temp', 'Conducted · 2', 'sid-cond', 'sid-ct']);
    expect([...list('demo').querySelectorAll('[data-session-group]')].map((li) => li.getAttribute('data-session-group'))).toEqual(['temp', 'conducted']);
    expect(summaryOf('demo').textContent).toBe('Sessions (4) · 4 live');
    const promote = (sid: string) => within(rowOf(sid)).queryByRole('button', { name: 'Make persistent' });
    for (const sid of ['sid-temp', 'sid-ct']) expect(promote(sid)).not.toBeNull();
    for (const sid of ['sid-cond', 'sid-normal']) expect(promote(sid)).toBeNull();
  });

  it('a place whose visible sessions are all temp has no group label and its summary reads Temp sessions', async () => {
    // Invariant: one visible group, temp, draws no label in the main checkout or a worktree, and its summary names it Temp sessions.
    sidebarStore.set({ expandedWorktrees: ['demo'] });
    seed({
      projects: [proj('demo', { worktrees: [wt('wt')] })],
      instances: [
        inst({ sessionId: 'sid-temp', project: 'demo', temp: true }),
        inst({ sessionId: 'wt-temp', project: 'demo', temp: true, worktree: { worktreeName: 'wt' } }),
      ],
    });
    renderSidebar();
    await settle();
    expect(items('demo')).toEqual(['sid-temp']);
    expect(items('demo:wt')).toEqual(['wt-temp']);
    expect(list('demo').querySelector('[data-session-group]')).toBeNull();
    expect(list('demo:wt').querySelector('[data-session-group]')).toBeNull();
    expect(summaryOf('demo').textContent).toBe('Temp sessions (1) · 1 live');
    expect(summaryOf('demo:wt').textContent).toBe('Temp sessions (1) · 1 live');
  });

  it('a place whose visible sessions are all conducted has no group label and its summary reads Conducted sessions', async () => {
    // Invariant: one visible group, conducted, draws no label and its summary names it Conducted sessions.
    seed({
      projects: [proj('demo')],
      instances: [
        inst({ sessionId: 'sid-c1', project: 'demo', conducted: true, lastResponseAt: 2000 }),
        inst({ sessionId: 'sid-c2', project: 'demo', conducted: true, lastResponseAt: 1000 }),
      ],
    });
    renderSidebar();
    await settle();
    expect(items('demo')).toEqual(['sid-c1', 'sid-c2']);
    expect(list('demo').querySelector('[data-session-group]')).toBeNull();
    expect(summaryOf('demo').textContent).toBe('Conducted sessions (2) · 2 live');
  });

  it("the project row's count badge tooltip reads Sessions (N) even where the open list names its only group Temp sessions", async () => {
    // Invariant: the count badge's tooltip always uses the noun Sessions, whatever group the place's visible rows fall in.
    seed({ projects: [proj('demo')], instances: [inst({ sessionId: 'sid-temp', project: 'demo', temp: true })] });
    renderSidebar();
    await settle();
    expect(summaryOf('demo').textContent, 'fixture check: the list names its only group').toBe('Temp sessions (1) · 1 live');
    const badge = el('[data-project-row="demo"] [data-sessions-count]');
    await act(async () => { fireEvent.focus(badge); });
    expect((await screen.findByRole('tooltip')).textContent).toBe('Sessions (1) · 1 live');
  });

  it('temp and conducted without normal rows both keep their counted labels and the summary reads Sessions', async () => {
    // Invariant: two visible groups label each one, even with no normal rows, and the summary keeps the noun Sessions.
    seed({
      projects: [proj('demo')],
      instances: [
        inst({ sessionId: 'sid-temp', project: 'demo', temp: true, lastResponseAt: 2000 }),
        inst({ sessionId: 'sid-cond', project: 'demo', conducted: true, lastResponseAt: 1000 }),
      ],
    });
    renderSidebar();
    await settle();
    expect(items('demo')).toEqual(['Temp · 1', 'sid-temp', 'Conducted · 1', 'sid-cond']);
    expect(summaryOf('demo').textContent).toBe('Sessions (2) · 2 live');
  });

  it('no separator renders when every session is a normal one', async () => {
    // Invariant: separators appear only for non-empty sections.
    seed({ projects: [proj('demo')], instances: [inst({ sessionId: 'sid-x', project: 'demo' })] });
    renderSidebar();
    await settle();
    expect(items('demo')).toEqual(['sid-x']);
  });

  it('only a live temp session offers Make persistent, just left of its ×, and it promotes that instance', async () => {
    // Invariant: the promote button appears exactly on live, not-exited temp rows, sits immediately before ×, and promotes that instance.
    loadSessions.mockResolvedValue([disk('sid-disktemp', 'Disk temp', { temp: true })]);
    seed({
      projects: [proj('demo', { sessions: { count: 1, archivedCount: 0, handCount: 1, lastActivity: 1 } })],
      instances: [
        inst({ sessionId: 'sid-temp', project: 'demo', temp: true, firstPrompt: 'Temp one' }),
        inst({ sessionId: 'sid-dead', project: 'demo', temp: true, status: 'exited' }),
        inst({ sessionId: 'sid-normal', project: 'demo' }),
      ],
    });
    renderSidebar();
    await screen.findByText('Disk temp');
    const promote = within(rowOf('sid-temp')).getByRole('button', { name: 'Make persistent' });
    expect(promote.nextElementSibling?.getAttribute('aria-label')).toBe('Archive session (keeps history)');
    fireEvent.click(promote);
    expect(promoteSession).toHaveBeenCalledWith({ projectName: 'demo', instanceId: 'i-sid-temp', preview: 'Temp one' });
    for (const sid of ['sid-dead', 'sid-normal', 'sid-disktemp']) {
      expect(within(rowOf(sid)).queryByRole('button', { name: 'Make persistent' })).toBeNull();
    }
  });

  it('a session row × reads Stop for a live persistent session and Archive otherwise, and a click closes with the row facts without selecting', async () => {
    // Invariant: the × title follows closeActionOf, and the click sends the row's facts without selecting.
    loadSessions.mockResolvedValue([disk('sid-disk', 'on disk')]);
    seed({
      projects: [proj('demo', { sessions: { count: 1, archivedCount: 0, handCount: 1, lastActivity: 1 } })],
      instances: [
        inst({ sessionId: 'sid-p', project: 'demo' }),
        inst({ sessionId: 'sid-t', project: 'demo', temp: true }),
        inst({ sessionId: 'sid-x', project: 'demo', status: 'exited' }),
      ],
    });
    renderSidebar();
    await screen.findByText('on disk');
    const STOP = 'Stop session';
    const ARCHIVE = 'Archive session (keeps history)';
    expect(within(rowOf('sid-p')).getByRole('button', { name: STOP })).toBeTruthy();
    expect(within(rowOf('sid-p')).queryByRole('button', { name: ARCHIVE })).toBeNull();
    expect(within(rowOf('sid-t')).getByRole('button', { name: ARCHIVE })).toBeTruthy();
    expect(within(rowOf('sid-t')).queryByRole('button', { name: STOP })).toBeNull();
    expect(within(rowOf('sid-x')).getByRole('button', { name: ARCHIVE })).toBeTruthy();
    expect(within(rowOf('sid-x')).queryByRole('button', { name: STOP })).toBeNull();
    expect(within(rowOf('sid-disk')).getByRole('button', { name: ARCHIVE })).toBeTruthy();
    expect(within(rowOf('sid-disk')).queryByRole('button', { name: STOP })).toBeNull();
    fireEvent.click(within(rowOf('sid-p')).getByRole('button', { name: STOP }));
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenLastCalledWith(expect.objectContaining({
      projectName: 'demo', worktreeName: null, sessionId: 'sid-p', instanceId: 'i-sid-p', status: 'idle', temp: false,
    }));
    expect(selectInstance).not.toHaveBeenCalled();
    expect(resumeSession).not.toHaveBeenCalled();
    fireEvent.click(within(rowOf('sid-disk')).getByRole('button', { name: ARCHIVE }));
    expect(closeSession).toHaveBeenCalledTimes(2);
    expect(closeSession).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'sid-disk', instanceId: null, status: null, temp: false }));
    expect(selectInstance).not.toHaveBeenCalled();
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it('a just-promoted live session overrides its stale on-disk temp flag', async () => {
    // Invariant: the live temp flag wins over the disk row's.
    loadSessions.mockResolvedValue([disk('sid-promoted', 'promoted', { temp: true })]);
    seed({
      projects: [proj('demo', { sessions: { count: 1, archivedCount: 0, handCount: 1, lastActivity: 1 } })],
      instances: [inst({ sessionId: 'sid-promoted', project: 'demo', temp: false })],
    });
    renderSidebar();
    await screen.findByText('promoted');
    expect(items('demo')).toEqual(['sid-promoted']);
    expect(within(rowOf('sid-promoted')).queryByRole('button', { name: 'Make persistent' })).toBeNull();
  });

  it('the 15s tick re-renders the ago labels without new data: the row and the Sessions summary line', async () => {
    // Invariant: the ago tick alone recomputes both labels, from their stored timestamps, in place.
    let now = 1_000_000_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      loadSessions.mockResolvedValue([disk('sid-x', 'ticking', { lastActivity: now - 2_000 })]);
      seed({ projects: [proj('demo', { sessions: { count: 1, archivedCount: 0, handCount: 1, lastActivity: now - 2_000 } })] });
      renderSidebar();
      await settle();
      const ago = rowOf('sid-x').querySelector('[data-ago]') as HTMLElement;
      expect(ago.textContent).toBe('2s ago');
      const line = summaryOf('demo');
      expect(line.textContent).toBe('Sessions (1) · last 2s ago');
      now += 63_000;
      act(() => agoTick.bump());
      expect(ago.textContent).toBe('1m ago');
      expect(line.textContent).toBe('Sessions (1) · last 1m ago');
      expect(rowOf('sid-x').querySelector('[data-ago]') === ago).toBe(true);
      expect(summaryOf('demo') === line).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('a live session whose disk row carries its public id renders one merged row, titled by that id', async () => {
    // Invariant: a live instance merges onto the disk row with the same public id, never adding a synthetic second row.
    loadSessions.mockResolvedValue([{ sessionId: 'a1b2c3d4', firstPrompt: 'do the thing', title: null, conducted: false, temp: false, archived: false, lastActivity: 1_000 }]);
    seed({
      projects: [proj('demo', { sessions: { count: 1, archivedCount: 0, handCount: 1, lastActivity: 1 } })],
      instances: [inst({ sessionId: 'a1b2c3d4', project: 'demo', lastResponseAt: 2_000 })],
    });
    renderSidebar();
    await screen.findByText('do the thing');
    expect(items('demo')).toEqual(['a1b2c3d4']);
    expect(rowOf('a1b2c3d4').querySelector<HTMLElement>(':scope > [data-row-open]')!.title).toBe('a1b2c3d4');
    expect(labelOf('a1b2c3d4').textContent).toBe('do the thing');
    expect(dotOf('a1b2c3d4').getAttribute('data-dot')).toBe('idle');
  });

  it('a synthetic row dates from the instance lastResponseAt, else its createdAt, and keeps counting across re-renders', async () => {
    // Invariant: a synthetic row's activity is the instance's lastResponseAt ?? createdAt (lastResponseAt wins when both are set), stable across renders, never a per-render now.
    let now = 1_000_000_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const instances = [
        inst({ sessionId: 'sid-r', project: 'demo', temp: true, lastResponseAt: now - 5_000 }),
        inst({ sessionId: 'sid-a', project: 'demo', temp: true, lastResponseAt: null, createdAt: now - 10_000 }),
        inst({ sessionId: 'sid-b', project: 'demo', temp: true, lastResponseAt: null, createdAt: now - 300_000 }),
        inst({ sessionId: 'sid-both', project: 'demo', temp: true, lastResponseAt: now - 7_000, createdAt: now - 600_000 }),
      ];
      seed({ projects: [proj('demo')], instances });
      renderSidebar();
      await settle();
      const ago = (sid: string) => (rowOf(sid).querySelector('[data-ago]') as HTMLElement).textContent;
      expect(ago('sid-r')).toBe('5s ago');
      expect(ago('sid-a')).toBe('10s ago');
      expect(ago('sid-b')).toBe('5m ago');
      expect(ago('sid-both')).toBe('7s ago');
      now += 30_000;
      act(() => appStore.set({ instances: instances.map((i) => ({ ...i })) }));
      act(() => appStore.set({ instances: instances.map((i) => ({ ...i })) }));
      expect(ago('sid-r')).toBe('35s ago');
      expect(ago('sid-a')).toBe('40s ago');
      expect(ago('sid-b')).toBe('5m ago');
      expect(ago('sid-both')).toBe('37s ago');
    } finally {
      spy.mockRestore();
    }
  });

  it('an unborn-HEAD project shows the no commits pill beside its ahead/behind pill, and loses it in place on the first commit', () => {
    // Invariant: the pill tracks unbornHead on the same row element, and the ahead/behind pill is independent of it.
    const demo = { isGitRepo: true, mergeStatus: { ahead: 2, behind: 0, upstream: 'origin/main' } };
    seed({ projects: [proj('demo', { ...demo, unbornHead: true })] });
    renderSidebar();
    const row = el('[data-project-row="demo"]');
    expect(within(row).getByText('no commits').getAttribute('title')).toBe('No commits yet — make a first commit to enable worktrees');
    expect(within(row).getByText('↑2')).toBeTruthy();
    act(() => appStore.set({ projects: [proj('demo', { ...demo, unbornHead: false })] }));
    expect(within(row).queryByText('no commits')).toBeNull();
    expect(within(row).getByText('↑2')).toBeTruthy();
    expect(document.querySelector('[data-project-row="demo"]') === row).toBe(true);
  });

  it('a normal repo and a plain directory show no no commits pill', () => {
    // Invariant: only unbornHead shows the pill.
    seed({ projects: [proj('normal', { isGitRepo: true }), proj('plain')] });
    renderSidebar();
    expect(within(el('[data-project-list]')).queryByText('no commits')).toBeNull();
  });

  it('commit history names the project on a project row and the pair on a worktree row, as the worktree review does', () => {
    // Invariant: a worktree's commit history and review address the (project, worktree) pair; a project's addresses the project alone.
    sidebarStore.set({ expandedWorktrees: ['demo'] });
    seed({ projects: [proj('demo', { isGitRepo: true, worktrees: [wt('demo_wt')] })] });
    renderSidebar();
    const wtRow = el('[data-worktree-row="demo_wt"]');
    fireEvent.click(within(wtRow).getByRole('button', { name: 'Commit history' }));
    expect(viewStore.get().commits).toEqual({ project: 'demo', worktree: 'demo_wt' });
    fireEvent.click(within(wtRow).getByRole('button', { name: 'Review changes' }));
    expect(viewStore.get().review).toEqual({ title: 'demo / demo_wt', url: '/api/projects/demo/worktrees/demo_wt/diff' });
    fireEvent.click(within(el('[data-project-row="demo"]')).getByRole('button', { name: 'Commit history' }));
    expect(viewStore.get().commits).toEqual({ project: 'demo', worktree: null });
  });

  it('a locked worktree shows the lock marker, which follows the lock across renders', () => {
    // Invariant: the marker follows wt.locked on every render.
    sidebarStore.set({ expandedWorktrees: ['demo'] });
    const at = (over: Record<string, any>) => [proj('demo', { worktrees: [wt('wt-a', over)] })];
    seed({ projects: at({ locked: true }) });
    renderSidebar();
    const row = () => el('[data-worktree-row="wt-a"]');
    expect(within(row()).getByTitle(/^Locked against merging/)).toBeTruthy();
    act(() => appStore.set({ projects: at({}) }));
    expect(within(row()).queryByTitle(/^Locked against merging/)).toBeNull();
    act(() => appStore.set({ projects: at({ locked: true }) }));
    expect(within(row()).getByTitle(/^Locked against merging/)).toBeTruthy();
  });
});

describe('Sessions summary line', () => {
  it('the open Sessions list of the main checkout and of each worktree starts with Sessions (N) · K live · last <ago>', async () => {
    // Invariant: every open Sessions list, main checkout and worktree, is headed by its summary; each place counts its own live sessions, and its total includes live sessions not yet on disk.
    const now = 1_000_000_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      sidebarStore.set({ expandedWorktrees: ['demo'] });
      byPlace({ '': [disk('s1', 'one'), disk('s2', 'two')], wt: [disk('w1', 'in worktree')] });
      seed({
        projects: [proj('demo', {
          sessions: { count: 2, archivedCount: 0, handCount: 2, lastActivity: now - 120_000 },
          worktrees: [wt('wt', { sessions: { count: 1, lastActivity: now - 30_000 } })],
        })],
        instances: [
          inst({ sessionId: 'sid-new', project: 'demo' }),
          inst({ sessionId: 'w-live', project: 'demo', worktree: { worktreeName: 'wt' } }),
        ],
      });
      renderSidebar();
      await settle();
      expect(summaryOf('demo').textContent).toBe('Sessions (3) · 1 live · last 2m ago');
      expect(summaryOf('demo').nextElementSibling === list('demo')).toBe(true);
      expect(summaryOf('demo:wt').textContent).toBe('Sessions (2) · 1 live · last 30s ago');
      expect(summaryOf('demo:wt').nextElementSibling === list('demo:wt')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('the summary line leaves out · K live with no live session and · last with no recorded activity', async () => {
    // Invariant: the live and last parts appear only when non-zero.
    loadSessions.mockResolvedValue([disk('s1', 'one')]);
    seed({ projects: [proj('demo', { sessions: { count: 1, archivedCount: 0, handCount: 1, lastActivity: 0 } })] });
    renderSidebar();
    await screen.findByText('one');
    expect(summaryOf('demo').textContent).toBe('Sessions (1)');
  });
});

describe('Other projects section', () => {
  const mixed = () => {
    sidebarStore.set({ expandedWorkspaces: ['TTD'] });
    seed({
      projects: [
        proj('recon', { workspace: 'TTD', isGitRepo: true }),
        proj('ttd-linux', { workspace: 'TTD', isGitRepo: true }),
        proj('alpha-member', { workspace: 'AI', isGitRepo: true }),
        proj('binary-ninja'),
        proj('zeta'),
      ],
    });
    renderSidebar();
  };

  it('unassigned projects follow the last workspace in a section of their own, outside every workspace', () => {
    // Invariant: unassigned rows are never nested in a workspace.
    mixed();
    expect(el('section[data-workspace="TTD"]').nextElementSibling?.matches('section[data-workspace=""]')).toBe(true);
    expect(el('[data-project-row="binary-ninja"]').closest('section')?.getAttribute('data-workspace')).toBe('');
    expect(el('section[data-workspace="TTD"]').contains(el('[data-project-row="binary-ninja"]'))).toBe(false);
  });

  it('a workspace header is a band holding its toggle, icon, count and pencil', () => {
    // Invariant: a workspace section opens with its band, which holds the toggle (icon and count inside it) and the pencil; the toggle shows and hides the members and the pencil opens that workspace's editor.
    mixed();
    const band = el('section[data-workspace="TTD"]').firstElementChild as HTMLElement;
    expect(band.getAttribute('data-workspace-band')).toBe('TTD');
    const toggle = band.querySelector(':scope > button[aria-expanded]') as HTMLElement;
    expect(toggle).not.toBeNull();
    expect(toggle.querySelector('[data-workspace-icon]')).not.toBeNull();
    expect(toggle.textContent).toContain('(2)');
    expect(within(band).getByRole('button', { name: 'Edit workspace TTD' })).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-project-row="recon"]')).not.toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-project-row="recon"]')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-project-row="recon"]')).not.toBeNull();
    fireEvent.click(within(band).getByRole('button', { name: 'Edit workspace TTD' }));
    expect(dialogStore.get().workspace).toEqual({ name: 'TTD' });
  });

  it('the Other projects band is drawn once, before the first unassigned project, with the last workspace open or closed', () => {
    // Invariant: the section boundary is one band, drawn once at the start of the unassigned run whatever the workspace's state, with an icon and no toggle, pencil or dashed rule.
    mixed();
    const boundary = () => {
      const headers = document.querySelectorAll('[data-unassigned-header]');
      expect(headers.length).toBe(1);
      const header = headers[0] as HTMLElement;
      expect(el('section[data-workspace=""]').firstElementChild === header).toBe(true);
      expect(header.getAttribute('data-workspace-band')).toBe('');
      expect(header.querySelector('[data-workspace-icon]')).not.toBeNull();
      expect(header.querySelector('button[aria-expanded]')).toBeNull();
      expect(within(header).queryByRole('button', { name: /^Edit workspace/ })).toBeNull();
      expect(header.textContent).toContain('Other projects');
      expect(document.querySelector('[data-section-rule]')).toBeNull();
    };
    boundary();
    fireEvent.click(wsHeader('TTD'));
    expect(wsHeader('TTD').getAttribute('aria-expanded')).toBe('false');
    boundary();
  });

  it('with only unassigned projects there is no Other projects header', () => {
    // Invariant: no boundary and no band is drawn when nothing precedes it.
    seed({ projects: [proj('binary-ninja'), proj('zeta')] });
    renderSidebar();
    expect(document.querySelector('[data-unassigned-header]')).toBeNull();
    expect(document.querySelector('[data-workspace-band]')).toBeNull();
    expect(document.querySelector('[data-section-rule]')).toBeNull();
    expect(document.querySelector('[data-project-row="binary-ninja"]')).not.toBeNull();
    expect(document.querySelector('[data-project-row="zeta"]')).not.toBeNull();
  });
});
