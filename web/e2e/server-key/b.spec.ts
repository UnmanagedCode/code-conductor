import { test } from '../harness/fixtures.ts';
import { record } from './record.ts';

test.use({ ccOptions: { server: 'key-b' } });

test('server key-b: records its cc', ({ cc }, testInfo) => {
  record(testInfo, 'b', cc);
});
