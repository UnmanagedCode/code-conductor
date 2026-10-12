// Dictation under /next/ through a real browser microphone: Chromium's fake capture device stands
// in for it, and the page's own route answers the transcription endpoints. Holding Send with text in
// the box records until a tap and keeps the box focused; a short press sends; a touch the browser
// cancels does nothing; and a recording keeps running when the user leaves the session view and
// comes back, where Cancel discards it. The body is shared by the per-project spec files.
import type { Locator, Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { spawnSession } from './harness/api.ts';
import { next } from './parity/ui.ts';

/** For a spec file's `test.use`: getUserMedia answers from a fake device, with no permission prompt. */
export const FAKE_MICROPHONE = {
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['microphone'],
};

const SPOKEN = 'spoken words';

type Session = { project: string; sessionId: string };

async function startSession(cc: Cc, what: string): Promise<Session> {
  const project = `dictate-${what}-${test.info().project.name}`;
  const { sessionId } = await spawnSession(cc, project);
  return { project, sessionId };
}

/** Selects a session from the sidebar once its row is live, then waits until the composer answers a role query. */
async function select(page: Page, s: Session): Promise<void> {
  const row = await next.sessionRow(page, s.project, s.sessionId);
  await expect.poll(() => next.sessionRowLive(row), { message: `${s.project}: the row is live` }).toBe(true);
  await row.click();
  await expect(messageBox(page)).toBeEnabled();
}

/**
 * Answers the transcription endpoints: whisper reads as installed, and every recording posted is
 * transcribed as SPOKEN, once `release()` has been called when `held`. `posted` lists each post's
 * content type.
 */
async function fakeTranscription(page: Page, { held = false } = {}) {
  const posted: string[] = [];
  let release: () => void = () => {};
  const answer = held ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
  await page.route('**/api/transcribe/status', (route) => route.fulfill({ json: { available: true } }));
  await page.route('**/api/transcribe', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posted.push(route.request().headers()['content-type'] ?? '');
    await answer;
    await route.fulfill({ json: { text: SPOKEN } });
  });
  return { posted, release: () => release() };
}

const messageBox = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const button = (page: Page, name: 'Send' | 'Dictate' | 'Stop recording') => page.getByRole('button', { name, exact: true });

/**
 * Presses `target` for `ms`: with the mouse on desktop, otherwise with a finger through CDP touch
 * events, lifted (`end`) or taken back by the browser (`cancel`). `during` runs before the release.
 */
async function press(page: Page, target: Locator, ms: number, { lift = 'end', during }: { lift?: 'end' | 'cancel'; during?: () => Promise<void> } = {}): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('the button has no box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (test.info().project.name === 'desktop') {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(ms);
    await during?.();
    await page.mouse.up();
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(ms);
  await during?.();
  await cdp.send('Input.dispatchTouchEvent', { type: lift === 'end' ? 'touchEnd' : 'touchCancel', touchPoints: [] });
  await cdp.detach();
}

/** Lets a release's click land: on touch it arrives a task after the finger lifts. */
const twoFrames = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

export async function holdToDictateFlow({ page, cc }: { page: Page; cc: Cc }): Promise<void> {
  const transcription = await fakeTranscription(page);
  const s = await startSession(cc, 'hold');
  await next.open(page);
  await select(page, s);
  const box = messageBox(page);
  await expect(button(page, 'Dictate'), 'positive control: the empty box offers dictation').toBeEnabled();

  await box.fill('a short press');
  await press(page, button(page, 'Send'), 150);
  await expect(next.lastUserMessage(page), 'a short press sends').toContainText('a short press');
  await expect(box).toHaveValue('');

  if (test.info().project.name !== 'desktop') {
    await box.fill('cancelled');
    await press(page, button(page, 'Send'), 250, { lift: 'cancel' });
    await twoFrames(page);
    await expect(box, 'a cancelled touch sends nothing').toHaveValue('cancelled');
    await expect(button(page, 'Stop recording'), 'and records nothing').toHaveCount(0);
  }

  await box.fill('hello');
  await box.focus();
  await press(page, button(page, 'Send'), 800, { during: () => expect(box, 'the hold keeps the focus in the message box').toBeFocused() });
  await twoFrames(page);
  await expect(button(page, 'Stop recording'), 'the recording keeps running after the release').toBeVisible();
  expect(transcription.posted, 'nothing is transcribed before the tap').toEqual([]);
  await button(page, 'Stop recording').click();
  await expect(box, 'the transcript is appended with one space').toHaveValue(`hello ${SPOKEN}`);
  expect(transcription.posted, 'the tap posted one recording, as audio').toEqual([expect.stringMatching(/^audio\//)]);

  await press(page, button(page, 'Send'), 800);
  await twoFrames(page);
  await expect(button(page, 'Stop recording'), 'a second hold records again and keeps running after the release').toBeVisible();
  await button(page, 'Stop recording').click();
  await expect(box).toHaveValue(`hello ${SPOKEN} ${SPOKEN}`);
}

export async function recordingSurvivesLeavingSessionViewFlow({ page, cc }: { page: Page; cc: Cc }): Promise<void> {
  const transcription = await fakeTranscription(page, { held: true });
  const s = await startSession(cc, 'leave');
  await next.open(page);
  await select(page, s);
  const box = messageBox(page);
  await button(page, 'Dictate').click();
  await expect(button(page, 'Stop recording'), 'positive control: a tap on Dictate records').toBeVisible();
  await box.fill('typed while recording');

  await next.openSettings(page);
  await next.leaveSettings(page);
  await select(page, s);
  await expect(button(page, 'Stop recording'), 'the recording survives leaving the session view').toBeVisible();
  await expect(box).toHaveValue('typed while recording');

  await button(page, 'Stop recording').click();
  await expect.poll(() => transcription.posted.length, { message: 'the tap posted the recording' }).toBe(1);
  await next.openSettings(page);
  const answered = page.waitForResponse((r) => r.url().endsWith('/api/transcribe') && r.request().method() === 'POST');
  transcription.release();
  await answered;
  await next.leaveSettings(page);
  await select(page, s);
  await expect(box, 'the transcript answered while the user was in Settings lands in its session').toHaveValue(`typed while recording ${SPOKEN}`);
  await expect(button(page, 'Send')).toBeEnabled();
}

export async function cancelAfterLeavingSessionViewFlow({ page, cc }: { page: Page; cc: Cc }): Promise<void> {
  const transcription = await fakeTranscription(page);
  const s = await startSession(cc, 'cancel');
  await next.open(page);
  await select(page, s);
  const box = messageBox(page);
  await box.fill('kept text');
  await press(page, button(page, 'Send'), 800);
  await twoFrames(page);
  await expect(button(page, 'Stop recording'), 'positive control: the hold records').toBeVisible();

  await next.openSettings(page);
  await next.leaveSettings(page);
  await select(page, s);
  await expect(button(page, 'Stop recording'), 'the recording survives leaving the session view').toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(button(page, 'Send'), 'Cancel returns the control to Send').toBeEnabled();
  await expect(box, 'and the box keeps its text').toHaveValue('kept text');
  expect(transcription.posted, 'Cancel posts nothing').toEqual([]);

  // A later recording is a barrier: its own post lands after the cancelled recorder has stopped, so a
  // post from the cancelled one would show here as a second.
  await press(page, button(page, 'Send'), 800);
  await twoFrames(page);
  await button(page, 'Stop recording').click();
  await expect(box).toHaveValue(`kept text ${SPOKEN}`);
  expect(transcription.posted, 'only the later recording was posted').toHaveLength(1);
}
