import { test } from './harness/fixtures.ts';
import {
  KEEP, PLAIN, autoCollapseFlow, dragFlow, installProbes, keyboardFlow, noReloadFlow, persistFlow, phoneFlow, railGeometryFlow, sessionWidthFlow, toastClearsRailFlow,
} from './plugin-dock.shared.ts';

// Its own cc with two probe plugins, one keep-alive and one plain.
test.use({ ccOptions: { server: 'plugin-dock' } });
test.beforeAll(async ({ cc }) => { await installProbes(cc); });

test('the rail sits at the right edge beside the session, and an app docks in split at the default width with no route change', railGeometryFlow);
test('split ↔ full view never reloads a plain plugin\'s page', noReloadFlow(PLAIN));
test('split ↔ full view never reloads a keep-alive plugin\'s page', noReloadFlow(KEEP));
test('the handle drags over the iframe, snaps to the rail and to full view, and a double-click toggles', dragFlow);
test('the dock and sidebar handles resize from the keyboard', keyboardFlow);
test('a window too narrow for the transcript collapses the dock to the rail, and widening restores it', autoCollapseFlow);
test('a reload restores the docked app at its width and route, off the URL', persistFlow);
test('the session width presets hold beside the dock', sessionWidthFlow);
test('on a phone the dock is absent and the plugin view works as before', phoneFlow);
test('a toast clears the rail and the dock handle', toastClearsRailFlow);
