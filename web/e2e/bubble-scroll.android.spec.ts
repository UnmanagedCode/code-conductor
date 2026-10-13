import path from 'node:path';
import { test } from './harness/fixtures.ts';
import { FIXTURES } from './harness/boot.ts';
import { chainingFlow, innerScrollFlow, longPlanFlow, shortPlanFlow } from './bubble-scroll.shared.ts';

// Its own cc on the bubble-scroll scenario: a short plan (PLAN-ASK) and a long one (PLAN-LONG).
test.use({ ccOptions: { server: 'bubble-scroll', scenario: path.join(FIXTURES, 'scenario-bubble-scroll.json') } });

test("a long plan's body is bounded and scrolls inside its card, with the header and Approve in view and the transcript at its bottom", longPlanFlow);
test("scrolling inside a plan's body leaves the transcript where it is", innerScrollFlow);
test("a scroll at either end of a plan's body carries on into the transcript", chainingFlow);
test('a short plan reserves no scroll space', shortPlanFlow);
