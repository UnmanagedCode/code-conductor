// Migration 0040: every plugin registry record gains a boolean `autoStart`
// (start the plugin's backend when cc boots).
//
// Before (under <root>/.code-conductor/):
//   plugins/registry.json   {plugins: {<id>: {project, enabled, activeVersion}}}
// After:
//   plugins/registry.json   {plugins: {<id>: {project, enabled, activeVersion, autoStart: false}}}
// A record that already holds a boolean `autoStart` keeps it; every other key
// of every record is preserved.
//
// ── PROBE ──────────────────────────────────────────────────────────────────
// No file, or every record already has a boolean `autoStart` → no-op.
//
// ── A CORRUPT FILE NEVER BLOCKS BOOT ───────────────────────────────────────
// A registry.json that cannot be read or parsed, or whose `plugins` is not an
// object, is left untouched and the run is `{applied:false}`: its loader owns
// that file (the `.corrupt` move-aside and the Settings notice). A record that
// is not an object is skipped the same way. A failed WRITE is a fault about the
// environment and aborts the boot.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0040-plugin-autostart-flag';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

async function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

export async function run({ root, log = () => {} } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const registryFile = path.join(projectsRoot, '.code-conductor', 'plugins', 'registry.json');

  let registry;
  try { registry = JSON.parse(await fs.readFile(registryFile, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { applied: false };
    log(`  ! ${name}: cannot read ${registryFile}: ${e.message}; left for its loader`);
    return { applied: false };
  }
  if (!isObject(registry) || !isObject(registry.plugins)) return { applied: false };

  const records = Object.keys(registry.plugins)
    .filter(id => isObject(registry.plugins[id]) && typeof registry.plugins[id].autoStart !== 'boolean');
  if (records.length === 0) return { applied: false };

  for (const id of records) registry.plugins[id].autoStart = false;
  await writeAtomic(registryFile, JSON.stringify(registry, null, 2) + '\n');
  return { applied: true, summary: { records } };
}
