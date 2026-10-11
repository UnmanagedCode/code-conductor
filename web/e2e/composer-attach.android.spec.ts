import { test } from './harness/fixtures.ts';
import { attachFlow } from './composer-attach.shared.ts';

test('files from the Attach files button and from a drop become removable chips', attachFlow);
