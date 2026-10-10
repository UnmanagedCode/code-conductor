import { expect } from '../harness/fixtures.ts';
import { parity } from './parity.ts';

parity('legacy-sidebar-lenses/R1', 'a fresh profile opens on the Conductors lens, and the chosen lens survives a reload', async ({ page, ui }) => {
  await ui.open(page);
  await expect.poll(() => ui.selectedLens(page)).toBe('conductors');
  await ui.lens(page, 'projects');
  await page.reload();
  await ui.open(page);
  await expect.poll(() => ui.selectedLens(page)).toBe('projects');
});
