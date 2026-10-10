import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect } from '../harness/fixtures.ts';
import { api } from '../harness/api.ts';
import { parity } from './parity.ts';

// The scratch cc has no reachable provider, so a scenario that needs a remote
// system answers the registry, its targets and its directory listings itself.
const SYSTEMS = [
  { id: 'local', label: 'This machine', managed: true },
  { id: 'prod-box', label: 'Prod box', managed: false, launch: ['ssh', 'prod', 'p'] },
  { id: 'namedonly', label: 'Named only', managed: false },
];
async function routeRemoteSystem(page: Page) {
  await page.route('**/api/settings/systems', (r) => r.fulfill({ json: { systems: SYSTEMS } }));
  await page.route('**/api/systems/prod-box/remotes', (r) => r.fulfill({ json: { system: 'prod-box', label: 'Prod box', state: 'not-enumerable' } }));
  await page.route('**/api/fs/dirs**', (r) => r.fulfill({ json: { ok: true, entries: ['api', 'app'], links: [], truncated: false, max: 1000 } }));
}

parity('new-project-dialog-wiring/R1', 'New project creates a project that the Projects lens lists', async ({ page, ui, uniq }) => {
  const name = uniq('proj');
  await ui.open(page);
  await ui.lens(page, 'projects');
  await ui.newProject(page, name);
  await expect(await ui.projectRow(page, name)).toBeVisible();
});

parity('adopt-dialog-markup/R2', 'Adding an existing directory from the project menu: the menu closes, System comes from the registry, a suggestion fills the form, and Relocate adopts over a stale record', async ({ page, cc, ui, uniq }) => {
  const name = uniq('stale');
  const held = path.join(cc.dirs.root, 'elsewhere', name);
  fs.mkdirSync(held, { recursive: true });
  const reg = await api(cc, 'POST', '/api/projects/external', { name, path: held });
  expect(reg.body, JSON.stringify(reg.body)).toMatchObject({ ok: true });
  fs.rmSync(held, { recursive: true, force: true });
  const candidate = path.join(cc.dirs.projects, uniq('adopt-b'));
  fs.mkdirSync(candidate, { recursive: true });

  await routeRemoteSystem(page);
  await ui.open(page);
  const dialog = await ui.openPlacementDialog(page, 'adopt');
  await expect(ui.projectActionsMenu(page)).toBeHidden();
  await expect.poll(() => ui.systemOptions(page, dialog, 'adopt')).toContain('Prod box (prod-box)');
  expect(await ui.systemOptions(page, dialog, 'adopt')).not.toContain('Named only (namedonly)');
  await ui.pickSuggestion(dialog, path.basename(candidate));
  await expect(ui.placementField(dialog, 'adopt', 'name')).toHaveValue(path.basename(candidate));
  await expect(ui.placementField(dialog, 'adopt', 'path')).toHaveValue(candidate);
  await ui.placementField(dialog, 'adopt', 'name').fill(name);
  await ui.submitAdd(dialog);
  await ui.relocate(dialog);
  await expect(dialog).toBeHidden();
  await expect(await ui.projectRow(page, name)).toBeVisible();
});

parity('hidden-attribute-layout/R1', 'The placement rows a flow reveals stay hidden until it reveals them', async ({ page, cc, ui, uniq }) => {
  fs.mkdirSync(path.join(cc.dirs.projects, uniq('candidate')), { recursive: true });
  await routeRemoteSystem(page);
  await ui.open(page);

  const np = await ui.openPlacementDialog(page, 'new');
  await expect(ui.placementField(np, 'new', 'target')).toBeHidden();
  await expect(ui.placementField(np, 'new', 'path')).toBeHidden();
  await ui.chooseSystem(page, np, 'new', 'Prod box (prod-box)');
  await expect(ui.placementField(np, 'new', 'target')).toBeVisible();
  await expect(ui.placementField(np, 'new', 'path')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(np).toBeHidden();

  const apd = await ui.openPlacementDialog(page, 'adopt');
  await expect(ui.placementField(apd, 'adopt', 'suggestions')).toBeVisible();
  await expect(ui.placementField(apd, 'adopt', 'target')).toBeHidden();
  await ui.chooseSystem(page, apd, 'adopt', 'Prod box (prod-box)');
  await expect(ui.placementField(apd, 'adopt', 'target')).toBeVisible();
  await expect(ui.placementField(apd, 'adopt', 'suggestions')).toBeHidden();
});

parity('new-project-dialog-markup/R1', 'New project lays out System, then Target, then the path field', async ({ page, ui }) => {
  await routeRemoteSystem(page);
  await ui.open(page);
  const np = await ui.openPlacementDialog(page, 'new');
  await ui.chooseSystem(page, np, 'new', 'Prod box (prod-box)');
  const fields = [ui.placementField(np, 'new', 'system'), ui.placementField(np, 'new', 'target'), ui.placementField(np, 'new', 'path')];
  for (const f of fields) await expect(f).toBeVisible();
  const [system, target, pathField] = await Promise.all(fields.map(async (f) => (await f.boundingBox())!.y));
  expect(system).toBeLessThan(target);
  expect(target).toBeLessThan(pathField);
});

parity('path-picker/R4', 'Escape in a path field closes its completion list, not the dialog', async ({ page, ui }) => {
  await routeRemoteSystem(page);
  await ui.open(page);
  for (const which of ['new', 'adopt'] as const) {
    const dialog = await ui.openPlacementDialog(page, which);
    await ui.chooseSystem(page, dialog, which, 'Prod box (prod-box)');
    const field = ui.placementField(dialog, which, 'path');
    await field.fill('/srv/a');
    await expect(ui.placementField(dialog, which, 'pathList')).toBeVisible();
    await field.press('Escape');
    await expect(ui.placementField(dialog, which, 'pathList')).toBeHidden();
    await expect(dialog).toBeVisible();
    await field.press('Escape');
    await expect(dialog).toBeHidden();
  }
});
