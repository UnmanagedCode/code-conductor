import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { uiStore } from '@/app/ui';
import { CLOSE_TITLES } from '@/lib/core/closeAction.js';
import { blockOf, conductor, el, hand, inactiveGroup, proj, seed, treeOf, worker, wt } from '@/test/sidebarFleet';

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
const { viewStore } = await import('@/features/views/api');
/** The sidebar state a fresh page starts from, read before any test writes it. */
const FRESH = sidebarStore.get();

const renderSidebar = () => render(<TooltipProvider><AppSidebar /></TooltipProvider>);
/** Lets the lazy session loads resolve and re-render. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** A conductor's chips as `project:kind`, in order, and whether any other text (the empty-list placeholder) sits beside them. */
function chipsOf(sid: string) {
  const box = blockOf(sid).querySelector('[data-chips]') as HTMLElement;
  const chips = [...box.querySelectorAll('[data-chip]')];
  return {
    chips: chips.map((c) => `${c.textContent}:${c.getAttribute('data-chip')}`),
    placeholder: box.textContent !== chips.map((c) => c.textContent).join(''),
  };
}
const caretOf = (sid: string) => within(blockOf(sid)).getByRole('button', { name: 'Show workers' });
const expand = (sid: string) => { fireEvent.click(caretOf(sid)); return treeOf(sid)!; };
/** The tree's rows in document order: `project:<name>`, `worktree:<name>` or `worker:<sid>`. */
const treeRows = (sid: string) => [...treeOf(sid)!.querySelectorAll('[data-project-row], [data-worktree-row], [data-session-row]')].map((n) => {
  const e = n as HTMLElement;
  if (e.dataset.projectRow !== undefined) return `project:${e.dataset.projectRow}`;
  if (e.dataset.worktreeRow !== undefined) return `worktree:${e.dataset.worktreeRow}`;
  return `worker:${e.dataset.sessionRow}`;
});
const projectItem = (tree: HTMLElement, name: string) => (tree.querySelector(`[data-project-row="${name}"]`) as HTMLElement | null)?.parentElement ?? null;
const worktreeItem = (tree: HTMLElement, name: string) => (tree.querySelector(`[data-worktree-row="${name}"]`) as HTMLElement | null)?.parentElement ?? null;
const workerRows = (root: HTMLElement) => [...root.querySelectorAll('[data-session-row]')].map((e) => e.getAttribute('data-session-row'));
const labels = (root: HTMLElement) => new Set([...root.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label')));
/** The tree's structural and close actions: none may appear in a conductor tree. */
const STRUCTURAL = ['New session', 'Delete project', 'New session in this worktree', 'Remove worktree', CLOSE_TITLES.stop, CLOSE_TITLES.archive];

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
  viewStore.set({ review: null, commits: null });
  location.hash = '';
  seed();
});

