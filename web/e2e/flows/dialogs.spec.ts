import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page, Route } from '@playwright/test';
import { expect, test, type Cc } from './test.ts';
import { api, createProject, spawnSession } from '../harness/api.ts';
import { seedTranscript } from '../harness/transcript.ts';
import type { Ui } from './ui.ts';

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

test('New project creates a project that the Projects lens lists', async ({ page, ui, uniq }) => {
  const name = uniq('proj');
  await ui.open(page);
  await ui.lens(page, 'projects');
  await ui.newProject(page, name);
  await expect(await ui.projectRow(page, name)).toBeVisible();
});

test('Adding an existing directory from the project menu: the menu closes, System comes from the registry, a suggestion fills the form, and Relocate adopts over a stale record', async ({ page, cc, ui, uniq }) => {
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

test('The placement rows a flow reveals stay hidden until it reveals them', async ({ page, cc, ui, uniq }) => {
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

test('New project offers System, Target and the path field once a system is chosen, and neither Target nor the path before', async ({ page, ui }) => {
  // Invariant: before a system is chosen the Target and path fields are hidden; once one is, System, Target and the path field are each visible and enabled.
  await routeRemoteSystem(page);
  await ui.open(page);
  const np = await ui.openPlacementDialog(page, 'new');
  await expect(ui.placementField(np, 'new', 'target')).toBeHidden();
  await expect(ui.placementField(np, 'new', 'path')).toBeHidden();
  await ui.chooseSystem(page, np, 'new', 'Prod box (prod-box)');
  for (const f of ['system', 'target', 'path'] as const) {
    await expect(ui.placementField(np, 'new', f), f).toBeVisible();
    await expect(ui.placementField(np, 'new', f), f).toBeEnabled();
  }
});

test('Escape in a path field closes its completion list, not the dialog', async ({ page, ui }) => {
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

test('Deleting a local project offers the directory opt-in unticked, labelled with the directory so its label toggles it, and Cancel keeps the project', async ({ page, cc, ui, uniq }) => {
  // Invariant: the opt-in box opens unticked; its label names the project's directory and is the box's accessible name, so a click on the label ticks it and a second unticks it; Cancel deletes nothing.
  const name = uniq('del');
  await createProject(cc, name);
  const projectPath = ((await api(cc, 'GET', '/api/projects')).body as { name: string; path: string }[]).find((p) => p.name === name)!.path;
  await ui.open(page);
  const d = await ui.openDeleteProject(page, name);
  const { box, label } = ui.deleteDirOptIn(d);
  await expect(box).not.toBeChecked();
  await expect(label).toContainText(projectPath);
  await expect(box).toHaveAccessibleName(new RegExp(projectPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await label.click();
  await expect(box).toBeChecked();
  await label.click();
  await expect(box).not.toBeChecked();
  await ui.cancelDialog(d);
  await expect(d).toBeHidden();
  await expect(await ui.projectRow(page, name)).toBeVisible();
});

test('A mismatched name in the delete dialog deletes nothing and keeps the dialog open, and Cancel keeps the project', async ({ page, cc, ui, uniq }) => {
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

test('Deleting a project on a system names its path, target and system, and Cancel keeps the project', async ({ page, ui, uniq }) => {
  // The delete dialog of a project on a system says which path, target and system it leaves alone.
  const name = uniq('delremote');
  const fake = { name, path: '/app', system: 'prod-box', remoteId: 'c1', systemUnreachable: null, workspace: null, isGitRepo: true, unbornHead: false, worktrees: [] };
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    await route.fulfill({ response: res, json: [...(await res.json()), fake] });
  });

  await ui.open(page);
  const d = await ui.openDeleteProject(page, name);
  // The wording differs by UI ("remote" became "target").
  const description = ui.deleteDescription(d);
  await expect(description).toContainText('/app');
  await expect(description).toContainText("'c1'");
  await expect(description).toContainText("'prod-box'");
  await ui.cancelDialog(d);
  await expect(await ui.projectRow(page, name)).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' });
});

test('Change target from the system pill: a refusal shows the server message and keeps the dialog, Cancel sends nothing, a reopen starts clean, and Save PUTs the trimmed target and refreshes the list', async ({ page, ui, uniq }) => {
  const name = uniq('remote');
  const fake = { name, path: '/app', system: 'prod-box', remoteId: 'ctr-7', systemUnreachable: null, workspace: null, isGitRepo: true, unbornHead: false, worktrees: [] };
  let gets = 0;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    await route.fulfill({ response: res, json: [...(await res.json()), fake] });
    // Counted once served, so a poll on `gets` never ends the test mid-fetch.
    gets++;
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
  // The PUT's project broadcast drives a second list refresh that may still be inside the route.
  await page.unrouteAll({ behavior: 'wait' });
});

test("The worktree box follows the project's repo: disabled with a reason for a non-git directory and an unborn HEAD, tickable on a repo with a commit", async ({ page, cc, ui, uniq }) => {
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

test('The spawn dialog hides disabled tiers, opens Effort on Default naming the tier level and follows a tier pick, opens Thinking on adaptive, and pre-checks Debug from the setting', async ({ page, cc, ui, uniq }) => {
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
  await page.route('**/api/settings/spawn', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { debugByDefault: true } });
  });
  const name = uniq('spawn');
  await createProject(cc, name);

  await ui.open(page);
  // The routed models must have landed before the open under test. The tier
  // cards show the routed enablement once it has landed; the dialog is then
  // reopened.
  const first = await ui.openSpawnDialog(page, name);
  await expect.poll(() => ui.spawnTiers(first)).toEqual({ offered: ['balanced', 'powerful', 'frontier'], selected: 'powerful' });
  await ui.cancelDialog(first);
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

// Dialogs part 3 (card 2026-0639)
type LiveInst = { id: string; status: string; sessionId: string | null };
/** Creates `project`, spawns a persistent session there, waits for it to idle and gives it a transcript. */
async function idleSession(cc: Cc, project: string): Promise<{ id: string; sessionId: string }> {
  await createProject(cc, project);
  const { id } = await spawnSession(cc, project, { temp: false });
  let row: LiveInst | undefined;
  await expect.poll(async () => {
    row = ((await api(cc, 'GET', '/api/instances')).body as LiveInst[]).find((i) => i.id === id);
    return row?.status === 'idle' && !!row.sessionId;
  }).toBe(true);
  await seedTranscript(cc, id, 'dialogs part 3');
  return { id, sessionId: row!.sessionId! };
}
/** Opens the live session from its Projects-lens row; the header then names it. */
async function selectSession(page: Page, ui: Ui, project: string, sessionId: string) {
  await expect.poll(async () => ui.sessionRowLive(await ui.sessionRow(page, project, sessionId))).toBe(true);
  await (await ui.sessionRow(page, project, sessionId)).click();
  await expect(ui.sessionHeader(page).locator(`[title="session ${sessionId}"]`)).toBeVisible();
}

test('Summarize opens on Medium with the cached summary as markdown and its stale warning, generates an empty tier on request with its cost, clears the cost on a tier switch, and applies the Title tier as the session title', async ({ page, cc, ui, uniq }) => {
  const project = uniq('sum');
  const { sessionId: sid } = await idleSession(cc, project);
  const data = {
    title: { summary: 'Demo: ship the port', generatedAt: 1, messageCount: 3, isStale: false },
    short: null,
    medium: { summary: '## Recap\n\nShipped **three** dialogs.', generatedAt: 1, messageCount: 3, isStale: true },
    long: null,
  };
  const posts: unknown[] = [];
  const titles: unknown[] = [];
  await page.route(`**/api/sessions/${sid}/summary`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ok: true, sessionId: sid, data } });
    posts.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true, sessionId: sid, data: { ...data, long: { summary: 'The long account.', generatedAt: 2, messageCount: 3, isStale: false } }, costUsd: 0.0123 } });
  });
  await page.route(`**/api/sessions/${sid}/title`, (route) => {
    const body = route.request().postDataJSON() as { title: string };
    titles.push(body);
    return route.fulfill({ json: { ok: true, sessionId: sid, title: body.title, maxLength: 100 } });
  });
  await ui.open(page);
  await selectSession(page, ui, project, sid);
  const d = await ui.openSessionDialog(page, 'summary');
  // Invariant: the dialog offers each of the four tiers and opens on Medium; a generation shows its cost, which no other state shows.
  await expect.poll(async () => {
    const t = await ui.summaryTiers(d);
    return { tiers: [...t.tiers].sort(), selected: t.selected };
  }).toEqual({ tiers: ['long', 'medium', 'short', 'title'], selected: 'medium' });
  await expect(ui.summaryContent(d).locator('h2')).toHaveText('Recap');
  await expect(ui.summaryContent(d).locator('strong')).toHaveText('three');
  await expect(ui.summaryStale(d)).toBeVisible();
  await expect(ui.summaryStale(d)).toContainText('grown since this summary');
  await expect(ui.summaryCost(d)).toBeHidden();
  await expect(ui.summaryUseAsTitle(d)).toBeHidden();

  await ui.pickSummaryTier(d, 'long');
  await expect(ui.summaryStale(d)).toBeHidden();
  await expect(ui.summaryGenerate(d)).toHaveText(/Generate summary/);
  expect(posts).toHaveLength(0);
  await ui.summaryGenerate(d).click();
  await expect.poll(() => posts).toEqual([{ length: 'long' }]);
  await expect(ui.summaryContent(d)).toContainText('The long account.');
  await expect(ui.summaryCost(d)).toContainText('0.0123');
  await expect(ui.summaryGenerate(d)).toHaveText(/Regenerate/);

  await ui.pickSummaryTier(d, 'title');
  await expect(ui.summaryCost(d)).toBeHidden();
  await expect(ui.summaryUseAsTitle(d)).toBeVisible();
  await ui.summaryUseAsTitle(d).click();
  await expect.poll(() => titles).toEqual([{ title: 'Demo: ship the port' }]);
  await expect(ui.summaryUseAsTitle(d)).toHaveText(/Applied/);
  await ui.closeSessionDialog(d);
});

test('Rename prefills the current title, sends nothing for a cancel or an unchanged title, cuts a long title to 100 characters, and sends an empty title to clear it', async ({ page, cc, ui, uniq }) => {
  const project = uniq('ren');
  const { sessionId: sid } = await idleSession(cc, project);
  const seeded = uniq('Seeded title');
  const seed = await api(cc, 'PUT', `/api/sessions/${sid}/title`, { title: seeded });
  expect(seed.status, JSON.stringify(seed.body)).toBe(200);
  const puts: unknown[] = [];
  await page.route(`**/api/sessions/${sid}/title`, (route) => {
    const body = route.request().postDataJSON() as { title: string };
    puts.push(body);
    return route.fulfill({ json: { ok: true, sessionId: sid, title: body.title || null, maxLength: 100 } });
  });
  await ui.open(page);
  await selectSession(page, ui, project, sid);
  expect(await ui.renameSession(page, null)).toBe(seeded);
  expect(await ui.renameSession(page, `  ${seeded}  `)).toBe(seeded);
  expect(puts).toHaveLength(0);
  // No spaces: the web UI's maxlength can cut the typed value before the trim.
  await ui.renameSession(page, 'x'.repeat(120));
  await expect.poll(() => puts).toEqual([{ title: 'x'.repeat(100) }]);
  await ui.renameSession(page, '');
  await expect.poll(() => puts).toEqual([{ title: 'x'.repeat(100) }, { title: '' }]);
});

test("Prune's slider runs from 0 to the turn count and starts at about 90%, thinking starts ticked and minimal inputs unticked, a visible thinking saving shows beside encrypted thinking, and Prune sends the cut and both choices", async ({ page, cc, ui, uniq }) => {
  const project = uniq('prune');
  const { id, sessionId } = await idleSession(cc, project);
  const turn = { thinking: 30, toolInputTruncatable: 10, toolInputMinimal: 20, toolOutput: 100, toolOutputImage: 0, exempt: 0 };
  const analysis = { turnCount: 20, turns: Array.from({ length: 20 }, () => turn), encryptedThinking: 500, contextTokens: 50000, calibration: { factor: 1, calibrated: true } };
  const prunes: unknown[] = [];
  await page.route(`**/api/instances/${id}/prune/analysis`, (route) => route.fulfill({ json: analysis }));
  await page.route(`**/api/instances/${id}/prune`, (route) => {
    prunes.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  await ui.open(page);
  await selectSession(page, ui, project, sessionId);
  const d = await ui.openSessionDialog(page, 'prune');
  // Invariant: the slider spans 0 to the turn count and opens at 18; its label names the cut and the turn count and follows the slider.
  const cut = ui.pruneField(d, 'cut');
  await expect(cut).toHaveAttribute('min', '0');
  await expect(cut).toHaveAttribute('max', '20');
  await expect(cut).toHaveValue('18');
  await expect(ui.pruneField(d, 'cutLabel')).toHaveText(/\b18\b.*\b20\b/);
  await expect(ui.pruneField(d, 'cutLabel')).not.toHaveText(/\b20\b.*\b20\b/);
  await expect(ui.pruneField(d, 'thinking')).toBeChecked();
  await expect(ui.pruneField(d, 'minimal')).not.toBeChecked();

  // Invariant: the first savings row names the thinking blocks; with thinking ticked it shows the visible-thinking saving (600) in tokens and no encrypted note, and unticked it shows the encrypted figure (500) instead of that saving.
  const row = ui.pruneSavingsRows(d).first().locator('td');
  await expect(row).toHaveCount(2);
  await expect(row.nth(0)).toContainText('Thinking');
  await expect(row.nth(1)).toHaveText(/\b600\b.*tokens/);
  await expect(row.nth(1)).not.toHaveText(/encrypted/);
  await ui.pruneField(d, 'thinking').setChecked(false);
  await expect(row.nth(1)).toHaveText(/encrypted/);
  await expect(row.nth(1)).toHaveText(/\b500\b/);
  await expect(row.nth(1)).not.toHaveText(/\b600\b/);

  await cut.fill('20');
  await expect(ui.pruneField(d, 'cutLabel')).toHaveText(/\b20\b.*\b20\b/);
  await ui.pruneField(d, 'minimal').setChecked(true);
  expect(prunes).toHaveLength(0);
  await ui.applyPrune(d);
  await expect(d).toBeHidden();
  await expect.poll(() => prunes.length).toBe(1);
  expect(prunes).toEqual([{ cutTurnIndex: 20, pruneThinking: false, inputMode: 'minimal' }]);
});

test('Statistics shows This session alone with the no-workers note, and with workers adds the Incl. N workers column and drops the note', async ({ page, cc, ui, uniq }) => {
  const project = uniq('stats');
  const { sessionId: sid } = await idleSession(cc, project);
  let workers = 0;
  await page.route(`**/api/costs/session/${sid}`, (route) => route.fulfill({ json: {
    own: { cost_usd: 1.2345, duration_api_ms: 65000, duration_ms: 125000, turns: 3 },
    rolled: { cost_usd: 9, duration_api_ms: 300000, duration_ms: 600000, turns: 9 },
    workerSessions: workers,
  } }));
  await ui.open(page);
  await selectSession(page, ui, project, sid);
  // Invariant: with no workers the table has the label column and This session only, plus the no-workers note; with workers it adds a column counting them, each value under its own header, and drops the note.
  let d = await ui.openSessionDialog(page, 'stats');
  const heads = () => ui.statsTable(d).locator('thead th');
  const costCells = () => ui.statsTable(d).locator('tbody tr').first().locator('td');
  await expect(heads()).toHaveCount(2);
  await expect(heads().nth(1)).toContainText('This session');
  await expect(costCells()).toHaveCount(2);
  await expect(costCells().nth(0)).toContainText('Cost');
  await expect(costCells().nth(1)).toContainText('1.2345');
  await expect(ui.statsNote(d)).toBeVisible();
  await expect(ui.statsNote(d)).toContainText('No worker sessions');
  await ui.closeSessionDialog(d);

  workers = 2;
  d = await ui.openSessionDialog(page, 'stats');
  await expect(heads()).toHaveCount(3);
  await expect(heads().nth(1)).toContainText('This session');
  await expect(heads().nth(2)).toContainText(/\b2 workers\b/);
  await expect(costCells()).toHaveCount(3);
  await expect(costCells().nth(1)).toContainText('1.2345');
  await expect(costCells().nth(2)).toContainText(/\b9\b/);
  await expect(ui.statsNote(d)).toBeHidden();
  await ui.closeSessionDialog(d);
});

test('A workspace is created from the project menu, edited from its pencil with its members pre-ticked, renamed before its members move, created empty with nothing ticked, and deleted only once the confirm is accepted', async ({ page, cc, ui, uniq }) => {
  const a = uniq('wsa');
  const b = uniq('wsb');
  await createProject(cc, a);
  await createProject(cc, b);
  const w1 = uniq('ws');
  const w2 = uniq('ws2');
  const w3 = uniq('ws3');

  // Page-local workspaces: every write is fulfilled here, and the list reads overlay it on the real lists.
  const registered = new Set<string>();
  const memberOf = new Map<string, string | null>();
  const writes: [string, string, unknown][] = [];
  const record = (route: Route) => {
    const r = route.request();
    const body = r.postData() ? r.postDataJSON() : null;
    writes.push([r.method(), new URL(r.url()).pathname, body]);
    return body;
  };
  await page.route('**/api/workspaces', async (route) => {
    if (route.request().method() === 'GET') {
      const res = await route.fetch();
      const real = (await res.json()) as { name: string; projectCount: number }[];
      const mine = [...registered].map((name) => ({ name, projectCount: [...memberOf.values()].filter((w) => w === name).length }));
      return route.fulfill({ response: res, json: [...real, ...mine] });
    }
    registered.add((record(route) as { name: string }).name);
    return route.fulfill({ status: 201, json: { ok: true, added: true } });
  });
  await page.route('**/api/workspaces/*', async (route) => {
    const from = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()!);
    const body = record(route) as { name?: string } | null;
    const to = route.request().method() === 'PUT' ? body!.name! : null;
    registered.delete(from);
    if (to) registered.add(to);
    for (const [p, w] of memberOf) if (w === from) memberOf.set(p, to);
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/projects/*/workspace', async (route) => {
    const project = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]);
    const { workspace } = record(route) as { workspace: string | null };
    memberOf.set(project, workspace);
    if (workspace) registered.add(workspace);
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const list = (await res.json()) as { name: string; workspace?: string | null }[];
    return route.fulfill({ response: res, json: list.map((p) => (memberOf.has(p.name) ? { ...p, workspace: memberOf.get(p.name) } : p)) });
  });

  await ui.open(page);
  let d = await ui.openNewWorkspace(page);
  await expect(ui.workspaceName(d)).toHaveValue('');
  await ui.workspaceName(d).fill(w1);
  await ui.workspaceMember(d, a).setChecked(true);
  await ui.saveWorkspace(d);
  await expect(d).toBeHidden();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes).toEqual([['PUT', `/api/projects/${a}/workspace`, { workspace: w1 }]]);
  await expect(await ui.workspaceHeader(page, w1)).toBeVisible();

  d = await ui.openEditWorkspace(page, w1);
  await expect(ui.workspaceName(d)).toHaveValue(w1);
  await expect(ui.workspaceMember(d, a)).toBeChecked();
  await expect(ui.workspaceMember(d, b)).not.toBeChecked();
  await ui.workspaceName(d).fill(w2);
  await ui.workspaceMember(d, a).setChecked(false);
  await ui.workspaceMember(d, b).setChecked(true);
  await ui.saveWorkspace(d);
  await expect(d).toBeHidden();
  await expect.poll(() => writes.length).toBe(4);
  expect(writes[1]).toEqual(['PUT', `/api/workspaces/${w1}`, { name: w2 }]);
  expect(writes.slice(2).sort((x, y) => x[1].localeCompare(y[1]))).toEqual([
    ['PUT', `/api/projects/${a}/workspace`, { workspace: null }],
    ['PUT', `/api/projects/${b}/workspace`, { workspace: w2 }],
  ]);
  await expect(await ui.workspaceHeader(page, w2)).toBeVisible();
  await expect(await ui.workspaceHeader(page, w1)).toHaveCount(0);

  d = await ui.openNewWorkspace(page);
  await ui.workspaceName(d).fill(w3);
  await ui.saveWorkspace(d);
  await expect.poll(() => writes.length).toBe(5);
  expect(writes[4]).toEqual(['POST', '/api/workspaces', { name: w3 }]);
  await expect(await ui.workspaceHeader(page, w3)).toBeVisible();

  d = await ui.openEditWorkspace(page, w2);
  await ui.deleteWorkspace(page, d, false);
  await expect(d).toBeVisible();
  expect(writes).toHaveLength(5);
  await ui.deleteWorkspace(page, d, true);
  await expect(d).toBeHidden();
  await expect.poll(() => writes.length).toBe(6);
  expect(writes[5]).toEqual(['DELETE', `/api/workspaces/${w2}`, null]);
  await expect(await ui.workspaceHeader(page, w2)).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' });
});

test('With live sessions the restart button asks first: dismissing restarts nothing, the plain choice posts resume:false and the resume choice resume:true, each reloading once the server is back; with no sessions it restarts plain without asking', async ({ page, cc, ui, uniq }) => {
  const p = uniq('rst');
  await createProject(cc, p);
  const { sessionId } = await spawnSession(cc, p, { temp: false });
  // The restart button counts the instance list the UI has loaded, which arrives after the sidebar mounts.
  const asks = async () => { await expect.poll(async () => ui.sessionRowLive(await ui.sessionRow(page, p, sessionId))).toBe(true); };
  let boot = 0;
  const restarts: unknown[] = [];
  await page.route('**/api/health', (route) => route.fulfill({ json: { ok: true, bootId: `pw-${boot}` } }));
  await page.route('**/api/admin/restart', (route) => {
    restarts.push(route.request().postDataJSON());
    boot++;
    return route.fulfill({ status: 202, json: { ok: true } });
  });

  await ui.open(page);
  await asks();
  await ui.clickRestart(page);
  const d = ui.restartDialog(page);
  await expect(d).toBeVisible();
  await expect(ui.restartChoice(d, 'only')).toBeVisible();
  await expect(ui.restartChoice(d, 'resume')).toBeVisible();
  await ui.dismissRestart(page, d);
  expect(restarts).toEqual([]);

  let reloaded = page.waitForEvent('load');
  await ui.clickRestart(page);
  await ui.restartChoice(ui.restartDialog(page), 'only').click();
  await reloaded;
  await expect.poll(() => restarts.length).toBe(1);
  expect(restarts).toEqual([{ resume: false }]);

  await ui.open(page);
  await asks();
  reloaded = page.waitForEvent('load');
  await ui.clickRestart(page);
  await ui.restartChoice(ui.restartDialog(page), 'resume').click();
  await reloaded;
  await expect.poll(() => restarts.length).toBe(2);
  expect(restarts).toEqual([{ resume: false }, { resume: true }]);

  await page.route('**/api/instances', (route) => route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.fallback());
  await ui.open(page);
  reloaded = page.waitForEvent('load');
  await ui.clickRestart(page);
  await reloaded;
  await expect.poll(() => restarts.length).toBe(3);
  expect(restarts).toEqual([{ resume: false }, { resume: true }, { resume: false }]);
  await page.unrouteAll({ behavior: 'wait' });
});
