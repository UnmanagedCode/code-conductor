import { test } from './harness/fixtures.ts';
import { FAKE_MICROPHONE, holdToDictateFlow, recordingSurvivesLeavingSessionViewFlow } from './composer-dictate.shared.ts';

test.use(FAKE_MICROPHONE);

test('holding Send with text records until a tap and keeps the box focused; a short press sends, and a cancelled touch does nothing', holdToDictateFlow);
test('a recording keeps running when the user leaves the session view and comes back, and its transcript lands in its session', recordingSurvivesLeavingSessionViewFlow);
