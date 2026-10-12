import { test } from './harness/fixtures.ts';
import { onlyPaneScrollsFlow, pageNeverScrollsFlow, paneHoldsHiddenInputFlow, pluginHoldsHiddenInputFlow } from './page-scroll.shared.ts';

// Its own cc: the flows create projects, a session and the fixture plugin.
test.use({ ccOptions: { server: 'page-scroll' } });
test.describe.configure({ timeout: 300_000 });

test('the page never scrolls and the shell fills the viewport on every Settings section and every full-page view', pageNeverScrollsFlow);
test("an absolutely positioned hidden input at the foot of a view's scrolling content stays in its pane: it never extends the page or the shell, and scrolls into view with the content", paneHoldsHiddenInputFlow);
test("the plugin view's section is the containing block of an absolutely positioned hidden input it holds, so the input never extends the page or the shell", pluginHoldsHiddenInputFlow);
test('scrolling the Settings content to its end and past it moves only the content pane: the sidebar, the Settings nav and the shell stay in place', onlyPaneScrollsFlow);
