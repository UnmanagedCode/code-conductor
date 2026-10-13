import path from 'node:path';
import { test } from './harness/fixtures.ts';
import { FIXTURES } from './harness/boot.ts';
import { blockReadAloudFlow, controlsReturnFlow, liveControlsFlow, queuedGhostsFlow } from './conversation-bubbles.shared.ts';

// Its own cc on the bubble scenario: a bubble held mid-stream, released by a permission-mode change.
test.use({ ccOptions: { server: 'conversation-bubbles', scenario: path.join(FIXTURES, 'scenario-conversation-bubbles.json') } });

test('a bubble whose turn is still running: its controls are enabled, copy takes the source streamed so far and is announced, and raw holds as the block finishes', liveControlsFlow);
test('read-aloud through raw and back, the raw view through a full-page view, and the same copy and raw view after a reload', controlsReturnFlow);
test('every finished text block has a read-aloud of its own that reads that block, and a block still streaming has none', blockReadAloudFlow);
test('queued messages show as ghosts that stay on screen, marked delivered, when the usage window resets', queuedGhostsFlow);
