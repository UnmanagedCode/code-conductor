import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/app/controller', () => ({ selectInstance: vi.fn(), refreshProjects: vi.fn() }));
vi.mock('@/app/sessionActions', () => ({
  closeSession: vi.fn(), promoteSession: vi.fn(), removeWorktree: vi.fn(), resumeSession: vi.fn(),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { closeDialog, dialogStore } from '@/features/dialogs/api';
import type { Project } from '@/state/types';
import { closeProjectMenu, openProjectMenu, pickProjectMenuItem, projectMenuItems, projectMenuTrigger } from '@/test/projectMenu';
import { ProjectRow } from './rows';

const project = (over: Partial<Project> = {}) => ({
  name: 'api', path: '/p/api', workspace: null, system: 'local', remoteId: null, systemUnreachable: null,
  isGitRepo: true, worktrees: [], conventions: { selected: ['design-guidelines'], unresolved: [] }, ...over,
}) as Project;

function renderRow(p: Project, instanceCount = 0) {
  render(<TooltipProvider><ProjectRow project={p} instanceCount={instanceCount} /></TooltipProvider>);
  return document.querySelector(`[data-project-row="${p.name}"]`) as HTMLElement;
}

const dot = (row: HTMLElement) => row.querySelector('[data-conventions-attention]');
const notice = (row: HTMLElement) => {
  const id = projectMenuTrigger(row).getAttribute('aria-describedby');
  return id ? document.getElementById(id)?.textContent ?? null : null;
};
const item = (menu: HTMLElement, label: string) => projectMenuItems(menu).find((i) => i.textContent === label)!;

afterEach(() => {
  for (const k of Object.keys(dialogStore.get()) as (keyof ReturnType<typeof dialogStore.get>)[]) closeDialog(k);
});

describe('the project row ⋮ menu', () => {
  it('is the row\'s only trailing action, holding New session, Edit conventions… and Delete… in that order', async () => {
    // Invariant: the old New session / Delete project buttons are gone; the menu carries their actions plus the edit, in order.
    const row = renderRow(project());
    expect(projectMenuTrigger(row)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New session' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete project' })).toBeNull();
    const menu = await openProjectMenu(row);
    expect(projectMenuItems(menu).map((i) => i.textContent)).toEqual(['New session', 'Edit conventions…', 'Delete…']);
    await closeProjectMenu();
  });

  it('New session opens the spawn dialog for the project with no options', async () => {
    // Invariant: the pick opens exactly the dialog the old + button did.
    const row = renderRow(project());
    await pickProjectMenuItem(row, 'New session');
    expect(dialogStore.get().spawn).toEqual({ project: 'api', opts: {} });
  });

  it('Delete… opens the delete dialog with the project and its instance count', async () => {
    // Invariant: the pick hands the delete dialog this row's project and the count it was given.
    const p = project();
    const row = renderRow(p, 3);
    await pickProjectMenuItem(row, 'Delete…');
    expect(dialogStore.get().deleteProject).toEqual({ project: p, instanceCount: 3 });
  });

  it('Edit conventions… opens the edit dialog for the project', async () => {
    // Invariant: the pick fills the editConventions slot with this row's project.
    const row = renderRow(project());
    await pickProjectMenuItem(row, 'Edit conventions…');
    expect(dialogStore.get().editConventions?.project.name).toBe('api');
  });

  it('on an unreachable row New session and Edit conventions… are disabled with the reason; Delete… stays enabled', async () => {
    // Invariant: the items that would fail are disabled and say why; delete never depends on reaching the system.
    const row = renderRow(project({ system: 'box', systemUnreachable: 'box is down', conventions: undefined }));
    const menu = await openProjectMenu(row);
    for (const label of ['New session', 'Edit conventions…']) {
      expect(item(menu, label).getAttribute('aria-disabled'), label).toBe('true');
      expect(item(menu, label).title, label).toBe('box is down');
    }
    expect(item(menu, 'Delete…').getAttribute('aria-disabled')).toBeNull();
    await closeProjectMenu();
  });
});

describe('the conventions dot on the ⋮', () => {
  it('shows for a project with no selection, saying so, and highlights Edit conventions…', async () => {
    // Invariant: an empty selection flags the trigger, describes why, and marks the Edit item.
    const row = renderRow(project({ conventions: { selected: [], unresolved: [] } }));
    expect(dot(row)).toBeTruthy();
    expect(notice(row)).toBe('No project conventions selected.');
    const menu = await openProjectMenu(row);
    expect(item(menu, 'Edit conventions…').hasAttribute('data-attention')).toBe(true);
    await closeProjectMenu();
  });

  it('shows for a selection with an unresolved slug, naming it', async () => {
    // Invariant: an unresolved slug flags the trigger, and the description names the slug.
    const row = renderRow(project({ conventions: { selected: ['design-guidelines', 'gone'], unresolved: ['gone'] } }));
    expect(dot(row)).toBeTruthy();
    expect(notice(row)).toContain('gone');
    expect(notice(row)).not.toContain('design-guidelines');
    const menu = await openProjectMenu(row);
    expect(item(menu, 'Edit conventions…').hasAttribute('data-attention')).toBe(true);
    await closeProjectMenu();
  });

  it('does not show for a healthy selection', async () => {
    // Invariant: a resolved, non-empty selection raises nothing.
    const row = renderRow(project());
    expect(dot(row)).toBeNull();
    expect(notice(row)).toBeNull();
    const menu = await openProjectMenu(row);
    expect(item(menu, 'Edit conventions…').hasAttribute('data-attention')).toBe(false);
    await closeProjectMenu();
  });

  it('does not show when the file could not be read, and Edit conventions… is disabled with the error', async () => {
    // Invariant: an unreadable file is not "no selection"; the edit is refused up front with the read error.
    const row = renderRow(project({ conventions: { error: 'EACCES: permission denied' } }));
    expect(dot(row)).toBeNull();
    const menu = await openProjectMenu(row);
    expect(item(menu, 'Edit conventions…').hasAttribute('data-attention')).toBe(false);
    expect(item(menu, 'Edit conventions…').getAttribute('aria-disabled')).toBe('true');
    expect(item(menu, 'Edit conventions…').title).toBe('EACCES: permission denied');
    await closeProjectMenu();
  });

  it('does not show when the listing carries no conventions field', async () => {
    // Invariant: an unresolvable project (no field) raises nothing.
    const row = renderRow(project({ conventions: undefined }));
    expect(dot(row)).toBeNull();
    const menu = await openProjectMenu(row);
    expect(item(menu, 'Edit conventions…').hasAttribute('data-attention')).toBe(false);
    await closeProjectMenu();
  });
});
