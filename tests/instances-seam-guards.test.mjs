// Structural gate for the modules split out of src/instances.ts: the event
// log's single-writer rule (tests/event-log-chokepoint.test.mjs lists
// src/instances.ts by path) applies to every file under src/instances/ too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function stripLineComments(src) {
  return src.split('\n').map(line => {
    const at = line.indexOf('//');
    return at === -1 ? line : line.slice(0, at);
  }).join('\n');
}

const importRe = /from\s+['"][^'"]*\/eventLog(?:\.ts)?['"]/;

const seamFiles = (await fs.readdir(path.join(ROOT, 'src/instances'), { withFileTypes: true }))
  .filter(e => e.isFile() && e.name.endsWith('.ts'))
  .map(e => e.name)
  .sort();

test('regex control', () => {
  assert.match("import { createEventLog } from '../eventLog.ts';", importRe);
  assert.match('import x from "../eventLog"', importRe);
  assert.doesNotMatch(stripLineComments("// import x from '../eventLog.ts'"), importRe);
  assert.doesNotMatch("import x from '../eventLogView.ts'", importRe);
});

test('the seam directory is scanned', () => {
  assert.ok(seamFiles.length >= 1);
  assert.ok(seamFiles.includes('overageRouting.ts'));
});

for (const f of seamFiles) {
  test(`src/instances/${f} does not import src/eventLog.ts`, async () => {
    const src = stripLineComments(await fs.readFile(path.join(ROOT, 'src/instances', f), 'utf8'));
    assert.doesNotMatch(src, importRe);
  });
}
