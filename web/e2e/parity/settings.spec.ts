import type { Locator, Page } from '@playwright/test';
import { expect } from '../harness/fixtures.ts';
import { createProject } from '../harness/api.ts';
import { parity } from './parity.ts';
import type { ConventionScope, Ui } from './ui.ts';

// The web UI ignores Escape while a dialog is open, and on a phone the sidebar
// drawer (a dialog) is still closing after Settings is opened from it.
const noDialog = (page: Page) => expect(page.getByRole('dialog')).toHaveCount(0);

parity('settings-toggle/R4', 'Escape leaves Settings, even after the hash drifted to a session', async ({ page, ui }) => {
  await ui.open(page);
  await ui.openSettings(page);
  await expect(ui.settingsView(page)).toBeVisible();
  await noDialog(page);
  await page.keyboard.press('Escape');
  await expect(ui.settingsView(page)).toBeHidden();

  await ui.openSettings(page);
  await expect(ui.settingsView(page)).toBeVisible();
  await page.evaluate(() => history.replaceState(null, '', location.pathname + '#session=drifted'));
  await noDialog(page);
  await page.keyboard.press('Escape');
  await expect(ui.settingsView(page)).toBeHidden();
});

parity('claude-auth-frontend/R2', 'Claude login: Log in shows the sign-in link, and Enter in the code field submits the trimmed code', async ({ page, ui }) => {
  const url = 'https://claude.com/cai/oauth/authorize?code=true&state=S';
  let snap: object = { state: 'idle' };
  const codes: unknown[] = [];
  await page.route('**/api/claude-auth/status', (r) => r.fulfill({ json: { loggedIn: false, authMethod: 'none' } }));
  await page.route('**/api/claude-auth/login', (r) => {
    if (r.request().method() === 'POST') snap = { state: 'awaiting_code', url };
    return r.fulfill({ json: snap });
  });
  await page.route('**/api/claude-auth/login/code', (r) => {
    codes.push(r.request().postDataJSON());
    snap = { state: 'succeeded' };
    return r.fulfill({ json: snap });
  });
  await ui.open(page);
  await ui.openSettingsSection(page, 'account');
  const login = ui.claudeLogin(page);
  await login.login.click();
  await expect(login.signInLink).toHaveAttribute('href', url);
  await login.code.fill('  abc#S  ');
  await login.code.press('Enter');
  await expect.poll(() => codes).toEqual([{ code: 'abc#S' }]);
  await expect(page.getByText('Signed in.', { exact: true })).toBeVisible();
});

parity('doc/A7', 'Archived: groups start collapsed with the Conductor group first, and Delete asks first and removes the transcript', async ({ page, ui }) => {
  let deleted = 0;
  await page.route('**/api/archived', (r) => r.fulfill({ json: { groups: [
    { project: 'p', sessions: deleted ? [] : [{ sessionId: 's1', title: 'T1' }] },
    { project: '.conduct', sessions: [{ sessionId: 's2', title: 'C1' }] },
  ] } }));
  await page.route('**/api/projects/p/sessions/s1', (r) => {
    if (r.request().method() !== 'DELETE') return r.fallback();
    deleted++;
    return r.fulfill({ json: { ok: true } });
  });
  await ui.open(page);
  await ui.openSettingsSection(page, 'archived');
  await expect(ui.archivedGroups(page).first()).toContainText('Conductor');
  await expect(page.getByText('T1', { exact: true })).toBeHidden();
  await ui.expandArchivedGroup(page, 'p');
  await expect(page.getByText('T1', { exact: true })).toBeVisible();
  await ui.deleteArchived(page, 'T1', false);
  await expect(page.getByText('T1', { exact: true })).toBeVisible();
  expect(deleted).toBe(0);
  await ui.deleteArchived(page, 'T1', true);
  await expect(page.getByText('T1', { exact: true })).toBeHidden();
  expect(deleted).toBe(1);
});

