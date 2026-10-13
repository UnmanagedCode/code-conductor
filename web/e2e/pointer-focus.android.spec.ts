import { test } from './harness/fixtures.ts';
import { drawerFlow, RETURNS, sessionDialogsFlow } from './keyboard-focus.shared.ts';
import { ACTS, by, pointerFlow, TEXT_TARGETS, touchButtonTargetFlow, touchTextTargetFlow, type How } from './pointer-focus.shared.ts';

test.use({ ccOptions: { server: 'pointer-focus' } });

for (const how of ['mouse', 'tap'] as How[]) {
  for (const row of RETURNS) test(`a dialog opened by ${how} has focus inside from the moment it opens, keeps Tab and Shift+Tab inside, and returns focus to its opener: ${row.name}`, pointerFlow(row, how));
  test(`Summarize, Statistics and Prune opened by ${how} keep Tab and Shift+Tab inside from the moment they open, and closing returns focus to Session actions`, by(how, sessionDialogsFlow(ACTS[how], `dialogs-${how}`)));
  test(`the navigation drawer opened by ${how} keeps Tab and Shift+Tab inside while open and Escape returns focus to Open sidebar`, by(how, drawerFlow(ACTS[how])));
}
for (const name of Object.keys(TEXT_TARGETS)) test(`on touch, a dialog whose opening target is a text field opens focused on the dialog itself: ${name}`, touchTextTargetFlow(name));
test('on touch, a dialog whose opening target is not a text field keeps it: a row action confirm', touchButtonTargetFlow);
