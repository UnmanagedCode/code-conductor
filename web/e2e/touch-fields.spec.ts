import { test } from './harness/fixtures.ts';
import { shellFollowsAppHeightFlow, touchFieldsFlow } from './touch-fields.shared.ts';

test.use({ ccOptions: { server: 'touch-fields' } });

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'a fine pointer keeps the desktop sizes');
});

test('text fields are at least 16px on a coarse pointer, at the device size and at a wide landscape one, and the viewport follower stays idle without a soft keyboard', touchFieldsFlow);

test('the app shell takes its height from --app-height and returns to the window height when it is removed', shellFollowsAppHeightFlow);
