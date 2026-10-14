import { test } from './harness/fixtures.ts';
import { attachmentsFlow, desktopPresetsFlow, narrowFlow, variantsFlow } from './user-bubble-width.shared.ts';

test("at every width preset each user bubble spans the row as the question and plan cards do", desktopPresetsFlow);
test("on a phone each user bubble spans the row as the question and plan cards do", narrowFlow);
test("a sent prompt's attachment chips start at its bubble's text", attachmentsFlow);
test('every user-side bubble variant spans the row as the question and plan cards do', variantsFlow);
