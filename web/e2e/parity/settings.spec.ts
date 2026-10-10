import type { Page } from '@playwright/test';
import { expect } from '../harness/fixtures.ts';
import { parity } from './parity.ts';

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
