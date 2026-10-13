import { test, expect } from '../harness/fixtures.ts';
import { records } from './record.ts';

// Its own worker, so it is dispatched after every recording file.
test.use({ ccOptions: { server: 'z-check' } });

test('a file that sets ccOptions gets a cc of its own; files that set none share one', ({}, testInfo) => {
  const by = records(testInfo);
  const id = (l: string) => ({ root: by[l].root, port: by[l].port, worker: by[l].worker });
  expect(Object.keys(by).sort(), `records (a1, a2, b, d1 and d2 must all run first): ${JSON.stringify(by)}`)
    .toEqual(['a1', 'a2', 'b', 'd1', 'd2']);
  // Different server keys: distinct servers.
  expect(by.b.root).not.toBe(by.a1.root);
  expect(by.b.port).not.toBe(by.a1.port);
  expect(by.b.worker).not.toBe(by.a1.worker);
  // Equal ccOptions set in two files: still distinct (Playwright keys a worker
  // on where worker options are set, not only their values).
  expect(by.a2.root).not.toBe(by.a1.root);
  expect(by.a2.worker).not.toBe(by.a1.worker);
  // No ccOptions in either file: one shared server.
  expect(id('d2')).toEqual(id('d1'));
});
