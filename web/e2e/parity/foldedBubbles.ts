// Helpers the folded-bubble parity scenarios share: a wake stub sent from the
// composer, which both UIs fold exactly as an orchestrator-injected wake, and
// a computed font size. Declares no tests.
import type { Locator, Page } from '@playwright/test';
import { expect } from '../harness/fixtures.ts';
import { buildWakeStub } from '../../../public/wakeCallback.ts';
import { cssOf } from './stickyPin.ts';
import type { Ui } from './ui.ts';

export const WAKE_PAYLOAD = '{"sessionId":"wakeparity","source":"live"}\nWAKE-PROSE first paragraph with **bold** words\n\n# WAKE-HEAD plan\n\nWAKE-TAIL closing paragraph';
const WAKE_STUB = buildWakeStub({ targetSessionId: 'wakeparity', payloadText: WAKE_PAYLOAD });

/** Sends the wake stub and waits for its fold and for the session's `turns`-th turn end. */
export async function sendWake(page: Page, ui: Ui, turns: number): Promise<void> {
  await ui.sendPrompt(page, WAKE_STUB);
  await expect(ui.wakeFold(page), 'the composer-sent stub renders as a wake fold').toHaveCount(1);
  await expect(ui.turnEnds(page)).toHaveCount(turns);
}

/** `loc`'s computed font size in px. */
export async function px(loc: Locator): Promise<number> {
  return parseFloat(await cssOf(loc, 'font-size'));
}