parity('doc/B23', 'About shows the legal notice and the update state', async ({ page, ui }) => {
  // GET only, and Update is never clicked: a real update would restart the cc.
  await page.route('**/api/settings/self-update', (r) => (r.request().method() === 'GET'
    ? r.fulfill({ json: { version: '9.9.9', canCheck: true, updateAvailable: true, behind: 2, upstream: 'origin/main' } })
    : r.abort()));
  await ui.open(page);
  await ui.openSettingsSection(page, 'about');
  await expect(page.getByText('Copyright © 2026 UnmanagedCode')).toBeVisible();
  await expect(page.getByRole('link', { name: 'GNU Affero General Public License v3.0 (AGPL-3.0)' })).toHaveAttribute('href', 'https://www.gnu.org/licenses/agpl-3.0.html');
  await expect(page.getByRole('link', { name: 'github.com/UnmanagedCode/code-conductor' })).toHaveAttribute('href', 'https://github.com/UnmanagedCode/code-conductor');
  await expect(page.getByText('update available (2 commits behind origin/main)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeVisible();
});

// Settings part 2 (card 2026-0636)
// Every models and systems write is recorded and fulfilled page-locally: the
// shared cc's own settings are never written.
type Write = { method: string; path: string; body: unknown };

const LOCAL = { id: 'local', label: 'This machine', managed: true, projects: [] };
const PROD = { id: 'prod-box', label: 'Prod box', launch: ['ssh', 'prod', 'cc-provider'], projects: [{ name: 'shipping', remoteId: 'ctr-7' }] };
const NAMED = { id: 'namedonly', label: 'Named only', launch: null, projects: [] };

/** A fake systems list; each write is recorded and answered by `answer`. */
async function routeSystems(page: Page, answer: (w: Write) => { status?: number; json: unknown }): Promise<Write[]> {
  const writes: Write[] = [];
  await page.route('**/api/settings/systems', (route) => (route.request().method() === 'GET'
    ? route.fulfill({ json: { systems: [LOCAL, PROD, NAMED] } })
    : route.fallback()));
  await page.route('**/api/settings/systems/**', (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fallback();
    const w = { method: req.method(), path: new URL(req.url()).pathname, body: req.postDataJSON() ?? null };
    writes.push(w);
    return route.fulfill(answer(w));
  });
  return writes;
}

/** The /api/settings/models fields these scenarios read or reshape; every other field passes through untouched. */
type ModelsBody = {
  backends: { id: string; label: string; template?: string; env?: { key: string; value: string }[]; managed?: boolean }[];
  customModels?: { label: string; model: string; backend: string; contextWindow: number }[];
  enabledTiers?: Record<string, boolean>;
  defaultSpawnTier?: string;
  roleEffort?: Record<string, { effort?: string; inheritsTo?: string }>;
  conductorCompactWindow?: { enabled: boolean; value: number };
  [key: string]: unknown;
};

/**
 * The real models payload reshaped by `get`; each models write is recorded and
 * answered by `answer` (a whole payload).
 */
async function routeModels(page: Page, opts: { get: (real: ModelsBody) => ModelsBody; answer: (w: Write) => unknown }): Promise<Write[]> {
  const writes: Write[] = [];
  await page.route('**/api/settings/models', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    await route.fulfill({ response: res, json: opts.get((await res.json()) as ModelsBody) });
  });
  await page.route('**/api/settings/models/**', (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fallback();
    const w = { method: req.method(), path: new URL(req.url()).pathname, body: req.postDataJSON() ?? null };
    writes.push(w);
    return route.fulfill({ json: opts.answer(w) });
  });
  return writes;
}

/** A Settings control by its accessible name; both UIs name the tier and role selects alike. */
const control = (page: Page, ui: Ui, name: string): Locator => ui.settingsView(page).getByLabel(name, { exact: true });

parity('settings-backends-panel/R4', "Models: the backend picker lists a user backend, switching a tier to it saves its first model, and a custom model's Remove addresses its pair", async ({ page, ui }) => {
  const withProxy = (b: ModelsBody): ModelsBody => ({
    ...b,
    backends: [...b.backends, { id: 'px', label: 'My Proxy', template: 'px {model}', env: [], managed: false }],
    customModels: [
      ...(b.customModels ?? []),
      { label: 'Mine', model: 'mine:v1', backend: 'px', contextWindow: 300000 },
      { label: 'Mine two', model: 'mine:v2', backend: 'px', contextWindow: 300000 },
    ],
  });
  let shown: unknown;
  const writes = await routeModels(page, { get: (b) => (shown = withProxy(b)), answer: () => shown });
  await ui.open(page);
  await ui.openSettingsSection(page, 'models');
  const backend = control(page, ui, 'Backend for the Fast tier');
  await expect.poll(() => backend.locator('option').allTextContents()).toContain('My Proxy');
  await backend.selectOption('px');
  await expect.poll(() => writes).toEqual([
    { method: 'POST', path: '/api/settings/models/prefs', body: { tierBackend: { tier: 'fast', backend: { backend: 'px', model: 'mine:v1' } } } },
  ]);
  await ui.removeCustomModel(page, 'mine:v2');
  await expect.poll(() => writes[1]).toEqual({ method: 'DELETE', path: '/api/settings/models/custom/px/mine%3Av2', body: null });
});

parity('settings-models-effort-panel/R2', "Models: a role's explicit effort shows and saves, and the Conduct session's compact-window override saves its window", async ({ page, ui }) => {
  let state: ModelsBody;
  const writes = await routeModels(page, {
    get: (b) => (state = {
      ...b,
      roleEffort: { ...b.roleEffort, conductor: { effort: 'xhigh', inheritsTo: 'low' } },
      conductorCompactWindow: { enabled: false, value: 300 },
    }),
    answer: (w) => {
      const posted = (w.body as Pick<ModelsBody, 'conductorCompactWindow'> | null)?.conductorCompactWindow;
      if (posted) state = { ...state, conductorCompactWindow: posted };
      return state;
    },
  });
  await ui.open(page);
  await ui.openSettingsSection(page, 'models');
  const role = control(page, ui, 'Default effort for the Conductor role');
  await expect(role).toHaveValue('xhigh');
  await expect(role.locator('option').first()).toHaveText('Inherit (low)');
  await role.selectOption('inherit');
  await expect.poll(() => writes[0]?.body).toEqual({ roleEffort: { role: 'conductor', effort: 'inherit' } });

  const cw = ui.compactWindow(page);
  await expect(cw.slider).toBeHidden();
  await cw.toggle.click();
  await expect.poll(() => writes.map((w) => w.body)).toContainEqual({ conductorCompactWindow: { enabled: true, value: 300 } });
  await expect(cw.slider).toBeVisible();
  await expect(cw.slider).toHaveValue('300');
  await expect(cw.readout).toHaveText('300k');
  await cw.slider.focus();
  await cw.slider.press('ArrowRight');
  await expect(cw.readout).toHaveText('310k');
  await expect.poll(() => writes.at(-1)?.body).toEqual({ conductorCompactWindow: { enabled: true, value: 310 } });
});

parity('app-models-change-wiring/R1', 'A tier switched off in Settings → Models leaves the New session dialog at once', async ({ page, cc, ui, uniq }) => {
  // The GET always answers the original tiers: only the save's answer carries
  // the switch-off, so a UI that re-fetched instead of applying it offers Fast.
  const original = (b: ModelsBody): ModelsBody => ({
    ...b,
    enabledTiers: { fast: true, balanced: true, powerful: true, frontier: true },
    defaultSpawnTier: 'powerful',
  });
  let real: ModelsBody;
  const writes = await routeModels(page, {
    get: (b) => original((real = b)),
    answer: () => ({ ...original(real), enabledTiers: { fast: false, balanced: true, powerful: true, frontier: true } }),
  });
  const name = uniq('tiers');
  await createProject(cc, name);

  await ui.open(page);
  await ui.openSettingsSection(page, 'models');
  await control(page, ui, 'Enable the Fast tier').click();
  await expect.poll(() => writes.map((w) => w.body)).toEqual([{ tierEnabled: { tier: 'fast', enabled: false } }]);
  await noDialog(page);
  await page.keyboard.press('Escape');
  await expect(ui.settingsView(page)).toBeHidden();
  const d = await ui.openSpawnDialog(page, name);
  await expect.poll(() => ui.spawnTiers(d)).toEqual({ offered: ['balanced', 'powerful', 'frontier'], selected: 'powerful' });
  await ui.cancelDialog(d);
});

parity('settings-systems-panel/R2', 'Systems: rows show the provider command or a name-only note; Edit keeps the id and resends the command; a refused Remove names the project', async ({ page, ui }) => {
  const writes = await routeSystems(page, (w) => (w.method === 'PATCH'
    ? { json: { systems: [LOCAL, { ...PROD, label: 'Production' }, NAMED] } }
    : { status: 409, json: { error: "system 'prod-box' is still named by 1 project (shipping) — move or remove it first" } }));
  await ui.open(page);
  await ui.openSettingsSection(page, 'systems');
  await expect(ui.systemRow(page, 'prod-box')).toContainText('ssh prod cc-provider');
  // Both UIs say "no provider command"; /next/'s "name only" wording is pinned in vitest.
  await expect(ui.systemRow(page, 'namedonly')).toContainText(/no provider command/i);
  await ui.editSystem(page, 'prod-box');
  const f = ui.systemForm(page);
  await expect(f.id).toBeDisabled();
  await expect(f.id).toHaveValue('prod-box');
  await expect(f.launch).toHaveValue('ssh prod cc-provider');
  await f.label.fill('Production');
  await f.save.click();
  await expect.poll(() => writes).toEqual([
    { method: 'PATCH', path: '/api/settings/systems/prod-box', body: { label: 'Production', launch: ['ssh', 'prod', 'cc-provider'], worktreesDir: null } },
  ]);
  await ui.removeSystem(page, 'prod-box');
  // The row itself already lists "shipping"; the refusal must name it in the status line.
  await expect(ui.settingsView(page)).toContainText("Remove failed: system 'prod-box' is still named by 1 project (shipping)");
  await expect(ui.systemRow(page, 'prod-box')).toBeVisible();
});

parity('settings-systems-panel/R2', 'Systems: an unsaved edit survives a section switch and leaving Settings, and Cancel clears it', async ({ page, ui }) => {
  const writes = await routeSystems(page, () => ({ status: 500, json: { error: 'no write is expected' } }));
  await ui.open(page);
  await ui.openSettingsSection(page, 'systems');
  await ui.editSystem(page, 'prod-box');
  const f = ui.systemForm(page);
  await f.label.fill('Draft label');
  const expectDraft = async () => {
    await expect(f.id).toBeDisabled();
    await expect(f.id).toHaveValue('prod-box');
    await expect(f.label).toHaveValue('Draft label');
    await expect(f.save).toHaveText(/Save/);
  };
  await ui.switchSettingsSection(page, 'backends');
  await ui.switchSettingsSection(page, 'systems');
  await expectDraft();
  await noDialog(page);
  await page.keyboard.press('Escape');
  await expect(ui.settingsView(page)).toBeHidden();
  await ui.openSettingsSection(page, 'systems');
  await expectDraft();
  await f.cancel.click();
  await ui.switchSettingsSection(page, 'backends');
  await ui.switchSettingsSection(page, 'systems');
  await expect(f.id).toBeEnabled();
  await expect(f.id).toHaveValue('');
  await expect(f.save).toHaveText(/^\s*Add/);
  expect(writes).toEqual([]);
});

// Settings part 3 (card 2026-0637)
// Every conventions write, and the plugin enable, is recorded and fulfilled
// page-locally: the shared cc's own conventions and plugins are never written.

/** Fakes the GET of each scope in `gets` (read per request); every write is recorded and answered by `answer`. */
async function routeConventions(page: Page, gets: Partial<Record<ConventionScope, () => unknown>>, answer: (w: Write) => { status: number; json: unknown }): Promise<Write[]> {
  const writes: Write[] = [];
  await page.route('**/api/settings/conventions/**', (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'GET') {
      const scope = path.replace('/api/settings/conventions/', '') as ConventionScope;
      const get = gets[scope];
      return get ? route.fulfill({ json: get() }) : route.fallback();
    }
    const w = { method: req.method(), path, body: req.postDataJSON() ?? null };
    writes.push(w);
    return route.fulfill(answer(w));
  });
  return writes;
}

