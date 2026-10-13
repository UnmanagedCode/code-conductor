import { test } from './harness/fixtures.ts';
import { installProbePlugin } from './harness/pluginProbe.ts';
import { PROBE, barAboveFrameFlow, desktopUnchangedFlow, overlayBelowBarFlow } from './plugin-topbar.shared.ts';

test.use({ ccOptions: { server: 'plugin-topbar' } });
test.beforeAll(async ({ cc }) => { await installProbePlugin(cc, PROBE); });

test('the plugin view has a top bar above the frame, and nothing covers the frame\'s corner', barAboveFrameFlow);
test('the drawer button stays reachable over the start-failure overlay, which starts below the bar', overlayBelowBarFlow);
test('on desktop the plugin view has no bar and its frame fills the view', desktopUnchangedFlow);
