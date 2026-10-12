import path from 'node:path';
import { test } from './harness/fixtures.ts';
import { FIXTURES } from './harness/boot.ts';
import { tailFirstUsageFlow } from './paged-call-usage.shared.ts';

// Its own cc: a three-event snapshot tail on the bubble scenario, whose plain turns carry per-call usage.
test.use({ ccOptions: { server: 'paged-call-usage', scenario: path.join(FIXTURES, 'scenario-conversation-bubbles.json'), env: { ORCH_SNAPSHOT_TAIL: '3' } } });

test('a usage line whose call_usage opens the snapshot tail shows once the page holding its message loads', tailFirstUsageFlow);