const WS = {
  core: { name: 'Workspace core', description: 'always applies' },
  conventions: [
    { slug: 'git', name: 'Git hygiene', description: 'commits', builtin: true },
    { slug: 'mine', name: 'Mine', description: 'my rule', body: '## Mine' },
    { slug: 'demo/rule', name: 'Demo rule', description: 'from demo', plugin: 'demo' },
  ],
  enabled: ['git', 'demo/rule'],
};
// None of these enforcement levels ships, so a client-side list cannot pass.
const CD = {
  core: { name: 'Conductor core', description: 'role' },
  conventions: [
    { slug: 'lean', name: 'Lean', description: 'l', builtin: true },
    { slug: 'cmine', name: 'C mine', description: 'c', body: 'cb' },
  ],
  enabled: ['lean'],
  playbooks: [{ id: 'solo', name: 'Solo' }, { id: 'relay', name: 'Relay' }],
  playbookErrors: [],
  defaultPlaybook: { mode: 'playbook', id: 'relay' },
  defaultPlaybookFallback: 'freeform',
  playbookEnforcementModes: ['lenient', 'strict', 'paranoid'],
  defaultPlaybookEnforcement: 'strict',
};
// Carries a core and a selection, so "Project shows neither" is not vacuous.
const PJ = {
  core: { name: 'Project core', description: 'p' },
  conventions: [
    { slug: 'tdd', name: 'TDD', description: 't', builtin: true },
    { slug: 'pmine', name: 'P mine', description: 'p', body: 'pb' },
  ],
  enabled: ['tdd'],
};
const optionValues = (select: Locator) => select.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));

