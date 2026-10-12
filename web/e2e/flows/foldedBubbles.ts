// Helpers the folded-bubble flows share: a wake stub sent from the composer,
// which the UI folds exactly as an orchestrator-injected wake, and
// a sideways-overflow probe. Declares no tests.
import type { Locator, Page } from '@playwright/test';
import { expect } from '../harness/fixtures.ts';
import { buildWakeStub } from '../../../public/wakeCallback.ts';
import type { Ui } from './ui.ts';

export const WAKE_PAYLOAD = '{"sessionId":"wakeparity","source":"live"}\nWAKE-PROSE first paragraph with **bold** words\n\n# WAKE-HEAD plan\n\nWAKE-TAIL closing paragraph';
const WAKE_STUB = buildWakeStub({ targetSessionId: 'wakeparity', payloadText: WAKE_PAYLOAD });

/** A payload whose meta line and one prose word are each a single unbroken token, far wider than a phone. */
export const LONG_WAKE_PAYLOAD = `{"sessionId":"wakeparity","hint":"${'m'.repeat(300)}"}\nLONGPROSE-${'p'.repeat(300)}\n\nWAKE-TAIL closing paragraph`;
export const LONG_WAKE_STUB = buildWakeStub({ targetSessionId: 'wakeparity', payloadText: LONG_WAKE_PAYLOAD });

/** Sends `stub` and waits until the transcript shows `folds` wake folds and `turns` turn ends. */
export async function sendWake(page: Page, ui: Ui, turns: number, { stub = WAKE_STUB, folds = 1 } = {}): Promise<void> {
  await ui.sendPrompt(page, stub);
  await expect(ui.wakeFold(page), 'the composer-sent stub renders as a wake fold').toHaveCount(folds);
  await expect(ui.turnEnds(page)).toHaveCount(turns);
}

/** Whether `loc`'s content is wider than its box. */
export function overflowsX(loc: Locator): Promise<boolean> {
  return loc.evaluate((e) => e.scrollWidth > e.clientWidth + 1);
}
