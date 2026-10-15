// The plugin host in a real browser, with the keep-alive probe plugin:
// picking a plugin while a session is open lands on the first pick; the hash
// opens, steers and swaps plugin pages without reloading them; a keep-alive
// page keeps running while hidden and comes back as the same page load, while a
// plain one reloads; a plugin page follows the host's light/dark theme. A
// reload makes a new nonce, so every "same page" check fails on one. The bodies are shared by the per-project spec files; this
// module declares no tests.
import type { Locator, Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { spawnSession } from './harness/api.ts';
import { installProbePlugin, probeFrame, readProbe, readTheme, type FrameTheme, type Probe, type ProbePlugin } from './harness/pluginProbe.ts';
import { next } from './flows/ui.ts';

type Args = { page: Page; cc: Cc };

const KEEP: ProbePlugin = { id: 'keepalive-plugin', name: 'Keep-alive probe', keepAlive: true };
const PLAIN: ProbePlugin = { id: 'keepalive-control', name: 'Keep-alive control', keepAlive: false };

/** Installs both probe plugins on this spec's cc. */
export async function installProbes(cc: Cc): Promise<void> {
  for (const p of [KEEP, PLAIN]) await installProbePlugin(cc, p);
}

const pluginView = (page: Page) => page.locator('[data-view="plugin"]');
const setHash = (page: Page, hash: string) => page.evaluate((h) => { location.hash = h; }, hash);
/** The path the plugin's page is at, as its bridge left it; null while no frame serves it. */
const framePath = (page: Page, id: string) => {
  const f = probeFrame(page, id);
  return f ? new URL(f.url()).pathname : null;
};

/** Waits until plugin `id`'s page answers, and returns its counters. */
async function loaded(page: Page, id: string, what: string): Promise<Probe> {
  await expect.poll(async () => (await readProbe(page, id).catch(() => null))?.nonce ?? null, { message: `${what}: ${id}'s page loaded`, timeout: 20_000 }).not.toBeNull();
  return (await readProbe(page, id))!;
}

/** Opens the app switcher, runs `read` on its menu, and closes it again. */
async function withSwitcher<T>(page: Page, read: (menu: Locator) => Promise<T>): Promise<T> {
  await next.openSidebar(page);
  await page.getByRole('button', { name: 'Switch app' }).filter({ visible: true }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const out = await read(menu);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  return out;
}
/** The ids of the switcher's checked entries; Conductor's is 'conductor'. */
const currentApp = (page: Page) => withSwitcher(page, (menu) => menu.getByRole('menuitemradio', { checked: true })
  .evaluateAll((els) => els.map((e) => e.getAttribute('data-app-id') ?? 'conductor')));
/** Plugin `id`'s entry as the switcher names it. */
const entryName = (page: Page, id: string) => withSwitcher(page, async (menu) => (await menu.locator(`[data-app-id="${id}"]`).textContent()) ?? '');

/** The view is hidden and takes no space, and the keep-alive page in it keeps running: polled, not slept. */
async function hiddenAndRunning(page: Page, where: string): Promise<void> {
  await expect(pluginView(page), `${where}: the plugin view is hidden`).toBeHidden();
  expect(await pluginView(page).boundingBox(), `${where}: and takes no space`).toBeNull();
  const a = (await readProbe(page, KEEP.id))!;
  expect(a?.mic, `${where}: fixture check: its microphone was started`).toBeTruthy();
  await expect.poll(async () => {
    const b = await readProbe(page, KEEP.id);
    return !!b?.mic && b.nonce === a.nonce && b.ticks - a.ticks >= 10 && b.ws - a.ws >= 4
      && b.mic.rmsNonZero > a.mic!.rmsNonZero && b.mic.currentTime - a.mic!.currentTime >= 1;
  }, { message: `${where}: the hidden page's timers, socket and microphone run on`, timeout: 15_000 }).toBe(true);
  const b = (await readProbe(page, KEEP.id))!;
  expect(b.nonce, `${where}: the same page`).toBe(a.nonce);
  expect(b.mic?.readyState, `${where}: the microphone track`).toBe('live');
  expect(b.mic?.ctxState, `${where}: the audio context`).toBe('running');
  await expect(pluginView(page), `${where}: still hidden`).toBeHidden();
}

// ── switching to a plugin ────────────────────────────────────────────────

export async function switchFlow({ page, cc }: Args): Promise<void> {
  // Invariant: picking a plugin from the switcher while a session is open lands on it on the first pick — the URL, the view, the page and the switcher's current entry — and Conductor leads back to that session's anchor.
  const project = `plugin-switch-${test.info().project.name}`;
  const { sessionId } = await spawnSession(cc, project);
  await next.open(page);
  const row = await next.sessionRow(page, project, sessionId);
  await expect.poll(() => next.sessionRowLive(row), { message: 'fixture check: the session is live', timeout: 15_000 }).toBe(true);
  await row.click();
  await expect(page, 'precondition: the session is open').toHaveURL(new RegExp(`#session=${sessionId}$`));

  await next.openPlugin(page, PLAIN.id);
  await loaded(page, PLAIN.id, 'the first pick');
  await expect(page, 'still on the plugin once its page loaded').toHaveURL(new RegExp(`#plugin/${PLAIN.id}/$`));
  await expect(pluginView(page)).toBeVisible();
  expect(await currentApp(page), 'the switcher shows the plugin as current').toEqual([PLAIN.id]);

  await next.leavePlugin(page);
  await expect(page).toHaveURL(new RegExp(`#session=${sessionId}$`));
  await expect(pluginView(page)).toBeHidden();
  expect(await currentApp(page), 'and Conductor once back').toEqual(['conductor']);
}

// ── plugin subpaths ──────────────────────────────────────────────────────

export async function subpathFlow({ page }: Args): Promise<void> {
  // Invariant: a plugin hash opens its plugin; an outside subpath change steers the open page there without a reload, also back to a subpath after the page moved itself; another plugin swaps in; a boot on a plugin hash opens it at its subpath.
  const id = PLAIN.id;
  await next.open(page);
  await setHash(page, `#plugin/${id}/`);
  await expect(pluginView(page)).toBeVisible();
  const first = await loaded(page, id, 'opened on its hash');
  expect(framePath(page, id)).toBe(`/plugins/${id}/`);

  await setHash(page, `#plugin/${id}/sub/a`);
  await expect.poll(() => framePath(page, id), { message: 'steered to the subpath' }).toBe(`/plugins/${id}/sub/a`);
  expect((await readProbe(page, id))?.nonce, 'the same page: no reload').toBe(first.nonce);

  await probeFrame(page, id)!.evaluate((p) => history.pushState(null, '', p), `/plugins/${id}/inner`);
  await expect(page, 'precondition: the page\'s own route mirrors into the URL').toHaveURL(new RegExp(`#plugin/${id}/inner$`));
  await setHash(page, `#plugin/${id}/sub/a`);
  await expect.poll(() => framePath(page, id), { message: 'steered back after the page moved itself' }).toBe(`/plugins/${id}/sub/a`);
  expect((await readProbe(page, id))?.nonce, 'still the same page').toBe(first.nonce);

  await next.openPlugin(page, KEEP.id);
  await loaded(page, KEEP.id, 'swapped in');
  expect(probeFrame(page, id), 'the plain plugin\'s page ended').toBeUndefined();

  await page.goto('about:blank');
  await page.goto(`/#plugin/${id}/deep/x`);
  await expect(pluginView(page)).toBeVisible();
  await loaded(page, id, 'booted on its hash');
  expect(framePath(page, id)).toBe(`/plugins/${id}/deep/x`);
}

// ── keep-alive plugins ───────────────────────────────────────────────────

export async function keepAliveFlow({ page }: Args): Promise<void> {
  // Invariant: a keep-alive plugin's page keeps running while hidden behind Settings and behind Conductor — timers, its WebSocket, a live microphone — and each return shows that same page load; the switcher marks it while resident. A plain plugin's page reloads on the same round trip.
  await next.open(page);
  const unmarked = await entryName(page, KEEP.id);
  await next.openPlugin(page, KEEP.id);
  const first = await loaded(page, KEEP.id, 'entered');
  await probeFrame(page, KEEP.id)!.click('#start');
  await expect.poll(async () => {
    const p = await readProbe(page, KEEP.id);
    return !!p?.mic && p.mic.polls > 2 && p.mic.rmsNonZero > 0;
  }, { message: 'fixture check: the microphone runs', timeout: 20_000 }).toBe(true);

  await next.openSettings(page);
  await hiddenAndRunning(page, 'behind Settings');
  await next.leaveSettings(page);
  await expect(pluginView(page)).toBeVisible();
  expect((await readProbe(page, KEEP.id))?.nonce, 'back from Settings: the same page').toBe(first.nonce);

  await next.leavePlugin(page);
  await hiddenAndRunning(page, 'behind Conductor');
  expect(await entryName(page, KEEP.id), 'the switcher marks it while resident').not.toBe(unmarked);
  const left = (await readProbe(page, KEEP.id))!;
  await next.openPlugin(page, KEEP.id);
  await expect(pluginView(page)).toBeVisible();
  const back = (await readProbe(page, KEEP.id))!;
  expect(back.nonce, 'back from Conductor: the same page').toBe(first.nonce);
  expect(back.ticks, 'its counters ran on').toBeGreaterThanOrEqual(left.ticks);
  expect(back.mic?.readyState).toBe('live');

  // Positive control: the same round trip reloads a plain plugin's page.
  await next.openPlugin(page, PLAIN.id);
  const plain = await loaded(page, PLAIN.id, 'the plain plugin');
  await next.openSettings(page);
  await expect(pluginView(page)).toBeHidden();
  expect(probeFrame(page, PLAIN.id), 'a plain plugin\'s page ends once hidden').toBeUndefined();
  await next.leaveSettings(page);
  const reloaded = await loaded(page, PLAIN.id, 'back from Settings');
  expect(reloaded.nonce, 'a new page load').not.toBe(plain.nonce);
}

// ── theme ────────────────────────────────────────────────────────────────

const THEME_KEY = 'code-conductor:theme';
const hostBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const hostDark = (page: Page) => page.evaluate(() => document.documentElement.classList.contains('dark'));
/** Plugin `id`'s page theme once it answers. */
const theme = async (page: Page, id: string): Promise<FrameTheme> => {
  await expect.poll(() => readTheme(page, id).catch(() => null), { message: `${id}'s page answers` }).not.toBeNull();
  return (await readTheme(page, id))!;
};
/** Polls until plugin `id`'s page shows `want`, via both `.dark` and `data-cc-theme`. */
const follows = (page: Page, id: string, want: 'light' | 'dark', what: string) => expect.poll(async () => {
  const t = await readTheme(page, id).catch(() => null);
  return t && `${t.dark ? 'dark' : 'light'}/${t.attr}`;
}, { message: `${what}: ${id}'s page is ${want}` }).toBe(`${want}/${want}`);
/** The sidebar's theme toggle, by the theme it switches to. */
async function toggleTheme(page: Page, to: 'Light theme' | 'Dark theme'): Promise<void> {
  await next.openSidebar(page);
  await page.getByRole('button', { name: to }).filter({ visible: true }).first().click();
}

export async function themeFlow({ page }: Args): Promise<void> {
  // Invariant: a plugin page shows the host's resolved theme before its body is parsed, follows every host change live (an OS flip under "system", the sidebar toggle) including while hidden, and the host-served sheet gives it the host's own background and Geist face.
  await page.emulateMedia({ colorScheme: 'light' });
  await next.open(page);
  await page.evaluate((k) => localStorage.removeItem(k), THEME_KEY);
  await setHash(page, `#plugin/${PLAIN.id}/`);
  await loaded(page, PLAIN.id, 'opened');
  const light = await theme(page, PLAIN.id);
  expect(await hostDark(page), 'precondition: the host is light').toBe(false);
  expect(light.atParse, 'light when its head was parsed').toBe('light');
  expect(light.dark).toBe(false);
  expect(light.attr).toBe('light');
  expect(light.bg, "the host's light background").toBe(await hostBg(page));

  await page.emulateMedia({ colorScheme: 'dark' });
  await follows(page, PLAIN.id, 'dark', 'the OS went dark under "system"');
  expect(await hostDark(page), 'precondition: the host is dark').toBe(true);
  const dark = await theme(page, PLAIN.id);
  expect(dark.bg, "the host's dark background").toBe(await hostBg(page));
  expect(dark.bg, 'fixture check: the two backgrounds differ').not.toBe(light.bg);
  expect(dark.geist, 'the host-served Geist face loads').toBe(true);

  await toggleTheme(page, 'Light theme');
  await follows(page, PLAIN.id, 'light', 'the sidebar toggle');
  expect(await hostDark(page)).toBe(false);

  // A stored dark choice under a light OS: only the host's choice can make the page dark at parse.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate((k) => localStorage.setItem(k, 'dark'), THEME_KEY);
  await page.goto('about:blank');
  await page.goto(`/#plugin/${PLAIN.id}/`);
  await loaded(page, PLAIN.id, 'booted on its hash');
  const booted = await theme(page, PLAIN.id);
  expect(booted.atParse, 'dark when its head was parsed').toBe('dark');
  expect(booted.dark).toBe(true);

  await next.openPlugin(page, KEEP.id);
  await loaded(page, KEEP.id, 'the keep-alive plugin');
  await follows(page, KEEP.id, 'dark', 'shown');
  await next.openSettings(page);
  await expect(pluginView(page), 'precondition: hidden behind Settings').toBeHidden();
  expect(probeFrame(page, KEEP.id), 'precondition: its page is resident').toBeDefined();
  await toggleTheme(page, 'Light theme');
  await follows(page, KEEP.id, 'light', 'hidden behind Settings');
  await expect(pluginView(page), 'still hidden').toBeHidden();
}
