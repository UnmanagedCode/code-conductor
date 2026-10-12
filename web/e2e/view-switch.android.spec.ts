import { test } from './harness/fixtures.ts';
import { backAfterBrowserBackFlow, costsForwardFlow, viewOrderFlow } from './view-switch.shared.ts';

// Its own cc: the flows create projects.
test.use({ ccOptions: { server: 'view-switch' } });

test('a commit row\'s review opens over its history, one full-page view shows at a time, and Back retraces the views it replaced', viewOrderFlow);
test('Back from a view the browser\'s Back returned to stays in the app', backAfterBrowserBackFlow);
test('Forward onto the cost dashboard shows it again and keeps the session selected', costsForwardFlow);
