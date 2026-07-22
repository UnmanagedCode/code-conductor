// Migration 0019: move the Sonnet context window from a single global into the
// individual model bindings that use it.
//
// Before:
//   models.sonnetContextWindow = '1m' | '200k'   (one global, applied to every
//                                                  Sonnet binding at once)
//   models.tierBackend[tier]   = { kind:'claude', model:'claude-sonnet-4-6' }
//   models.roleBackend[role]   = { kind:'claude', model:'claude-sonnet-4-5' } | …
// After:
//   (models.sonnetContextWindow deleted)
//   models.tierBackend[tier]   = { kind:'claude', model:'claude-sonnet-4-6', window:'200k' }
//   models.roleBackend[role]   = { kind:'claude', model:'claude-sonnet-4-5', window:'200k' } | …
//
// The old global is backfilled onto every persisted Sonnet 4.x Claude binding
// (tier bindings + direct-claude role bindings). This is exhaustive without
// silent flips: the default `balanced` binding is claude-sonnet-5, which is
// fixed at 1M and ignores the window — so the ONLY bindings the global could
// ever have affected are explicitly-set Sonnet 4.x ones, and those are by
// definition persisted here. A global of '1m' backfills nothing meaningful
// (1m is the default) but is still applied for exactness. Non-Sonnet / Sonnet-5
// / Ollama / tier-reference role bindings are left untouched.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0019-inline-sonnet-window-into-bindings';

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

// A Sonnet version whose window is user-selectable (Sonnet 4.x) — i.e. a
// 'claude-sonnet-*' id that is NOT the fixed-1M Sonnet 5. Frozen snapshot rule.
function isSelectableSonnet(model) {
  return typeof model === 'string'
    && model.startsWith('claude-sonnet')
    && model !== 'claude-sonnet-5';
}

export async function run({ root, log = () => {} } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const settingsFile = path.join(projectsRoot, '.code-conductor', 'settings.json');

  const settings = await readJsonSafe(settingsFile);
  if (!settings || typeof settings !== 'object' || !settings.models || typeof settings.models !== 'object') {
    return { applied: false };
  }
  const models = settings.models;
  // Idempotency probe: once the global is gone, there's nothing left to do.
  if (!('sonnetContextWindow' in models)) return { applied: false };

  const window = models.sonnetContextWindow === '200k' ? '200k' : '1m';
  let backfilled = 0;

  const backfill = (binding) => {
    if (binding && typeof binding === 'object' && binding.kind === 'claude' && isSelectableSonnet(binding.model)) {
      binding.window = window;
      backfilled += 1;
    }
  };

  if (models.tierBackend && typeof models.tierBackend === 'object') {
    for (const b of Object.values(models.tierBackend)) backfill(b);
  }
  if (models.roleBackend && typeof models.roleBackend === 'object') {
    // Only direct-claude role bindings carry a model; tier-reference bindings
    // ({kind:'tier',tier}) inherit the tier binding's window and are skipped.
    for (const b of Object.values(models.roleBackend)) backfill(b);
  }

  delete models.sonnetContextWindow;
  await writeJsonAtomic(settingsFile, settings);

  log(`  ✓ inlined Sonnet window '${window}' onto ${backfilled} binding(s); dropped global sonnetContextWindow`);
  return { applied: true, summary: { window, backfilled } };
}
