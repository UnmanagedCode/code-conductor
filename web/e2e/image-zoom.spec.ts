import { test } from './harness/fixtures.ts';
import { largeStartsAtTapFlow, outsideClickClosesFlow, smallFitsCenteredFlow, tallScrollsBesideImageFlow, wideReanchorsOnZoomFlow } from './image-zoom.shared.ts';

// Its own cc, with classic scrollbars laid out (the worker option scopes to this file).
test.use({ ccOptions: { server: 'image-zoom' }, launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });
test.describe.configure({ timeout: 120_000 });

test('a zoomed image that fits is centred in the dialog, and fit and close are unchanged', smallFitsCenteredFlow);
test('a zoomed image taller than the viewer scrolls beside the image, starting at the tapped spot', tallScrollsBesideImageFlow);
test('a zoomed image larger than the viewer in both axes starts at the tapped spot', largeStartsAtTapFlow);
test('a wide image whose viewer grows on zoom starts at the tapped spot measured from the zoomed viewer', wideReanchorsOnZoomFlow);
test('a tap beside the image closes the preview, fit or zoomed, and never zooms', outsideClickClosesFlow);
