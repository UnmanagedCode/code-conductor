import { test } from '../harness/fixtures.ts';
import { record } from './record.ts';

test.use({ ccOptions: { server: 'key-a' } });

test('server key-a, second file with equal options: records its cc', ({ cc }, testInfo) => {
  record(testInfo, 'a2', cc);
});
