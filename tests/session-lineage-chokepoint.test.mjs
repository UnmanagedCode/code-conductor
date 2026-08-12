// Structural gate: EVERY persisted-transcript path is built by
// `sessionFilePath()` / `subAgentDirPath()` in src/projects.ts, and nowhere else.
//
// Why a source scan rather than a behavioural test: a session's public id is not
// a filename, so a `${sid}.jsonl` join that skipped resolution would silently
// read the wrong transcript (or none) — and the only signal would be missing
// history, which no existing test asserts the absence of. The chokepoint is what
// keeps `assertBackingId` able to catch that at runtime; this test is what keeps
// the chokepoint total.
//
// Fail-by-default, in the same shape as tests/mcp-conductor-view.test.mjs's
// doc-drift gate: a new `.jsonl` path literal fails until it is either routed
// through the helpers or added to EXEMPT below with a reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Every `.jsonl` string/template literal that is legitimately NOT a session
// transcript path, keyed by file → the exact literals allowed there.
const EXEMPT = {
  // THE chokepoint itself, plus the readdir suffix filters that scan a cwd's
  // directory (they consume filenames, they do not construct a path).
  'src/projects.ts': ['`${backingId}.jsonl`', "'.jsonl'"],
  // The sub-agent LEAF filename is agentId-keyed; its session-keyed directory
  // already comes from subAgentDirPath.
  'src/transcript.ts': ['`agent-${agentId}.jsonl`'],
  // Raw CLI stream captures under the debug dir — not transcripts.
  'src/instances.ts': ["'claude-stdin.jsonl'", "'claude-stdout.jsonl'"],
  // Orchestrator-owned append-only logs under <store>/, not session files.
  'src/costTracking.ts': ["'costs.jsonl'"],
  'src/playbookLedger.ts': ["'playbook-ledger.jsonl'"],
};

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

// Strip `//` line comments so the prose in module headers (which names paths like
// `<sid>.jsonl` freely, and should stay free to) can't trip the gate. Crude but
// sufficient: no `.jsonl` literal in this codebase sits inside a string that
// itself contains `//`.
function stripLineComments(src) {
  return src.split('\n').map(line => {
    const at = line.indexOf('//');
    return at === -1 ? line : line.slice(0, at);
  }).join('\n');
}

const LITERAL_RE = /`[^`]*\.jsonl`|'[^']*\.jsonl'|"[^"]*\.jsonl"/g;

test('every .jsonl path literal in src/ is the chokepoint or an explicitly exempt one', async () => {
  const files = await sourceFiles();
  assert.ok(files.length > 40, `expected the whole src tree, walked only ${files.length} files`);

  const violations = [];
  let exemptSeen = 0;
  for (const rel of files) {
    const src = stripLineComments(await fs.readFile(path.join(ROOT, rel), 'utf8'));
    const allowed = EXEMPT[rel] ?? [];
    for (const m of src.match(LITERAL_RE) ?? []) {
      if (allowed.includes(m)) { exemptSeen++; continue; }
      violations.push(`${rel}: ${m}`);
    }
  }

  assert.deepEqual(violations, [], 'route these through sessionFilePath() / subAgentDirPath()');
  // Non-vacuity: the scanner must actually be finding literals. If the regex
  // or the walk broke, this catches it instead of passing on an empty set.
  const expectedExempt = Object.values(EXEMPT).flat().length;
  assert.ok(exemptSeen >= expectedExempt,
    `matched only ${exemptSeen} exempt literals, expected >= ${expectedExempt} — the scanner is not seeing the source`);
});

test('G4 — no `${…}.jsonl` interpolation outside src/projects.ts and the sub-agent leaf', async () => {
  // The plan's G4 grep, as an assertion. Narrower than the test above (it only
  // sees INTERPOLATED literals) and it is the one that catches the actual
  // regression shape: someone re-deriving a transcript path from an id variable.
  const g4 = /`[^`]*\$\{[^}]*\}[^`]*\.jsonl`/g;
  const hits = [];
  for (const rel of await sourceFiles()) {
    const src = stripLineComments(await fs.readFile(path.join(ROOT, rel), 'utf8'));
    for (const m of src.match(g4) ?? []) hits.push(`${rel}: ${m}`);
  }
  assert.deepEqual(hits.sort(), [
    'src/projects.ts: `${backingId}.jsonl`',
    'src/transcript.ts: `agent-${agentId}.jsonl`',
  ]);
});

test('the gate fails on a planted violation (vacuity guard)', () => {
  // Proves the scanner can't silently pass: run it over a synthetic source.
  const planted = stripLineComments([
    "// a comment naming `${sid}.jsonl` must NOT count",
    'const file = path.join(dir, `${sessionId}.jsonl`);',
  ].join('\n'));
  const found = planted.match(LITERAL_RE) ?? [];
  assert.deepEqual(found, ['`${sessionId}.jsonl`'], 'code counts, comments do not');
});
