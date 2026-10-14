import { test } from './harness/fixtures.ts';
import { flatListFlow, seedFlat } from './sidebar-tiers.shared.ts';

// Its own cc: the tree must hold no workspace, which sidebar-tiers seeds.
test.use({ ccOptions: { server: 'sidebar-tiers-flat' } });

test.beforeAll(seedFlat);

test('with no workspaces an unassigned project row starts at the project list left edge, with no rail', flatListFlow);
