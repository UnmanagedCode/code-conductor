import { test } from './harness/fixtures.ts';
import { attachFlow, attachmentsFollowSessionFlow, attachmentsSurviveLeavingSessionViewFlow } from './composer-attach.shared.ts';

test('files from the Attach files button and from a drop become removable chips', attachFlow);
test('each session keeps its own chips and previews through sidebar switches, and removing one leaves the other session alone', attachmentsFollowSessionFlow);
test('a session keeps its chips and previews when the user leaves the session view and comes back', attachmentsSurviveLeavingSessionViewFlow);
