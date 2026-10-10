// One driver per UI. Each method is one user-level operation performed through
// that UI's own controls, so a parity scenario reads the same against both.
// A method that reaches the sidebar opens the phone drawer itself.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../harness/fixtures.ts';
import type { UiName } from './uis.ts';

export type Lens = 'conductors' | 'projects';
/** The two dialogs that place a project: New project and Add (adopt) project. */
export type PlacementDialog = 'new' | 'adopt';
export type PlacementField = 'name' | 'system' | 'target' | 'path' | 'pathList' | 'suggestions';
// Settings (card 2026-0625)
export type SettingsSection = 'account' | 'archived' | 'about' | 'models' | 'backends' | 'systems';
export type SpawnField = 'worktree' | 'worktreeHint' | 'debug';
export type SpawnSelect = 'effort' | 'thinking';

export interface Ui {
  name: UiName;
  /** Navigates to the UI and waits until its JS answers. */
  open(page: Page): Promise<void>;
  /** On a drawer viewport, opens the sidebar drawer unless it already is. */
  openSidebar(page: Page): Promise<void>;
  lens(page: Page, which: Lens): Promise<void>;
  selectedLens(page: Page): Promise<string | null>;
  newProject(page: Page, name: string): Promise<void>;
  /** Opens the sidebar ≡ menu's add-existing-directory entry; returns the dialog. */
  openAddProject(page: Page): Promise<Locator>;
  /** Clicks Conduct once. Not idempotent: every click spawns a conductor. */
  conduct(page: Page): Promise<void>;
  /** The project's row in the Projects lens. */
  projectRow(page: Page, name: string): Promise<Locator>;
  /** Starts a session in `project` from its sidebar row with the dialog's defaults; `temp: false` unticks Temp session (under Advanced options) first. */
  startSessionIn(page: Page, project: string, opts?: { temp?: boolean }): Promise<void>;
  sessionHeader(page: Page): Locator;
  /** The active session's Terminate, from its overflow menu, answering the confirm with `accept`. */
  terminate(page: Page, accept: boolean): Promise<void>;
  /** The header's Resume button. */
  resumeButton(page: Page): Locator;
  /** Opens plugin `id` from the app switcher; the URL then names it. */
  openPlugin(page: Page, id: string): Promise<void>;
  /** Leaves a plugin view for the conductor through the app switcher. */
  leavePlugin(page: Page): Promise<void>;
  /** Opens the conductor whose session id is `sessionId` from its Conductors-lens row. */
  openConductor(page: Page, sessionId: string): Promise<void>;
  /** The open conductor's workers panel. */
  workersPanel(page: Page): Locator;
  composer(page: Page): Locator;
  sendPrompt(page: Page, text: string): Promise<void>;
  lastUserMessage(page: Page): Locator;
  lastAssistantMessage(page: Page): Locator;
  turnEnded(page: Page): Locator;
  openSettings(page: Page): Promise<void>;
  leaveSettings(page: Page): Promise<void>;
  /** Selects the Projects lens, opens the dialog from the project-actions menu, and returns the dialog. */
  openPlacementDialog(page: Page, which: PlacementDialog): Promise<Locator>;
  /** The open project-actions menu. */
  projectActionsMenu(page: Page): Locator;
  placementField(dialog: Locator, which: PlacementDialog, field: PlacementField): Locator;
  /** The System picker's option labels, in order. */
  systemOptions(page: Page, dialog: Locator, which: PlacementDialog): Promise<string[]>;
  chooseSystem(page: Page, dialog: Locator, which: PlacementDialog, label: string): Promise<void>;
  /** Clicks the Add-project suggestion listing `relPath`. */
  pickSuggestion(dialog: Locator, relPath: string): Promise<void>;
  submitAdd(dialog: Locator): Promise<void>;
  /** On the Add-project stale pane, Relocate. */
  relocate(dialog: Locator): Promise<void>;
  /** The transcript's scroll root. */
  transcript(page: Page): Locator;
  userMessages(page: Page): Locator;
  turnEnds(page: Page): Locator;
  /** The sticky prompt's pin. */
  pin(page: Page): Locator;
  /** Its clamped text box. */
  pinBody(page: Page): Locator;
  /** The box drawing the pin's shadow. */
  pinCard(page: Page): Locator;
  /** The reveal swipe zones: the top bar and the pin. */
  swipeZones(page: Page): Locator[];

  // Settings (card 2026-0625)
  settingsView(page: Page): Locator;
  /** Opens Settings and switches to `section`. */
  openSettingsSection(page: Page, section: SettingsSection): Promise<void>;
  /** Account → Claude login's Log in button, sign-in link and code field. */
  claudeLogin(page: Page): { login: Locator; signInLink: Locator; code: Locator };
  /** Archived's project groups, in order. */
  archivedGroups(page: Page): Locator;
  expandArchivedGroup(page: Page, project: string): Promise<void>;
  /** Deletes the archived row labelled `label`, confirming or declining the prompt. */
  deleteArchived(page: Page, label: string, confirm: boolean): Promise<void>;

