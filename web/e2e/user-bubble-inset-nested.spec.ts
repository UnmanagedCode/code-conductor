import path from 'node:path';
import { test } from './harness/fixtures.ts';
import { FIXTURES } from './harness/boot.ts';
import { nestedFlow } from './user-bubble-inset.shared.ts';

// Its own cc on the nested scenario: an Agent call (SUB-INSET) whose sub-agent has a prompt and a text reply.
test.use({ ccOptions: { server: 'user-bubble-inset-nested', scenario: path.join(FIXTURES, 'scenario-user-bubble-inset.json') } });

test("a sub-agent's user bubble starts one avatar gutter past the sub-agent's text and fills to the panel edge", nestedFlow);
