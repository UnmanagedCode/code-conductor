// The composer's attachments under /next/: a file chosen through the Attach files button and files
// dropped on the composer both become removable chips; each session keeps its own chips and previews
// through sidebar switches; and a session's chips survive leaving the session view. The body is
// shared by the per-project spec files.
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { spawnSession } from './harness/api.ts';
import { next } from './parity/ui.ts';

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

type Session = { project: string; sessionId: string };

/** A 1×1 PNG: an image chip shows it as a preview. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function startSession(cc: Cc, what: string): Promise<Session> {
  const project = `attach-${what}-${test.info().project.name}`;
  const { sessionId } = await spawnSession(cc, project);
  return { project, sessionId };
}

/**
 * Selects a session from the sidebar once its row is live, then waits until the composer answers a
 * role query. On a drawer viewport the closing drawer keeps the page aria-hidden for a moment, and a
 * role query made then finds no chip at all, so an absence check would pass for the wrong reason.
 */
async function select(page: Page, s: Session): Promise<void> {
  const row = await next.sessionRow(page, s.project, s.sessionId);
  await expect.poll(() => next.sessionRowLive(row), { message: `${s.project}: the row is live` }).toBe(true);
  await row.click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
}

const filePicker = (page: Page) => page.locator('[data-composer] input[type="file"]');
const removeButton = (page: Page, name: string) => page.getByRole('button', { name: `Remove ${name}`, exact: true });
const sendButton = (page: Page) => page.getByRole('button', { name: 'Send', exact: true });

export async function attachmentsFollowSessionFlow({ page, cc }: { page: Page; cc: Cc }): Promise<void> {
  const a = await startSession(cc, 'follow-a');
  const b = await startSession(cc, 'follow-b');
  await next.open(page);

  await select(page, a);
  await filePicker(page).setInputFiles([
    { name: 'a-shot.png', mimeType: 'image/png', buffer: PNG },
    { name: 'a-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('a notes') },
  ]);
  const preview = page.getByRole('img', { name: 'a-shot.png', exact: true });
  await expect(preview).toBeVisible();
  await expect(removeButton(page, 'a-notes.txt')).toBeVisible();
  const src = await preview.getAttribute('src');
  expect(src, 'positive control: the image chip shows a preview').toMatch(/^blob:/);
  await expect(sendButton(page), 'an attachment alone is sendable').toBeEnabled();

  await select(page, b);
  await expect(removeButton(page, 'a-shot.png'), "B does not show A's chips").toHaveCount(0);
  await expect(removeButton(page, 'a-notes.txt'), "B does not show A's chips").toHaveCount(0);
  await filePicker(page).setInputFiles([{ name: 'b-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('b notes') }]);
  await expect(removeButton(page, 'b-notes.txt')).toBeVisible();

  await select(page, a);
  await expect(removeButton(page, 'a-shot.png'), "A's chips are back").toBeVisible();
  await expect(removeButton(page, 'a-notes.txt'), "A's chips are back").toBeVisible();
  await expect(removeButton(page, 'b-notes.txt'), "B's chip stays with B").toHaveCount(0);
  await expect(preview, 'with the same preview').toHaveAttribute('src', src ?? '');
  await removeButton(page, 'a-notes.txt').click();
  await expect(removeButton(page, 'a-notes.txt')).toHaveCount(0);

  await select(page, b);
  await expect(removeButton(page, 'b-notes.txt'), "removing A's chip left B's alone").toBeVisible();
  await select(page, a);
  await expect(removeButton(page, 'a-shot.png')).toBeVisible();
  await expect(removeButton(page, 'a-notes.txt'), 'a removed chip stays removed').toHaveCount(0);
}

export async function attachmentsSurviveLeavingSessionViewFlow({ page, cc }: { page: Page; cc: Cc }): Promise<void> {
  const a = await startSession(cc, 'leave-a');
  const b = await startSession(cc, 'leave-b');
  await next.open(page);

  await select(page, a);
  await filePicker(page).setInputFiles([
    { name: 'keep.png', mimeType: 'image/png', buffer: PNG },
    { name: 'keep-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('keep notes') },
  ]);
  const preview = page.getByRole('img', { name: 'keep.png', exact: true });
  await expect(preview).toBeVisible();
  const src = await preview.getAttribute('src');

  await select(page, b);
  await select(page, a);
  await expect(removeButton(page, 'keep.png'), 'positive control: a switch away and back keeps the chips').toBeVisible();

  await next.openSettings(page);
  await next.leaveSettings(page);
  await select(page, a);
  await expect(removeButton(page, 'keep.png'), 'the chips survive leaving the session view').toBeVisible();
  await expect(removeButton(page, 'keep-notes.txt'), 'the chips survive leaving the session view').toBeVisible();
  await expect(preview, 'with the same preview').toHaveAttribute('src', src ?? '');
  await sendButton(page).click();
  await expect(removeButton(page, 'keep.png'), 'the send clears them').toHaveCount(0);
  await expect(next.lastUserMessage(page).getByRole('img', { name: 'keep.png', exact: true }), 'and the sent prompt carries the image').toBeVisible();
}
