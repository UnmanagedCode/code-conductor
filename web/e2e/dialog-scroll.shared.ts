// A dialog with a long scrolling list scrolls only that list. Radix renders a
// hidden absolutely positioned <input> beside each Checkbox inside a <form>; a
// fixed dialog captures any such input its list does not hold, so the dialog
// grows a scrollbar of its own. These flows measure that on Edit conventions
// (also on a short viewport), New project and the workspace dialog. The bodies
// are shared by the per-project spec files; this module declares no tests.
import type { Locator, Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { createProject } from './harness/api.ts';
import { next } from './flows/ui.ts';

type Args = { page: Page; cc: Cc };
const EPS = 1;
const SHORT_HEIGHT = 400;
/** DialogContent's `max-h-[calc(100dvh-2rem)]`: one rem of margin above and below. */
const DIALOG_MARGIN = 32;
const SEEDED = 30;
const PLUGINS = ['alpha-plugin', 'beta-plugin', 'gamma-plugin'];

const tag = () => `ds-${test.info().project.name}`;

/** Serves the project-convention catalog page-locally with synthetic plugin conventions appended, so the list is several times taller than its cap. */
async function routeLongCatalog(page: Page): Promise<void> {
  await page.route('**/api/settings/conventions/project', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const extra = Array.from({ length: SEEDED }, (_, n) => {
      const plugin = PLUGINS[n % PLUGINS.length];
      return {
        slug: `${plugin}/c${n}`, name: `Synthetic convention ${n}`, plugin, builtin: false,
        description: 'A description of several words that wraps onto a second line in a narrow dialog.',
      };
    });
    await route.fulfill({ response: res, json: { ...body, conventions: [...(body.conventions ?? []), ...extra] } });
  });
}

type Measure = {
  dialogOver: number; listOver: number; dialogHeight: number; innerHeight: number;
  inputs: number; inputsHeldByList: number;
  headerInView: boolean; footerInView: boolean; headerInDialog: boolean; footerInDialog: boolean;
  cancelHit: boolean; primaryHit: boolean;
  dialogTopAfter: number; headerMoved: number; lastRowInList: boolean;
};

/** Runs in the page: the dialog's and the list's overflow, where the hidden inputs are held, what is on screen and hit-testable, then scrolls the list to its end and reads what moved. */
function measure(a: { dialog: string; list: string | null; primary: string | null }): Measure {
  const dialog = document.querySelector(a.dialog) as HTMLElement;
  // The convention checklist carries no hook: its list is the parent of its first fieldset.
  const list = (a.list === null ? dialog.querySelector('fieldset')!.parentElement : dialog.querySelector(a.list)) as HTMLElement;
  const header = dialog.querySelector('[data-slot="dialog-header"]') as HTMLElement;
  const footer = dialog.querySelector('[data-slot="dialog-footer"]') as HTMLElement | null;
  const inside = (inner: DOMRect, outer: DOMRect) => inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
  const view = new DOMRect(0, 0, innerWidth, innerHeight);
  const inputs = [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"][aria-hidden="true"]')];
  const hit = (name: string) => {
    const b = [...dialog.querySelectorAll('button')].find((x) => x.textContent?.trim() === name);
    if (!b) return false;
    const r = b.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!at && b.contains(at);
  };
  const out: Measure = {
    dialogOver: dialog.scrollHeight - dialog.clientHeight,
    listOver: list.scrollHeight - list.clientHeight,
    dialogHeight: dialog.offsetHeight,
    innerHeight,
    inputs: inputs.length,
    inputsHeldByList: inputs.filter((i) => i.offsetParent === list).length,
    headerInView: inside(header.getBoundingClientRect(), view),
    footerInView: !footer || inside(footer.getBoundingClientRect(), view),
    headerInDialog: inside(header.getBoundingClientRect(), dialog.getBoundingClientRect()),
    footerInDialog: !footer || inside(footer.getBoundingClientRect(), dialog.getBoundingClientRect()),
    cancelHit: hit('Cancel'),
    primaryHit: a.primary === null ? true : hit(a.primary),
    dialogTopAfter: 0, headerMoved: 0, lastRowInList: false,
  };
  const headerTop = header.getBoundingClientRect().top;
  list.scrollTop = list.scrollHeight;
  out.dialogTopAfter = dialog.scrollTop;
  out.headerMoved = Math.abs(header.getBoundingClientRect().top - headerTop);
  const last = [...list.querySelectorAll('button[role="checkbox"]')].pop();
  out.lastRowInList = !!last && inside(last.getBoundingClientRect(), list.getBoundingClientRect());
  list.scrollTop = 0;
  return out;
}

/** Fails with every broken property named, so one run shows the whole defect. */
function violations(at: string, m: Measure, primary: string | null, chrome: boolean): string[] {
  const v: string[] = [];
  if (m.dialogOver > EPS) v.push(`${at}: the dialog scrolls by ${m.dialogOver}px`);
  if (m.inputsHeldByList !== m.inputs) v.push(`${at}: ${m.inputs - m.inputsHeldByList} of ${m.inputs} hidden inputs have a containing block other than the list`);
  if (!chrome) return v;
  if (!m.headerInView || !m.headerInDialog) v.push(`${at}: the header is out of view`);
  if (!m.footerInView || !m.footerInDialog) v.push(`${at}: the footer is out of view`);
  if (!m.cancelHit) v.push(`${at}: Cancel is not hit at its centre`);
  if (!m.primaryHit) v.push(`${at}: ${primary} is not hit at its centre`);
  if (m.dialogTopAfter !== 0) v.push(`${at}: scrolling the list scrolled the dialog to ${m.dialogTopAfter}px`);
  if (m.headerMoved > 0.5) v.push(`${at}: scrolling the list moved the header by ${m.headerMoved}px`);
  if (!m.lastRowInList) v.push(`${at}: the last row is not inside the list at the list's end`);
  return v;
}

async function closeWith(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
}

async function settled(page: Page): Promise<void> {
  // The dialog's zoom-in animation scales its boxes: measure once it has finished.
  await page.evaluate(() => document.fonts.ready.then(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).map((a) => a.finished.catch(() => undefined)))).then(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))));
}

