import { test } from './harness/fixtures.ts';
import { draftsFollowSessionFlow, leaveSessionViewFlow } from './composer-drafts.shared.ts';

test('a draft follows its session through sidebar switches byte for byte, and a reload keeps a draft whose save was pending', draftsFollowSessionFlow);
test('text typed just before leaving the session view survives the page closing before its save was due', leaveSessionViewFlow);
