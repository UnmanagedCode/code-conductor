import { test } from './harness/fixtures.ts';
import { installProbes, keepAliveFlow, subpathFlow, switchFlow } from './plugin-host.shared.ts';

// Its own cc with the two probe plugins, and a fake microphone for the keep-alive page.
test.use({
  ccOptions: { server: 'plugin-host' },
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['microphone'],
});
test.beforeAll(async ({ cc }) => { await installProbes(cc); });

test('picking a plugin from the switcher while a session is open lands on it on the first pick', switchFlow);
test('a plugin hash opens, steers and swaps plugin pages without reloading them, and a boot on a plugin hash opens it there', subpathFlow);
test('a keep-alive plugin keeps running hidden behind Settings and Conductor and comes back as the same page, while a plain one reloads', keepAliveFlow);
