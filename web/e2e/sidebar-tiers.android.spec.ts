import { test } from './harness/fixtures.ts';
import { bandGeometryFlow, revealBelowBandFlow, screenshotsFlow, seedTiers, stickyBandFlow } from './sidebar-tiers.shared.ts';

test.use({ ccOptions: { server: 'sidebar-tiers' } });

test.beforeAll(seedTiers);

test('a workspace band stays pinned to the top of the sidebar body while its projects scroll, and the next band takes over', stickyBandFlow);
test('a workspace band spans the sidebar body and its project rows start at the project list edge', bandGeometryFlow);
test('a selected row revealed upward lands below the sticky band', revealBelowBandFlow);
test('the workspace bands in light and dark, and in the drawer, for the visual pass', screenshotsFlow);
