// A conducted worker's identity where you type: the header's owner chip, the composer's owner colour, the first-send check and the way back to the owner, in a real browser with the drawer closed on the narrow projects.
import { api, createProject } from '../harness/api.ts';
import { expect, test } from './test.ts';
import { colourOf, spawnConductor, spawnWorker } from './fleet.ts';

test.use({ ccOptions: { server: 'worker-identity' } });

test("a worker's owner chip and composer carry the owner's colour; the first send asks, Send to the owner instead lands there, Send to this worker lands here once, and the ack survives a reload", async ({ page, cc, ui, uniq }) => {
  // Invariant: opening a conducted worker shows `Back to <owner>` and an owner-coloured composer without the sidebar; the first Enter sends nothing and offers the choice; Send to the owner puts the text in the owner's transcript and opens it; Send to this worker delivers it and later sends (and a reload) skip the choice; Alt+ArrowUp from the message box opens the owner (desktop).
  test.setTimeout(180_000);
  const project = uniq('wid');
  await createProject(cc, project);
  await api(cc, 'POST', '/api/projects/.conduct/ensure');
  const conductor = await spawnConductor(cc, true);
  const label = uniq('Owner');
  await api(cc, 'PUT', `/api/sessions/${conductor.sessionId}/title`, { title: label });
  const worker = await spawnWorker(cc, conductor.id, { project });
  const colour = await colourOf(page, conductor.sessionId);

  await page.goto(`/#session=${worker.sessionId}`);
  const box = page.getByRole('textbox', { name: 'Message' });
  await expect(box).toBeEnabled();
  const chip = ui.sessionHeader(page).getByRole('button', { name: `Back to ${label}` });
  await expect(chip).toBeVisible();
  const resolved = (css: string) => page.evaluate((c) => {
    const probe = document.createElement('i');
    probe.style.color = c;
    document.body.appendChild(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, css);
  expect(await resolved(await chip.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--owner-color')))).toBe(colour);
  expect(await page.locator('[data-composer]').evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(colour);
  expect(await ui.drawerOpen(page)).toBe(false);

  // The focused composer's ring layer is the owner's colour at the ring's strength, and not the default ring's. Both are read off probes that share the composer's own variables, as the ring's computed colour is an oklab/oklch value no regex should parse.
  await box.focus();
  const readRing = () => page.locator('[data-composer]').evaluate((el) => {
    const colourOfShadow = (css: string) => {
      const probe = document.createElement('i');
      probe.style.boxShadow = `0 0 0 3px ${css}`;
      el.appendChild(probe);
      const out = getComputedStyle(probe).boxShadow;
      probe.remove();
      return out.slice(0, out.indexOf(' 0px'));
    };
    return {
      shadow: getComputedStyle(el).boxShadow,
      owner: colourOfShadow('color-mix(in oklab, var(--owner-color) 40%, transparent)'),
      base: colourOfShadow('color-mix(in oklab, var(--ring) 40%, transparent)'),
    };
  });
  // box-shadow transitions, so the ring arrives a moment after the focus.
  await expect.poll(async () => { const r = await readRing(); return r.owner !== '' && r.shadow.includes(r.owner); }, { message: "the focus ring is the owner's colour" }).toBe(true);
  const ring = await readRing();
  expect(ring.owner, 'the probe resolved a colour').not.toBe('');
  expect(ring.owner).not.toBe(ring.base);
  expect(ring.shadow, 'and not the default ring colour').not.toContain(ring.base);

  await box.fill('meant for the owner');
  await box.press('Enter');
  const choice = page.locator('[data-send-choice]');
  await expect(choice).toBeVisible();
  await expect(ui.userMessages(page)).toHaveCount(0);

  await choice.getByRole('button', { name: /instead/ }).click();
  await expect(ui.sessionHeader(page).locator(`[title="session ${conductor.sessionId}"]`)).toBeVisible();
  await expect(ui.lastUserMessage(page)).toContainText('meant for the owner');

  await page.goto(`/#session=${worker.sessionId}`);
  await expect(chip).toBeVisible();
  await expect(box).toBeEnabled();
  await box.fill('first for the worker');
  await box.press('Enter');
  await expect(choice).toBeVisible();
  await choice.getByRole('button', { name: 'Send to this worker' }).click();
  await expect(ui.lastUserMessage(page)).toContainText('first for the worker');
  await expect(ui.turnEnded(page)).toBeVisible();

  await box.fill('second for the worker');
  await box.press('Enter');
  await expect(ui.lastUserMessage(page)).toContainText('second for the worker');
  await expect(choice).toHaveCount(0);
  await expect(ui.turnEnds(page)).toHaveCount(2);

  await page.reload();
  await expect(box).toBeEnabled();
  await box.fill('after the reload');
  await box.press('Enter');
  await expect(ui.lastUserMessage(page)).toContainText('after the reload');
  await expect(choice).toHaveCount(0);

  if (test.info().project.name === 'desktop') {
    await box.focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(ui.sessionHeader(page).locator(`[title="session ${conductor.sessionId}"]`)).toBeVisible();
  }
});
