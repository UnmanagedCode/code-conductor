import { expect } from '../harness/fixtures.ts';
import { createProject } from '../harness/api.ts';
import { parity } from './parity.ts';

parity('legacy-main-bar-reset/R1', 'opening Settings clears the session from the main bar, and leaving restores it', async ({ page, cc, ui, uniq }) => {
  const project = uniq('hdr');
  await createProject(cc, project);
  await ui.open(page);
  await ui.startSessionIn(page, project);
  // toContainText matches a hidden element too: visibility is asserted on its own.
  await expect(ui.sessionHeader(page)).toBeVisible();
  await expect(ui.sessionHeader(page)).toContainText(project);
  await ui.openSettings(page);
  await expect(ui.sessionHeader(page)).toBeHidden();
  await ui.leaveSettings(page);
  await expect(ui.sessionHeader(page)).toBeVisible();
  await expect(ui.sessionHeader(page)).toContainText(project);
});
