import { test } from './harness/fixtures.ts';
import { installProbePlugin } from './harness/pluginProbe.ts';
import { PROBE, barAboveFrameFlow, desktopStripFlow, overlayBelowBarFlow } from './plugin-topbar.shared.ts';

test.use({ ccOptions: { server: 'plugin-topbar' } });
test.beforeAll(async ({ cc }) => { await installProbePlugin(cc, PROBE); });

test('the plugin view has a top bar with Close above the frame, and nothing covers the frame\'s corner', barAboveFrameFlow);
test('the drawer button stays reachable over the start-failure overlay, which starts below the bar', overlayBelowBarFlow);
test('on desktop the plugin view\'s bar holds the app switcher, Dock to side and Close plugin, no drawer button, and the frame fills the rest', desktopStripFlow);
