import { expect } from '../harness/fixtures.ts';
import { createProject } from '../harness/api.ts';
import { parity } from './parity.ts';
import { bringTo, conceal, cssOf, offsetFromTop, reveal, sendAll, shadowLayers, tallPrompt } from './stickyPin.ts';
import { px, sendWake, WAKE_PAYLOAD } from './foldedBubbles.ts';

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
  // The fade covers the last line and a half: the stop's offset is 1.5 line-heights,
  // whether the browser serializes it resolved (px) or as written (lh).
  const stop = /calc\(100% - ([\d.]+)(px|lh)\)/.exec(await cssOf(pinBody, 'mask-image'))!;
  const lineHeight = parseFloat(await cssOf(pinBody, 'line-height'));
  const fadeLines = stop[2] === 'lh' ? parseFloat(stop[1]) : parseFloat(stop[1]) / lineHeight;
  expect(fadeLines, `the fade stop ${stop[0]} at line-height ${lineHeight}px`).toBeCloseTo(1.5, 1);
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

parity('legacy-awaiting-wake-dot/R2', 'a wake-callback stub renders as a collapsed fold with the bell badge that opens to its payload and closes again', async ({ page, cc, ui, uniq }) => {
  // Invariant: the wake stub is a closed fold carrying the bell, whose body opens and closes with its toggle.
  const project = uniq('wake-fold');
  await createProject(cc, project);
  await ui.open(page);
  await ui.startSessionIn(page, project);
  await sendWake(page, ui, 1);
  const fold = ui.wakeFold(page);
  const toggle = ui.foldToggle(fold);
  const body = ui.foldBody(fold);

  await expect(body).toBeHidden();
  await expect(toggle).toContainText('finished its turn');
  await expect(toggle).toContainText('wakeparity');
  await expect(ui.wakeBadge(fold)).toBeVisible();

  await toggle.click();
  await expect(body).toBeVisible();
  await expect(body).toContainText('WAKE-PROSE');

  await toggle.click();
  await expect(body).toBeHidden();
  await expect(ui.wakeBadge(fold)).toBeVisible();
  await expect(ui.userMessages(page).first()).not.toContainText('[[cc:');
});

parity('wake-callback-bubble/R2', 'an expanded wake body keeps its raw view across a collapse and reopen; its metadata line is muted monospace while the prose keeps the body font', async ({ page, cc, ui, uniq }) => {
  // Invariant: the expanded body and its raw view survive a collapse and reopen; the meta line is muted monospace, the prose is not monospace.
  const project = uniq('wake-raw');
  await createProject(cc, project);
  await ui.open(page);
  await ui.startSessionIn(page, project);
  await sendWake(page, ui, 1);
  const fold = ui.wakeFold(page);
  const toggle = ui.foldToggle(fold);
  await toggle.click();

  const meta = ui.wakeMeta(fold);
  const prose = fold.locator('.md p', { hasText: 'WAKE-PROSE' });
  await expect(meta).toHaveText('{"sessionId":"wakeparity","source":"live"}');
  await expect(prose).toBeVisible();
  expect(await cssOf(meta, 'font-family')).toMatch(/mono/i);
  expect(await cssOf(prose, 'font-family')).not.toMatch(/mono/i);
  expect(await cssOf(meta, 'color')).not.toBe(await cssOf(prose, 'color'));

  await ui.toggleFoldView(fold);
  await expect(ui.foldRaw(fold)).toBeVisible();
  expect(await ui.foldRaw(fold).evaluate((e) => e.textContent)).toBe(WAKE_PAYLOAD);
  await toggle.click();
  await expect(ui.foldBody(fold)).toBeHidden();
  await toggle.click();
  await expect(ui.foldRaw(fold)).toBeVisible();
  expect(await ui.foldRaw(fold).evaluate((e) => e.textContent)).toBe(WAKE_PAYLOAD);
});

parity('user-bubble-markdown/R2', 'headings render at body size in a prompt and in a folded wake body, while an assistant heading stays larger', async ({ page, cc, ui, uniq }) => {
  // Invariant: markdown headings render at body size in prompt text and in a fold body, while assistant markdown keeps its heading scale.
  const project = uniq('heads');
  await createProject(cc, project);
  await ui.open(page);
  await ui.startSessionIn(page, project);
  await sendAll(page, ui, ['HEAD-PIN intro paragraph\n\n# HEAD-PIN heading\n\nHEAD-PIN body paragraph']);
  const t = ui.transcript(page);

  const h1 = t.locator('.md h1', { hasText: 'HEAD-PIN heading' });
  await expect(h1).toBeVisible();
  expect(await px(h1)).toBe(await px(t.locator('.md p', { hasText: 'HEAD-PIN body paragraph' })));
  expect(parseFloat(await cssOf(h1, 'font-weight')), 'the prompt heading is still a heading').toBeGreaterThanOrEqual(600);
  const h2 = t.locator('.md h2', { hasText: 'What changed' });
  await expect(h2).toBeVisible();
  expect(await px(h2), 'an assistant heading stays larger than its prose').toBeGreaterThan(await px(t.locator('.md p', { hasText: 'token-bucket' })));

  await sendWake(page, ui, 2);
  const fold = ui.wakeFold(page);
  await ui.foldToggle(fold).click();
  const foldHead = fold.locator('.md h1', { hasText: 'WAKE-HEAD' });
  await expect(foldHead).toBeVisible();
  expect(await px(foldHead)).toBe(await px(fold.locator('.md p', { hasText: 'WAKE-PROSE' })));
});
