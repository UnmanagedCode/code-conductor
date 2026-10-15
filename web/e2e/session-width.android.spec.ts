import { test } from './harness/fixtures.ts';
import { dragFlow, drawerHasNoControlFlow, roomFlow, widthsFlow } from './session-width.shared.ts';

test('any session width widens the whole column together, keeps its value under Full, has no handles in Full and survives a reload', widthsFlow);
test('both edge handles mirror, keep the column centred, snap near Wide, apply live and reset on a double-click', dragFlow);
test('there is no fixed maximum: a drag stops a gutter clear per side, and a wider stored width renders clamped and is kept', roomFlow);
test('the drawer sidebar has no session width control and the session has no handles', drawerHasNoControlFlow);
