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
export type SettingsSection = 'account' | 'archived' | 'about' | 'models' | 'backends' | 'systems' | 'conventions' | 'plugins';
export type SpawnField = 'worktree' | 'worktreeHint' | 'debug';
export type SpawnSelect = 'effort' | 'thinking';
// Dialogs part 3 (card 2026-0639)
export type SessionDialog = 'summary' | 'stats' | 'prune';
export type SummaryTier = 'title' | 'short' | 'medium' | 'long';
export type PruneField = 'cut' | 'cutLabel' | 'thinking' | 'minimal';
export type RestartChoice = 'resume' | 'only';
// Settings part 3 (card 2026-0637)
export type ConventionScope = 'workspace' | 'conductor' | 'project';

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

  // Sidebar B2 (card 2026-0638)
  /** Selects the Projects lens and opens `project`'s Worktrees group. */
  openWorktrees(page: Page, project: string): Promise<void>;
  /** Selects the Projects lens and closes `project`'s Worktrees group. */
  closeWorktrees(page: Page, project: string): Promise<void>;
  /** Selects the Projects lens and reads whether `project`'s Worktrees group is open, without touching it. */
  worktreesOpen(page: Page, project: string): Promise<boolean>;
  /** Selects the Projects lens, opens `project`'s Worktrees group and returns `worktree`'s head row. */
  worktreeHead(page: Page, project: string, worktree: string): Promise<Locator>;
  /** The computed colour of the 3px owner bar `el` draws, or null when it draws none. */
  ownerBar(el: Locator): Promise<string | null>;
  /** Selects the Projects lens and returns the listed project names, in order. */
  projectNames(page: Page): Promise<string[]>;
  /** Selects the Projects lens and sets the conductor filter: '' is All, else an owner session id shown as `label`. */
  filterTo(page: Page, value: string, label: string): Promise<void>;
  /** Selects the Projects lens and returns the filter root's owner bar colour, or null. */
  filterBar(page: Page): Promise<string | null>;
  /** Whether a session row is the selected one. */
  sessionRowActive(row: Locator): Promise<boolean>;
  /** A session row's label weight, whether it draws a 1px selection frame, and its fill. */
  sessionRowStyle(row: Locator): Promise<{ weight: string; framed: boolean; fill: string }>;

  // Dialogs part 3 (card 2026-0639)
  /** Opens the active session's ⋮ item for `which` and returns its dialog. */
  openSessionDialog(page: Page, which: SessionDialog): Promise<Locator>;
  /** ⋮ → Rename: returns the prefilled title, then saves `answer` (null cancels) and waits until the prompt or dialog is gone. */
  renameSession(page: Page, answer: string | null): Promise<string>;
  /** Closes a Summary or Statistics dialog through its Close control and waits until it is hidden. */
  closeSessionDialog(dialog: Locator): Promise<void>;
  /** One read of the summary tiers in order and the selected one. */
  summaryTiers(dialog: Locator): Promise<{ tiers: string[]; selected: string | null }>;
  pickSummaryTier(dialog: Locator, tier: SummaryTier): Promise<void>;
  summaryContent(dialog: Locator): Locator;
  summaryStale(dialog: Locator): Locator;
  summaryCost(dialog: Locator): Locator;
  /** The Generate summary / Regenerate button. */
  summaryGenerate(dialog: Locator): Locator;
  summaryUseAsTitle(dialog: Locator): Locator;
  statsTable(dialog: Locator): Locator;
  /** The note shown when the session spawned no workers. */
  statsNote(dialog: Locator): Locator;
  pruneField(dialog: Locator, field: PruneField): Locator;
  /** The savings table's rows, Thinking first. */
  pruneSavingsRows(dialog: Locator): Locator;
  applyPrune(dialog: Locator): Promise<void>;
  /** Opens New workspace from the Projects-lens project menu and returns the dialog. */
  openNewWorkspace(page: Page): Promise<Locator>;
  /** Opens a workspace's editor from its header's pencil and returns the dialog. */
  openEditWorkspace(page: Page, name: string): Promise<Locator>;
  /** Selects the Projects lens and returns the workspace's header. */
  workspaceHeader(page: Page, name: string): Promise<Locator>;
  workspaceName(dialog: Locator): Locator;
  /** The member box of `project` in the workspace dialog. */
  workspaceMember(dialog: Locator, project: string): Locator;
  saveWorkspace(dialog: Locator): Promise<void>;
  /** Clicks Delete workspace and answers the confirm. */
  deleteWorkspace(page: Page, dialog: Locator, confirm: boolean): Promise<void>;
  /** Clicks the sidebar's restart button once. */
  clickRestart(page: Page): Promise<void>;
  restartDialog(page: Page): Locator;
  restartChoice(dialog: Locator, which: RestartChoice): Locator;
  /** Leaves the restart dialog without choosing and waits until it is hidden. */
  dismissRestart(page: Page, dialog: Locator): Promise<void>;

  // Sidebar C (card 2026-0629)
  /** Selects the Conductors lens and returns the clickable header row of `sessionId`'s conductor block. */
  conductorRow(page: Page, sessionId: string): Promise<Locator>;
  /** Selects the Conductors lens and opens the Inactive group. */
  openInactive(page: Page): Promise<void>;
  /** A conductor row's selected state, label text, weight, italic and whether its colour is the UI's muted token, and the row's frame and fill. */
  conductorRowStyle(row: Locator): Promise<{ active: boolean; text: string; weight: string; italic: boolean; muted: boolean; framed: boolean; fill: string }>;
  /** Selects the Conductors lens and returns `sessionId`'s project chips in order, their text colour resolved against the UI's muted and foreground tokens. */
  conductorChips(page: Page, sessionId: string): Promise<ConductorChip[]>;
  /** Selects the Conductors lens and returns `sessionId`'s block bar (computed colour, width) and where its row box and its first control start, from the block's left edge. */
  conductorGeometry(page: Page, sessionId: string): Promise<ConductorGeometry>;
  /** Selects the Conductors lens, expands `conductor`'s tree and returns the worker row of `sessionId` in it. */
  treeWorkerRow(page: Page, conductor: string, sessionId: string): Promise<Locator>;
  /** A conductor, tree-worker or session row's label (floor, flex basis and grow, width, text height, truncated) and its ago / ↑ / × (flex-shrink, inside the row box). */
  rowLayout(row: Locator): Promise<RowLayout>;
  /** Opens the sidebar and returns `sessionId`'s needs-you strip entry. */
  stripEntry(page: Page, sessionId: string): Promise<Locator>;
  /** A strip entry's selected state, label weight, frame and fill. */
  stripEntryStyle(entry: Locator): Promise<{ active: boolean; weight: string; framed: boolean; fill: string }>;
  /** A row's status dot: its tooltip and computed fill. */
  rowDot(row: Locator): Promise<{ title: string; fill: string }>;

  // Settings part 3 (card 2026-0637)
  /** Opens a Conventions block if it is closed; idempotent. */
  expandConventionsBlock(page: Page, scope: ConventionScope): Promise<void>;
  conventionList(page: Page, scope: ConventionScope): Locator;
  conventionRow(page: Page, scope: ConventionScope, slug: string): Locator;
  /** The block's per-convention enable controls. */
  conventionToggles(page: Page, scope: ConventionScope): Locator;
  /** The block's Add button and its add/edit form's fields, Save and Cancel. */
  conventionForm(page: Page, scope: ConventionScope): { add: Locator; slug: Locator; name: Locator; description: Locator; body: Locator; save: Locator; cancel: Locator };
  /** The conductor block's preferred-playbook and enforcement selects and their status lines. */
  conductorPickers(page: Page): { playbook: Locator; enforcement: Locator; playbookStatus: Locator; enforcementStatus: Locator };
  /** Deletes the custom convention `slug`, accepting the confirm prompt. */
  deleteConvention(page: Page, scope: ConventionScope, slug: string): Promise<void>;
  /** The block's list status line (load failures and refused actions). */
  conventionStatus(page: Page, scope: ConventionScope): Locator;

  // Conversation part 3 (card 2026-0633)
  /** The AskUserQuestion card(s) in the transcript. */
  questionCard(page: Page): Locator;
  /** The option button `label` in the card's visible pane. */
  cardOption(card: Locator, label: string): Locator;
  /** Whether an option returned by `cardOption` is picked. */
  cardOptionPicked(option: Locator): Promise<boolean>;
  /** The visible pane's text field (custom answer or note). */
  cardField(card: Locator): Locator;
  /** The card's Send button. */
  cardSend(card: Locator): Locator;
  /** The card's status line. */
  cardStatus(card: Locator): Locator;
  /** The tab of question `i` on a multi-question card. */
  cardTab(card: Locator, i: number): Locator;
  /** The answer bubble(s) a stamped echo renders. */
  answerBubble(page: Page): Locator;
  /** One entry per question row of an answer bubble. */
  answerRows(bubble: Locator): Promise<{ kind: string; choices: string[]; note: string | null; custom: string | null }[]>;

  // Sidebar B3 (card 2026-0642)
  /** Closes the sidebar drawer on a drawer viewport so the next driver call opens it afresh; a no-op on desktop. */
  closeSidebar(page: Page): Promise<void>;
  /** Selects the Projects lens and returns the conductor filter's value: '' (All), 'hand', or an owner session id. */
  filterValue(page: Page): Promise<string>;
  /** Selects the Projects lens and returns the conductor filter's option labels in order, leaving the menu closed. */
  filterOptions(page: Page): Promise<string[]>;
  /** Selects the Projects lens and reads what `project`'s entry holds below its row. */
  projectParts(page: Page, project: string): Promise<ProjectParts>;
  /** Selects the Projects lens and reads whether the Sessions list of `project`'s `worktree` shows the conducted separator. */
  conductedSeparator(page: Page, project: string, worktree: string): Promise<boolean>;

  // Settings part 3b (card 2026-0646)
  /** A Plugin Library entry, found by its display name. */
  libraryEntry(page: Page, name: string): Locator;
  /** An entry's action button by its exact label: `Install`, `Update`, or the in-flight `Installing…` / `Updating…`. */
  libraryAction(entry: Locator, label: string): Locator;
  /** The entry's `installed as …` line. */
  libraryInstalledAs(entry: Locator): Locator;
  /** The entry's live install/update output. */
  libraryLive(entry: Locator): Locator;
  /** The Plugin Library's status line. */
  libraryStatus(page: Page): Locator;
  /** The Plugin Library's install/update output: a failure's or a warning's tail. */
  libraryTail(page: Page): Locator;
}

