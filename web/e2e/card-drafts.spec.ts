import { test } from './harness/fixtures.ts';
import { caretFlow, viewReturnFlow } from './card-drafts.shared.ts';

test.use({ ccOptions: { server: 'card-drafts' } });

test('leaving a full-page view brings back a plan card\'s feedback and a question card\'s tab, pick and note', viewReturnFlow);
test('typing in the middle of a card\'s text keeps the caret where the reader typed', caretFlow);
