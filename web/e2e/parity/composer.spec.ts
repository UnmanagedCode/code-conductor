import { expect, test } from './test.ts';
import { createProject } from '../harness/api.ts';

test("a prompt sent from the composer shows as the user's message, the reply streams in, and the turn ends", async ({ page, cc, ui, uniq }) => {
  const project = uniq('chat');
  await createProject(cc, project);
  await ui.open(page);
  await ui.startSessionIn(page, project);
  await ui.sendPrompt(page, 'Add a rate limiter to the API');
  await expect(ui.lastUserMessage(page)).toContainText('Add a rate limiter to the API');
  // The reply text of fixtures/scenario.json's first turn.
  await expect(ui.lastAssistantMessage(page)).toContainText('token-bucket rate limiter');
  await expect(ui.turnEnded(page)).toBeVisible();
  await expect(ui.composer(page)).toHaveValue('');
});