parity('default-enforcement-frontend/R2', "Conventions: the conductor's playbook and enforcement pickers list the payload's rows, save each pick to its own endpoint, and report a refused save", async ({ page, ui }) => {
  const writes = await routeConventions(page, { conductor: () => CD }, (w) => (w.path.endsWith('default-playbook-enforcement')
    ? { status: 400, json: { error: 'mode must be one of warn | enforce' } }
    : { status: 200, json: {} }));
  await ui.open(page);
  await ui.openSettingsSection(page, 'conventions');
  await ui.expandConventionsBlock(page, 'conductor');
  const p = ui.conductorPickers(page);
  await expect.poll(() => optionValues(p.enforcement)).toEqual(['lenient', 'strict', 'paranoid']);
  await expect(p.enforcement).toHaveValue('strict');
  await expect.poll(() => optionValues(p.playbook)).toEqual(['unset', 'none', 'playbook:solo', 'playbook:relay']);
  await expect(p.playbook).toHaveValue('playbook:relay');
  await p.playbook.selectOption('none');
  await expect.poll(() => writes).toEqual([
    { method: 'PUT', path: '/api/settings/conventions/conductor/default-playbook', body: { defaultPlaybook: { mode: 'none' } } },
  ]);
  await p.enforcement.selectOption('lenient');
  await expect.poll(() => writes[1]).toEqual({ method: 'PUT', path: '/api/settings/conventions/conductor/default-playbook-enforcement', body: { mode: 'lenient' } });
  await expect(p.enforcementStatus).toContainText('mode must be one of warn | enforce');
});

