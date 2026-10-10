import { test } from '../harness/fixtures.ts';
import { record } from './record.ts';

// No ccOptions: the default server every such file shares.
test('no ccOptions (d2): records its cc', ({ cc }, testInfo) => {
  record(testInfo, 'd2', cc);
});
