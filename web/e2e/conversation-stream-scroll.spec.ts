import path from 'node:path';
import { test } from './harness/fixtures.ts';
import { FIXTURES } from './harness/boot.ts';
import { dragWhileStreamingFlow } from './conversation-scroll.shared.ts';

// Its own cc on the stream-scroll scenario: a long reply held mid-stream (SCROLL-STREAM), each later frame released by a permission-mode change.
test.use({ ccOptions: { server: 'conversation-stream-scroll', scenario: path.join(FIXTURES, 'scenario-conversation-stream-scroll.json') } });

test('a reader holding or dragging the transcript while a reply streams is never moved; lifting at the bottom and Jump to latest resume following', dragWhileStreamingFlow);
