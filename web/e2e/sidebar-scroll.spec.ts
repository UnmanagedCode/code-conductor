import { test } from './harness/fixtures.ts';
import { onlyListScrollsFlow, tallStripFlow } from './sidebar-scroll.shared.ts';

test.use({ ccOptions: { server: 'sidebar-scroll' } });

test('scrolling the sidebar list moves the list only: the needs-you strip, the tab bar and the filter row keep their boxes', onlyListScrollsFlow);
test('a tall needs-you strip is bounded and scrolls within itself, and the list keeps a usable height, on a short viewport too', tallStripFlow);
