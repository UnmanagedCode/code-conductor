// summarizeSessions' `handCount`: the non-archived, non-conducted subset of
// `count`, which the sidebar's Hand-spawned only filter reads to decide
// whether a place holds a hand-spawned session before any list is loaded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';

// Both roots are read at call time, so setting them before import isolates
// the conducted/archived sidecars and the transcripts.
const tmp = await mkdtemp('cc-hand-count-');
process.env.PROJECTS_ROOT = path.join(tmp, 'projects');
process.env.CLAUDE_PROJECTS_ROOT = path.join(tmp, 'claude-projects');

const { summarizeSessions, encodeCwd, localPlace } = await import('../src/projects.ts');
const { markConducted } = await import('../src/conductedSessions.ts');
const { markArchived } = await import('../src/archivedSessions.ts');

async function writeTranscript(dir, sid, timestamp) {
  await fs.writeFile(path.join(dir, `${sid}.jsonl`),
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp, message: { role: 'user', content: 'hi' } }) + '\n');
}

// Pins: handCount excludes both conducted and archived transcripts, and an
// archived conducted one lands in archivedCount only.
test('handCount counts only non-archived, non-conducted transcripts', async () => {
  const cwd = path.join(tmp, 'tree');
  const dir = path.join(process.env.CLAUDE_PROJECTS_ROOT, encodeCwd(cwd));
  await fs.mkdir(dir, { recursive: true });
  // Unequal hand and conducted counts, so counting the conducted subset
  // instead cannot pass.
  await writeTranscript(dir, 'hand', '2026-08-07T06:00:00.000Z');
  await writeTranscript(dir, 'conducted', '2026-08-07T07:00:00.000Z');
  await writeTranscript(dir, 'conducted-2', '2026-08-07T05:00:00.000Z');
  await writeTranscript(dir, 'archived-hand', '2026-08-07T08:00:00.000Z');
  await writeTranscript(dir, 'archived-conducted', '2026-08-07T09:00:00.000Z');
  await markConducted('conducted');
  await markConducted('conducted-2');
  await markConducted('archived-conducted');
  await markArchived('archived-hand');
  await markArchived('archived-conducted');

  assert.deepEqual(await summarizeSessions(localPlace(cwd)), {
    count: 3, archivedCount: 2, handCount: 1, lastActivity: Date.parse('2026-08-07T07:00:00.000Z'),
  });
});

// Pins: the no-transcripts shape carries handCount too, so the client never
// sees a summary without it.
test('a missing transcript dir yields handCount 0', async () => {
  assert.deepEqual(await summarizeSessions(localPlace(path.join(tmp, 'nowhere'))), {
    count: 0, archivedCount: 0, handCount: 0, lastActivity: 0,
  });
});
