// The plugin groups a sidebar row's ⋮ (project or worktree, both lenses) shows from the catalog's `menuItems`, and what a pick hands the opener.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { uiStore } from '@/app/ui';
import { A, fleet, headOf, projectRowOf, proj, seed, seedFleet, treeOf, wt } from '@/test/sidebarFleet';
import { closeRowMenu, openProjectMenu, openWorktreeMenu, pickProjectMenuItem, pickWorktreeMenuItem, rowMenuItems } from '@/test/rowMenu';

vi.mock('@/app/controller', () => ({
  selectInstance: vi.fn(),
  send: vi.fn(),
  refreshProjects: vi.fn(),
  refreshInstances: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(() => Promise.resolve([])),
  closeSession: vi.fn(),
  resumeSession: vi.fn(),
  promoteSession: vi.fn(),
  removeWorktree: vi.fn(),
}));
vi.mock('@/features/views/AppSwitcher', () => ({ AppSwitcher: () => null }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));
const openForRow = vi.fn();
vi.mock('@/features/views/pluginMenu', async (orig) => ({
  ...(await orig<typeof import('@/features/views/pluginMenu')>()),
  openPluginForRow: (...a: unknown[]) => openForRow(...a),
}));

const { AppSidebar } = await import('./AppSidebar');
const { sidebarStore, invalidateSessions } = await import('./state');
const { catalogStore } = await import('@/features/views/plugins');

type Row = import('@/features/views/plugins').PluginRow;
const app = (id: string, navLabel: string, menuItems: Row['menuItems']): Row => ({ id, name: id, navLabel, enabled: true, hasFrontend: true, menuItems });
const CATALOG: Row[] = [
  app('alpha', 'Alpha', [
    { label: '<b>Board</b>', scope: 'project', path: '/board' },
    { label: 'Issues', scope: 'project', path: '/issues' },
    { label: 'Diff', scope: 'worktree', path: '/diff' },
  ]),
  app('beta', 'Beta', [
    { label: 'Wiki', scope: 'project', path: '/wiki' },
    { label: 'Terminal', scope: 'worktree', path: '/term' },
    { label: 'Logs', scope: 'worktree', path: '/logs' },
  ]),
  app('gamma', 'Gamma', [{ label: 'Notes', scope: 'project', path: '/notes' }]),
];

const PROJECT_GROUPS = [['Alpha', ['<b>Board</b>', 'Issues']], ['Beta', ['Wiki']], ['Gamma', ['Notes']]];
const WORKTREE_GROUPS = [['Alpha', ['Diff']], ['Beta', ['Terminal', 'Logs']]];

/** Each group of the open menu as [its name, its item texts]; every group follows a separator. */
function groupsOf(menu: HTMLElement) {
  return within(menu).queryAllByRole('group').map((g) => {
    expect(g.previousElementSibling?.getAttribute('role'), 'a group follows a separator').toBe('separator');
    const name = document.getElementById(g.getAttribute('aria-labelledby')!)!.textContent;
    return [name, rowMenuItems(g).map((i) => i.textContent)];
  });
}
/** The groups of a row's ⋮, closing the menu again. */
async function projectGroups(row: HTMLElement) {
  const menu = await openProjectMenu(row);
  const groups = groupsOf(menu);
  await closeRowMenu();
  return groups;
}
async function worktreeGroups(head: HTMLElement) {
  const menu = await openWorktreeMenu(head);
  const groups = groupsOf(menu);
  await closeRowMenu();
  return groups;
}

function renderApi() {
  seed({ projects: [proj('api', { isGitRepo: true, worktrees: [wt('wt1')] })] });
  sidebarStore.set({ expandedWorktrees: ['api'] });
  render(<TooltipProvider><AppSidebar /></TooltipProvider>);
}

beforeEach(() => {
  localStorage.clear();
  openForRow.mockReset();
  invalidateSessions();
  catalogStore.set({ apps: [] });
  sidebarStore.set({ collapsedSessions: [], expandedWorktrees: [], expandedWorkspaces: [], expandedConductors: [], inactiveOpen: false, filter: '' });
  uiStore.set({ lens: 'projects' });
});

