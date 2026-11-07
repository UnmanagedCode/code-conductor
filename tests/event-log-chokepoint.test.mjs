// Structural gate for the event log's single-writer rule — a checkable
// invariant, not a review habit. Same shape as
// tests/session-lineage-chokepoint.test.mjs: a source scan, fail-by-default,
// `//` comments stripped so prose naming the module cannot trip it.

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

async function sourceFiles() {
  const out = [];
  async function walk(rel) {
    for (const entry of await fs.readdir(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith('.ts')) out.push(child);
    }
  }
  await walk('src');
  out.push('server.ts');
  return out;
}

// Count `pattern` per file across src/** and server.ts.
async function hitsByFile(pattern) {
  const files = await sourceFiles();
  assert.ok(files.length > 40, `expected the whole src tree, walked only ${files.length} files`);
  const hits = {};
  for (const rel of files) {
    const n = ((await read(rel)).match(pattern) ?? []).length;
    if (n) hits[rel] = n;
  }
  return hits;
}

test('the surfaces the manager stream reaches never import the event log: routes, instances, idleSubscriptions, playbookApi, wsHub', async () => {
  // They reach the log only through the gate (reads) and the manager's event
  // stream (writes), so none of them can grow a second writer.
  const importRe = /from\s+['"][^'"]*\/eventLog(?:\.ts)?['"]/;
  for (const rel of ['src/routes.ts', 'src/instances.ts', 'src/idleSubscriptions.ts', 'src/playbookApi.ts', 'src/wsHub.ts']) {
    assert.doesNotMatch(await read(rel), importRe, `${rel} must not import src/eventLog.ts`);
  }
});

test('exactly one eventLog.append( call site in src/** and server.ts, in src/mcp/playbookGate.ts', async () => {
  assert.deepEqual(await hitsByFile(/\beventLog\.append\(/g), { 'src/mcp/playbookGate.ts': 1 });
});

test('the log is constructed only by the gate: one createEventLog( call outside its definition', async () => {
  assert.deepEqual(await hitsByFile(/\bcreateEventLog\(/g), { 'src/eventLog.ts': 1, 'src/mcp/playbookGate.ts': 1 });
});

test('src/eventLog.ts holds exactly one appendFileSync( — the one write', async () => {
  const hits = (await read('src/eventLog.ts')).match(/\bappendFileSync\(/g) ?? [];
  assert.equal(hits.length, 1);
});

test('nothing in src/** or server.ts names the old ledger file: no back-compat reader', async () => {
  assert.deepEqual(await hitsByFile(/playbook-ledger/g), {});
});
