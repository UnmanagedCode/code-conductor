import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect } from '../harness/fixtures.ts';
import { api, createProject } from '../harness/api.ts';
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

// Dialogs part 2 (card 2026-0631)

parity('delete-project-confirm/R4', 'Deleting a local project offers the directory opt-in unticked, its box inline before a label naming the directory, and Cancel keeps the project', async ({ page, cc, ui, uniq }) => {
  const name = uniq('del');
  await createProject(cc, name);
  const projectPath = ((await api(cc, 'GET', '/api/projects')).body as { name: string; path: string }[]).find((p) => p.name === name)!.path;
  await ui.open(page);
  const d = await ui.openDeleteProject(page, name);
  const { box, label } = ui.deleteDirOptIn(d);
  await expect(box).not.toBeChecked();
  await expect(label).toHaveText('Also delete the directory ' + projectPath);
  const b = (await box.boundingBox())!;
  const l = (await label.boundingBox())!;
  expect(b.x + b.width).toBeLessThanOrEqual(l.x + 0.5);
  const centre = b.y + b.height / 2;
  expect(centre).toBeGreaterThanOrEqual(l.y);
  expect(centre).toBeLessThanOrEqual(l.y + l.height);
  await ui.cancelDialog(d);
  await expect(d).toBeHidden();
  await expect(await ui.projectRow(page, name)).toBeVisible();
});

parity('delete-project-confirm/R3', 'A mismatched name in the delete dialog deletes nothing and keeps the dialog open, and Cancel keeps the project', async ({ page, cc, ui, uniq }) => {
  const name = uniq('mismatch');
  await createProject(cc, name);
  const deletes: string[] = [];
  page.on('request', (r) => { if (r.method() === 'DELETE' && new URL(r.url()).pathname === '/api/projects/' + name) deletes.push(r.url()); });
  await ui.open(page);
  const d = await ui.openDeleteProject(page, name);
  await ui.tryDeleteWithMismatch(page, d, name);
  await expect(d).toBeVisible();
  expect(deletes).toHaveLength(0);
  await ui.cancelDialog(d);
  await expect(await ui.projectRow(page, name)).toBeVisible();
  expect(deletes).toHaveLength(0);
});

parity('project-remote-dialog/R3', 'Change target from the system pill: a refusal shows the server message and keeps the dialog, Cancel sends nothing, a reopen starts clean, and Save PUTs the trimmed target and refreshes the list', async ({ page, ui, uniq }) => {
  const name = uniq('remote');
  const fake = { name, path: '/app', system: 'prod-box', remoteId: 'ctr-7', systemUnreachable: null, workspace: null, isGitRepo: true, unbornHead: false, worktrees: [] };
  let gets = 0;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    gets++;
    const res = await route.fetch();
    await route.fulfill({ response: res, json: [...(await res.json()), fake] });
  });
  const puts: unknown[] = [];
  let answer: { status: number; json: unknown } = { status: 502, json: { error: "remote 'typo' of system 'prod-box', which does not serve it" } };
  await page.route('**/api/projects/' + name + '/remote', async (route) => {
    puts.push(route.request().postDataJSON());
    await route.fulfill(answer);
  });

  await ui.open(page);
  const d = await ui.openChangeTarget(page, name);
  const { target, error } = ui.changeTarget(d);
  await expect(target).toHaveValue('ctr-7');
  await target.fill('typo');
  await ui.saveTarget(d);
  await expect(error).toContainText('does not serve it');
  await expect(d).toBeVisible();
  await expect.poll(() => puts).toEqual([{ remoteId: 'typo' }]);
  await ui.cancelDialog(d);
  expect(puts).toHaveLength(1);

  await ui.openChangeTarget(page, name);
  await expect(error.filter({ hasText: /\S/ })).toHaveCount(0);
  await expect(target).toHaveValue('ctr-7');
  answer = { status: 200, json: { ok: true } };
  const before = gets;
  await target.fill('  ctr-9  ');
  await ui.saveTarget(d);
  await expect(d).toBeHidden();
  await expect.poll(() => puts.length).toBe(2);
  expect(puts[1]).toEqual({ remoteId: 'ctr-9' });
  await expect.poll(() => gets).toBeGreaterThan(before);
});

