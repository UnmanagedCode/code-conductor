import path from 'node:path';
import { test } from './harness/fixtures.ts';
import { FIXTURES } from './harness/boot.ts';
import { codeFirstFlow, gutterFlow, iconSizeFlow, inlineEndFlow } from './speaker-gutter.shared.ts';

// Its own cc on the speaker scenario: one bubble of five text blocks between Bash calls, and one whose first block is code.
test.use({ ccOptions: { server: 'speaker-gutter', scenario: path.join(FIXTURES, 'scenario-speaker-gutter.json') } });

test('at md and up, every block but the first holds its read-aloud in the gutter, level with its first line; the first holds it after its last word', gutterFlow);
test('a first block ending in a code block keeps its read-aloud on a row under the code', codeFirstFlow);
test('below md, a block ending in prose holds its read-aloud after its last word and adds no line; a tap reads that block', inlineEndFlow);
test('every read-aloud keeps a 14px icon on a 28px button', iconSizeFlow);
