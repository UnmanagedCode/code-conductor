import { test } from './harness/fixtures.ts';
import {
  KEEP, PLAIN, collapseFlow, dragClampFlow, fullExitFlow, installProbes, keyboardFlow, narrowWindowFlow, noReloadFlow, persistFlow, phoneFlow, sessionHandleCoexistFlow, sessionWidthFlow,
  toastClearsToggleFlow, toggleGeometryFlow,
} from './plugin-dock.shared.ts';

// Its own cc with two probe plugins, one keep-alive and one plain.
test.use({ ccOptions: { server: 'plugin-dock' } });
test.beforeAll(async ({ cc }) => { await installProbes(cc); });

test('the column holds Collapse and its mode toggle left of the plugin\'s name and Close at the strip\'s end in a header strip: across the row in full, beside the session in split, gone on Conductor', toggleGeometryFlow);
test('Dock to side and Expand to full view never reload a plain plugin\'s page', noReloadFlow(PLAIN));
test('Dock to side and Expand to full view never reload a keep-alive plugin\'s page', noReloadFlow(KEEP));
test('Back and Escape from the full view land on Conductor, never on split, and a switch in full costs no entry', fullExitFlow);
test('a handle drag crossing the iframe resizes and stops at both limits, and a double-click resets the default width', dragClampFlow);
test('the dock and sidebar handles resize from the keyboard', keyboardFlow);
test('a window too narrow for any split shows the plugin full-screen without writing, and Escape or a session pick closes it keeping the remembered split; a narrower window clamps split; widening restores the stored width', narrowWindowFlow);
test('Collapse parks the split as a rail at the edge, widening the session, keeps the page live and scrolled, and Expand restores the width; a reload keeps the rail', collapseFlow);
test('a reload restores the split plugin at its width and the page\'s own route, checked in the switcher, off the URL', persistFlow);
test('a session width holds beside the dock', sessionWidthFlow);
test('the session handles stay clear of the dock and sidebar handles and the scrollbar, and each grab moves only its own box', sessionHandleCoexistFlow);
test('below md the plugin view is full-page whatever the remembered mode, with no toggle', phoneFlow);
test('a toast sits below the strip and never covers its toggle or Close', toastClearsToggleFlow);
