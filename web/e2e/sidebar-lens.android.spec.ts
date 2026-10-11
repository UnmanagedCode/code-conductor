import { test } from './harness/fixtures.ts';
import { lensControlsFitFlow, lensListsFlow } from './sidebar-lens.shared.ts';

test.use({ ccOptions: { server: 'sidebar-lens' } });

test('each lens shows its own lists and they are reachable', lensListsFlow);
test('the Projects lens filter and project-actions controls are reachable and do not overflow the sidebar', lensControlsFitFlow);
