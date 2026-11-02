import { test } from './harness/fixtures.ts';
import { drawerEscapeFlow, filterRowFitsFlow, lensControlsFitFlow, lensListsFlow } from './sidebar-lens.shared.ts';

test.use({ ccOptions: { server: 'sidebar-lens' } });

test('each lens shows its own lists and they are reachable', lensListsFlow);
test('the Projects lens filter and project-actions controls are reachable and do not overflow the sidebar', lensControlsFitFlow);
test('the filter row stays one line at the narrowest width with a query and a long conductor label', filterRowFitsFlow);
test('in the drawer the first Escape in the filter clears it and the next closes the drawer', drawerEscapeFlow);
