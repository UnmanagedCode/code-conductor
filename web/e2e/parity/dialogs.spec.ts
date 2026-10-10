import { expect } from '../harness/fixtures.ts';
import { parity } from './parity.ts';

parity('new-project-dialog-wiring/R1', 'New project creates a project that the Projects lens lists', async ({ page, ui, uniq }) => {
  const name = uniq('proj');
  await ui.open(page);
  await ui.lens(page, 'projects');
  await ui.newProject(page, name);
  await expect(await ui.projectRow(page, name)).toBeVisible();
});
