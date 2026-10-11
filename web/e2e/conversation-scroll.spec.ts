import { test } from './harness/fixtures.ts';
import { anchorFlow, lineageFlow, rewindFlow, stickFlow, viewReturnFlow } from './conversation-scroll.shared.ts';

// Its own cc: a two-event snapshot tail, so older history pages in through lineage-events.
test.use({ ccOptions: { server: 'conversation-scroll', env: { ORCH_SNAPSHOT_TAIL: '2' } } });

test('live output keeps a reader at the bottom there; a reader scrolled up stays put; re-opening the session lands at the bottom', stickFlow);
test('leaving a full-page view puts the transcript back where the reader left it', viewReturnFlow);
test('a rewind from a prompt the reader scrolled up to lands them at the bottom of the rewound transcript', rewindFlow);
test('an older page spliced above keeps the prompt being read where it was on screen', anchorFlow);
test('a lineage walk shows its dividers and gap in order, and only the current segment offers rewind and fork', lineageFlow);