parity('spawn-dialog-worktree/R1', "The worktree box follows the project's repo: disabled with a reason for a non-git directory and an unborn HEAD, tickable on a repo with a commit", async ({ page, cc, ui, uniq }) => {
  async function adopt(name: string, init: boolean) {
    const dir = path.join(cc.dirs.root, 'elsewhere', name);
    fs.mkdirSync(dir, { recursive: true });
    if (init) execFileSync('git', ['init', '-q'], { cwd: dir });
    const reg = await api(cc, 'POST', '/api/projects/external', { name, path: dir });
    expect(reg.body, JSON.stringify(reg.body)).toMatchObject({ ok: true });
  }
  const plain = uniq('nogit');
  const unborn = uniq('unborn');
  const repo = uniq('repo');
  await adopt(plain, false);
  await adopt(unborn, true);
  await createProject(cc, repo);
  await ui.open(page);

  // Each dialog is cancelled before the next opens: an open modal blocks the next row's click.
  let d = await ui.openSpawnDialog(page, plain);
  await ui.spawnAdvanced(d);
  await expect(ui.spawnField(d, 'worktree')).toBeDisabled();
  await expect(ui.spawnField(d, 'worktree')).not.toBeChecked();
  await expect(ui.spawnField(d, 'worktreeHint')).toHaveText(/not a git repo/i);
  await ui.cancelDialog(d);

  d = await ui.openSpawnDialog(page, unborn);
  await ui.spawnAdvanced(d);
  await expect(ui.spawnField(d, 'worktree')).toBeDisabled();
  await expect(ui.spawnField(d, 'worktree')).not.toBeChecked();
  await expect(ui.spawnField(d, 'worktreeHint')).toHaveText(/no commits yet/i);
  await ui.cancelDialog(d);

  d = await ui.openSpawnDialog(page, repo);
  await ui.spawnAdvanced(d);
  await expect(ui.spawnField(d, 'worktree')).toBeEnabled();
  await expect(ui.spawnField(d, 'worktreeHint')).toHaveText(/branched off (the )?current HEAD/i);
  await ui.spawnField(d, 'worktree').click();
  await expect(ui.spawnField(d, 'worktree')).toBeChecked();
  await ui.cancelDialog(d);
});

parity('spawn-dialog-effort/R2', 'The spawn dialog hides disabled tiers, opens Effort on Default naming the tier level and follows a tier pick, opens Thinking on adaptive, and pre-checks Debug from the setting', async ({ page, cc, ui, uniq }) => {
  // Page-local settings: the shared cc's own settings are never written.
  await page.route('**/api/settings/models', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({
      response: res,
      json: {
        ...body,
        enabledTiers: { ...body.enabledTiers, fast: false },
        tierEffort: { ...body.tierEffort, balanced: 'medium', powerful: 'xhigh', frontier: 'max' },
        defaultSpawnTier: 'powerful',
      },
    });
  });
  await page.route('**/api/settings/spawn', (route) => route.fulfill({ json: { debugByDefault: true } }));
  const name = uniq('spawn');
  await createProject(cc, name);

  await ui.open(page);
  const d = await ui.openSpawnDialog(page, name);
  await expect.poll(() => ui.spawnTiers(d)).toEqual({ offered: ['balanced', 'powerful', 'frontier'], selected: 'powerful' });
  await ui.spawnAdvanced(d);
  expect(await ui.spawnSelect(page, d, 'effort')).toEqual({ options: ['Default (xhigh)', 'low', 'medium', 'high', 'xhigh', 'max'], selected: 'Default (xhigh)' });
  await ui.pickTier(d, 'frontier');
  const effort = await ui.spawnSelect(page, d, 'effort');
  expect(effort.options[0]).toBe('Default (max)');
  expect(effort.selected).toBe('Default (max)');
  const thinking = await ui.spawnSelect(page, d, 'thinking');
  expect({ options: thinking.options.map((o) => o.toLowerCase()), selected: thinking.selected.toLowerCase() })
    .toEqual({ options: ['adaptive (claude decides)', 'enabled', 'disabled'], selected: 'adaptive (claude decides)' });
  await expect(ui.spawnField(d, 'debug')).toBeChecked();
  await ui.cancelDialog(d);
});
