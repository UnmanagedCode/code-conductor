// The composer's attach flow under /next/: a file chosen through the Attach files button and files
// dropped on the composer both become removable chips. The body is shared by the per-project spec files.
import type { Page } from '@playwright/test';
import { test, expect } from './harness/fixtures.ts';
import { spawnSession } from './harness/api.ts';

export async function attachFlow({ page, cc }: { page: Page; cc: Parameters<typeof spawnSession>[0] }): Promise<void> {
  const { sessionId } = await spawnSession(cc, `e2e-attach-${test.info().project.name}`);
  await page.goto(`/next/#session=${sessionId}`);
  await expect(page.locator('#composer-input')).toBeEnabled();

  // The button opens the picker; choosing a file attaches it.
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach files' }).click();
  (await chooser).setFiles({ name: 'picked.txt', mimeType: 'text/plain', buffer: Buffer.from('picked content') });
  const picked = page.getByRole('button', { name: 'Remove picked.txt' });
  await expect(picked).toBeVisible();

  // A real DataTransfer drop on the composer attaches too.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['dropped content'], 'dropped.txt', { type: 'text/plain' }));
    document.querySelector('[data-composer]')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  const dropped = page.getByRole('button', { name: 'Remove dropped.txt' });
  await expect(dropped).toBeVisible();
  await expect(picked).toBeVisible();

  // Removing one chip leaves the other.
  await dropped.click();
  await expect(dropped).toHaveCount(0);
  await expect(picked).toBeVisible();
  await picked.click();
  await expect(picked).toHaveCount(0);
}
