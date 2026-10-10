import { api } from '../harness/api.ts';
import { expect } from '../harness/fixtures.ts';
import { parity } from './parity.ts';

parity('legacy-sidebar-lenses/R1', 'a fresh profile opens on the Conductors lens, and the chosen lens survives a reload', async ({ page, ui }) => {
  await ui.open(page);
  await expect.poll(() => ui.selectedLens(page)).toBe('conductors');
  await ui.lens(page, 'projects');
  await page.reload();
  await ui.open(page);
  await expect.poll(() => ui.selectedLens(page)).toBe('projects');
});

parity('spawn-dialog-server-resolves/R2', 'Conduct POSTs exactly {project, role, temp, mode} and opens the new conductor', async ({ page, cc, ui }) => {
  await ui.open(page);
  const spawn = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/instances');
  await ui.conduct(page);
  const req = await spawn;
  expect(req.postDataJSON()).toEqual({ project: '.conduct', role: 'conductor', temp: true, mode: 'bypassPermissions' });
  const { id } = await (await req.response())!.json();
  // The new conductor's session id, once cc reports it.
  let sid: string | null = null;
  await expect.poll(async () => {
    sid = ((await api(cc, 'GET', '/api/instances')).body as { id: string; sessionId: string | null }[])
      .find((i) => i.id === id)?.sessionId ?? null;
    return sid;
  }).not.toBeNull();
  const header = ui.sessionHeader(page);
  await expect(header).toBeVisible();
  await expect(header).not.toContainText('no instance selected');
  await expect(header.locator(`[title="session ${sid}"]`)).toBeVisible();
});

parity('adopt-dialog-markup/R1', 'the ≡ menu opens the Add-project dialog', async ({ page, ui }) => {
  await ui.open(page);
  const dialog = await ui.openAddProject(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Add a project');
  await expect(dialog.getByLabel('Name', { exact: true })).toBeVisible();
});