  // Dialogs part 2 (card 2026-0631)
  /** Opens the project's delete dialog from its Projects-lens row and returns the dialog. */
  openDeleteProject(page: Page, name: string): Promise<Locator>;
  /** The delete dialog's directory opt-in checkbox and its label. */
  deleteDirOptIn(dialog: Locator): { box: Locator; label: Locator };
  /** The delete dialog's line saying where the project lives. */
  deleteDescription(dialog: Locator): Locator;
  /** Types a name that does not match and attempts the delete as far as the UI allows. */
  tryDeleteWithMismatch(page: Page, dialog: Locator, name: string): Promise<void>;
  /** Cancels a dialog and waits until it is hidden. */
  cancelDialog(dialog: Locator): Promise<void>;
  /** Opens Change target from the project's system pill and returns the dialog. */
  openChangeTarget(page: Page, name: string): Promise<Locator>;
  changeTarget(dialog: Locator): { target: Locator; error: Locator };
  saveTarget(dialog: Locator): Promise<void>;
  /** Opens the New session dialog from the project's row and returns it; spawns nothing. */
  openSpawnDialog(page: Page, project: string): Promise<Locator>;
  /** Expands the spawn dialog's Advanced options; idempotent. */
  spawnAdvanced(dialog: Locator): Promise<void>;
  /** One read of the tier cards offered and the selected one. */
  spawnTiers(dialog: Locator): Promise<{ offered: string[]; selected: string | null }>;
  pickTier(dialog: Locator, tier: string): Promise<void>;
  /** The options of the Effort or Thinking select and the one selected; leaves the select closed. */
  spawnSelect(page: Page, dialog: Locator, which: SpawnSelect): Promise<{ options: string[]; selected: string }>;
  spawnField(dialog: Locator, field: SpawnField): Locator;

  // Sidebar B (card 2026-0628)
  /** Selects the Projects lens and returns the clickable row of `sessionId` in `project`'s Sessions lists. */
  sessionRow(page: Page, project: string, sessionId: string): Promise<Locator>;
  /** Whether that row is overlaid by a live instance. */
  sessionRowLive(row: Locator): Promise<boolean>;
  /** Selects the Projects lens and returns the summary heading the Sessions list of `project`'s main checkout (worktree null) or of that worktree, opening its Worktrees group first. */
  sessionsSummary(page: Page, project: string, worktree: string | null): Promise<Locator>;
  /** Whether the sidebar drawer is open (always false on desktop, which has no drawer). */
  drawerOpen(page: Page): Promise<boolean>;
  /** The × of a session row returned by `sessionRow`. */
  sessionClose(row: Locator): Locator;

  // Conversation part 2 (card 2026-0632)
  /** The wake-callback bubble's fold. */
  wakeFold(page: Page): Locator;
  /** A fold's open/close control. */
  foldToggle(fold: Locator): Locator;
  /** A fold's body box: hidden while the fold is closed. */
  foldBody(fold: Locator): Locator;
  /** The bell on a wake fold. */
  wakeBadge(fold: Locator): Locator;
  /** The wake body's metadata line. */
  wakeMeta(fold: Locator): Locator;
  /** The fold body's raw view, present only while raw shows. */
  foldRaw(fold: Locator): Locator;
  /** Flips the fold body between rendered and raw. */
  toggleFoldView(fold: Locator): Promise<void>;
  /** A prompt bubble's hover-revealed raw/copy controls row. */
  userControls(bubble: Locator): Locator;

  // Settings part 2 (card 2026-0636)
  /** Switches the open Settings view to `section` without reopening Settings. */
  switchSettingsSection(page: Page, section: SettingsSection): Promise<void>;
  /** Clicks Remove on the custom model whose row names `model`. */
  removeCustomModel(page: Page, model: string): Promise<void>;
  /** The Conduct session's compact-window override: its switch, slider and value readout. */
  compactWindow(page: Page): { toggle: Locator; slider: Locator; readout: Locator };
  systemRow(page: Page, id: string): Locator;
  editSystem(page: Page, id: string): Promise<void>;
  removeSystem(page: Page, id: string): Promise<void>;
  /** The Systems add/edit form; `save` is its submit button (Add in add mode, Save in edit mode). */
  systemForm(page: Page): { id: Locator; label: Locator; launch: Locator; save: Locator; cancel: Locator };
}

/** Pixel 7 projects (phone, android) show the sidebar as a drawer. */
const drawerViewport = () => test.info().project.name !== 'desktop';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactly = (s: string) => new RegExp(`^${escapeRe(s)}$`);

// The old UI's controls are static HTML whose listeners public/app.js attaches
// while its module evaluates, after the document has parsed: a click that lands
// first is lost. So each action is retried until the state it drives shows,
// and the drawer toggle — not idempotent — is clicked only while it reads closed.

