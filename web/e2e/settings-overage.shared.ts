// The web UI's Settings → Account overage draft on a real cc: a staged edit
// survives a section switch, Apply commits it to the server and keeps its
// status, and reopening Settings discards an edit that was never applied.
import type { Locator, Page } from '@playwright/test';
import { expect, type Cc } from './harness/fixtures.ts';
import { api } from './harness/api.ts';
import { next } from './parity/ui.ts';

type Shown = { action: string; threshold: boolean; value: string | null; applyEnabled: boolean };

const card = (page: Page): Locator =>
  next.settingsView(page).locator('[data-slot="card"]').filter({ has: page.getByRole('group', { name: 'Action on overage', exact: true }) });

async function expectShown(page: Page, want: Shown, what: string): Promise<void> {
  const c = card(page);
  await expect(c.getByRole('button', { name: want.action, exact: true }), `${what}: the action`).toHaveAttribute('aria-pressed', 'true');
  await expect(c.locator('[aria-pressed="true"]'), `${what}: one action`).toHaveCount(1);
  await expect(c.getByRole('switch', { name: 'Also stop at a usage threshold', exact: true }), `${what}: the threshold switch`).toHaveAttribute('aria-checked', String(want.threshold));
  const slider = c.getByRole('slider', { name: 'Stop at', exact: true });
  if (want.value === null) await expect(slider, `${what}: no slider`).toHaveCount(0);
  else await expect(slider, `${what}: the threshold`).toHaveValue(want.value);
  await expect(c.getByRole('button', { name: 'Apply', exact: true }), `${what}: Apply`).toBeEnabled({ enabled: want.applyEnabled });
}

async function committedPrefs(cc: Cc): Promise<unknown> {
  const { body } = await api(cc, 'GET', '/api/settings/models');
  return { onOverage: body.onOverage, overageThreshold: body.overageThreshold };
}

export async function overageDraftFlow({ page, cc }: { page: Page; cc: Cc }): Promise<void> {
  const start = { onOverage: 'stop', overageThreshold: { enabled: false, value: 60 } };
  expect((await api(cc, 'POST', '/api/settings/models/prefs', start)).status).toBe(200);
  await next.open(page);
  await next.openSettingsSection(page, 'account');
  await expectShown(page, { action: 'Stop', threshold: false, value: null, applyEnabled: false }, 'positive control: the server values');

  const c = card(page);
  await c.getByRole('button', { name: 'Stop & resume', exact: true }).click();
  await c.getByRole('switch', { name: 'Also stop at a usage threshold', exact: true }).click();
  await c.getByRole('slider', { name: 'Stop at', exact: true }).focus();
  await page.keyboard.press('Home');
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
  const staged: Shown = { action: 'Stop & resume', threshold: true, value: '40', applyEnabled: true };
  await expectShown(page, staged, 'positive control: the edit is staged');

  await next.switchSettingsSection(page, 'models');
  await next.switchSettingsSection(page, 'account');
  await expectShown(page, staged, 'the staged edit after a section switch');
  expect(await committedPrefs(cc), 'nothing is committed before Apply').toEqual(start);

  await c.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(c.getByRole('status'), 'Apply reports success').toHaveText(/applied/i);
  expect(await committedPrefs(cc), 'Apply commits the staged values').toEqual({ onOverage: 'stop-resume', overageThreshold: { enabled: true, value: 40 } });
  await next.switchSettingsSection(page, 'models');
  await next.switchSettingsSection(page, 'account');
  await expectShown(page, { ...staged, applyEnabled: false }, 'after Apply and a section switch');
  await expect(c.getByRole('status'), 'the applied status after a section switch').toHaveText(/applied/i);

  await c.getByRole('button', { name: 'Off', exact: true }).click();
  await expectShown(page, { ...staged, action: 'Off' }, 'positive control: a second edit is staged');
  await next.leaveSettings(page);
  await next.openSettingsSection(page, 'account');
  await expectShown(page, { ...staged, applyEnabled: false }, 'reopening Settings shows the committed values');
  await expect(c.getByRole('status'), 'reopening Settings clears the status').toHaveCount(0);
  expect(await committedPrefs(cc), 'the discarded edit was never committed').toEqual({ onOverage: 'stop-resume', overageThreshold: { enabled: true, value: 40 } });
}