describe('plugin groups in a row ⋮', () => {
  it('Projects lens: the project ⋮ lists each contributing plugin\'s project items in a group of its own, catalog then manifest order, before Delete…', async () => {
    // Invariant: one group per plugin with project-scope items, in catalog order, items in manifest order, no worktree items, Delete… last.
    catalogStore.set({ apps: CATALOG });
    renderApi();
    const menu = await openProjectMenu(projectRowOf('api'));
    expect(groupsOf(menu)).toEqual(PROJECT_GROUPS);
    expect(rowMenuItems(menu).at(-1)!.textContent).toBe('Delete…');
  });

  it('the menus keep the plugin groups between the existing items and the destructive item', async () => {
    // Invariant: project ⋮ = New session, Edit conventions…, plugin items, Delete…; worktree ⋮ = New session in this worktree, plugin items, Remove worktree…; one separator before each group and one before the destructive item.
    catalogStore.set({ apps: CATALOG });
    renderApi();
    const sequence = (menu: HTMLElement) => [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')]
      .map((n) => (n.getAttribute('role') === 'separator' ? '—' : n.textContent));
    expect(sequence(await openProjectMenu(projectRowOf('api')))).toEqual([
      'New session', 'Edit conventions…',
      '—', '<b>Board</b>', 'Issues', '—', 'Wiki', '—', 'Notes',
      '—', 'Delete…',
    ]);
    await closeRowMenu();
    expect(sequence(await openWorktreeMenu(headOf('wt1')))).toEqual([
      'New session in this worktree',
      '—', 'Diff', '—', 'Terminal', 'Logs',
      '—', 'Remove worktree…',
    ]);
  });

  it('Projects lens: the worktree ⋮ lists only worktree items; a plugin with none in that scope has no group', async () => {
    // Invariant: the worktree ⋮ shows worktree-scope items only, and omits a plugin with none.
    catalogStore.set({ apps: CATALOG });
    renderApi();
    expect(await worktreeGroups(headOf('wt1'))).toEqual(WORKTREE_GROUPS);
  });

  it('a label renders as text, not markup', async () => {
    // Invariant: a plugin's label is text content, never parsed as HTML.
    catalogStore.set({ apps: CATALOG });
    renderApi();
    const item = rowMenuItems(await openProjectMenu(projectRowOf('api'))).find((i) => i.textContent === '<b>Board</b>')!;
    expect(item.textContent).toBe('<b>Board</b>');
    expect(item.querySelector('b')).toBeNull();
  });

  it('Conductors lens: the project and worktree ⋮ carry the same groups', async () => {
    // Invariant: the Conductors lens rows offer the same plugin groups as the Projects lens.
    catalogStore.set({ apps: CATALOG });
    seedFleet(fleet());
    uiStore.set({ lens: 'conductors' });
    sidebarStore.set({ expandedConductors: [A] });
    render(<TooltipProvider><AppSidebar /></TooltipProvider>);
    const tree = treeOf(A)!;
    expect(await projectGroups(within(tree).getByText('solo').closest('[data-project-row]') as HTMLElement)).toEqual(PROJECT_GROUPS);
    expect(await worktreeGroups(tree.querySelector('[data-worktree-row="solo-a"]') as HTMLElement)).toEqual(WORKTREE_GROUPS);
  });

  it('with no plugin contributing to a scope the menu is unchanged', async () => {
    // Invariant: no contributing plugin means no extra separator or group.
    catalogStore.set({ apps: CATALOG.filter((a) => a.id === 'gamma') });
    renderApi();
    const wtMenu = await openWorktreeMenu(headOf('wt1'));
    expect(rowMenuItems(wtMenu).map((i) => i.textContent)).toEqual(['New session in this worktree', 'Remove worktree…']);
    expect(wtMenu.querySelectorAll('[role="separator"]')).toHaveLength(1);
    await closeRowMenu();
    catalogStore.set({ apps: [] });
    const prMenu = await openProjectMenu(projectRowOf('api'));
    expect(rowMenuItems(prMenu)).toHaveLength(3);
    expect(prMenu.querySelectorAll('[role="separator"]')).toHaveLength(1);
  });

  it('a pick opens the plugin for that row', async () => {
    // Invariant: a pick hands the opener the plugin, the item's path, and the row's project and worktree, unswapped; a project item carries no worktree.
    catalogStore.set({ apps: CATALOG });
    renderApi();
    await pickProjectMenuItem(projectRowOf('api'), 'Issues');
    expect(openForRow).toHaveBeenLastCalledWith('alpha', '/issues', { project: 'api', worktree: null });
    await pickWorktreeMenuItem(headOf('wt1'), 'Logs');
    expect(openForRow).toHaveBeenLastCalledWith('beta', '/logs', { project: 'api', worktree: 'wt1' });
  });

  it('a pick in the Conductors lens opens the plugin for that row', async () => {
    // Invariant: the Conductors lens hands the opener the same row scope.
    catalogStore.set({ apps: CATALOG });
    seedFleet(fleet());
    uiStore.set({ lens: 'conductors' });
    sidebarStore.set({ expandedConductors: [A] });
    render(<TooltipProvider><AppSidebar /></TooltipProvider>);
    await pickWorktreeMenuItem(treeOf(A)!.querySelector('[data-worktree-row="solo-a"]') as HTMLElement, 'Logs');
    expect(openForRow).toHaveBeenLastCalledWith('beta', '/logs', { project: 'solo', worktree: 'solo-a' });
  });
});
