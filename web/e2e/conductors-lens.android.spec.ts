import { test } from './harness/fixtures.ts';
import { inactiveFlow, treeFlow } from './conductors-lens.shared.ts';

test.use({ ccOptions: { server: 'conductors-lens' } });

test('the expanded conductor tree is read-only, ↑ sits on exactly the live temp rows, and a stage line shows only on a bound worker', treeFlow);
test('a killed conductor moves under a collapsed Inactive (1), an archived temp conductor is in no group, ↑ makes a conductor persistent in place and × archives an inactive one', inactiveFlow);
