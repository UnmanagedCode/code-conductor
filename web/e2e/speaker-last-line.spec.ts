import path from 'node:path';
import { test } from './harness/fixtures.ts';
import { FIXTURES } from './harness/boot.ts';
import { codeFirstFlow, iconSizeFlow, lastLineFlow } from './speaker-last-line.shared.ts';

// Its own cc on the speaker scenario: one bubble of five text blocks between Bash calls, and one whose first block is code.
test.use({ ccOptions: { server: 'speaker-last-line', scenario: path.join(FIXTURES, 'scenario-speaker-last-line.json') } });

test('every block ending in prose holds its read-aloud after its last word, on its last line, inside the body; a block ending in code keeps a row under it; a tap reads that block', lastLineFlow);
test('a first block ending in a code block keeps its read-aloud on a row under the code, at the code\'s left edge', codeFirstFlow);
test('every read-aloud keeps a 14px icon on a 28px button', iconSizeFlow);
