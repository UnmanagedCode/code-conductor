// Migration 0019: move the global models.sonnetContextWindow onto the
// individual Sonnet 4.x Claude bindings (tierBackend + direct-claude
// roleBackend), then delete the global.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0019 from '../migrations/0019-inline-sonnet-window-into-bindings.mjs';

async function mkTmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'cc-mig19-')); }
function settingsFile(root) { return path.join(root, '.code-conductor', 'settings.json'); }
async function writeJson(file, obj) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(obj, null, 2)); }
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }

test('backfills a 200k global onto Sonnet 4.x bindings and drops the global; leaves others untouched', async () => {
  const root = await mkTmp();
  await writeJson(settingsFile(root), {
    models: {
      sonnetContextWindow: '200k',
      tierBackend: {
        fast:     { kind: 'claude', model: 'claude-haiku-4-5' },   // non-sonnet → untouched
        balanced: { kind: 'claude', model: 'claude-sonnet-4-6' },  // Sonnet 4.x → window backfilled
        powerful: { kind: 'claude', model: 'claude-opus-4-8' },    // non-sonnet → untouched
        frontier: { kind: 'ollama', model: 'gemma4:cloud' },       // ollama → untouched
      },
      roleBackend: {
        conductor: { kind: 'tier', tier: 'powerful' },             // tier ref → untouched (inherits)
        reviewer:  { kind: 'claude', model: 'claude-sonnet-4-5' },  // direct Sonnet 4.x → backfilled
      },
    },
  });

  const res = await m0019.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(res.summary.window, '200k');
  assert.equal(res.summary.backfilled, 2);

  const m = (await readJson(settingsFile(root))).models;
  assert.equal('sonnetContextWindow' in m, false, 'global key deleted');
  assert.deepEqual(m.tierBackend.balanced, { kind: 'claude', model: 'claude-sonnet-4-6', window: '200k' });
  assert.deepEqual(m.roleBackend.reviewer, { kind: 'claude', model: 'claude-sonnet-4-5', window: '200k' });
  // Untouched:
  assert.deepEqual(m.tierBackend.fast, { kind: 'claude', model: 'claude-haiku-4-5' });
  assert.deepEqual(m.tierBackend.powerful, { kind: 'claude', model: 'claude-opus-4-8' });
  assert.deepEqual(m.tierBackend.frontier, { kind: 'ollama', model: 'gemma4:cloud' });
  assert.deepEqual(m.roleBackend.conductor, { kind: 'tier', tier: 'powerful' });

  // Idempotent — second run is a no-op (global already gone).
  const res2 = await m0019.run({ root, log: () => {} });
  assert.equal(res2.applied, false);

  await fs.rm(root, { recursive: true, force: true });
});

test('a Sonnet 5 binding is NOT given a window (fixed 1M); global still dropped', async () => {
  const root = await mkTmp();
  await writeJson(settingsFile(root), {
    models: {
      sonnetContextWindow: '200k',
      tierBackend: { balanced: { kind: 'claude', model: 'claude-sonnet-5' } },
    },
  });

  const res = await m0019.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(res.summary.backfilled, 0);

  const m = (await readJson(settingsFile(root))).models;
  assert.equal('sonnetContextWindow' in m, false);
  assert.deepEqual(m.tierBackend.balanced, { kind: 'claude', model: 'claude-sonnet-5' });

  await fs.rm(root, { recursive: true, force: true });
});

test('a 1m global backfills window:"1m" onto Sonnet 4.x bindings', async () => {
  const root = await mkTmp();
  await writeJson(settingsFile(root), {
    models: {
      sonnetContextWindow: '1m',
      tierBackend: { balanced: { kind: 'claude', model: 'claude-sonnet-4-6' } },
    },
  });

  const res = await m0019.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(res.summary.window, '1m');

  const m = (await readJson(settingsFile(root))).models;
  assert.deepEqual(m.tierBackend.balanced, { kind: 'claude', model: 'claude-sonnet-4-6', window: '1m' });

  await fs.rm(root, { recursive: true, force: true });
});

test('no-op when the global is already absent', async () => {
  const root = await mkTmp();
  await writeJson(settingsFile(root), {
    models: { tierBackend: { balanced: { kind: 'claude', model: 'claude-sonnet-4-6', window: '200k' } } },
  });

  const res = await m0019.run({ root, log: () => {} });
  assert.equal(res.applied, false);

  await fs.rm(root, { recursive: true, force: true });
});
