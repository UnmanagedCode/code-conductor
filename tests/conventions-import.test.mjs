// withConventionsImport (src/conventionsImport.ts): the bytes
// ensureConventionsImport writes for a given CLAUDE.md, or null for no write.
// The update-time classifier relies on it being exactly the writer's content.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withConventionsImport } from '../src/conventionsImport.ts';

test('withConventionsImport(): the writer\'s content per CLAUDE.md state', async (t) => {
  const rows = [
    ['absent -> the import alone', null, '@CONVENTIONS.md\n'],
    ['not imported -> the import prepended to every byte', '# Notes\nsee CONVENTIONS.md\n', '@CONVENTIONS.md\n# Notes\nsee CONVENTIONS.md\n'],
    ['empty -> the import prepended', '', '@CONVENTIONS.md\n'],
    ['imported -> no write', '# Notes\n@CONVENTIONS.md\n', null],
    ['imported on an indented line -> no write', '  @CONVENTIONS.md  \n', null],
  ];
  for (const [title, input, expected] of rows) {
    await t.test(title, () => assert.equal(withConventionsImport(input), expected));
  }
});
