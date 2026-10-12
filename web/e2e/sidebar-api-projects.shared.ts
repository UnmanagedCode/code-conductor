// The Projects lens under /next/ follows changes made through cc's API after the
// page loaded — REST and MCP alike, as a conductor makes them — without a reload:
// the server's `projects` hint re-reads the list. The bodies are shared by the
// per-project spec files.
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { api, createProject, mcpCall } from './harness/api.ts';
import { next, nextSidebar } from './flows/ui.ts';

type Ctx = { page: Page; cc: Cc };

/** One MCP tool's JSON answer. */
async function tool<T>(cc: Cc, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await mcpCall(cc, name, args);
  expect(result.isError, `${name}: ${JSON.stringify(result)}`).toBeFalsy();
  return JSON.parse(result.content[0].text) as T;
}

// Invariant: after each change the flow's rows are exactly the projects that exist — a creation adds
// one, two created together add two, a deletion removes one, and a re-creation brings it back.
export async function projectsFlow({ page, cc }: Ctx): Promise<void> {
  const prefix = `api-p-${test.info().project.name}`;
  const name = (s: string) => `${prefix}-${s}`;
  await createProject(cc, name('a'));
  await next.open(page);
  await next.lens(page, 'projects');
  const sb = nextSidebar(page);
  const row = (s: string) => sb.locator(`[data-project-row="${name(s)}"]`);
  const rows = sb.locator(`[data-project-row^="${prefix}-"]`);
  await expect(row('a')).toHaveCount(1);
  await expect(rows).toHaveCount(1);

  await Promise.all([createProject(cc, name('b')), createProject(cc, name('c'))]);
  await expect(row('b')).toHaveCount(1);
  await expect(row('c')).toHaveCount(1);
  await expect(rows).toHaveCount(3);

  await tool(cc, 'create_project', { name: name('d') });
  await expect(row('d')).toHaveCount(1);
  await expect(rows).toHaveCount(4);

  expect((await api(cc, 'DELETE', `/api/projects/${name('b')}`, { deleteDirectory: true })).status).toBe(200);
  await expect(row('b')).toHaveCount(0);
  await expect(rows).toHaveCount(3);

  await tool(cc, 'create_project', { name: name('b') });
  await expect(row('b')).toHaveCount(1);
  await expect(rows).toHaveCount(4);
}

// Invariant: a worktree made and removed through MCP appears and goes under its project, a
// workspace assignment and rename regroup the project under the new name and never the old, and a
// workspace created with no members shows its section until it is deleted.
export async function regroupFlow({ page, cc }: Ctx): Promise<void> {
  const tag = test.info().project.name;
  const project = `api-w-${tag}`;
  const ws = `Api-WS-${tag}`;
  const renamed = `Api-WS2-${tag}`;
  const empty = `Api-Empty-${tag}`;
  await createProject(cc, project);
  await next.open(page);
  await next.lens(page, 'projects');
  const sb = nextSidebar(page);
  await expect(sb.locator(`[data-project-row="${project}"]`)).toHaveCount(1);
  const group = sb.locator(`[data-worktrees="${project}"]`);
  await expect(group).toHaveCount(0);

  const wt = await tool<{ worktree: string }>(cc, 'create_worktree', { project });
  await expect(group).toHaveCount(1);
  await next.openWorktrees(page, project);
  await expect(sb.locator(`[data-project="${project}"] [data-worktree-row="${wt.worktree}"]`)).toHaveCount(1);
  await tool(cc, 'delete_worktree', { project, worktree: wt.worktree });
  await expect(group).toHaveCount(0);

  await tool(cc, 'set_project_workspace', { project, workspace: ws });
  const section = (w: string) => sb.locator(`section[data-workspace="${w}"]`);
  await expect(section(ws)).toHaveCount(1);
  await expect(section('').locator(`[data-project-row="${project}"]`)).toHaveCount(0);
  await section(ws).locator('button[aria-expanded]').click();
  await expect(section(ws).locator(`[data-project-row="${project}"]`)).toHaveCount(1);

  await tool(cc, 'rename_workspace', { oldName: ws, newName: renamed });
  await expect(section(renamed)).toHaveCount(1);
  await expect(section(ws)).toHaveCount(0);

  await tool(cc, 'create_workspace', { name: empty });
  await expect(section(empty)).toHaveCount(1);
  await expect(section(empty).locator('[data-project-row]')).toHaveCount(0);
  await tool(cc, 'delete_workspace', { name: empty });
  await expect(section(empty)).toHaveCount(0);
  await expect(section(renamed)).toHaveCount(1);
}