describe('conductor chips', () => {
  it('one live chip per project with a live owned worker, sorted by name, and a conductor with no chip says so', async () => {
    // Invariant: live chips are the distinct projects of the conductor's live owned workers, by name; an empty chip list shows a placeholder instead.
    seed({
      projects: [proj('zeta'), proj('alpha', { worktrees: [wt('wt1')] })],
      instances: [
        conductor('A'), conductor('B'),
        worker('w1', 'A', 'zeta'), worker('w2', 'A', 'alpha', 'wt1'), worker('w3', 'A', 'zeta'),
        worker('dead', 'A', 'other', null, { status: 'exited', ownerSessionId: null }),
      ],
    });
    renderSidebar();
    await settle();
    expect(chipsOf('A')).toEqual({ chips: ['alpha:live', 'zeta:live'], placeholder: false });
    expect(chipsOf('B')).toEqual({ chips: [], placeholder: true });
  });

  it('idle chips follow the live chips, newest spawn first and by name on a tie, and a project with a live worker is never also idle', async () => {
    // Invariant: idle chips are the other spawned projects, newest spawn first with ties by name, after every live chip; a spawned project with a live worker is live only.
    seed({
      projects: ['alpha', 'zeta', 'older', 'newer', 'tie-b', 'tie-a'].map((n) => proj(n)),
      instances: [conductor('A'), worker('w1', 'A', 'zeta'), worker('w2', 'A', 'alpha')],
      conductorSpawns: { A: [
        { project: 'older', lastSpawnAt: 1 },
        { project: 'tie-b', lastSpawnAt: 2 },
        { project: 'zeta', lastSpawnAt: 5 },
        { project: 'newer', lastSpawnAt: 3 },
        { project: 'tie-a', lastSpawnAt: 2 },
      ] },
    });
    renderSidebar();
    await settle();
    expect(chipsOf('A').chips).toEqual(['alpha:live', 'zeta:live', 'newer:idle', 'tie-a:idle', 'tie-b:idle', 'older:idle']);
  });

  it('an idle chip for an unregistered project is not shown, and a conductor whose spawned projects are all unregistered says it has no chip', async () => {
    // Invariant: only registered projects become idle chips; with none left, the placeholder shows.
    seed({
      projects: [proj('kept'), proj('other')],
      instances: [conductor('A'), conductor('B')],
      conductorSpawns: {
        A: [{ project: 'removed', lastSpawnAt: 2 }, { project: 'kept', lastSpawnAt: 1 }],
        B: [{ project: 'gone-1', lastSpawnAt: 2 }, { project: 'gone-2', lastSpawnAt: 1 }],
      },
    });
    renderSidebar();
    await settle();
    expect(chipsOf('A')).toEqual({ chips: ['kept:idle'], placeholder: false });
    expect(chipsOf('B')).toEqual({ chips: [], placeholder: true });
  });

  it('a live conductor with only spawned projects shows idle chips and no placeholder, and an inactive conductor shows its spawned projects as idle chips', async () => {
    // Invariant: spawn history alone fills the chips, for a live conductor and for one under Inactive.
    sidebarStore.set({ inactiveOpen: true });
    seed({
      projects: [proj('p'), proj('q')],
      instances: [conductor('A')],
      conductSessions: [{ sessionId: 'D', title: 'Done', lastActivity: 1 }],
      conductorSpawns: {
        A: [{ project: 'p', lastSpawnAt: 1 }],
        D: [{ project: 'p', lastSpawnAt: 1 }, { project: 'q', lastSpawnAt: 2 }],
      },
    });
    renderSidebar();
    await settle();
    expect(chipsOf('A')).toEqual({ chips: ['p:idle'], placeholder: false });
    expect(inactiveGroup()!.contains(blockOf('D'))).toBe(true);
    expect(chipsOf('D')).toEqual({ chips: ['q:idle', 'p:idle'], placeholder: false });
  });

  it('a chip whose project gains a live worker moves to its place among the live chips, and goes back to idle when the worker goes', async () => {
    // Invariant: a project is one chip, live while it has a live owned worker and idle otherwise, placed by the live or idle ordering.
    const base = { projects: [proj('m'), proj('b'), proj('z')], conductorSpawns: { A: [{ project: 'b', lastSpawnAt: 3 }, { project: 'z', lastSpawnAt: 2 }] } };
    seed({ ...base, instances: [conductor('A'), worker('wm', 'A', 'm')] });
    renderSidebar();
    await settle();
    expect(chipsOf('A').chips).toEqual(['m:live', 'b:idle', 'z:idle']);
    act(() => appStore.set({ instances: [conductor('A'), worker('wm', 'A', 'm'), worker('wz', 'A', 'z')] }));
    expect(chipsOf('A').chips).toEqual(['m:live', 'z:live', 'b:idle']);
    act(() => appStore.set({ instances: [conductor('A'), worker('wm', 'A', 'm')] }));
    expect(chipsOf('A').chips).toEqual(['m:live', 'b:idle', 'z:idle']);
  });

  it('the chips follow a spawn-history refresh on its own', async () => {
    // Invariant: a change to the spawn history alone re-renders the chips.
    seed({ projects: [proj('p')], instances: [conductor('A')] });
    renderSidebar();
    await settle();
    expect(chipsOf('A')).toEqual({ chips: [], placeholder: true });
    act(() => appStore.set({ conductorSpawns: { A: [{ project: 'p', lastSpawnAt: 1 }] } }));
    expect(chipsOf('A')).toEqual({ chips: ['p:idle'], placeholder: false });
  });

  it('chips are display-only: neither kind is a button or focusable, and a click on either opens, expands and closes nothing', async () => {
    // Invariant: a chip carries no action; clicking it reaches no handler.
    seed({
      projects: [proj('p'), proj('q')],
      instances: [conductor('A'), worker('w', 'A', 'p')],
      conductorSpawns: { A: [{ project: 'q', lastSpawnAt: 1 }] },
    });
    renderSidebar();
    await settle();
    const chips = [...blockOf('A').querySelectorAll('[data-chip]')] as HTMLElement[];
    expect(chips.map((c) => c.getAttribute('data-chip'))).toEqual(['live', 'idle']);
    for (const c of chips) {
      expect(c.tagName).not.toBe('BUTTON');
      expect(c.hasAttribute('role')).toBe(false);
      expect(c.hasAttribute('tabindex')).toBe(false);
      fireEvent.click(c);
    }
    expect(selectInstance).not.toHaveBeenCalled();
    expect(resumeSession).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
    expect(promoteSession).not.toHaveBeenCalled();
    expect(caretOf('A').getAttribute('aria-expanded')).toBe('false');
    expect(treeOf('A')).toBeNull();
  });
});

