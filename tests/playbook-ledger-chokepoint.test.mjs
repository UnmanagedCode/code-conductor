// Structural gate for 2026-0130's "no second ledger write path" acceptance
// criterion — as a checkable invariant, not a review habit. Two claims:
//
//   • src/routes.ts, src/instances.ts and src/playbookApi.ts import the
//     playbook ledger ZERO times (the REST surfaces read it through the gate). The coupling from instances.ts to the gate is one-way, via the
//     'status' EventEmitter — nothing in either module may reach for the
//     ledger directly and grow a second writer.
//   • src/mcp/playbookGate.ts contains exactly ONE `ledger.append(` call
//     site — the serialized appendChain. A second call site would be a
//     second writer even if it also went through that chain.
//
// Same shape as tests/session-lineage-chokepoint.test.mjs: a source scan,
// fail-by-default, comments stripped so prose mentioning the module name
// cannot trip the gate.

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

async function read(rel) {
  return stripLineComments(await fs.readFile(path.join(ROOT, rel), 'utf8'));
}

test('src/routes.ts, src/instances.ts and src/playbookApi.ts import the playbook ledger zero times', async () => {
  const importRe = /from\s+['"][^'"]*playbookLedger(?:\.ts)?['"]/;
  for (const rel of ['src/routes.ts', 'src/instances.ts', 'src/playbookApi.ts']) {
    const src = await read(rel);
    assert.doesNotMatch(src, importRe,
      `${rel} must not import playbookLedger — the ledger has exactly one writer (src/mcp/playbookGate.ts)`);
  }
});

test('src/mcp/playbookGate.ts contains exactly one ledger.append( call site', async () => {
  const src = await read('src/mcp/playbookGate.ts');
  const hits = src.match(/\bledger\.append\(/g) ?? [];
  assert.equal(hits.length, 1,
    `expected exactly one ledger.append( call site (the serialized appendChain), found ${hits.length}`);
});
