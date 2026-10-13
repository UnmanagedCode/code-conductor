import { test } from './harness/fixtures.ts';
import { commitsHeaderFlow, sessionHeaderFlow, settingsHeaderFlow } from './toast-header.shared.ts';

// Its own cc: the flows sync, lock and switch modes.
test.use({ ccOptions: { server: 'toast-header' } });

test('with a toast showing and hovered, every control of the commit history\'s header takes a real click, and the toast stays announced, dismissable and leaves on its own', commitsHeaderFlow);
test('with a toast showing and hovered, every control of the session header takes a real click', sessionHeaderFlow);
test('with a refused restore\'s toast showing and hovered, every control of the phone Settings bar takes a real click', settingsHeaderFlow);
