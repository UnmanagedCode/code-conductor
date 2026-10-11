import { test } from './harness/fixtures.ts';
import { hiddenPluginFlow } from './plugin-hidden.shared.ts';

test.use({ ccOptions: { server: 'plugin-hidden' } });

test('a plugin view left behind is not visible and does not intercept the pointer', hiddenPluginFlow);
