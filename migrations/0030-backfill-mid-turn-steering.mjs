// Migration 0030: backfill the per-model `midTurnSteering` capability flag onto
// every stored custom model.
//
// Before (settings.json):
//   models.customModels = [{ label, model, backend, contextWindow }]
// After:
//   models.customModels = [{ label, model, backend, contextWindow, midTurnSteering: true }]
//
// `midTurnSteering: false` means the model cannot accept a user message written
// INTO a running turn (it hard-errors or silently swallows it), so cc stops the
// turn at a block edge and delivers the message as a fresh turn instead. Every
// pre-existing row predates the flag and was being steered mid-turn, so `true`
// (the unchanged behaviour) is the only correct backfill. Only the user's own
// rows are touched: the curated Ollama cloud presets live in src/ and are never
// persisted (per migrations.md, src/ is never imported here).
//
// Idempotent: a no-op once every row already carries a boolean flag.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0030-backfill-mid-turn-steering';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

async function readJsonSafe(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
}

async function writeJsonAtomic(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, file);
}

export async function run({ root, log = () => {} } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const settingsFile = path.join(projectsRoot, '.code-conductor', 'settings.json');

  const settings = await readJsonSafe(settingsFile);
  const list = settings?.models?.customModels;
  if (!Array.isArray(list)) return { applied: false };

  let backfilled = 0;
  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue;
    if (typeof rec.midTurnSteering === 'boolean') continue; // already flagged
    rec.midTurnSteering = true;
    backfilled += 1;
  }
  if (!backfilled) return { applied: false };

  await writeJsonAtomic(settingsFile, settings);
  log(`  ✓ backfilled midTurnSteering:true onto ${backfilled} custom model${backfilled === 1 ? '' : 's'}`);
  return { applied: true, summary: { backfilled } };
}
