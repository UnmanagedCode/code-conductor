import { test } from './harness/fixtures.ts';
import { desktopColumnFlow, drawerFlow, headerAlignFlow } from './sidebar-chrome.shared.ts';

test.use({ ccOptions: { server: 'sidebar-chrome' } });

test('the phone drawer opens from its toggle and closes from its scrim, Escape and navigating', drawerFlow);
test('the desktop sidebar column has no drawer toggle and stays when a session is chosen', desktopColumnFlow);
test("the sidebar header's controls share one line and end on the content column's right edge; on a drawer the close × is one of them", headerAlignFlow);
