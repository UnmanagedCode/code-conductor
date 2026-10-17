import { test } from './harness/fixtures.ts';
import { editConventionsFlow, newProjectFlow, workspaceFlow } from './dialog-scroll.shared.ts';

// Its own cc: the flows seed about thirty projects.
test.use({ ccOptions: { server: 'dialog-scroll' } });
test.describe.configure({ timeout: 300_000 });

test("Edit conventions: only the conventions list scrolls, on the project's viewport and on a 400px-tall one, with the header and Save/Cancel in view", editConventionsFlow);
test('New project: the conventions list holds every hidden input, so the dialog does not scroll', newProjectFlow);
test('New workspace: the project list holds every hidden input, so the dialog does not scroll', workspaceFlow);
