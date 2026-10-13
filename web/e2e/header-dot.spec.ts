import { test } from './harness/fixtures.ts';
import { dotCentringFlow } from './header-dot.shared.ts';

test.use({ ccOptions: { server: 'header-dot' } });

test('the status dot is centred on the two-line title block and on the bar, and the subline stays under the title', dotCentringFlow);