parity('doc/B17', 'Conventions: each block shows its core row, read-only built-ins and editable customs, switches only where the scope has a selection, and an unsaved Add form survives a section switch and leaving Settings', async ({ page, ui }) => {
  const writes = await routeConventions(page, { workspace: () => WS, conductor: () => CD, project: () => PJ }, () => ({ status: 500, json: { error: 'no write is expected' } }));
  await ui.open(page);
  await ui.openSettingsSection(page, 'conventions');
  for (const scope of ['workspace', 'conductor', 'project'] as const) await ui.expandConventionsBlock(page, scope);
  const core = ui.conventionList(page, 'workspace').locator('li').first();
  await expect(core).toContainText('Workspace core');
  await expect(core).toContainText('always on');
  await expect(ui.conventionRow(page, 'workspace', 'git')).toContainText('built-in');
  await expect(ui.conventionRow(page, 'workspace', 'git').getByRole('button')).toHaveCount(0);
  await expect(ui.conventionRow(page, 'workspace', 'mine').getByRole('button', { name: /^Edit/ })).toBeVisible();
  await expect(ui.conventionRow(page, 'workspace', 'mine').getByRole('button', { name: /^Delete/ })).toBeVisible();
  await expect(ui.conventionToggles(page, 'workspace')).toHaveCount(3);
  await expect(ui.conventionRow(page, 'project', 'pmine')).toBeVisible();
  await expect(ui.conventionToggles(page, 'project')).toHaveCount(0);
  await expect(ui.conventionList(page, 'project')).not.toContainText('Project core');

  const f = ui.conventionForm(page, 'conductor');
  await f.add.click();
  await f.slug.fill('draft');
  await f.name.fill('Draft');
  // No expand after the switch: the block itself must stay open.
  await ui.switchSettingsSection(page, 'archived');
  await ui.switchSettingsSection(page, 'conventions');
  await expect(f.slug).toHaveValue('draft');
  await expect(f.name).toHaveValue('Draft');
  await noDialog(page);
  await page.keyboard.press('Escape');
  await expect(ui.settingsView(page)).toBeHidden();
  await ui.openSettingsSection(page, 'conventions');
  await expect(f.slug).toHaveValue('draft');
  await expect(f.name).toHaveValue('Draft');
  await f.cancel.click();
  await ui.switchSettingsSection(page, 'archived');
  await ui.switchSettingsSection(page, 'conventions');
  await expect(f.slug).toBeHidden();
  await expect(f.add).toBeVisible();
  expect(writes).toEqual([]);
});

