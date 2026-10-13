import { test } from './harness/fixtures.ts';
import { pagedDecisionFlow } from './paged-plan-card.shared.ts';

test.use({ ccOptions: { server: 'paged-plan-card', env: { ORCH_SNAPSHOT_TAIL: '2' } } });

test('a plan card from an older page re-opens with its feedback when Reject can\'t reach the CLI, and sends again', pagedDecisionFlow('Reject'));
test('a plan card from an older page re-opens with its feedback when Approve can\'t reach the CLI, and sends again', pagedDecisionFlow('Approve'));
