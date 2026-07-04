// Unit tests for migration 0008 (rewrite old flat session-summary entries
// in session-summaries.json to the tiered shape). Verifies the conversion,
// the invalid-entry drop path, mixed old/new shapes, and idempotency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0008 from '../migrations/0008-migrate-tiered-session-summaries.mjs';

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-tiered-summaries-'));
}

async function writeSummaries(root, summaries) {
  const file = path.join(root, '.code-conductor', 'session-summaries.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ summaries }, null, 2) + '\n');
  return file;
}

async function readSummaries(root) {
  const file = path.join(root, '.code-conductor', 'session-summaries.json');
  return JSON.parse(await fs.readFile(file, 'utf8')).summaries;
}

test('no-op when session-summaries.json does not exist', async () => {
  const root = await mkTmp();
  const res = await m0008.run({ root, log: () => {} });
  assert.equal(res.applied, false);
});

test('no-op when no entry is in the old flat shape', async () => {
  const root = await mkTmp();
  await writeSummaries(root, { 'sid-new': { medium: { summary: 'x', generatedAt: 1, messageCount: 2 } } });
  const res = await m0008.run({ root, log: () => {} });
  assert.equal(res.applied, false);
});

test('converts an old flat entry to the tiered shape', async () => {
  const root = await mkTmp();
  await writeSummaries(root, {
    'old-sid': { summary: 'Old summary.', length: 'medium', generatedAt: 999, messageCount: 7 },
  });
  const res = await m0008.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(res.summary.entriesMigrated, 1);
  assert.equal(res.summary.entriesDropped, 0);
  const summaries = await readSummaries(root);
  assert.deepEqual(summaries['old-sid'], { medium: { summary: 'Old summary.', generatedAt: 999, messageCount: 7 } });
});

test('drops an old-shape entry with an invalid length', async () => {
  const root = await mkTmp();
  await writeSummaries(root, {
    'bad-sid': { summary: 'x', length: 'huge', generatedAt: 1, messageCount: 1 },
  });
  const res = await m0008.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(res.summary.entriesDropped, 1);
  const summaries = await readSummaries(root);
  assert.ok(!('bad-sid' in summaries));
});

test('drops an old-shape entry with an empty summary', async () => {
  const root = await mkTmp();
  await writeSummaries(root, {
    'empty-sid': { summary: '   ', length: 'short', generatedAt: 1, messageCount: 1 },
  });
  const res = await m0008.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(res.summary.entriesDropped, 1);
  const summaries = await readSummaries(root);
  assert.ok(!('empty-sid' in summaries));
});

test('mixed old + new shape: only the old-shape entry is converted', async () => {
  const root = await mkTmp();
  await writeSummaries(root, {
    'old-sid': { summary: 'Old.', length: 'short', generatedAt: 1, messageCount: 1 },
    'new-sid': { long: { summary: 'New.', generatedAt: 2, messageCount: 2 } },
  });
  const res = await m0008.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(res.summary.entriesMigrated, 1);
  const summaries = await readSummaries(root);
  assert.deepEqual(summaries['old-sid'], { short: { summary: 'Old.', generatedAt: 1, messageCount: 1 } });
  assert.deepEqual(summaries['new-sid'], { long: { summary: 'New.', generatedAt: 2, messageCount: 2 } });
});

test('post-migration, getSummaries reads the converted entry correctly', async () => {
  const root = await mkTmp();
  await writeSummaries(root, {
    'old-sid': { summary: 'Old summary.', length: 'medium', generatedAt: 999, messageCount: 7 },
  });
  await m0008.run({ root, log: () => {} });

  process.env.PROJECTS_ROOT = root;
  try {
    const { getSummaries } = await import('../src/sessionSummaries.js');
    const tiers = await getSummaries('old-sid');
    assert.equal(tiers.medium?.summary, 'Old summary.');
    assert.equal(tiers.medium?.messageCount, 7);
    assert.equal(tiers.short, undefined);
    assert.equal(tiers.long, undefined);
  } finally {
    delete process.env.PROJECTS_ROOT;
  }
});

test('idempotent: second run is a no-op', async () => {
  const root = await mkTmp();
  await writeSummaries(root, {
    'old-sid': { summary: 'Old.', length: 'short', generatedAt: 1, messageCount: 1 },
  });
  const res1 = await m0008.run({ root, log: () => {} });
  assert.equal(res1.applied, true);
  const res2 = await m0008.run({ root, log: () => {} });
  assert.equal(res2.applied, false);
});