// Sidebar C (card 2026-0629)
export type ConductorGeometry = { bar: string | null; barWidth: number; rowLeft: number; contentLeft: number };
/** A chip's project and kind, its border style, and whether its text colour is the UI's muted or foreground token. */
export type ConductorChip = { project: string; kind: 'live' | 'idle'; dashed: boolean; muted: boolean; foreground: boolean };
export type RowLayout = {
  label: { minWidth: number; basis: number; grow: string; width: number; textHeight: number; truncated: boolean };
  fixed: { part: 'ago' | 'promote' | 'close'; shrink: string; inside: boolean }[];
};

// Sidebar B3 (card 2026-0642)
/** What a project's entry holds below its row: a main-checkout Sessions subnode, a Worktrees group, its session rows, the empty-project hint. */
export type ProjectParts = { sessions: boolean; worktrees: boolean; rows: number; hint: boolean };
/** Reads `rowLayout` in the page: the label box is the first of `labels` that matches, its text the label's `text` descendant or else the label itself, and `fixed` the row's ago / ↑ / × by part. */
const measureRow = (row: Locator, sel: { labels: string[]; text: string; fixed: Record<'ago' | 'promote' | 'close', string> }) =>
  row.evaluate((e, s): RowLayout => {
    const label = s.labels.map((l) => e.querySelector<HTMLElement>(l)).find((l) => l);
    if (!label) throw new Error(`rowLayout: no label in the row matched any of ${JSON.stringify(s.labels)}`);
    const text = label.querySelector<HTMLElement>(s.text) ?? label;
    const ls = getComputedStyle(label);
    const r = e.getBoundingClientRect();
    const fixed: RowLayout['fixed'] = [];
    for (const part of ['ago', 'promote', 'close'] as const) {
      for (const f of e.querySelectorAll<HTMLElement>(s.fixed[part])) {
        const fr = f.getBoundingClientRect();
        fixed.push({
          part,
          shrink: getComputedStyle(f).flexShrink,
          inside: fr.left >= r.left - 0.5 && fr.right <= r.right + 0.5 && fr.top >= r.top - 0.5 && fr.bottom <= r.bottom + 0.5,
        });
      }
    }
    return {
      label: {
        minWidth: parseFloat(ls.minWidth),
        basis: parseFloat(ls.flexBasis),
        grow: ls.flexGrow,
        width: label.getBoundingClientRect().width,
        textHeight: text.getBoundingClientRect().height,
        truncated: text.scrollWidth > text.clientWidth,
      },
      fixed,
    };
  }, sel);

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