/** On a drawer viewport, the old UI's drawer is open (its toggle's listener ran). */
export async function openOldDrawer(page: Page) {
  if (!drawerViewport()) return;
  const toggle = page.locator('#sidebar-toggle');
  await expect(async () => {
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(page.locator('#sidebar')).toHaveClass(/\bopen\b/, { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
}

/** The old UI is live: its JS (not just its HTML) ran, so the lens toggle answers. Selects Projects. */
export async function expectOldUiRunning(page: Page) {
  await openOldDrawer(page);
  await legacy.lens(page, 'projects');
}

export const legacy: Ui = {
  name: 'legacy',
  async open(page) {
    await page.goto('/legacy/');
    // The sidebar's first render fills the conductor filter: app.js has run,
    // without changing any state a scenario reads.
    await expect(page.locator('#conductor-filter-select option[value="hand"]')).toBeAttached({ timeout: 15_000 });
  },
  openSidebar: openOldDrawer,
  async lens(page, which) {
    await openOldDrawer(page);
    const button = page.locator(`.sidebar-lens button[data-lens="${which}"]`);
    // Choosing a lens is idempotent, so a lost click is simply clicked again.
    await expect(async () => {
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true', { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
  },
  async selectedLens(page) {
    await openOldDrawer(page);
    return page.locator('.sidebar-lens button[aria-pressed="true"]').getAttribute('data-lens');
  },
  async newProject(page, name) {
    await openOldDrawer(page);
    const dialog = page.locator('#new-project-dialog');
    await expect(async () => {
      if (!(await page.locator('#new-project-btn').isVisible())) await page.locator('#sidebar-overflow-toggle').click();
      await page.locator('#new-project-btn').click({ timeout: 1_000 });
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    await page.locator('#np-name').fill(name);
    await page.locator('#np-create').click();
    // A create that skipped git or carries a scaffold directive confirms first.
    const done = page.locator('#np-confirm button[value="ack"]');
    await expect(async () => {
      if (await done.isVisible()) await done.click();
      await expect(dialog).toBeHidden({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
  },
  async openAddProject(page) {
    // The ≡ row is hidden in the Conductors lens, where a fresh profile opens.
    await legacy.lens(page, 'projects');
    const dialog = page.locator('#adopt-project-dialog');
    await expect(async () => {
      if (!(await page.locator('#adopt-project-btn').isVisible())) await page.locator('#sidebar-overflow-toggle').click();
      await page.locator('#adopt-project-btn').click({ timeout: 1_000 });
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    return dialog;
  },
  async conduct(page) {
    await openOldDrawer(page);
    // open() waited for the sidebar's first render, after the Conduct listener is attached.
    await page.locator('#conduct-btn').click();
  },
  async projectRow(page, name) {
    await openOldDrawer(page);
    return page.locator('#project-list .project-row').filter({ has: page.locator('.project-name', { hasText: exactly(name) }) });
  },
  async startSessionIn(page, project, opts = {}) {
    await legacy.lens(page, 'projects');
    const row = await legacy.projectRow(page, project);
    const dialog = page.locator('#spawn-dialog');
    await expect(async () => {
      await row.locator('.add-instance').click({ timeout: 1_000 });
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    if (opts.temp === false) {
      const advanced = page.locator('#sd-advanced');
      if ((await advanced.getAttribute('open')) === null) await advanced.locator('summary').click();
      await page.locator('#sd-temp').setChecked(false);
    }
    await page.locator('#sd-spawn').click();
    await expect(dialog).toBeHidden();
  },
  // #main.settings-open hides #instance-title (the session's chips), never #instance-header.
  sessionHeader: (page) => page.locator('#instance-title'),
  async terminate(page, accept) {
    const kill = page.locator('#kill-btn');
    await expect(async () => {
      if (!(await kill.isVisible())) await page.locator('#overflow-toggle').click();
      await expect(kill).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    // The old UI asks with the browser's confirm().
    const answered = new Promise<void>((resolve) => {
      page.once('dialog', (d) => { void (accept ? d.accept() : d.dismiss()).then(resolve); });
    });
    await kill.click();
    await answered;
  },
  resumeButton: (page) => page.locator('#resume-btn'),
  async openPlugin(page, id) {
    await openOldDrawer(page);
    await page.locator('#app-switcher-select').selectOption(id);
    await expect(page).toHaveURL(new RegExp(`#plugin/${escapeRe(id)}/`));
  },
  async leavePlugin(page) {
    await openOldDrawer(page);
    await page.locator('#app-switcher-select').selectOption('conductor');
    await expect(page).not.toHaveURL(/#plugin\//);
  },
  async openConductor(page, sessionId) {
    await legacy.lens(page, 'conductors');
    const title = page.locator(`#conductor-list [data-key="conductor:${sessionId}"] .conductor-title`);
    await expect(async () => {
      await title.click({ timeout: 1_000 });
      await expect(page).toHaveURL(new RegExp(`#session=${escapeRe(sessionId)}(?:$|&)`), { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
  },
  workersPanel: (page) => page.locator('#subagent-panel'),
  composer: (page) => page.locator('#composer-input'),
  async sendPrompt(page, text) {
    await expect(legacy.composer(page)).toBeEnabled();
    await legacy.composer(page).fill(text);
    await page.locator('#composer-send').click();
  },
  lastUserMessage: (page) => page.locator('#conversation .msg.user').last(),
  lastAssistantMessage: (page) => page.locator('#conversation .msg.assistant').last(),
  turnEnded: (page) => page.locator('#conversation .block.turn-end').last(),
  async openSettings(page) {
    await openOldDrawer(page);
    await expect(async () => {
      await page.locator('#settings-btn').click();
      await expect(page.locator('#main')).toHaveClass(/\bsettings-open\b/, { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
  },
  async leaveSettings(page) {
    await openOldDrawer(page);
    await page.locator('#settings-btn').click();
    await expect(page.locator('#main')).not.toHaveClass(/\bsettings-open\b/);
  },
  async openPlacementDialog(page, which) {
    // The ≡ menu sits in the Projects lens row, hidden in the default Conductors lens.
    await legacy.lens(page, 'projects');
    const dialog = page.locator(which === 'new' ? '#new-project-dialog' : '#adopt-project-dialog');
    const item = page.locator(which === 'new' ? '#new-project-btn' : '#adopt-project-btn');
    await expect(async () => {
      if (!(await item.isVisible())) await page.locator('#sidebar-overflow-toggle').click();
      await item.click({ timeout: 1_000 });
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    return dialog;
  },
  projectActionsMenu: (page) => page.locator('#sidebar-overflow-panel'),
  placementField(dialog, which, field) {
    const p = which === 'new' ? 'np' : 'apd';
    const ids: Record<PlacementField, string> = {
      name: `${p}-name`,
      system: `${p}-system`,
      target: `${p}-remote`,
      path: which === 'new' ? 'np-system-path' : 'apd-path',
      pathList: which === 'new' ? 'np-system-path-completions' : 'apd-path-completions',
      suggestions: 'apd-suggestions',
    };
    return dialog.locator(`#${ids[field]}`);
  },
  async systemOptions(_page, dialog, which) {
    return legacy.placementField(dialog, which, 'system').locator('option').allTextContents();
  },
  async chooseSystem(_page, dialog, which, label) {
    await legacy.placementField(dialog, which, 'system').selectOption({ label });
  },
  async pickSuggestion(dialog, relPath) {
    await dialog.locator('#apd-suggestions .apd-suggestion')
      .filter({ has: dialog.page().locator('.apd-suggestion-path', { hasText: exactly(relPath) }) })
      .click();
  },
  async submitAdd(dialog) {
    await dialog.locator('#apd-adopt').click();
  },
  async relocate(dialog) {
    await dialog.locator('#apd-stale button[value="relocate"]').click();
  },
  transcript: (page) => page.locator('#conversation'),
  userMessages: (page) => page.locator('#conversation .msg.user'),
  turnEnds: (page) => page.locator('#conversation .block.turn-end'),
  pin: (page) => page.locator('#pinned-prompt'),
  pinBody: (page) => page.locator('#pinned-prompt .pinned-prompt-body'),
  pinCard: (page) => page.locator('#pinned-prompt'),
  swipeZones: (page) => [page.locator('#instance-header'), page.locator('#pinned-prompt')],

  // Settings (card 2026-0625)
  settingsView: (page) => page.locator('#settings-view'),
  async openSettingsSection(page, section) {
    await legacy.openSettings(page);
    await page.locator('#settings-group-select').selectOption(section);
    await expect(page.locator(`#settings-${section}`)).toBeVisible();
  },
  claudeLogin: (page) => ({ login: page.locator('#ca-login'), signInLink: page.locator('#ca-url'), code: page.locator('#ca-code') }),
  archivedGroups: (page) => page.locator('#ar-list details'),
  async expandArchivedGroup(page, project) {
    await legacy.archivedGroups(page).locator('summary', { hasText: new RegExp(`^${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(`) }).click();
  },
  async deleteArchived(page, label, confirm) {
    // The old UI asks with the browser's native confirm().
    page.once('dialog', (d) => void (confirm ? d.accept() : d.dismiss()));
    await page.locator('#ar-list .archived-row')
      .filter({ has: page.locator('.archived-row-title', { hasText: exactly(label) }) })
      .locator('.archived-delete').click();
  },

  // Dialogs part 2 (card 2026-0631)
  async openDeleteProject(page, name) {
    await legacy.lens(page, 'projects');
    const row = await legacy.projectRow(page, name);
    const dialog = page.locator('#delete-project-dialog');
    await expect(async () => {
      await row.locator('.delete-project').click({ timeout: 1_000 });
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    return dialog;
  },
  deleteDirOptIn: (dialog) => ({ box: dialog.locator('#dpd-delete-dir'), label: dialog.locator('#dpd-dir-label') }),
  deleteDescription: (dialog) => dialog.locator('#dpd-summary'),
  async tryDeleteWithMismatch(_page, dialog, name) {
    await dialog.locator('#dpd-confirm').fill(name + 'x');
    // The old dialog closes on the click and reopens itself with the refusal.
    await dialog.locator('button[value="delete"]').click();
    await expect(dialog.locator('#dpd-error')).toHaveText(/\S/);
  },
  async cancelDialog(dialog) {
    await dialog.locator('button[value="cancel"]').click();
    await expect(dialog).toBeHidden();
  },
  async openChangeTarget(page, name) {
    await legacy.lens(page, 'projects');
    const row = await legacy.projectRow(page, name);
    const dialog = page.locator('#project-remote-dialog');
    await expect(async () => {
      await row.locator('.system-pill[role="button"]').click({ timeout: 1_000 });
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    return dialog;
  },
  changeTarget: (dialog) => ({ target: dialog.locator('#pr-remote'), error: dialog.locator('#pr-error') }),
  async saveTarget(dialog) {
    await dialog.locator('#pr-save').click();
  },
  async openSpawnDialog(page, project) {
    await legacy.lens(page, 'projects');
    const row = await legacy.projectRow(page, project);
    const dialog = page.locator('#spawn-dialog');
    await expect(async () => {
      await row.locator('.add-instance').click({ timeout: 1_000 });
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    return dialog;
  },
  async spawnAdvanced(dialog) {
    const advanced = dialog.locator('#sd-advanced');
    if ((await advanced.getAttribute('open')) === null) await advanced.locator('summary').click();
  },
  async spawnTiers(dialog) {
    const tiers = (sel: string) => dialog.locator(sel).evaluateAll((els) => els.map((e) => e.getAttribute('data-tier') ?? ''));
    const offered = await tiers('.qs-model:not([hidden])');
    const selected = await tiers('.qs-model.qs-selected');
    return { offered, selected: selected[0] ?? null };
  },
  async pickTier(dialog, tier) {
    await dialog.locator(`.qs-model[data-tier="${tier}"]`).click();
  },
  async spawnSelect(_page, dialog, which) {
    const select = dialog.locator(which === 'effort' ? '#sd-effort' : '#sd-thinking');
    const options = (await select.locator('option').allTextContents()).map((t) => t.trim());
    const selected = (await select.locator('option:checked').textContent())?.trim() ?? '';
    return { options, selected };
  },
  spawnField(dialog, field) {
    const ids: Record<SpawnField, string> = { worktree: 'sd-worktree', worktreeHint: 'sd-worktree-hint', debug: 'sd-debug' };
    return dialog.locator(`#${ids[field]}`);
  },
  // Sidebar B (card 2026-0628)
  async sessionRow(page, project, sessionId) {
    await legacy.lens(page, 'projects');
    // A row's title starts with its session id.
    return (await legacy.projectRow(page, project)).locator('xpath=..').locator(`.session-row[title^="${sessionId}"]`);
  },
  sessionRowLive: (row) => row.evaluate((e) => e.classList.contains('live')),
  async sessionsSummary(page, project, worktree) {
    await legacy.lens(page, 'projects');
    const li = (await legacy.projectRow(page, project)).locator('xpath=..');
    if (worktree === null) return li.locator(':scope > details.sessions-group > summary');
    const group = li.locator('details.worktree-group').first();
    await expect(async () => {
      if ((await group.getAttribute('open')) === null) await group.locator(':scope > summary').click();
      await expect(group).toHaveAttribute('open', '', { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    return group.locator('.worktree-item')
      .filter({ has: page.locator('.worktree-name', { hasText: exactly(worktree) }) })
      .locator('details.sessions-group > summary')
      .first();
  },
  drawerOpen: (page) => page.locator('#sidebar').evaluate((e) => e.classList.contains('open')),
  sessionClose: (row) => row.locator('.session-delete'),

  // Conversation part 2 (card 2026-0632)
  wakeFold: (page) => page.locator('#conversation .msg.user.wake-callback details.block.wake'),
  foldToggle: (fold) => fold.locator(':scope > summary'),
  foldBody: (fold) => fold.locator(':scope > .user-text'),
  wakeBadge: (fold) => fold.locator(':scope > summary .wake-badge'),
  wakeMeta: (fold) => fold.locator('.wake-meta'),
  foldRaw: (fold) => fold.locator('.user-text[data-view="raw"]'),
  async toggleFoldView(fold) {
    await fold.locator('.user-view-toggle').click();
  },
  userControls: (bubble) => bubble.locator('.user-view-controls'),

  // Settings part 2 (card 2026-0636)
  async switchSettingsSection(page, section) {
    await page.locator('#settings-group-select').selectOption(section);
    await expect(page.locator(`#settings-${section}`)).toBeVisible();
  },
  async removeCustomModel(page, model) {
    await page.locator('#sm-custom-list .sm-custom-item').filter({ hasText: model }).locator('.sm-custom-remove').click();
  },
  compactWindow: (page) => ({ toggle: page.locator('#sm-compact-window-enabled'), slider: page.locator('#sm-compact-window'), readout: page.locator('#sm-compact-window-val') }),
  systemRow: (page, id) => page.locator('#sy-list .sy-row').filter({ has: page.locator('.sy-row-id', { hasText: exactly(id) }) }),
  async editSystem(page, id) {
    await legacy.systemRow(page, id).locator('.sy-row-actions button', { hasText: exactly('Edit') }).click();
  },
  async removeSystem(page, id) {
    await legacy.systemRow(page, id).locator('.sy-row-actions button', { hasText: exactly('Remove') }).click();
  },
  systemForm: (page) => ({ id: page.locator('#sy-id'), label: page.locator('#sy-label'), launch: page.locator('#sy-launch'), save: page.locator('#sy-save'), cancel: page.locator('#sy-cancel') }),
};

/**
 * The web UI's sidebar: the desktop column, or the phone drawer while it is
 * open — a drawer still animating closed (selecting a session closes it) is not.
 */
const sidebar = (page: Page) => drawerViewport()
  ? page.locator('[data-slot="sheet-content"][data-state="open"] [data-sidebar]')
  : page.locator('[data-sidebar]:visible');
const LENS_LABEL: Record<Lens, string> = { conductors: 'Conductors', projects: 'Projects' };

export const next: Ui = {
  name: 'next',
  async open(page) {
    await page.goto('/next/');
    await expect(page.locator('[data-sidebar]').first()).toBeAttached();
  },
  async openSidebar(page) {
    if (!drawerViewport()) return;
    await expect(async () => {
      if (!(await sidebar(page).count())) await page.getByRole('button', { name: 'Open sidebar' }).filter({ visible: true }).first().click();
      await expect(sidebar(page)).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
  },
  async lens(page, which) {
    await next.openSidebar(page);
    const tab = sidebar(page).getByRole('tab', { name: LENS_LABEL[which] });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  },
  async selectedLens(page) {
    await next.openSidebar(page);
    const label = await sidebar(page).getByRole('tab', { selected: true }).textContent();
    return (Object.keys(LENS_LABEL) as Lens[]).find((k) => LENS_LABEL[k] === label?.trim()) ?? null;
  },
  async newProject(page, name) {
    await next.openSidebar(page);
    await sidebar(page).getByRole('button', { name: 'Project actions' }).click();
    await page.getByRole('menuitem', { name: 'New project' }).click();
    const dialog = page.getByRole('dialog', { name: 'New project' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByRole('button', { name: 'Create project' }).click();
    await expect(dialog).toBeHidden();
  },
  async openAddProject(page) {
    await next.openSidebar(page);
    await sidebar(page).getByRole('button', { name: 'Project actions' }).click();
    await page.getByRole('menuitem', { name: 'Add existing directory' }).click();
    return page.getByRole('dialog', { name: 'Add a project' });
  },
  async conduct(page) {
    await next.openSidebar(page);
    await sidebar(page).locator('[data-conduct]').click();
  },
  async projectRow(page, name) {
    await next.openSidebar(page);
    return sidebar(page).locator(`[data-project-row="${name}"]`);
  },
  async startSessionIn(page, project, opts = {}) {
    await next.lens(page, 'projects');
    const row = await next.projectRow(page, project);
    await row.hover();
    await row.getByRole('button', { name: 'New session' }).click();
    const dialog = page.getByRole('dialog', { name: 'New session' });
    await expect(dialog).toBeVisible();
    if (opts.temp === false) {
      const temp = dialog.locator('#sd-temp');
      if (!(await temp.isVisible())) await dialog.getByRole('button', { name: 'Advanced options' }).click();
      await temp.setChecked(false);
    }
    await dialog.getByRole('button', { name: 'Start session' }).click();
    await expect(dialog).toBeHidden();
  },
  sessionHeader: (page) => page.locator('[data-session-header]'),
  async terminate(page, accept) {
    await next.sessionHeader(page).getByRole('button', { name: 'Session actions' }).click();
    await page.getByRole('menuitem', { name: 'Terminate' }).click();
    const dialog = page.getByRole('dialog', { name: 'Terminate this session?' });
    await dialog.getByRole('button', { name: accept ? 'Terminate' : 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  },
  resumeButton: (page) => next.sessionHeader(page).getByRole('button', { name: 'Resume' }),
  async openPlugin(page, id) {
    await next.openSidebar(page);
    await sidebar(page).getByRole('button', { name: 'Switch app' }).click();
    await page.locator(`[data-app-id="${id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`#plugin/${escapeRe(id)}/`));
  },
  async leavePlugin(page) {
    await next.openSidebar(page);
    await sidebar(page).getByRole('button', { name: 'Switch app' }).click();
    await page.getByRole('menuitem', { name: 'Conductor' }).click();
    await expect(page).not.toHaveURL(/#plugin\//);
  },
  async openConductor(page, sessionId) {
    await next.lens(page, 'conductors');
    await sidebar(page).locator(`[data-conductor="${sessionId}"] > [role=button]`).click();
  },
  workersPanel: (page) => page.locator('[data-subagent-panel]'),
  composer: (page) => page.locator('#composer-input'),
  async sendPrompt(page, text) {
    await expect(next.composer(page)).toBeEnabled();
    await next.composer(page).fill(text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
  },
  lastUserMessage: (page) => page.locator('[data-item=user]').last(),
  lastAssistantMessage: (page) => page.locator('[data-item=assistant]').last(),
  turnEnded: (page) => page.locator('[data-item=turn-end]').last(),
  async openSettings(page) {
    await next.openSidebar(page);
    await sidebar(page).getByRole('button', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/#settings/);
  },
  async leaveSettings(page) {
    await page.getByRole('button', { name: 'Back', exact: true }).filter({ visible: true }).first().click();
    await expect(page).not.toHaveURL(/#settings/);
  },
  async openPlacementDialog(page, which) {
    // The menu is not lens-gated here; the Projects lens keeps both drivers in one state (projectRow reads that list).
    await next.lens(page, 'projects');
    await sidebar(page).getByRole('button', { name: 'Project actions' }).click();
    await page.getByRole('menuitem', { name: which === 'new' ? 'New project' : 'Add existing directory' }).click();
    await expect(page.getByRole('dialog', { name: which === 'new' ? 'New project' : 'Add a project' })).toBeVisible();
    // By its slot, not its title: the stale pane retitles the Add-project dialog.
    return page.locator(`[role="dialog"][data-dialog="${which === 'new' ? 'new-project' : 'adopt-project'}"]`);
  },
  projectActionsMenu: (page) => page.getByRole('menu'),
  placementField(dialog, which, field) {
    switch (field) {
      case 'name': return dialog.getByLabel('Name', { exact: true });
      case 'system': return dialog.getByRole('combobox', { name: 'System', exact: true });
      case 'target': return dialog.getByRole('textbox', { name: 'Target', exact: true });
      case 'path': return dialog.getByRole('combobox', { name: which === 'new' ? 'Path on that system' : 'Directory', exact: true });
      case 'pathList': return dialog.getByRole('listbox');
      case 'suggestions': return dialog.locator('[data-suggestions]');
    }
  },
  async systemOptions(page, dialog, which) {
    await next.placementField(dialog, which, 'system').click();
    const options = page.getByRole('option');
    await expect(options.first()).toBeVisible();
    const labels = await options.allTextContents();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toBeHidden();
    return labels;
  },
  async chooseSystem(page, dialog, which, label) {
    await next.placementField(dialog, which, 'system').click();
    await page.getByRole('option', { name: label, exact: true }).click();
    await expect(page.getByRole('option')).toHaveCount(0);
  },
  async pickSuggestion(dialog, relPath) {
    await dialog.locator('[data-suggestions] button')
      .filter({ has: dialog.page().locator('span', { hasText: exactly(relPath) }) })
      .click();
  },
  async submitAdd(dialog) {
    await dialog.getByRole('button', { name: 'Add project' }).click();
  },
  async relocate(dialog) {
    await dialog.getByRole('button', { name: 'Relocate' }).click();
  },
  transcript: (page) => page.locator('[data-conversation]'),
  userMessages: (page) => page.locator('[data-item=user]'),
  turnEnds: (page) => page.locator('[data-item=turn-end]'),
  pin: (page) => page.locator('[data-pinned-prompt]'),
  pinBody: (page) => page.locator('[data-pin-body]'),
  pinCard: (page) => page.locator('[data-pin-body]').locator('..'),
  swipeZones: (page) => [page.locator('[data-session-header]'), page.locator('[data-pinned-prompt]')],

  // Settings (card 2026-0625)
  settingsView: (page) => page.locator('[data-settings-view]'),
  async openSettingsSection(page, section) {
    const label: Record<SettingsSection, string> = { account: 'Account', archived: 'Archived', about: 'About', models: 'Models', backends: 'Backends', systems: 'Systems' };
    await next.openSettings(page);
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: label[section], exact: true }).click();
    await expect(page.locator(`[data-section="${section}"]`)).toBeVisible();
  },
  claudeLogin: (page) => ({ login: page.getByTestId('ca-login'), signInLink: page.getByTestId('ca-url'), code: page.getByLabel('Sign-in code') }),
  archivedGroups: (page) => page.locator('[data-testid="archived-list"] [data-group]'),
  async expandArchivedGroup(page, project) {
    await page.locator(`[data-group="${project}"]`).getByRole('button').first().click();
  },
  async deleteArchived(page, label, confirm) {
    await page.locator('[data-session]').filter({ has: page.getByText(label, { exact: true }) }).getByRole('button', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog', { name: `Delete the transcript of “${label}”?` });
    await dialog.getByRole('button', { name: confirm ? 'Delete permanently' : 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  },

  // Dialogs part 2 (card 2026-0631)
  async openDeleteProject(page, name) {
    await next.lens(page, 'projects');
    const row = await next.projectRow(page, name);
    await row.hover();
    await row.getByRole('button', { name: 'Delete project' }).click();
    const dialog = page.locator('[role="dialog"][data-dialog="delete-project"]');
    await expect(dialog).toBeVisible();
    return dialog;
  },
  // By `for`, never `#dpd-delete-dir + label`: a hidden Radix bubble input sits between them.
  deleteDirOptIn: (dialog) => ({ box: dialog.locator('#dpd-delete-dir'), label: dialog.locator('label[for="dpd-delete-dir"]') }),
  deleteDescription: (dialog) => dialog.locator('[data-slot="dialog-description"]'),
  async tryDeleteWithMismatch(_page, dialog, name) {
    await dialog.locator('#dpd-confirm').fill(name + 'x');
    await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
  },
  async cancelDialog(dialog) {
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
  },
  async openChangeTarget(page, name) {
    await next.lens(page, 'projects');
    const row = await next.projectRow(page, name);
    await row.locator('[data-system-pill]').click();
    const dialog = page.locator('[role="dialog"][data-dialog="project-remote"]');
    await expect(dialog).toBeVisible();
    return dialog;
  },
  changeTarget: (dialog) => ({ target: dialog.getByRole('textbox', { name: 'Target', exact: true }), error: dialog.getByRole('alert') }),
  async saveTarget(dialog) {
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  },
  async openSpawnDialog(page, project) {
    await next.lens(page, 'projects');
    const row = await next.projectRow(page, project);
    await row.hover();
    await row.getByRole('button', { name: 'New session' }).click();
    const dialog = page.locator('[role="dialog"][data-dialog="spawn"]');
    await expect(dialog).toBeVisible();
    return dialog;
  },
  async spawnAdvanced(dialog) {
    if (!(await dialog.locator('#sd-temp').isVisible())) await dialog.getByRole('button', { name: 'Advanced options' }).click();
  },
  async spawnTiers(dialog) {
    const offered = await dialog.locator('[role="radio"][data-tier]').evaluateAll((els) => els.map((e) => e.getAttribute('data-tier') ?? ''));
    const selected = await dialog.locator('[role="radio"][data-tier][aria-checked="true"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-tier') ?? ''));
    return { offered, selected: selected[0] ?? null };
  },
  async pickTier(dialog, tier) {
    await dialog.locator(`[role="radio"][data-tier="${tier}"]`).click();
  },
  async spawnSelect(page, dialog, which) {
    const trigger = dialog.getByRole('combobox', { name: which === 'effort' ? 'Effort' : 'Thinking', exact: true });
    const selected = (await trigger.textContent())?.trim() ?? '';
    await trigger.click();
    const options = page.getByRole('option');
    await expect(options.first()).toBeVisible();
    const labels = (await options.allTextContents()).map((t) => t.trim());
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toBeHidden();
    return { options: labels, selected };
  },
  spawnField(dialog, field) {
    switch (field) {
      case 'worktree': return dialog.locator('#sd-worktree');
      case 'worktreeHint': return dialog.locator('label[for="sd-worktree"] + p');
      case 'debug': return dialog.locator('#sd-debug');
    }
  },
  // Sidebar B (card 2026-0628)
  async sessionRow(page, project, sessionId) {
    await next.lens(page, 'projects');
    return sidebar(page).locator(`[data-project="${project}"] [data-session-row="${sessionId}"] > [role="button"]`);
  },
  sessionRowLive: async (row) => (await row.locator('[data-dot]').getAttribute('data-dot')) !== 'offline',
  async sessionsSummary(page, project, worktree) {
    await next.lens(page, 'projects');
    if (worktree) {
      const toggle = sidebar(page).locator(`[data-worktrees="${project}"] > button`);
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    }
    return sidebar(page).locator(`[data-sessions-summary="${worktree ? `${project}:${worktree}` : project}"]`);
  },
  drawerOpen: async (page) => (await page.locator('[data-slot="sheet-content"][data-state="open"]').count()) > 0,
  sessionClose: (row) => row.getByRole('button', { name: /^(Stop session|Archive session \(keeps history\))$/ }),

  // Conversation part 2 (card 2026-0632)
  wakeFold: (page) => page.locator('[data-item=user][data-variant=wake] [data-fold=wake]'),
  foldToggle: (fold) => fold.locator('[data-fold-trigger]'),
  foldBody: (fold) => fold.locator('[data-slot="collapsible-content"]'),
  wakeBadge: (fold) => fold.locator('[data-fold-trigger] svg.lucide-bell'),
  wakeMeta: (fold) => fold.locator('[data-wake-meta]'),
  foldRaw: (fold) => fold.locator('[data-view="raw"]'),
  async toggleFoldView(fold) {
    await fold.getByRole('button', { name: /^Show (raw text|rendered markdown)$/ }).click();
  },
  userControls: (bubble) => bubble.getByRole('button', { name: 'Copy message', exact: true }).locator('xpath=..'),

  // Settings part 2 (card 2026-0636)
  async switchSettingsSection(page, section) {
    const label: Record<SettingsSection, string> = { account: 'Account', archived: 'Archived', about: 'About', models: 'Models', backends: 'Backends', systems: 'Systems' };
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: label[section], exact: true }).click();
    await expect(page.locator(`[data-section="${section}"]`)).toBeVisible();
  },
  async removeCustomModel(page, model) {
    await page.locator('[data-testid="custom-list"] li').filter({ hasText: model }).getByRole('button', { name: /^Remove / }).click();
  },
  compactWindow: (page) => ({
    toggle: page.getByRole('switch', { name: 'Override the compact window for the Conduct session', exact: true }),
    slider: page.locator('#compact-window'),
    readout: page.locator('#compact-window + span'),
  }),
  systemRow: (page, id) => page.locator(`[data-system="${id}"]`),
  async editSystem(page, id) {
    await next.systemRow(page, id).getByRole('button', { name: /^Edit / }).click();
  },
  async removeSystem(page, id) {
    await next.systemRow(page, id).getByRole('button', { name: /^Remove / }).click();
  },
  systemForm: (page) => {
    const form = page.locator('[data-section="systems"] form');
    return { id: page.locator('#sy-id'), label: page.locator('#sy-label'), launch: page.locator('#sy-launch'), save: form.locator('button[type="submit"]'), cancel: form.getByRole('button', { name: 'Cancel', exact: true }) };
  },
};

// Sidebar B (card 2026-0628)
/** The web UI's sidebar, for /next/-only specs. */
export const nextSidebar = sidebar;

export const UIS: Record<UiName, Ui> = { legacy, next };
