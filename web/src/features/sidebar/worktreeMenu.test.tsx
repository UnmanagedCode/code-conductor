// The sidebar worktree row's ⋮ in the Projects lens: what it holds, what each
// item does, how an unreachable system gates it, and its hover reveal.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { uiStore } from '@/app/ui';
import { headOf, proj, seed, wt } from '@/test/sidebarFleet';
import { closeRowMenu, openWorktreeMenu, pickWorktreeMenuItem, rowMenuItems, worktreeMenuTrigger } from '@/test/rowMenu';

vi.mock('@/app/controller', () => ({
  selectInstance: vi.fn(),
  send: vi.fn(),
  refreshProjects: vi.fn(),
  refreshInstances: vi.fn(),
}));
const removeWorktree = vi.fn();
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(() => Promise.resolve([])),
  closeSession: vi.fn(),
  resumeSession: vi.fn(),
  promoteSession: vi.fn(),
  removeWorktree: (...a: unknown[]) => removeWorktree(...a),
}));
vi.mock('@/features/views/AppSwitcher', () => ({ AppSwitcher: () => null }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));

const { AppSidebar } = await import('./AppSidebar');
const { sidebarStore, invalidateSessions } = await import('./state');
const { closeDialog, dialogStore } = await import('@/features/dialogs/api');
const { REVEAL } = await import('./rows');

const ITEMS = ['New session in this worktree', 'Remove worktree…'];

function renderFleet(projects: any[]) {
  seed({ projects });
  sidebarStore.set({ expandedWorktrees: projects.map((p) => p.name) });
  render(<TooltipProvider><AppSidebar /></TooltipProvider>);
}
/** Each item of the row's open ⋮ as [text, aria-disabled, title]; closes the menu again. */
async function itemStates(head: HTMLElement) {
  const states = rowMenuItems(await openWorktreeMenu(head)).map((i) => [i.textContent, i.getAttribute('aria-disabled'), i.getAttribute('title')]);
  await closeRowMenu();
  return states;
}

beforeEach(() => {
  localStorage.clear();
  removeWorktree.mockReset();
  invalidateSessions();
  sidebarStore.set({ collapsedSessions: [], expandedWorktrees: [], expandedWorkspaces: [], expandedConductors: [], inactiveOpen: false, filter: '' });
  uiStore.set({ lens: 'projects' });
});
afterEach(() => {
  for (const k of Object.keys(dialogStore.get()) as (keyof ReturnType<typeof dialogStore.get>)[]) closeDialog(k);
});

describe('the worktree row ⋮ menu', () => {
  it('is the row\'s only trailing action, holding New session in this worktree, a separator, then Remove worktree…', async () => {
    // Invariant: the row's only trailing action is the ⋮, holding New session in this worktree, a separator, then Remove worktree….
    renderFleet([proj('api', { isGitRepo: true, worktrees: [wt('wt1')] })]);
    const head = headOf('wt1');
    expect(worktreeMenuTrigger(head)).toBeTruthy();
    expect(within(head).getByRole('button', { name: 'Commit history' }), 'positive control: the row\'s other action').toBeTruthy();
    for (const name of ['Review changes', 'New session in this worktree', 'Remove worktree']) {
      expect(within(head).queryByRole('button', { name }), name).toBeNull();
    }
    const menu = await openWorktreeMenu(head);
    const items = rowMenuItems(menu);
    expect(items.map((i) => i.textContent)).toEqual(ITEMS);
    const separator = menu.querySelector('[role="separator"]');
    expect(separator).not.toBeNull();
    expect(items[0].compareDocumentPosition(separator!) & Node.DOCUMENT_POSITION_FOLLOWING, 'the separator follows New session').toBeTruthy();
    expect(separator!.compareDocumentPosition(items[1]) & Node.DOCUMENT_POSITION_FOLLOWING, 'Remove follows the separator').toBeTruthy();
    expect(items[1].getAttribute('data-variant')).toBe('destructive');
    await closeRowMenu();
  });

  it('New session in this worktree opens the spawn dialog preset to that worktree', async () => {
    // Invariant: New session in this worktree opens the spawn dialog preset to that worktree.
    renderFleet([proj('api', { isGitRepo: true, worktrees: [wt('wt1')] })]);
    await pickWorktreeMenuItem(headOf('wt1'), 'New session in this worktree');
    expect(dialogStore.get().spawn).toEqual({ project: 'api', opts: { worktree: 'wt1' } });
  });

  it('Remove worktree… runs removeWorktree for that project and worktree', async () => {
    // Invariant: Remove worktree… runs removeWorktree for that project and worktree.
    renderFleet([proj('api', { isGitRepo: true, worktrees: [wt('wt1')] })]);
    await pickWorktreeMenuItem(headOf('wt1'), 'Remove worktree…');
    expect(removeWorktree.mock.calls).toEqual([['api', 'wt1']]);
  });

  it('on an unreachable project New session in this worktree is disabled with the reason; Remove worktree… stays enabled', async () => {
    // Invariant: on an unreachable project, New session in this worktree is disabled with the reason; Remove worktree… stays enabled.
    renderFleet([
      proj('api', { isGitRepo: true, systemUnreachable: 'system gone', worktrees: [wt('wt1')] }),
      proj('ok', { isGitRepo: true, worktrees: [wt('wt2')] }),
    ]);
    expect(await itemStates(headOf('wt1')), 'unreachable').toEqual([
      ['New session in this worktree', 'true', 'system gone'],
      ['Remove worktree…', null, null],
    ]);
    expect(await itemStates(headOf('wt2')), 'control: reachable').toEqual([
      ['New session in this worktree', null, null],
      ['Remove worktree…', null, null],
    ]);
  });

  it('the trigger is hover-revealed on pointer devices', () => {
    // Invariant: the trigger is hover-revealed on pointer devices.
    renderFleet([proj('api', { isGitRepo: true, worktrees: [wt('wt1')] })]);
    const classes = worktreeMenuTrigger(headOf('wt1')).classList;
    expect(REVEAL.split(' ').filter((c) => !classes.contains(c))).toEqual([]);
  });
});
