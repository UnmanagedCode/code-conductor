import { test } from './harness/fixtures.ts';
import { chipFlow, longTitleFlow } from './composer-chip.shared.ts';

test('a chip set through the API shows live on every page, × clears it everywhere, and Send carries it into the transcript once', chipFlow);
test('a long chip title truncates inside the composer and leaves the × hittable', longTitleFlow);
