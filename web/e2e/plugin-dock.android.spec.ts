import { test } from './harness/fixtures.ts';
import { installProbes, phoneFlow } from './plugin-dock.shared.ts';

// Its own cc with two probe plugins, one keep-alive and one plain.
test.use({ ccOptions: { server: 'plugin-dock' } });
test.beforeAll(async ({ cc }) => { await installProbes(cc); });

test('below md the plugin view is full-page whatever the remembered mode, with no toggle', phoneFlow);
