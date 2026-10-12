import { test } from './harness/fixtures.ts';
import { rowKeysFlow } from './keyboard-focus.shared.ts';

test.use({ ccOptions: { server: 'keyboard-focus' } });

test("Enter and Space on a sidebar row's Make persistent, Stop, Archive and Show workers buttons run that button and never open the session; Enter and Space on the row's own button open it; no sidebar control is nested inside another", rowKeysFlow);
