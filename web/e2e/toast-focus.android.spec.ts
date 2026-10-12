import { test } from './harness/fixtures.ts';
import { altTFlow, closeReturnsFocusFlow, forwardTabFlow } from './toast-focus.shared.ts';

test('with a toast showing, forward Tab moves through it and on in page order, never back to the element it came from, and Shift+Tab walks back out to that element', forwardTabFlow);
test('closing a toast by keyboard or pointer returns focus to the element focus came from', closeReturnsFocusFlow);
test('Alt+T focuses the toast list in the polite Notifications region, and leaving that visit returns focus to where Alt+T was pressed', altTFlow);
