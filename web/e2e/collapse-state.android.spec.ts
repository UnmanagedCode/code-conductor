import { test } from './harness/fixtures.ts';
import { cardReopenFlow, foldsReturnFlow, toolsReturnFlow } from './collapse-state.shared.ts';

test.use({ ccOptions: { server: 'collapse-state' } });

test('an opened tool card keeps its Arguments and Result through closing and reopening it', cardReopenFlow);
test('leaving a full-page view brings back the tool card and thinking block the reader opened, on the prompt being read', toolsReturnFlow);
test('leaving a full-page view brings back the fold and raw views the reader set, on the prompt being read', foldsReturnFlow);
