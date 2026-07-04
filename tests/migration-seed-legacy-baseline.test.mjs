// Unit tests for migration 0009 (seed the workspace-CLAUDE.md baseline from
// the legacy shell-installer's baseline file when present). Verifies the
// seed, the no-legacy no-op, the already-seeded no-op, and idempotency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0009 from '../migrations/0009-seed-legacy-shell-installer-baseline.mjs';

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-seed-legacy-baseline-'));
}

async function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) {
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return await fn(); }
  finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function baselinePathFor(root) {
  return path.join(root, '.code-conductor', 'workspace-claudemd', 'baseline.md');
}

test('seeds the baseline verbatim from the legacy file when present', async () => {
  const root = await mkTmp();
  const legacyDir = await mkTmp();
  const legacy = path.join(legacyDir, 'CLAUDE.md.installed');
  await fs.writeFile(legacy, 'LEGACY CANONICAL\n');
  try {
    await withEnv({ TCC_LEGACY_BASELINE: legacy }, async () => {
      const res = await m0009.run({ root, log: () => {} });
      assert.equal(res.applied, true);
      assert.deepEqual(res.summary, { seededFrom: 'legacy' });
      assert.equal(await fs.readFile(baselinePathFor(root), 'utf8'), 'LEGACY CANONICAL\n');
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(legacyDir, { recursive: true, force: true });
  }
});

test('no-op when the legacy file is absent', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ TCC_LEGACY_BASELINE: path.join(root, 'no-legacy') }, async () => {
      const res = await m0009.run({ root, log: () => {} });
      assert.equal(res.applied, false);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('no-op when the baseline already exists, regardless of a legacy file', async () => {
  const root = await mkTmp();
  const legacyDir = await mkTmp();
  const legacy = path.join(legacyDir, 'CLAUDE.md.installed');
  await fs.writeFile(legacy, 'LEGACY CANONICAL\n');
  const baseline = baselinePathFor(root);
  await fs.mkdir(path.dirname(baseline), { recursive: true });
  await fs.writeFile(baseline, 'EXISTING BASELINE\n');
  try {
    await withEnv({ TCC_LEGACY_BASELINE: legacy }, async () => {
      const res = await m0009.run({ root, log: () => {} });
      assert.equal(res.applied, false);
      assert.equal(await fs.readFile(baseline, 'utf8'), 'EXISTING BASELINE\n');
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(legacyDir, { recursive: true, force: true });
  }
});

test('idempotent: second run after seeding is a no-op', async () => {
  const root = await mkTmp();
  const legacyDir = await mkTmp();
  const legacy = path.join(legacyDir, 'CLAUDE.md.installed');
  await fs.writeFile(legacy, 'LEGACY CANONICAL\n');
  try {
    await withEnv({ TCC_LEGACY_BASELINE: legacy }, async () => {
      const res1 = await m0009.run({ root, log: () => {} });
      assert.equal(res1.applied, true);
      const res2 = await m0009.run({ root, log: () => {} });
      assert.equal(res2.applied, false);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(legacyDir, { recursive: true, force: true });
  }
});
