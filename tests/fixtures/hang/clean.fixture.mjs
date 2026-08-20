// The control. Releases everything, so the run must go green AND exit promptly —
// which is what pins "the guard's own timers never outlive the run".
import test from 'node:test';

test('clean: holds nothing open', () => {});
