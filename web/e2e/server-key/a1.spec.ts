import { test } from '../harness/fixtures.ts';
import { record } from './record.ts';

test.use({ ccOptions: { server: 'key-a' } });

test('server key-a, first file: records its cc', ({ cc }, testInfo) => {
  record(testInfo, 'a1', cc);
});
