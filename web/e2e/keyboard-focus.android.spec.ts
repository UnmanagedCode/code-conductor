import { test } from './harness/fixtures.ts';
import { drawerFlow, keepsActionFocusFlow, RETURNS, returnFlow, rowKeysFlow, sessionDialogsFlow } from './keyboard-focus.shared.ts';

test.use({ ccOptions: { server: 'keyboard-focus' } });

test("Enter and Space on a sidebar row's Make persistent, Stop, Archive and Show workers buttons run that button and never open the session; Enter and Space on the row's own button open it; no sidebar control is nested inside another", rowKeysFlow);
test('Summarize, Statistics and Prune keep Tab and Shift+Tab inside from the moment they open, and closing returns focus to Session actions', sessionDialogsFlow);
test('the navigation drawer keeps Tab and Shift+Tab inside while open and Escape returns focus to Open sidebar', drawerFlow);
for (const row of RETURNS) test(`every dialog returns focus to the control that opened it: ${row.name}`, returnFlow(row));
test('closing a dialog leaves focus where its action put it: Start session keeps the prompt bar focused', keepsActionFocusFlow);