// Settings part 3 (card 2026-0637)
const LEGACY_PREFIX: Record<ConventionScope, string> = { workspace: 'wk', conductor: 'cc', project: 'pc' };
const conventionsBase = (scope: ConventionScope) => `/api/settings/conventions/${scope}`;
const conventionsTitle = (scope: ConventionScope) => `${scope[0].toUpperCase()}${scope.slice(1)} conventions`;

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
    await legacy.openWorktrees(page, project);
    const group = li.locator('details.worktree-group').first();
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

  // Sidebar B2 (card 2026-0638)
  async openWorktrees(page, project) {
    await legacy.lens(page, 'projects');
    const group = (await legacy.projectRow(page, project)).locator('xpath=..').locator('details.worktree-group').first();
    await expect(async () => {
      if ((await group.getAttribute('open')) === null) await group.locator(':scope > summary').click();
      await expect(group).toHaveAttribute('open', '', { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
  },
  async closeWorktrees(page, project) {
    await legacy.lens(page, 'projects');
    const group = (await legacy.projectRow(page, project)).locator('xpath=..').locator('details.worktree-group').first();
    await expect(async () => {
      if ((await group.getAttribute('open')) !== null) await group.locator(':scope > summary').click();
      await expect(group).not.toHaveAttribute('open', { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
  },
  async worktreesOpen(page, project) {
    await legacy.lens(page, 'projects');
    const group = (await legacy.projectRow(page, project)).locator('xpath=..').locator('details.worktree-group').first();
    return group.evaluate((e) => (e as HTMLDetailsElement).open);
  },
  async worktreeHead(page, project, worktree) {
    await legacy.openWorktrees(page, project);
    const li = (await legacy.projectRow(page, project)).locator('xpath=..');
    return li.locator('.worktree-row').filter({ has: page.locator('.worktree-name', { hasText: exactly(worktree) }) }).first();
  },
  // A session row draws the bar as a border; a head and the filter draw it inset.
  ownerBar: (el) => el.evaluate((e) => {
    const cs = getComputedStyle(e);
    if (cs.borderLeftStyle === 'solid' && cs.borderLeftWidth === '3px') return cs.borderLeftColor;
    return /(rgba?\([^)]*\)) 3px 0px 0px 0px inset/.exec(cs.boxShadow)?.[1] ?? null;
  }),
  async projectNames(page) {
    await legacy.lens(page, 'projects');
    return page.locator('#project-list .project-name').allTextContents();
  },
  async filterTo(page, value, _label) {
    await legacy.lens(page, 'projects');
    const select = page.locator('#conductor-filter-select');
    await select.selectOption(value);
    await expect(select).toHaveValue(value);
  },
  async filterBar(page) {
    await legacy.lens(page, 'projects');
    return legacy.ownerBar(page.locator('#conductor-filter'));
  },
  sessionRowActive: (row) => row.evaluate((e) => e.classList.contains('active')),
  sessionRowStyle: (row) => row.evaluate((e) => {
    const cs = getComputedStyle(e);
    return {
      weight: getComputedStyle(e.querySelector('.session-preview')!).fontWeight,
      framed: cs.outlineStyle === 'solid' && cs.outlineWidth === '1px',
      fill: cs.backgroundColor,
    };
  }),

  // Dialogs part 3 (card 2026-0639)
  async openSessionDialog(page, which) {
    const ids: Record<SessionDialog, [string, string]> = {
      summary: ['summarize-session-btn', 'summary-dialog'], stats: ['session-stats-btn', 'stats-dialog'], prune: ['prune-session-btn', 'prune-dialog'],
    };
    const item = page.locator(`#${ids[which][0]}`);
    const dialog = page.locator(`#${ids[which][1]}`);
    // Clicked only while the dialog is closed: a second showModal() throws.
    await expect(async () => {
      if (!(await dialog.isVisible())) {
        if (!(await item.isVisible())) await page.locator('#overflow-toggle').click();
        await item.click({ timeout: 1_000 });
      }
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    return dialog;
  },
  async renameSession(page, answer) {
    const item = page.locator('#rename-session-btn');
    await expect(async () => {
      if (!(await item.isVisible())) await page.locator('#overflow-toggle').click();
      await expect(item).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    // The old UI asks with the browser's prompt(), prefilled with the current title.
    const asked = new Promise<string>((resolve) => {
      page.once('dialog', (d) => {
        const prefill = d.defaultValue();
        void (answer === null ? d.dismiss() : d.accept(answer)).then(() => resolve(prefill));
      });
    });
    await item.click();
    return asked;
  },
  async closeSessionDialog(dialog) {
    await dialog.locator('button[value="close"]').click();
    await expect(dialog).toBeHidden();
  },
  async summaryTiers(dialog) {
    const lens = (sel: string) => dialog.locator(sel).evaluateAll((els) => els.map((e) => e.getAttribute('data-len') ?? ''));
    return { tiers: await lens('.summary-tier-selector button[data-len]'), selected: (await lens('.summary-tier-selector button[data-len].active'))[0] ?? null };
  },
  async pickSummaryTier(dialog, tier) {
    await dialog.locator(`.summary-tier-selector button[data-len="${tier}"]`).click();
  },
  summaryContent: (dialog) => dialog.locator('#summary-content'),
  summaryStale: (dialog) => dialog.locator('#summary-stale-badge'),
  summaryCost: (dialog) => dialog.locator('#summary-cost'),
  summaryGenerate: (dialog) => dialog.locator('#summary-generate-btn'),
  summaryUseAsTitle: (dialog) => dialog.locator('#summary-apply-title-btn'),
  statsTable: (dialog) => dialog.locator('#stats-content table.stats-table'),
  statsNote: (dialog) => dialog.locator('#stats-content p.hint'),
  pruneField(dialog, field) {
    const ids: Record<PruneField, string> = { cut: 'pd-cut', cutLabel: 'pd-cut-label', thinking: 'pd-thinking', minimal: 'pd-minimal' };
    return dialog.locator(`#${ids[field]}`);
  },
  pruneSavingsRows: (dialog) => dialog.locator('#pd-savings table tbody tr'),
  async applyPrune(dialog) {
    await dialog.locator('#pd-apply').click();
  },
  async openNewWorkspace(page) {
    await legacy.lens(page, 'projects');
    const dialog = page.locator('#workspace-dialog');
    const item = page.locator('#new-workspace-btn');
    await expect(async () => {
      if (!(await dialog.isVisible())) {
        if (!(await item.isVisible())) await page.locator('#sidebar-overflow-toggle').click();
        await item.click({ timeout: 1_000 });
      }
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    return dialog;
  },
  async openEditWorkspace(page, name) {
    const header = await legacy.workspaceHeader(page, name);
    const dialog = page.locator('#workspace-dialog');
    await expect(async () => {
      if (!(await dialog.isVisible())) await header.locator('.project-workspace-edit').click({ timeout: 1_000 });
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    return dialog;
  },
  async workspaceHeader(page, name) {
    await legacy.lens(page, 'projects');
    return page.locator('#project-list details.project-workspace > summary')
      .filter({ has: page.locator('.project-workspace-name', { hasText: exactly(name) }) });
  },
  workspaceName: (dialog) => dialog.locator('#gd-name'),
  workspaceMember: (dialog, project) => dialog.locator(`#gd-project-list input[type="checkbox"][value="${project}"]`),
  async saveWorkspace(dialog) {
    await dialog.locator('#gd-save').click();
  },
  async deleteWorkspace(page, dialog, confirm) {
    // The old UI asks with the browser's native confirm().
    const answered = new Promise<void>((resolve) => {
      page.once('dialog', (d) => { void (confirm ? d.accept() : d.dismiss()).then(resolve); });
    });
    await dialog.locator('#gd-delete').click();
    await answered;
  },
  async clickRestart(page) {
    await openOldDrawer(page);
    await page.locator('#restart-server-btn').click();
  },
  restartDialog: (page) => page.locator('#restart-dialog'),
  restartChoice: (dialog, which) => dialog.locator(which === 'resume' ? '#rd-resume' : 'button[value="plain"]'),
  async dismissRestart(page, dialog) {
    // The old dialog has no Cancel button: Escape closes it with no choice.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  },

  // Sidebar C (card 2026-0629)
  async conductorRow(page, sessionId) {
    await legacy.lens(page, 'conductors');
    return page.locator(`#conductor-list [data-key="conductor:${sessionId}"] > .conductor-row`);
  },
  async openInactive(page) {
    await legacy.lens(page, 'conductors');
    const det = page.locator('#conductor-list details.conductor-inactive');
    await expect(det).toBeAttached();
    await expect(async () => {
      if ((await det.getAttribute('open')) === null) await det.locator(':scope > summary').click();
      await expect(det).toHaveAttribute('open', '', { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
  },
  conductorRowStyle: (row) => row.evaluate((e) => {
    const t = e.querySelector('.conductor-title')!;
    const ts = getComputedStyle(t);
    const p = document.createElement('i');
    p.style.color = 'var(--muted)';
    document.body.appendChild(p);
    const muted = getComputedStyle(p).color;
    p.remove();
    const cs = getComputedStyle(e);
    return {
      active: e.classList.contains('active'),
      text: t.textContent ?? '',
      weight: ts.fontWeight,
      italic: ts.fontStyle === 'italic',
      muted: ts.color === muted,
      framed: cs.outlineStyle === 'solid' && cs.outlineWidth === '1px',
      fill: cs.backgroundColor,
    };
  }),
  async conductorChips(page, sessionId) {
    await legacy.lens(page, 'conductors');
    const b = `#conductor-list [data-key="conductor:${sessionId}"]`;
    return page.locator(`${b} .conductor-chip.live, ${b} .conductor-chip.idle`).evaluateAll((es) => {
      const token = (v: string) => {
        const p = document.createElement('i');
        p.style.color = `var(${v})`;
        document.body.appendChild(p);
        const c = getComputedStyle(p).color;
        p.remove();
        return c;
      };
      const t = { foreground: token('--text'), muted: token('--muted') };
      return es.map((c) => {
        const cs = getComputedStyle(c);
        return {
          project: c.textContent ?? '',
          kind: c.classList.contains('live') ? 'live' as const : 'idle' as const,
          dashed: cs.borderTopStyle === 'dashed',
          muted: cs.color === t.muted,
          foreground: cs.color === t.foreground,
        };
      });
    });
  },
  async conductorGeometry(page, sessionId) {
    await legacy.lens(page, 'conductors');
    return page.locator(`#conductor-list [data-key="conductor:${sessionId}"]`).evaluate((e) => {
      const b = e.getBoundingClientRect();
      // Any colour function: an inactive block's faded bar is a color-mix, which is no rgb().
      const m = /([a-z-]+\([^)]*\)) (-?[\d.]+)px 0px 0px 0px inset/.exec(getComputedStyle(e).boxShadow);
      const row = e.querySelector(':scope > .conductor-row')!;
      const caret = row.querySelector('.conductor-caret')!;
      return {
        bar: m?.[1] ?? null,
        barWidth: m ? parseFloat(m[2]) : 0,
        rowLeft: row.getBoundingClientRect().left - b.left,
        contentLeft: caret.getBoundingClientRect().left - b.left,
      };
    });
  },
  async treeWorkerRow(page, conductor, sessionId) {
    await legacy.lens(page, 'conductors');
    const block = page.locator(`#conductor-list [data-key="conductor:${conductor}"]`);
    await expect(async () => {
      if (!/\bopen\b/.test((await block.getAttribute('class')) ?? '')) await block.locator(':scope > .conductor-row .conductor-caret').click();
      await expect(block).toHaveClass(/\bopen\b/, { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    return block.locator(`.conductor-tree .session-row[title^="${sessionId}"]`);
  },
  rowLayout: async (row) => {
    const conductor = await row.evaluate((e) => e.matches('.conductor-row'));
    return measureRow(row, {
      labels: conductor ? [':scope > .conductor-title'] : [':scope > .session-label-col', ':scope > .session-preview'],
      text: '.session-preview',
      fixed: { ago: ':scope > .session-ago', promote: ':scope > .session-promote', close: ':scope > .session-delete' },
    });
  },
  async stripEntry(page, sessionId) {
    await openOldDrawer(page);
    return page.locator(`#sidebar-strip-slot .strip-list > li[data-key="entry:${sessionId}"] > .strip-entry`);
  },
  stripEntryStyle: (entry) => entry.evaluate((e) => {
    const cs = getComputedStyle(e);
    return {
      active: e.classList.contains('active'),
      weight: getComputedStyle(e.querySelector('.strip-title')!).fontWeight,
      framed: cs.outlineStyle === 'solid' && cs.outlineWidth === '1px',
      fill: cs.backgroundColor,
    };
  }),
  rowDot: (row) => row.evaluate((e) => {
    const d = e.querySelector<HTMLElement>('.dot')!;
    return { title: d.title, fill: getComputedStyle(d).backgroundColor };
  }),

  // Settings part 3 (card 2026-0637)
  async expandConventionsBlock(page, scope) {
    const block = page.locator('#settings-conventions details.conventions-block').filter({ has: page.locator('summary', { hasText: exactly(conventionsTitle(scope)) }) });
    if (!(await block.evaluate((d) => (d as HTMLDetailsElement).open))) await block.locator('summary').click();
    await expect(block).toHaveAttribute('open', '');
  },
  conventionList: (page, scope) => page.locator(`#${LEGACY_PREFIX[scope]}-convention-list`),
  conventionRow: (page, scope, slug) => page.locator(`#${LEGACY_PREFIX[scope]}-convention-list li`).filter({ has: page.locator('.or-rule-slug', { hasText: exactly(slug) }) }),
  conventionToggles: (page, scope) => page.locator(`#${LEGACY_PREFIX[scope]}-convention-list input.cc-convention-toggle`),
  conventionForm: (page, scope) => {
    const p = LEGACY_PREFIX[scope];
    return {
      add: page.locator(`#${p}-add-btn`),
      slug: page.locator(`#${p}-add-slug`),
      name: page.locator(`#${p}-add-name`),
      description: page.locator(`#${p}-add-desc`),
      body: page.locator(`#${p}-add-body`),
      save: page.locator(`#${p}-add-save`),
      cancel: page.locator(`#${p}-add-cancel`),
    };
  },
  conductorPickers: (page) => ({ playbook: page.locator('#dp-select'), enforcement: page.locator('#dpe-select'), playbookStatus: page.locator('#dp-status'), enforcementStatus: page.locator('#dpe-status') }),
  async deleteConvention(page, scope, slug) {
    page.once('dialog', (d) => void d.accept());
    await legacy.conventionRow(page, scope, slug).locator('button', { hasText: exactly('Delete') }).click();
  },
  conventionStatus: (page, scope) => page.locator(`#${LEGACY_PREFIX[scope]}-status`),

  // Conversation part 3 (card 2026-0633)
  questionCard: (page) => page.locator('#conversation .block.user-question'),
  // Inactive panes are display:none (UserQuestionBlock._render).
  cardOption: (card, label) => card.locator('.uq-pane').filter({ visible: true }).locator(`button.uq-opt[data-label="${label}"]`),
  cardOptionPicked: (option) => option.evaluate((e) => e.classList.contains('picked')),
  cardField: (card) => card.locator('.uq-pane').filter({ visible: true }).locator('.uq-custom-input'),
  cardSend: (card) => card.locator('.uq-submit'),
  cardStatus: (card) => card.locator('.uq-status'),
  cardTab: (card, i) => card.locator('.uq-tab').nth(i),
  answerBubble: (page) => page.locator('#conversation .msg.user.question-answer'),
  answerRows: (bubble) => bubble.locator('.qa-item').evaluateAll((es) => es.map((e) => ({
    kind: (e as HTMLElement).dataset.kind ?? '',
    choices: [...e.querySelectorAll('.qa-choice')].map((n) => n.textContent ?? ''),
    note: e.querySelector('.qa-note')?.textContent ?? null,
    custom: e.querySelector('.qa-custom')?.textContent ?? null,
  }))),

  // Sidebar B3 (card 2026-0642)
  async closeSidebar(page) {
    if (!drawerViewport()) return;
    const vp = page.viewportSize();
    if (!vp) throw new Error('closeSidebar: the page has no viewport size');
    // The scrim covers the viewport; the 80vw drawer leaves its right edge exposed.
    await expect(async () => {
      if (await page.locator('#sidebar').evaluate((e) => e.classList.contains('open'))) {
        await page.locator('#sidebar-scrim').click({ position: { x: vp.width - 4, y: Math.round(vp.height / 2) }, timeout: 1_000 });
      }
      await expect(page.locator('#sidebar')).not.toHaveClass(/\bopen\b/, { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
  },
  async filterValue(page) {
    await legacy.lens(page, 'projects');
    return page.locator('#conductor-filter-select').inputValue();
  },
  async filterOptions(page) {
    await legacy.lens(page, 'projects');
    return page.locator('#conductor-filter-select option').allTextContents();
  },
  async projectParts(page, project) {
    await legacy.lens(page, 'projects');
    return (await legacy.projectRow(page, project)).locator('xpath=..').evaluate((e) => ({
      sessions: e.querySelector(':scope > details.sessions-group') !== null,
      worktrees: e.querySelector(':scope > details.worktree-group') !== null,
      rows: e.querySelectorAll('.session-row').length,
      hint: e.querySelector(':scope > .empty-project-hint') !== null,
    }));
  },
  async conductedSeparator(page, project, worktree) {
    await legacy.lens(page, 'projects');
    return (await legacy.projectRow(page, project)).locator('xpath=..').locator('.worktree-item')
      .filter({ has: page.locator('.worktree-name', { hasText: exactly(worktree) }) })
      .locator('.sessions-separator')
      .evaluateAll((es) => es.some((e) => e.textContent === '— conducted —'));
  },

  // Settings part 3b (card 2026-0646)
  libraryEntry: (page, name) => page.locator('#pll-list .pll-row').filter({ has: page.locator('.pll-name', { hasText: exactly(name) }) }),
  libraryAction: (entry, label) => entry.locator('button', { hasText: exactly(label) }),
  libraryInstalledAs: (entry) => entry.locator('.pll-installed-as'),
  libraryLive: (entry) => entry.locator('.pll-live'),
  libraryStatus: (page) => page.locator('#pll-status'),
  libraryTail: (page) => page.locator('#pll-tail-pre'),
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
    const label: Record<SettingsSection, string> = { account: 'Account', archived: 'Archived', about: 'About', models: 'Models', backends: 'Backends', systems: 'Systems', conventions: 'Conventions', plugins: 'Plugins' };
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
    if (worktree) await next.openWorktrees(page, project);
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
    const label: Record<SettingsSection, string> = { account: 'Account', archived: 'Archived', about: 'About', models: 'Models', backends: 'Backends', systems: 'Systems', conventions: 'Conventions', plugins: 'Plugins' };
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

  // Sidebar B2 (card 2026-0638)
  async openWorktrees(page, project) {
    await next.lens(page, 'projects');
    const toggle = sidebar(page).locator(`[data-worktrees="${project}"] > button`);
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  },
  async closeWorktrees(page, project) {
    await next.lens(page, 'projects');
    const toggle = sidebar(page).locator(`[data-worktrees="${project}"] > button`);
    if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  },
  async worktreesOpen(page, project) {
    await next.lens(page, 'projects');
    const toggle = sidebar(page).locator(`[data-worktrees="${project}"] > button`);
    return (await toggle.getAttribute('aria-expanded')) === 'true';
  },
  async worktreeHead(page, project, worktree) {
    await next.openWorktrees(page, project);
    return sidebar(page).locator(`[data-project="${project}"] [data-worktree-row="${worktree}"]`);
  },
  ownerBar: (el) => el.evaluate((e) => /(rgba?\([^)]*\)) 3px 0px 0px 0px inset/.exec(getComputedStyle(e).boxShadow)?.[1] ?? null),
  async projectNames(page) {
    await next.lens(page, 'projects');
    return sidebar(page).locator('[data-project-list] [data-project-row]').evaluateAll((es) => es.map((e) => e.getAttribute('data-project-row') ?? ''));
  },
  async filterTo(page, value, label) {
    await next.lens(page, 'projects');
    await sidebar(page).getByRole('combobox', { name: 'Filter by conductor' }).click();
    await page.getByRole('option', { name: label, exact: true }).click();
    await expect(sidebar(page).locator('[data-filter]')).toHaveAttribute('data-filter', value || 'all');
  },
  async filterBar(page) {
    await next.lens(page, 'projects');
    return next.ownerBar(sidebar(page).locator('[data-filter]'));
  },
  sessionRowActive: async (row) => (await row.getAttribute('data-active')) === 'true',
  sessionRowStyle: (row) => row.evaluate((e) => {
    const cs = getComputedStyle(e);
    return {
      weight: getComputedStyle(e.querySelector('span.truncate')!).fontWeight,
      // By geometry, not colour: ring-border is --border, an oklch() Chrome serializes verbatim in box-shadow.
      framed: cs.boxShadow.replace(/\s+/g, ' ').split(', ').some((p) => p.endsWith(' 0px 0px 0px 1px')),
      fill: cs.backgroundColor,
    };
  }),

  // Dialogs part 3 (card 2026-0639)
  async openSessionDialog(page, which) {
    const label: Record<SessionDialog, string> = { summary: 'Summarize session', stats: 'Statistics', prune: 'Prune context…' };
    await next.sessionHeader(page).getByRole('button', { name: 'Session actions' }).click();
    await page.getByRole('menuitem', { name: label[which], exact: true }).click();
    const dialog = page.locator(`[role="dialog"][data-dialog="${which}"]`);
    await expect(dialog).toBeVisible();
    return dialog;
  },
  async renameSession(page, answer) {
    await next.sessionHeader(page).getByRole('button', { name: 'Session actions' }).click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const dialog = page.locator('[role="dialog"][data-dialog="rename"]');
    await expect(dialog).toBeVisible();
    const input = dialog.locator('#rename-title');
    const prefill = await input.inputValue();
    if (answer === null) await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    else {
      await input.fill(answer);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    }
    await expect(dialog).toBeHidden();
    return prefill;
  },
  // The footer's Close comes before the corner ×; either closes.
  async closeSessionDialog(dialog) {
    await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(dialog).toBeHidden();
  },
  async summaryTiers(dialog) {
    const lens = (sel: string) => dialog.locator(sel).evaluateAll((els) => els.map((e) => e.getAttribute('data-len') ?? ''));
    return { tiers: await lens('[data-len]'), selected: (await lens('[data-len][aria-pressed="true"]'))[0] ?? null };
  },
  async pickSummaryTier(dialog, tier) {
    await dialog.locator(`[data-len="${tier}"]`).click();
  },
  summaryContent: (dialog) => dialog.locator('[data-summary-content]'),
  summaryStale: (dialog) => dialog.locator('[data-stale]'),
  summaryCost: (dialog) => dialog.locator('[data-cost]'),
  summaryGenerate: (dialog) => dialog.getByRole('button', { name: /^(Generate summary|Regenerate|Generating…)$/ }),
  summaryUseAsTitle: (dialog) => dialog.getByRole('button', { name: /^(Use as session title|Applied)$/ }),
  statsTable: (dialog) => dialog.locator('[data-stats-table]'),
  statsNote: (dialog) => dialog.locator('p').filter({ hasText: /^No worker sessions/ }),
  pruneField(dialog, field) {
    return dialog.locator(field === 'cutLabel' ? '[data-cut-label]' : `#pd-${field}`);
  },
  pruneSavingsRows: (dialog) => dialog.locator('[data-savings] tr'),
  async applyPrune(dialog) {
    await dialog.getByRole('button', { name: 'Prune', exact: true }).click();
  },
  async openNewWorkspace(page) {
    await next.lens(page, 'projects');
    await sidebar(page).getByRole('button', { name: 'Project actions' }).click();
    await page.getByRole('menuitem', { name: 'New workspace', exact: true }).click();
    const dialog = page.locator('[role="dialog"][data-dialog="workspace"]');
    await expect(dialog).toBeVisible();
    return dialog;
  },
  async openEditWorkspace(page, name) {
    const header = await next.workspaceHeader(page, name);
    await header.hover();
    await header.getByRole('button', { name: `Edit workspace ${name}`, exact: true }).click();
    const dialog = page.locator('[role="dialog"][data-dialog="workspace"]');
    await expect(dialog).toBeVisible();
    return dialog;
  },
  async workspaceHeader(page, name) {
    await next.lens(page, 'projects');
    return sidebar(page).locator(`section[data-workspace="${name}"]`);
  },
  workspaceName: (dialog) => dialog.locator('#gd-name'),
  workspaceMember: (dialog, project) => dialog.locator(`button[role="checkbox"][data-project="${project}"]`),
  async saveWorkspace(dialog) {
    await dialog.locator('button[type="submit"]').click();
  },
  async deleteWorkspace(page, dialog, confirm) {
    await dialog.getByRole('button', { name: 'Delete workspace', exact: true }).click();
    const ask = page.getByRole('dialog', { name: /^Delete workspace .+\?$/ });
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: confirm ? 'Delete workspace' : 'Cancel', exact: true }).click();
    await expect(ask).toBeHidden();
  },
  async clickRestart(page) {
    await next.openSidebar(page);
    await sidebar(page).locator('[data-restart]').click();
  },
  restartDialog: (page) => page.locator('[role="dialog"][data-restart-dialog]'),
  restartChoice: (dialog, which) => dialog.getByRole('button', { name: which === 'resume' ? 'Restart & resume' : 'Restart only', exact: true }),
  async dismissRestart(_page, dialog) {
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
  },

  // Sidebar C (card 2026-0629)
  async conductorRow(page, sessionId) {
    await next.lens(page, 'conductors');
    return sidebar(page).locator(`[data-conductor="${sessionId}"] > [role="button"]`);
  },
  async openInactive(page) {
    await next.lens(page, 'conductors');
    const t = sidebar(page).getByRole('button', { name: /^Inactive \(\d+\)$/ });
    await expect(t).toBeVisible();
    if ((await t.getAttribute('aria-expanded')) !== 'true') await t.click();
    await expect(t).toHaveAttribute('aria-expanded', 'true');
  },
  conductorRowStyle: (row) => row.evaluate((e) => {
    const t = e.querySelector<HTMLElement>('span.truncate')!;
    const ts = getComputedStyle(t);
    const p = document.createElement('span');
    p.className = 'text-muted-foreground';
    e.appendChild(p);
    const muted = getComputedStyle(p).color;
    p.remove();
    const cs = getComputedStyle(e);
    return {
      active: e.getAttribute('data-active') === 'true',
      text: t.textContent ?? '',
      weight: ts.fontWeight,
      italic: ts.fontStyle === 'italic',
      muted: ts.color === muted,
      // By geometry, not colour: ring-border is --border, an oklch() Chrome serializes verbatim in box-shadow.
      framed: cs.boxShadow.replace(/\s+/g, ' ').split(', ').some((x) => x.endsWith(' 0px 0px 0px 1px')),
      fill: cs.backgroundColor,
    };
  }),
  async conductorChips(page, sessionId) {
    await next.lens(page, 'conductors');
    return sidebar(page).locator(`[data-conductor="${sessionId}"] [data-chip]`).evaluateAll((es) => es.map((c) => {
      // Probes in the chip's own subtree, so the sidebar's variables resolve as they do for the chip.
      const token = (cls: string) => {
        const p = document.createElement('span');
        p.className = cls;
        c.parentElement!.appendChild(p);
        const v = getComputedStyle(p).color;
        p.remove();
        return v;
      };
      const t = { foreground: token('text-foreground'), muted: token('text-muted-foreground') };
      const cs = getComputedStyle(c);
      return {
        project: c.textContent ?? '',
        kind: c.getAttribute('data-chip') as 'live' | 'idle',
        dashed: cs.borderTopStyle === 'dashed',
        muted: cs.color === t.muted,
        foreground: cs.color === t.foreground,
      };
    }));
  },
  async conductorGeometry(page, sessionId) {
    await next.lens(page, 'conductors');
    return sidebar(page).locator(`[data-conductor="${sessionId}"]`).evaluate((e) => {
      const b = e.getBoundingClientRect();
      const bar = e.firstElementChild as HTMLElement;
      const row = e.querySelector(':scope > [role="button"]')!;
      const caret = row.querySelector('button[aria-label="Show workers"]')!;
      return {
        bar: getComputedStyle(bar).backgroundColor,
        barWidth: bar.getBoundingClientRect().width,
        rowLeft: row.getBoundingClientRect().left - b.left,
        contentLeft: caret.getBoundingClientRect().left - b.left,
      };
    });
  },
  async treeWorkerRow(page, conductor, sessionId) {
    await next.lens(page, 'conductors');
    const caret = sidebar(page).locator(`[data-conductor="${conductor}"] > [role="button"] button[aria-label="Show workers"]`);
    if ((await caret.getAttribute('aria-expanded')) !== 'true') await caret.click();
    await expect(caret).toHaveAttribute('aria-expanded', 'true');
    return sidebar(page).locator(`[data-conductor="${conductor}"] [data-session-row="${sessionId}"] > [role="button"]`);
  },
  rowLayout: async (row) => {
    const conductor = await row.evaluate((e) => !!e.parentElement?.hasAttribute('data-conductor'));
    return measureRow(row, {
      labels: [conductor ? ':scope > span.truncate' : ':scope > span.flex-col'],
      text: 'span.truncate',
      fixed: {
        ago: ':scope > [data-ago]',
        promote: ':scope > button[aria-label="Make persistent"]',
        close: ':scope > button[aria-label="Stop session"], :scope > button[aria-label="Archive session (keeps history)"]',
      },
    });
  },
  async stripEntry(page, sessionId) {
    await next.openSidebar(page);
    return sidebar(page).locator(`[data-strip-entry="${sessionId}"] > button`);
  },
  stripEntryStyle: (entry) => entry.evaluate((e) => {
    const cs = getComputedStyle(e);
    return {
      active: e.getAttribute('data-active') === 'true',
      // The label is the first span.truncate; the resume badge comes after it.
      weight: getComputedStyle(e.querySelector('span.truncate')!).fontWeight,
      framed: cs.boxShadow.replace(/\s+/g, ' ').split(', ').some((x) => x.endsWith(' 0px 0px 0px 1px')),
      fill: cs.backgroundColor,
    };
  }),
  rowDot: (row) => row.evaluate((e) => {
    const d = e.querySelector<HTMLElement>('[data-dot]')!;
    return { title: d.title, fill: getComputedStyle(d).backgroundColor };
  }),

  // Settings part 3 (card 2026-0637)
  async expandConventionsBlock(page, scope) {
    const trigger = page.locator('[data-section="conventions"]').getByRole('button', { name: conventionsTitle(scope), exact: true });
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(next.conventionList(page, scope)).toBeVisible();
  },
  conventionList: (page, scope) => page.locator(`[data-testid="conventions-${scope}"]`),
  conventionRow: (page, scope, slug) => page.locator(`[data-testid="conventions-${scope}"] li[data-slug="${slug}"]`),
  conventionToggles: (page, scope) => page.locator(`[data-testid="conventions-${scope}"] [role="switch"]`),
  conventionForm: (page, scope) => {
    const block = page.locator('[data-slot="collapsible"]').filter({ has: page.getByRole('button', { name: conventionsTitle(scope), exact: true }) });
    const slug = page.locator(`[id="${conventionsBase(scope)}-slug"]`);
    const form = page.locator('form').filter({ has: slug });
    return {
      add: block.getByRole('button', { name: 'Add custom convention', exact: true }),
      slug,
      name: page.locator(`[id="${conventionsBase(scope)}-name"]`),
      description: page.locator(`[id="${conventionsBase(scope)}-desc"]`),
      body: page.locator(`[id="${conventionsBase(scope)}-body"]`),
      save: form.locator('button[type="submit"]'),
      cancel: form.getByRole('button', { name: 'Cancel', exact: true }),
    };
  },
  conductorPickers: (page) => ({
    playbook: page.locator('#dp-select'),
    enforcement: page.locator('#dpe-select'),
    playbookStatus: page.locator('div:has(> label[for="dp-select"]) [role="status"]'),
    enforcementStatus: page.locator('div:has(> label[for="dpe-select"]) [role="status"]'),
  }),
  async deleteConvention(page, scope, slug) {
    await next.conventionRow(page, scope, slug).getByRole('button', { name: /^Delete / }).click();
    const dialog = page.getByRole('dialog', { name: `Delete ${scope} convention “${slug}”?` });
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(dialog).toBeHidden();
  },
  // The list's own status line is a direct child of the panel; the conductor pickers' status lines sit deeper.
  conventionStatus: (page, scope) => next.conventionList(page, scope).locator('xpath=../div[@role="status"]'),

  // Conversation part 3 (card 2026-0633)
  questionCard: (page) => page.locator('[data-item=question]'),
  cardOption: (card, label) => card.locator(`[data-option="${label}"]`),
  cardOptionPicked: async (option) => (await option.getAttribute('aria-pressed')) === 'true',
  cardField: (card) => card.locator('input'),
  cardSend: (card) => card.getByRole('button', { name: /^Send (all )?answers?$/ }),
  cardStatus: (card) => card.locator('[data-status]'),
  cardTab: (card, i) => card.locator(`[data-tab="${i}"]`),
  answerBubble: (page) => page.locator('[data-item=user][data-variant=answer]'),
  answerRows: (bubble) => bubble.locator('[data-kind]').evaluateAll((es) => es.map((e) => ({
    kind: (e as HTMLElement).dataset.kind ?? '',
    choices: [...e.querySelectorAll('[data-choice]')].map((n) => n.textContent ?? ''),
    note: e.querySelector('[data-note]')?.textContent ?? null,
    custom: e.querySelector('[data-custom]')?.textContent ?? null,
  }))),

  // Sidebar B3 (card 2026-0642)
  async closeSidebar(page) {
    if (!drawerViewport()) return;
    if (await sidebar(page).count()) await page.keyboard.press('Escape');
    await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0);
  },
  async filterValue(page) {
    await next.lens(page, 'projects');
    const v = await sidebar(page).locator('[data-filter]').getAttribute('data-filter');
    return v === 'all' ? '' : (v ?? '');
  },
  async filterOptions(page) {
    await next.lens(page, 'projects');
    const trigger = sidebar(page).getByRole('combobox', { name: 'Filter by conductor' });
    await trigger.click();
    await expect(page.getByRole('listbox')).toBeVisible();
    const labels = await page.getByRole('option').allTextContents();
    // Escape closes the topmost layer only: the menu, never the phone drawer under it.
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    return labels;
  },
  async projectParts(page, project) {
    await next.lens(page, 'projects');
    return sidebar(page).locator(`li[data-project="${project}"]`).evaluate((e, p) => ({
      sessions: e.querySelector(`[data-sessions="${p}"]`) !== null,
      worktrees: e.querySelector(`[data-worktrees="${p}"]`) !== null,
      rows: e.querySelectorAll('[data-session-row]').length,
      hint: (e.textContent ?? '').includes('No sessions yet'),
    }), project);
  },
  async conductedSeparator(page, project, worktree) {
    await next.lens(page, 'projects');
    return sidebar(page).locator(`ul[data-sessions="${project}:${worktree}"] > li:not([data-session-row])`)
      .evaluateAll((es) => es.some((e) => e.textContent === 'Conducted'));
  },

  // Settings part 3b (card 2026-0646)
  libraryEntry: (page, name) => page.locator('[data-testid="library-list"] [data-entry]').filter({ has: page.getByText(name, { exact: true }) }),
  libraryAction: (entry, label) => entry.getByRole('button', { name: label, exact: true }),
  libraryInstalledAs: (entry) => entry.getByText(/^installed as /),
  libraryLive: (entry) => entry.locator('pre'),
  // The library's own status line is a direct child of its card content, beside the list.
  libraryStatus: (page) => page.locator('[data-testid="library-list"]').locator('xpath=../div[@role="status"]'),
  libraryTail: (page) => page.locator('details').filter({ has: page.locator('summary', { hasText: 'Install output' }) }).locator('pre'),
};

// Sidebar B (card 2026-0628)
/** The web UI's sidebar, for /next/-only specs. */
export const nextSidebar = sidebar;

export const UIS: Record<UiName, Ui> = { legacy, next };
