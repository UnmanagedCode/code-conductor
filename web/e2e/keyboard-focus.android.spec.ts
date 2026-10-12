import { test } from './harness/fixtures.ts';
import { drawerFlow, rowKeysFlow, sessionDialogsFlow } from './keyboard-focus.shared.ts';

test.use({ ccOptions: { server: 'keyboard-focus' } });

test("Enter and Space on a sidebar row's Make persistent, Stop, Archive and Show workers buttons run that button and never open the session; Enter and Space on the row's own button open it; no sidebar control is nested inside another", rowKeysFlow);
test('Summarize, Statistics and Prune keep Tab and Shift+Tab inside from the moment they open, and closing returns focus to Session actions', sessionDialogsFlow);
test('the navigation drawer keeps Tab and Shift+Tab inside while open and Escape returns focus to Open sidebar', drawerFlow);
