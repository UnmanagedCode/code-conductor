// Migration 0042: the retired generated-client directory is moved aside, never
// deleted, and the run is idempotent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as m0042 from '../migrations/0042-remove-mcp-client-dir.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

const storeOf = (root) => path.join(root, '.code-conductor');

test('a present mcp-client dir is moved under migrated-backup-0042-*, contents intact', async () => {
  const root = await mkdtemp('cc-mig42-');
  const dir = path.join(storeOf(root), 'mcp-client');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'conductor_client.mjs'), 'export {};\n');
  const r = await m0042.run({ root });
  assert.equal(r.applied, true);
  await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
  const backups = (await fs.readdir(storeOf(root))).filter(n => n.startsWith('migrated-backup-0042-'));
  assert.equal(backups.length, 1);
  assert.equal(
    await fs.readFile(path.join(storeOf(root), backups[0], 'mcp-client', 'conductor_client.mjs'), 'utf8'),
    'export {};\n',
  );
});

test('a second run is a no-op and leaves exactly one backup', async () => {
  const root = await mkdtemp('cc-mig42-');
  await fs.mkdir(path.join(storeOf(root), 'mcp-client'), { recursive: true });
  await m0042.run({ root });
  const again = await m0042.run({ root });
  assert.equal(again.applied, false);
  const backups = (await fs.readdir(storeOf(root))).filter(n => n.startsWith('migrated-backup-0042-'));
  assert.equal(backups.length, 1);
});

test('an absent dir (or absent store) is a no-op that creates nothing', async () => {
  const root = await mkdtemp('cc-mig42-');
  assert.equal((await m0042.run({ root })).applied, false);
  await assert.rejects(fs.stat(storeOf(root)), { code: 'ENOENT' });
});