/** A worktree project holding A's workers (two in wt-a, one in wt-b, one in the main checkout), B's worker and a hand session. */
const treeFixture = () => ({
  projects: [proj('proj', { isGitRepo: true, worktrees: [wt('wt-b'), wt('wt-a')] })],
  instances: [
    conductor('A'), conductor('B'),
    worker('wb', 'A', 'proj', 'wt-b'),
    worker('wa1', 'A', 'proj', 'wt-a', { createdAt: 10 }),
    worker('wa2', 'A', 'proj', 'wt-a', { createdAt: 20 }),
    worker('wd', 'A', 'proj'),
    worker('other', 'B', 'proj', 'wt-a'),
    hand('h', 'proj', 'wt-a'),
  ],
});

describe('expanded conductor tree', () => {
  it('a conductor is collapsed by default, and the caret expands it into its project row, main-checkout workers, then each worktree by name with its workers newest first', async () => {
    // Invariant: the tree order is project row → main-checkout workers → worktree rows by name, each followed by its workers newest first.
    expect(FRESH.expandedConductors).toEqual([]);
    seed(treeFixture());
    renderSidebar();
    await settle();
    expect(treeOf('A')).toBeNull();
    expect(caretOf('A').getAttribute('aria-expanded')).toBe('false');
    expand('A');
    expect(caretOf('A').getAttribute('aria-expanded')).toBe('true');
    expect(treeRows('A')).toEqual([
      'project:proj', 'worker:wd', 'worktree:wt-a', 'worker:wa2', 'worker:wa1', 'worktree:wt-b', 'worker:wb',
    ]);
  });

  it('the expanded tree is read-only: no spawn, delete, worktree or close action, while commit history and review stay', async () => {
    // Invariant: the tree offers only commit history, review and promote; the same project, worktree and workers offer the structural actions in the Projects lens.
    sidebarStore.set({ expandedWorktrees: ['proj'] });
    seed(treeFixture());
    renderSidebar();
    await settle();
    const tree = labels(expand('A'));
    for (const l of STRUCTURAL) expect(tree.has(l), l).toBe(false);
    expect(tree.has('Commit history')).toBe(true);
    expect(tree.has('Review changes')).toBe(true);
    act(() => uiStore.set({ lens: 'projects' }));
    await settle();
    const projects = labels(el('[data-project-list]'));
    for (const l of ['New session', 'Delete project', 'New session in this worktree', 'Remove worktree', CLOSE_TITLES.archive]) expect(projects.has(l), `positive control: ${l}`).toBe(true);
  });

  it("the tree shows only this conductor's workers", async () => {
    // Invariant: a conductor's tree lists its own workers; another conductor's worker in the same worktree and a hand session are absent.
    seed(treeFixture());
    renderSidebar();
    await settle();
    expect(workerRows(expand('A'))).toEqual(['wd', 'wa2', 'wa1', 'wb']);
    expect(workerRows(expand('B'))).toEqual(['other']);
  });

  it('the tree lists live projects then idle projects in chip order, and an idle project with no surviving recorded worktree is its project row alone', async () => {
    // Invariant: the tree's projects follow the chip order; an idle project without a surviving recorded worktree has no worktree or worker rows.
    seed({
      projects: [proj('idle-b'), proj('live-p'), proj('idle-a', { worktrees: [wt('wt')] })],
      instances: [conductor('A'), worker('w', 'A', 'live-p')],
      conductorSpawns: { A: [{ project: 'idle-b', lastSpawnAt: 1 }, { project: 'idle-a', lastSpawnAt: 2 }] },
    });
    renderSidebar();
    await settle();
    expect(chipsOf('A').chips).toEqual(['live-p:live', 'idle-a:idle', 'idle-b:idle']);
    expand('A');
    expect(treeRows('A')).toEqual(['project:live-p', 'worker:w', 'project:idle-a', 'project:idle-b']);
  });

  it('an inactive conductor with only idle chips expands into its registered idle projects, with no worker rows', async () => {
    // Invariant: an inactive conductor's tree is its registered spawned projects, newest spawn first.
    sidebarStore.set({ inactiveOpen: true });
    seed({
      projects: [proj('p'), proj('q')],
      conductSessions: [{ sessionId: 'D', title: 'Done', lastActivity: 1 }],
      conductorSpawns: { D: [{ project: 'p', lastSpawnAt: 1 }, { project: 'removed', lastSpawnAt: 3 }, { project: 'q', lastSpawnAt: 2 }] },
    });
    renderSidebar();
    await settle();
    expect(inactiveGroup()!.contains(blockOf('D'))).toBe(true);
    expand('D');
    expect(treeRows('D')).toEqual(['project:q', 'project:p']);
  });

  it('a tree project flipping idle → live gains its worker rows in the same item, and loses them when the worker goes', async () => {
    // Invariant: the project's tree item survives the flip both ways; only its worker rows come and go.
    const base = { projects: [proj('p')], conductorSpawns: { A: [{ project: 'p', lastSpawnAt: 1 }] } };
    seed({ ...base, instances: [conductor('A')] });
    renderSidebar();
    await settle();
    const item = projectItem(expand('A'), 'p')!;
    expect(workerRows(item)).toEqual([]);
    act(() => appStore.set({ instances: [conductor('A'), worker('w', 'A', 'p')] }));
    expect(projectItem(treeOf('A')!, 'p') === item).toBe(true);
    expect(workerRows(item)).toEqual(['w']);
    act(() => appStore.set({ instances: [conductor('A')] }));
    expect(projectItem(treeOf('A')!, 'p') === item).toBe(true);
    expect(workerRows(item)).toEqual([]);
  });

  it('an idle project lists its surviving recorded worktrees by name, each marked idle, read-only and with no worker rows', async () => {
    // Invariant: recorded worktree names still in the project's list show, sorted, marked idle; a deleted or unrecorded worktree does not; each keeps only commit history and review.
    seed({
      projects: [proj('p', { worktrees: [wt('wt-z'), wt('wt-a'), wt('unrecorded')] })],
      instances: [conductor('A')],
      conductorSpawns: { A: [{ project: 'p', lastSpawnAt: 1, worktrees: ['wt-z', 'deleted', 'wt-a'] }] },
    });
    renderSidebar();
    await settle();
    const tree = expand('A');
    expect(treeRows('A')).toEqual(['project:p', 'worktree:wt-a', 'worktree:wt-z']);
    for (const name of ['wt-a', 'wt-z']) {
      const item = worktreeItem(tree, name)!;
      expect(item.getAttribute('data-idle'), name).toBe('true');
      expect(workerRows(item)).toEqual([]);
      const actions = labels(item);
      expect(actions.has('Commit history') && actions.has('Review changes'), name).toBe(true);
      expect(actions.has('New session in this worktree') || actions.has('Remove worktree'), name).toBe(false);
    }
  });

  it('an active project lists its live worktrees with their workers and its recorded-only ones without, all by name, a worktree with a live worker once', async () => {
    // Invariant: live and recorded-only worktrees share one by-name order; one with this conductor's live worker is a single live item with its rows, a recorded-only one is idle with none.
    seed({
      projects: [proj('p', { worktrees: [wt('wt-b'), wt('wt-a')] })],
      instances: [conductor('A'), worker('w', 'A', 'p', 'wt-b')],
      conductorSpawns: { A: [{ project: 'p', lastSpawnAt: 1, worktrees: ['wt-b', 'wt-a'] }] },
    });
    renderSidebar();
    await settle();
    const tree = expand('A');
    expect(treeRows('A')).toEqual(['project:p', 'worktree:wt-a', 'worktree:wt-b', 'worker:w']);
    expect(worktreeItem(tree, 'wt-b')!.hasAttribute('data-idle')).toBe(false);
    expect(worktreeItem(tree, 'wt-a')!.getAttribute('data-idle')).toBe('true');
  });

  it('a recorded worktree going live gains its worker rows in the same item and head, and goes back to idle when the worker goes', async () => {
    // Invariant: the worktree item and its head survive the flip both ways; the idle mark and the worker rows follow the live worker.
    const base = { projects: [proj('p', { worktrees: [wt('wt')] })], conductorSpawns: { A: [{ project: 'p', lastSpawnAt: 1, worktrees: ['wt'] }] } };
    seed({ ...base, instances: [conductor('A')] });
    renderSidebar();
    await settle();
    const item = worktreeItem(expand('A'), 'wt')!;
    const head = item.querySelector('[data-worktree-row]');
    expect(item.getAttribute('data-idle')).toBe('true');
    act(() => appStore.set({ instances: [conductor('A'), worker('w', 'A', 'p', 'wt')] }));
    expect(worktreeItem(treeOf('A')!, 'wt') === item).toBe(true);
    expect(item.querySelector('[data-worktree-row]') === head).toBe(true);
    expect(item.hasAttribute('data-idle')).toBe(false);
    expect(workerRows(item)).toEqual(['w']);
    act(() => appStore.set({ instances: [conductor('A')] }));
    expect(worktreeItem(treeOf('A')!, 'wt') === item).toBe(true);
    expect(item.getAttribute('data-idle')).toBe('true');
    expect(workerRows(item)).toEqual([]);
  });

  it("a recorded worktree dropped from the project's worktrees leaves the tree, and the project row stays", async () => {
    // Invariant: a recorded worktree shows only while the project lists it.
    seed({ projects: [proj('p', { worktrees: [wt('wt')] })], instances: [conductor('A')], conductorSpawns: { A: [{ project: 'p', lastSpawnAt: 1, worktrees: ['wt'] }] } });
    renderSidebar();
    await settle();
    expand('A');
    expect(treeRows('A')).toEqual(['project:p', 'worktree:wt']);
    act(() => appStore.set({ projects: [proj('p')] }));
    expect(treeRows('A')).toEqual(['project:p']);
  });

  it("a recorded worktree whose only live worker is another conductor's is idle under this conductor, with no rows", async () => {
    // Invariant: a worktree goes live under a conductor only for that conductor's own worker; the other conductor shows it live.
    seed({
      projects: [proj('p', { worktrees: [wt('wt')] })],
      instances: [conductor('A'), conductor('B'), worker('bw', 'B', 'p', 'wt')],
      conductorSpawns: { A: [{ project: 'p', lastSpawnAt: 1, worktrees: ['wt'] }] },
    });
    renderSidebar();
    await settle();
    const mine = worktreeItem(expand('A'), 'wt')!;
    expect(mine.getAttribute('data-idle')).toBe('true');
    expect(workerRows(mine)).toEqual([]);
    const theirs = worktreeItem(expand('B'), 'wt')!;
    expect(theirs.hasAttribute('data-idle')).toBe(false);
    expect(workerRows(theirs)).toEqual(['bw']);
  });

  it('commit history and review on a recorded-only worktree open that project and worktree', async () => {
    // Invariant: a recorded-only worktree's commit history and review address its (project, worktree) pair.
    seed({ projects: [proj('p', { worktrees: [wt('wt')] })], instances: [conductor('A')], conductorSpawns: { A: [{ project: 'p', lastSpawnAt: 1, worktrees: ['wt'] }] } });
    renderSidebar();
    await settle();
    const item = worktreeItem(expand('A'), 'wt')!;
    fireEvent.click(within(item).getByRole('button', { name: 'Commit history' }));
    expect(viewStore.get().commits).toEqual({ project: 'p', worktree: 'wt' });
    fireEvent.click(within(item).getByRole('button', { name: 'Review changes' }));
    expect(viewStore.get().review?.url).toBe('/api/projects/p/worktrees/wt/diff');
  });

  it("a worktree head shows the listed worktree's current meta, recorded-only or live, never the worker instance's copy", async () => {
    // Invariant: a head is built from the project's listed worktree, matched by name, whether or not a live worker sits in it.
    seed({
      projects: [proj('p', { worktrees: [
        wt('rec', { branch: 'cc/recreated' }),
        wt('live', { branch: 'cc/listed', mergeStatus: { ahead: 2, behind: 0 } }),
      ] })],
      instances: [conductor('A'), worker('w', 'A', 'p', 'live', {
        worktree: { worktreeName: 'live', branch: 'cc/instance', baseBranch: 'dev', baseSha: 'instsha00000000', mergeStatus: { ahead: 9, behind: 9 } },
      })],
      conductorSpawns: { A: [{ project: 'p', lastSpawnAt: 1, worktrees: ['rec'] }] },
    });
    renderSidebar();
    await settle();
    const tree = expand('A');
    const branchOf = (name: string) => (tree.querySelector(`[data-worktree-row="${name}"] [title^="cc/"]`) as HTMLElement).title.split('\n')[0];
    expect(branchOf('rec')).toBe('cc/recreated');
    expect(workerRows(worktreeItem(tree, 'live')!)).toEqual(['w']);
    expect(branchOf('live')).toBe('cc/listed');
    const live = tree.querySelector('[data-worktree-row="live"]')!.textContent!;
    expect(live).toContain('main');
    expect(live).not.toContain('dev');
    expect(live).toContain('2');
    expect(live).not.toContain('9');
  });

  it('expansion survives an instances update, and the tree takes the new worker', async () => {
    // Invariant: the expanded state is the conductor's, not the render's: the same block stays open and lists a worker that arrives.
    seed(treeFixture());
    renderSidebar();
    await settle();
    const block = blockOf('A');
    expand('A');
    act(() => appStore.set({ instances: [...treeFixture().instances, worker('new', 'A', 'proj')] }));
    expect(blockOf('A') === block).toBe(true);
    expect(caretOf('A').getAttribute('aria-expanded')).toBe('true');
    expect(workerRows(treeOf('A')!)).toContain('new');
  });

  it('a bound worker row shows its playbook · stage line verbatim, a playbook alone shows alone, and an unbound worker has none', async () => {
    // Invariant: the stage line is the worker's binding verbatim, present exactly when it is bound.
    seed({
      projects: [proj('proj')],
      instances: [
        conductor('A'),
        worker('free', 'A', 'proj', null, { createdAt: 1 }),
        worker('bound', 'A', 'proj', null, { playbook: 'triage-lab', stage: 'write-it-up ✎', createdAt: 3 }),
        worker('half', 'A', 'proj', null, { playbook: 'forge', createdAt: 2 }),
      ],
    });
    renderSidebar();
    await settle();
    const tree = expand('A');
    const stageOf = (sid: string) => tree.querySelector(`[data-session-row="${sid}"] [data-stage]`)?.textContent ?? null;
    expect(workerRows(tree)).toEqual(['bound', 'half', 'free']);
    expect(stageOf('bound')).toBe('triage-lab · write-it-up ✎');
    expect(stageOf('half')).toBe('forge');
    expect(stageOf('free')).toBeNull();
  });

  it('a stage change re-renders the same worker row in place', async () => {
    // Invariant: the worker row survives a stage change and shows the new stage.
    seed({ projects: [proj('proj')], instances: [conductor('A'), worker('w', 'A', 'proj', null, { playbook: 'forge', stage: 'plan' })] });
    renderSidebar();
    await settle();
    const tree = expand('A');
    const row = tree.querySelector('[data-session-row="w"]');
    expect(row?.querySelector('[data-stage]')?.textContent).toBe('forge · plan');
    act(() => appStore.set({ instances: [conductor('A'), worker('w', 'A', 'proj', null, { playbook: 'forge', stage: 'implement' })] }));
    expect(treeOf('A')!.querySelector('[data-session-row="w"]') === row).toBe(true);
    expect(row?.querySelector('[data-stage]')?.textContent).toBe('forge · implement');
  });
});
