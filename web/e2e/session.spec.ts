import { test, expect, type APIRequestContext } from '@playwright/test';

async function spawnSession(request: APIRequestContext, project: string) {
  await request.post('/api/projects', { data: { name: project } });
  const r = await request.post('/api/instances', { data: { project, mode: 'bypassPermissions' } });
  expect(r.ok()).toBeTruthy();
  return (await r.json()) as { id: string; sessionId: string };
}

test('a prompt streams a reply with tool calls, prose and a turn footer', async ({ page, request }) => {
  const { sessionId } = await spawnSession(request, `e2e-chat-${test.info().project.name}`);
  await page.goto(`/#session=${sessionId}`);
  const composer = page.locator('#composer-input');
  await expect(composer).toBeEnabled();
  await composer.fill('Add a rate limiter to the API');
  await composer.press('Enter');

  await expect(page.locator('[data-item=user]').first()).toContainText('Add a rate limiter to the API');
  const reply = page.locator('[data-item=assistant]').first();
  await expect(reply).toContainText('token-bucket rate limiter');
  await expect(reply.getByRole('button', { name: /4 actions/ })).toBeVisible();
  await expect(page.locator('[data-item=turn-end]').first()).toContainText('Done');
  // The composer is cleared and ready for the next prompt.
  await expect(composer).toHaveValue('');
});

test('the action group expands to show each tool call with its arguments', async ({ page, request }) => {
  const { sessionId } = await spawnSession(request, `e2e-tools-${test.info().project.name}`);
  await page.goto(`/#session=${sessionId}`);
  await page.locator('#composer-input').fill('go');
  await page.locator('#composer-input').press('Enter');
  const group = page.locator('[data-item=assistant]').getByRole('button', { name: /4 actions/ });
  await group.click();
  await expect(page.getByText('Run the test suite')).toBeVisible();
  await page.getByText('Run the test suite').click();
  await expect(page.locator('pre', { hasText: 'npm test' }).first()).toBeVisible();
});

test('a reload restores the session named in the URL', async ({ page, request }) => {
  const { sessionId } = await spawnSession(request, `e2e-reload-${test.info().project.name}`);
  await page.goto(`/#session=${sessionId}`);
  await page.locator('#composer-input').fill('hello');
  await page.locator('#composer-input').press('Enter');
  await expect(page.locator('[data-item=turn-end]').first()).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-item=user]').first()).toContainText('hello');
  await expect(page.locator('[data-session-header]')).toBeVisible();
});

test('the theme follows the system and can be forced dark', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/dark/);
});
