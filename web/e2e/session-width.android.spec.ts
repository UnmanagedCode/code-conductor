import { test } from './harness/fixtures.ts';
import { drawerHasNoControlFlow, presetsFlow } from './session-width.shared.ts';

test('every width preset widens the whole column together, fills at Full and survives a reload', presetsFlow);
test('the drawer sidebar has no session width button', drawerHasNoControlFlow);
