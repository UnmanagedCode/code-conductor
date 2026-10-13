import { test } from './harness/fixtures.ts';
import { attachmentsFlow, desktopPresetsFlow, narrowFlow } from './user-bubble-inset.shared.ts';

test("at every width preset each user bubble starts at the action card's left edge and fills to the column edge", desktopPresetsFlow);
test("on a phone each user bubble starts at the action card's left edge and fills to the column edge", narrowFlow);
test("a sent prompt's attachment chips start at its bubble's text", attachmentsFlow);
