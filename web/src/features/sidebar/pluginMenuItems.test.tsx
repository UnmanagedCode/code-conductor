// The plugin entries a sidebar row's ⋮ (project or worktree, both lenses) shows from the catalog's `menuItems`, and what a pick hands the opener.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { uiStore } from '@/app/ui';
import { A, fleet, headOf, projectRowOf, proj, seed, seedFleet, treeOf, wt } from '@/test/sidebarFleet';
import { closeRowMenu, openProjectMenu, openWorktreeMenu, pickProjectMenuItem, pickWorktreeMenuItem, rowMenuItemLabel, rowMenuItems } from '@/test/rowMenu';

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
const app = (id: string, navLabel: string, menuItems: Row['menuItems'], icon?: string): Row => ({ id, name: id, navLabel, enabled: true, hasFrontend: true, menuItems, icon });
const CATALOG: Row[] = [
  app('alpha', 'Alpha', [
    { label: '<b>Board</b>', scope: 'project', path: '/board' },
    { label: 'Issues', scope: 'project', path: '/issues' },
    { label: 'Diff', scope: 'worktree', path: '/diff' },
  ], 'square-kanban'),
  app('beta', 'Code Beta', [
    { label: 'Wiki', scope: 'project', path: '/wiki' },
    { label: 'Terminal', scope: 'worktree', path: '/term' },
    { label: 'Logs', scope: 'worktree', path: '/logs' },
  ]),
  app('gamma', 'Code Gamma', [{ label: 'Notes', scope: 'project', path: '/notes' }]),
];

const PROJECT_GROUPS = [['Alpha', ['<b>Board</b>', 'Issues']]];
const WORKTREE_GROUPS = [['Code Beta', ['Terminal', 'Logs']]];

