import { expect } from '../harness/fixtures.ts';
import { createProject } from '../harness/api.ts';
import { parity } from './parity.ts';
import { bringTo, conceal, cssOf, offsetFromTop, reveal, sendAll, shadowLayers, tallPrompt } from './stickyPin.ts';

parity('sticky-prompt/R2', 'revealed with Down, the pin holds the prompt being read; a click jumps to it, the held prompt peeks back as the transcript scrolls on, a full-page view keeps it, and Up conceals it', async ({ page, cc, ui, uniq }) => {
  const project = uniq('pin-jump');
  await createProject(cc, project);
  await ui.open(page);
  await ui.startSessionIn(page, project);
  await sendAll(page, ui, [tallPrompt('PIN-ALPHA'), tallPrompt('PIN-BRAVO'), tallPrompt('PIN-CHARLIE')]);
  const transcript = ui.transcript(page);
  const prompts = ui.userMessages(page);
  const pin = ui.pin(page);
  const bravo = prompts.nth(1);

  await expect(prompts).toHaveCount(3);
  await expect(pin).toBeHidden();
  await bringTo(transcript, bravo, -150);
  await reveal(page, ui);
  await expect(pin).toBeVisible();
  await expect(pin).toHaveAttribute('role', 'button');
  await expect(pin).toContainText('PIN-BRAVO');

  await pin.click();
  await expect.poll(async () => Math.abs(await offsetFromTop(transcript, bravo))).toBeLessThanOrEqual(1);
  // "Hidden right after the jump" is left to the /next/ spec: the old UI's `<= 0`
  // rule can leave a sub-pixel peek on Pixel 7.
  await bringTo(transcript, bravo, 40);
  await expect(pin).toBeVisible();
  await expect(pin).toContainText('PIN-ALPHA');

  await ui.openSettings(page);
  await expect(pin).toBeHidden();
  await ui.leaveSettings(page);
  await expect(pin).toBeVisible();

  await conceal(page, ui);
  await expect(pin).toBeHidden();
});

parity('sticky-prompt/R4', 'a status line is a status region with the default cursor; a pinned prompt is the jump button with the pointer', async ({ page, cc, ui, uniq }) => {
  const project = uniq('pin-cursor');
  await createProject(cc, project);
  await ui.open(page);
  await ui.startSessionIn(page, project);
  await sendAll(page, ui, [tallPrompt('PIN-SOLO')]);
  const transcript = ui.transcript(page);
  const pin = ui.pin(page);
  const solo = ui.userMessages(page).nth(0);

  await transcript.evaluate((s) => { s.scrollTop = 0; });
  await reveal(page, ui);
  // Both UIs read "none" only once the session's tail probe has settled; the old
  // UI can read "loading" until then. Every check below compares that settled state.
  await expect(pin).toContainText('No earlier prompt in this session');
  await expect(pin).not.toContainText('Loading earlier history');
  await expect(pin).toHaveAttribute('role', 'status');
  await expect(pin).not.toHaveAttribute('tabindex');
  await expect(pin).not.toHaveAttribute('title');
  await expect.poll(() => cssOf(pin, 'cursor')).toBe('default');

  await bringTo(transcript, solo, -150);
  await expect(pin).toHaveAttribute('role', 'button');
  await expect(pin).toHaveAttribute('tabindex', '0');
  await expect(pin).toHaveAttribute('title', /.+/);
  await expect(pin).toContainText('PIN-SOLO');
  await expect.poll(() => cssOf(pin, 'cursor')).toBe('pointer');
});

parity('sticky-prompt/R3', 'the pin clamps a long prompt to five lines and fades only its last lines, its shadow is not clipped by the fade, and both swipe zones keep pinch zoom without a vertical pan', async ({ page, cc, ui, uniq }) => {
  const project = uniq('pin-clamp');
  await createProject(cc, project);
  await ui.open(page);
  await ui.startSessionIn(page, project);
  await sendAll(page, ui, [tallPrompt('PIN-LONG'), 'PIN-SHORT a short prompt', tallPrompt('PIN-FILLER')]);
  const transcript = ui.transcript(page);
  const prompts = ui.userMessages(page);
  const pin = ui.pin(page);
  const pinBody = ui.pinBody(page);
  const pinCard = ui.pinCard(page);

  for (const z of ui.swipeZones(page)) expect(await cssOf(z, 'touch-action')).toBe('pan-x pinch-zoom');

  await bringTo(transcript, prompts.nth(0), -100);
  await reveal(page, ui);
  await expect(pin).toContainText('PIN-LONG');
  expect(await pinBody.evaluate((e) => e.scrollHeight > e.clientHeight + 1), 'the long prompt overflows the clamp').toBe(true);
  const lines = await pinBody.evaluate((e) => {
    const s = getComputedStyle(e);
    return (e.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)) / parseFloat(s.lineHeight);
  });
  expect(lines).toBeCloseTo(5, 1);
  await expect.poll(() => cssOf(pinBody, 'mask-image')).toMatch(/calc\(100% - [\d.]+(px|lh)\)/);
  const layers = shadowLayers(await cssOf(pinCard, 'box-shadow'));
  expect(layers.some((l) => l.inset), 'no inset layer').toBe(false);
  expect(layers.some((l) => l.blur > 0), 'a drop shadow').toBe(true);
  expect(layers.some((l) => l.blur === 0 && (l.y >= 1 || l.spread >= 1)), 'a light edge line').toBe(true);
  expect(await cssOf(pinCard, 'mask-image')).toBe('none');
  expect(await cssOf(pinCard, 'overflow')).toBe('visible');
  expect(await pinCard.evaluate((c, b) => c !== b && c.contains(b), await pinBody.elementHandle())).toBe(true);

  await bringTo(transcript, prompts.nth(1), -60);
  await expect(pin).toContainText('PIN-SHORT');
  await expect.poll(() => cssOf(pinBody, 'mask-image')).toBe('none');
  expect(await pinBody.evaluate((e) => e.scrollHeight <= e.clientHeight + 1)).toBe(true);
});
