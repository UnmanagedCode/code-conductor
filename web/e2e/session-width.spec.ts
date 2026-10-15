import { test } from './harness/fixtures.ts';
import { drawerHasNoControlFlow, widthsFlow } from './session-width.shared.ts';

test('any session width widens the whole column together, clamps to the room, keeps its value under Full and survives a reload', widthsFlow);
test('the drawer sidebar has no session width control', drawerHasNoControlFlow);