/** Measures `dialogSel`, whose list is `listSel` (null: the convention checklist), with every violation named. */
async function measured(page: Page, at: string, dialogSel: string, listSel: string | null, primary: string | null, chrome = false): Promise<{ found: string[]; dialogHeight: number }> {
  await settled(page);
  const m = await page.evaluate(measure, { dialog: dialogSel, list: listSel, primary });
  // Positive control: the list really overflows its cap and holds hidden inputs, so the checks below can fail.
  expect(m.listOver, `${at}: the list overflows`).toBeGreaterThan(0);
  expect(m.inputs, `${at}: the dialog holds hidden inputs`).toBeGreaterThan(0);
  return { found: violations(at, m, primary, chrome), dialogHeight: m.dialogHeight };
}

async function attachShot(page: Page, name: string): Promise<void> {
  const shot = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path: shot });
  await test.info().attach(name, { path: shot, contentType: 'image/png' });
}

export async function editConventionsFlow({ page, cc }: Args): Promise<void> {
  const project = `${tag()}-edit`;
  await createProject(cc, project);
  await routeLongCatalog(page);
  await next.open(page);
  const own = page.viewportSize()!;
  const found: string[] = [];
  for (const vp of [own, { width: own.width, height: SHORT_HEIGHT }]) {
    await page.setViewportSize(vp);
    const at = `edit conventions @ ${vp.width}x${vp.height}`;
    const dialog = await next.openEditConventions(page, project);
    await expect(dialog.locator(`[data-convention="${PLUGINS[0]}/c0"]`)).toBeAttached();
    // Save stays disabled, and so unreachable by a pointer, until the selection changes.
    await dialog.locator('[data-convention]').first().click();
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    const r = await measured(page, at, '[data-dialog="edit-conventions"]', null, 'Save', true);
    found.push(...r.found);
    if (vp.height === SHORT_HEIGHT) {
      // Positive control: the dialog sits at its max height, so the list shrank rather than the dialog overflowing.
      const height = r.dialogHeight;
      if (Math.abs(height - (SHORT_HEIGHT - DIALOG_MARGIN)) > EPS) found.push(`${at}: the dialog is ${height}px tall, not ${SHORT_HEIGHT - DIALOG_MARGIN}px`);
      await attachShot(page, 'edit-conventions-short');
    }
    await closeWith(dialog);
  }
  expect(found, `${found.length} violation(s)`).toEqual([]);
}

export async function newProjectFlow({ page }: Args): Promise<void> {
  await routeLongCatalog(page);
  await next.open(page);
  const dialog = await next.openPlacementDialog(page, 'new');
  await expect(dialog.locator(`[data-convention="${PLUGINS[0]}/c0"]`)).toBeAttached();
  const vp = page.viewportSize()!;
  const { found } = await measured(page, `new project @ ${vp.width}x${vp.height}`, '[data-dialog="new-project"]', null, 'Create project');
  await closeWith(dialog);
  expect(found, `${found.length} violation(s)`).toEqual([]);
}

export async function workspaceFlow({ page, cc }: Args): Promise<void> {
  for (let n = 0; n < SEEDED; n++) await createProject(cc, `${tag()}-ws-${String(n).padStart(2, '0')}`);
  await next.open(page);
  const dialog = await next.openNewWorkspace(page);
  await expect(dialog.locator('[data-project-list] [data-project]').first()).toBeVisible();
  const vp = page.viewportSize()!;
  const { found } = await measured(page, `workspace @ ${vp.width}x${vp.height}`, '[data-dialog="workspace"]', '[data-project-list]', 'Create');
  await closeWith(dialog);
  expect(found, `${found.length} violation(s)`).toEqual([]);
}