/** Each group of the open menu as [its name, its item texts]; every group follows a separator. */
function groupsOf(menu: HTMLElement) {
  return within(menu).queryAllByRole('group').map((g) => {
    expect(g.previousElementSibling?.getAttribute('role'), 'a group follows a separator').toBe('separator');
    const name = document.getElementById(g.getAttribute('aria-labelledby')!)!.textContent;
    return [name, rowMenuItems(g).map(rowMenuItemLabel)];
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

describe('plugin entries in a row ⋮', () => {
  it('Projects lens: a plugin with several project items keeps a labelled group, the single-item plugins are flat entries before it', async () => {
    // Invariant: a plugin with 2+ items in scope is one headed group in manifest order; single-item plugins are flat, with no header, before the groups; Delete… last.
    catalogStore.set({ apps: CATALOG });
    renderApi();
    const menu = await openProjectMenu(projectRowOf('api'));
    expect(groupsOf(menu)).toEqual(PROJECT_GROUPS);
    for (const label of ['Wiki', 'Notes']) {
      expect(rowMenuItems(menu).find((i) => rowMenuItemLabel(i) === label)!.closest('[role="group"]'), `${label} is flat`).toBeNull();
    }
    expect(within(menu).queryByText('Code Beta')).toBeNull();
    expect(within(menu).queryByText('Code Gamma')).toBeNull();
    expect(rowMenuItems(menu).at(-1)!.textContent).toBe('Delete…');
  });

  it('the menus keep the plugin entries between the existing items and the destructive item', async () => {
    // Invariant: project ⋮ = New session, Edit conventions…, singles section, groups, Delete…; worktree ⋮ = New session in this worktree, singles, groups, Remove worktree…; one separator before each section and before the destructive item.
    catalogStore.set({ apps: CATALOG });
    renderApi();
    const sequence = (menu: HTMLElement) => [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')]
      .map((n) => (n.getAttribute('role') === 'separator' ? '—' : rowMenuItemLabel(n as HTMLElement)));
    expect(sequence(await openProjectMenu(projectRowOf('api')))).toEqual([
      'New session', 'Edit conventions…',
      '—', 'Wiki', 'Notes',
      '—', '<b>Board</b>', 'Issues',
      '—', 'Delete…',
    ]);
    await closeRowMenu();
    expect(sequence(await openWorktreeMenu(headOf('wt1')))).toEqual([
      'New session in this worktree',
      '—', 'Diff',
      '—', 'Terminal', 'Logs',
      '—', 'Remove worktree…',
    ]);
  });

  it('Projects lens: the worktree ⋮ lists only worktree items; a plugin with none in that scope has no entry', async () => {
    // Invariant: the worktree ⋮ shows worktree-scope items only, groups by that scope's item count, and omits a plugin with none.
    catalogStore.set({ apps: CATALOG });
    renderApi();
    const menu = await openWorktreeMenu(headOf('wt1'));
    expect(groupsOf(menu)).toEqual(WORKTREE_GROUPS);
    expect(rowMenuItems(menu).find((i) => rowMenuItemLabel(i) === 'Diff')!.closest('[role="group"]')).toBeNull();
    expect(rowMenuItems(menu).map(rowMenuItemLabel)).not.toContain('Wiki');
  });

  it('a flat entry is tagged with its plugin\'s short name as a hidden, described-by tag; a grouped item has none', async () => {
    // Invariant: a flat entry's accessible name is its label and its accessible description is the plugin's short name ("Code " stripped), the visible tag is aria-hidden; items under a header carry no tag.
    catalogStore.set({ apps: CATALOG });
    renderApi();
    const menu = await openProjectMenu(projectRowOf('api'));
    const item = (label: string) => rowMenuItems(menu).find((i) => rowMenuItemLabel(i) === label)!;
    const tagOf = (label: string) => document.getElementById(item(label).getAttribute('aria-describedby')!)!;
    expect(tagOf('Wiki').textContent).toBe('Beta');
    expect(tagOf('Notes').textContent).toBe('Gamma');
    expect(tagOf('Wiki').getAttribute('aria-hidden')).toBe('true');
    expect(item('Issues').hasAttribute('aria-describedby')).toBe(false);
    await closeRowMenu();
    const wt = await openWorktreeMenu(headOf('wt1'));
    const diff = rowMenuItems(wt).find((i) => rowMenuItemLabel(i) === 'Diff')!;
    expect(document.getElementById(diff.getAttribute('aria-describedby')!)!.textContent).toBe('Alpha');
  });

  it('every plugin entry leads with an icon, the plugin\'s own or the plug; core entries still do', async () => {
    // Invariant: each plugin item's first element child is an svg (the plugin's `icon`, else lucide-plug) so it aligns with the core items' icons.
    catalogStore.set({ apps: CATALOG });
    renderApi();
    const menu = await openProjectMenu(projectRowOf('api'));
    const lead = (label: string) => rowMenuItems(menu).find((i) => rowMenuItemLabel(i) === label)!.firstElementChild!;
    for (const label of ['<b>Board</b>', 'Issues']) expect(lead(label).getAttribute('class')).toContain('lucide-square-kanban');
    for (const label of ['Wiki', 'Notes']) expect(lead(label).getAttribute('class')).toContain('lucide-plug');
    for (const label of ['New session', 'Edit conventions…', 'Delete…']) expect(lead(label).tagName.toLowerCase(), `${label} leads with an svg`).toBe('svg');
  });

  it('a label renders as text, not markup', async () => {
    // Invariant: a plugin's label is text content, never parsed as HTML.
    catalogStore.set({ apps: CATALOG });
    renderApi();
    const item = rowMenuItems(await openProjectMenu(projectRowOf('api'))).find((i) => rowMenuItemLabel(i) === '<b>Board</b>')!;
    expect(rowMenuItemLabel(item)).toBe('<b>Board</b>');
    expect(item.querySelector('b')).toBeNull();
  });

  it('Conductors lens: the project and worktree ⋮ carry the same sections', async () => {
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
    // Invariant: a pick, of a grouped or a flat entry, hands the opener the plugin, the item's path, and the row's project and worktree, unswapped; a project item carries no worktree.
    catalogStore.set({ apps: CATALOG });
    renderApi();
    await pickProjectMenuItem(projectRowOf('api'), 'Issues');
    expect(openForRow).toHaveBeenLastCalledWith('alpha', '/issues', { project: 'api', worktree: null });
    await pickProjectMenuItem(projectRowOf('api'), 'Notes');
    expect(openForRow).toHaveBeenLastCalledWith('gamma', '/notes', { project: 'api', worktree: null });
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