parity('settings-toggle/R5', 'Conventions: enabling a plugin brings its conductor convention into the Conductor block', async ({ page, ui }) => {
  let enabled = false;
  let enables = 0;
  await page.route('**/api/plugins', (r) => (r.request().method() === 'GET'
    ? r.fulfill({ json: { rows: [{ id: 'demo', name: 'Demo', project: 'demoproj', state: 'stopped', enabled, hasBackend: false, localOnly: [], conventions: [] }], notices: [] } })
    : r.fallback()));
  await page.route('**/api/plugins/library', (r) => r.fulfill({ json: { entries: [] } }));
  await page.route('**/api/plugins/demo/enable', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    enabled = true;
    enables++;
    return r.fulfill({ json: {} });
  });
  await routeConventions(page, {
    conductor: () => ({ ...CD, conventions: [...CD.conventions, ...(enabled ? [{ slug: 'demo/rule', name: 'Demo rule', description: 'd', plugin: 'demo' }] : [])] }),
  }, () => ({ status: 500, json: { error: 'no write is expected' } }));
  await ui.open(page);
  await ui.openSettingsSection(page, 'conventions');
  await ui.expandConventionsBlock(page, 'conductor');
  await expect(ui.conventionRow(page, 'conductor', 'lean')).toBeVisible();
  await expect(ui.conventionRow(page, 'conductor', 'demo/rule')).toHaveCount(0);
  await ui.switchSettingsSection(page, 'plugins');
  await ui.settingsView(page).getByRole('button', { name: 'Enable', exact: true }).click();
  await expect.poll(() => enables).toBe(1);
  await ui.switchSettingsSection(page, 'conventions');
  await ui.expandConventionsBlock(page, 'conductor');
  await expect(ui.conventionRow(page, 'conductor', 'demo/rule')).toBeVisible();
  await expect(ui.conventionRow(page, 'conductor', 'demo/rule')).toContainText('plugin: demo');
});
