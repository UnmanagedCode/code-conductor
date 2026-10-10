// One driver per UI. Each method is one user-level operation performed through
// that UI's own controls, so a parity scenario reads the same against both.
// A method that reaches the sidebar opens the phone drawer itself.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../harness/fixtures.ts';
import type { UiName } from './uis.ts';

export type Lens = 'conductors' | 'projects';

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
  /** Starts a session in `project` from its sidebar row with the dialog's defaults. */
  startSessionIn(page: Page, project: string): Promise<void>;
  sessionHeader(page: Page): Locator;
  composer(page: Page): Locator;
  sendPrompt(page: Page, text: string): Promise<void>;
  lastUserMessage(page: Page): Locator;
  lastAssistantMessage(page: Page): Locator;
  turnEnded(page: Page): Locator;
  openSettings(page: Page): Promise<void>;
  leaveSettings(page: Page): Promise<void>;
}

/** Pixel 7 projects (phone, android) show the sidebar as a drawer. */
const drawerViewport = () => test.info().project.name !== 'desktop';
const exactly = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

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
  async startSessionIn(page, project) {
    await legacy.lens(page, 'projects');
    const row = await legacy.projectRow(page, project);
    const dialog = page.locator('#spawn-dialog');
    await expect(async () => {
      await row.locator('.add-instance').click({ timeout: 1_000 });
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    await page.locator('#sd-spawn').click();
    await expect(dialog).toBeHidden();
  },
  // #main.settings-open hides #instance-title (the session's chips), never #instance-header.
  sessionHeader: (page) => page.locator('#instance-title'),
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
  async startSessionIn(page, project) {
    await next.lens(page, 'projects');
    const row = await next.projectRow(page, project);
    await row.hover();
    await row.getByRole('button', { name: 'New session' }).click();
    const dialog = page.getByRole('dialog', { name: 'New session' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Start session' }).click();
    await expect(dialog).toBeHidden();
  },
  sessionHeader: (page) => page.locator('[data-session-header]'),
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
    await page.getByRole('button', { name: 'Back' }).filter({ visible: true }).first().click();
    await expect(page).not.toHaveURL(/#settings/);
  },
};

export const UIS: Record<UiName, Ui> = { legacy, next };
