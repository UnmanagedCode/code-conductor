// Migration 0038: the wiki plugin's manifest id is renamed
// `code-karpathy-wiki` → `code-wiki`. Every store keyed by a plugin id, or by a
// plugin-contributed `<id>/<slug>`, is re-keyed so the plugin stays enabled,
// its live backend is adopted, and its conventions stay selected. The project
// name, its checkout and its repo do NOT change.
//
// Before (under <root>/.code-conductor/):
//   plugins/registry.json       {plugins: {"code-karpathy-wiki": {project, enabled, activeVersion}}}
//   plugins/runtime.json        {"code-karpathy-wiki": {pid, pgid, port, startedAt, gitHead}}
//   conventions/{conductor,workspace}.json   {disabled: ["code-karpathy-wiki/<slug>", …]}
//   settings.json               {models: {roleBackend|roleEffort: {"code-karpathy-wiki/<slug>": …}}}
//   <each registered local project>/CONVENTIONS.md, line 1:
//                               <!-- cc:conventions …,code-karpathy-wiki/<slug>,… -->
// After: the same records under `code-wiki` / `code-wiki/<slug>`, every other
// byte of every file preserved.
//
// ── DEFERRED ON THE DISCOVERED MANIFEST ────────────────────────────────────
// cc and the plugin checkout update independently. A blind rename on an
// install whose checkout still declares `code-karpathy-wiki` would disable the
// plugin in the opposite direction. So nothing is written until the plugin
// project's MAIN-checkout `conductor.plugin.json` — the file discovery reads the
// id from — says `code-wiki`. Until then the run is `{applied:false}` and is
// re-evaluated on every boot — silently, since that is the normal wait. A
// defer that can never resolve on its own (the plugin project's record missing
// or not `local`, its main-checkout manifest missing, unparsable or declaring
// some third id) logs a one-line warning naming the manual repair, every boot.
//
// ── THE DONE-FLAG IS THE OLD REGISTRY KEY ──────────────────────────────────
// Probe: `plugins["code-karpathy-wiki"]` absent from registry.json → no-op. It
// is deleted by the LAST step, and every earlier step is idempotent, so a run
// that dies part-way replays on the next boot. It is also NOT deleted when any
// earlier step could not read a file it needed, so that step retries next boot. A store that never had the
// record never enabled the plugin, so no convention of it can have been
// selected and there is nothing to migrate. No completion marker.
//
// ── A CORRUPT FILE NEVER BLOCKS BOOT ───────────────────────────────────────
// Every store this touches has an owner that tolerates corruption, so this
// does too: a file that cannot be read or parsed is logged by path, its step
// is skipped, and the old registry key is kept (see above). A corrupt
// registry.json defers the whole run — its loader owns that file. A failed
// WRITE is a fault about the environment and still aborts the boot.
//
// ── CONFLICTS: THE NEW KEY WINS ────────────────────────────────────────────
// A `code-wiki` record that already exists was made after the manifest changed
// (e.g. enabled in Settings before a restart) and is left untouched. A
// displaced registry record or role setting is written to
// <root>/.code-conductor/migrated-backup-0038/ before its key is removed.
//
// ── THE BACKEND IS ADOPTED, NOT STOPPED ────────────────────────────────────
// The runtime record moves to the new key. The backend never reads its own id;
// cc reaches it by port. At boot `adoptRunning()` keeps the record only if the
// id is enabled, discovered, its pid alive AND the manifest's healthPath
// answers on the recorded port — so a reused pid is dropped, never signalled.
// When a `code-wiki` runtime record already exists, the old one is left for
// boot to drop and its pid/pgid/port are reported with the manual repair; this
// migration kills nothing.
//
// ── KNOWN LIMITS ───────────────────────────────────────────────────────────
// - Migrations run only at boot. A manifest change picked up by a rescan while
//   cc runs (Library Update, a manual pull) reads as a disabled plugin until
//   the next restart, which applies this migration.
// - An `activeVersion` pinning a worktree whose manifest still declares the old
//   id is carried over as is; `doStart` refuses it until the pin is changed.
// - A plugin whose main checkout has no manifest and is discovered only
//   through a worktree's (discovery's bootstrap fallback) is not followed;
//   it defers with the "manifest missing" warning and is re-keyed by hand.
// - A registered REMOTE project's CONVENTIONS.md cannot be reached with
//   built-ins; each such project is named in the summary for a hand edit of
//   its line-1 marker.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0038-rename-wiki-plugin-id';

const OLD = 'code-karpathy-wiki';
const NEW = 'code-wiki';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

// The line-1 selection marker, as src/projectClaudeMd.ts parses it.
const MARKER_RE = /^<!-- cc:conventions ?(.*?) ?-->$/;

// A file that exists but cannot be read or parsed.
const UNREADABLE = Symbol('unreadable');

// Reads `file`: its text (or parsed JSON), null when absent, UNREADABLE (logged
// by path) on any other failure.
async function readTolerant(file, { json, log }) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    log(`  ! ${name}: cannot read ${file}: ${e.message}`);
    return UNREADABLE;
  }
  if (!json) return text;
  try { return JSON.parse(text); }
  catch (e) {
    log(`  ! ${name}: cannot parse ${file}: ${e.message}`);
    return UNREADABLE;
  }
}

async function writeAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}

const jsonText = (obj) => JSON.stringify(obj, null, 2) + '\n';

function renameSlug(slug) {
  return typeof slug === 'string' && slug.startsWith(`${OLD}/`) ? `${NEW}/${slug.slice(OLD.length + 1)}` : slug;
}

// Why the gate cannot pass on this boot, or null when the plugin project's
// main-checkout manifest declares NEW. `warn` is set when the defer will not
// resolve by itself.
async function gate(storeDir, project, log) {
  const recFile = path.join(storeDir, 'projects', project, 'project.json');
  const rec = await readTolerant(recFile, { json: true, log });
  if (rec === UNREADABLE) return { warn: `project record ${recFile} is unreadable` };
  if (!rec) return { warn: `project '${project}' has no record at ${recFile}` };
  if (rec.location?.kind !== 'local' || typeof rec.location.path !== 'string') {
    return { warn: `project '${project}' is not local` };
  }
  const file = path.join(rec.location.path, 'conductor.plugin.json');
  const manifest = await readTolerant(file, { json: true, log });
  if (manifest === UNREADABLE || !manifest) return { warn: `manifest ${file} is ${manifest ? 'unreadable' : 'missing'}` };
  if (manifest.id === NEW) return null;
  if (manifest.id === OLD) return {};
  return { warn: `manifest ${file} declares id ${JSON.stringify(manifest.id)}` };
}

async function rewriteMarkers(storeDir, ctx) {
  let entries;
  try { entries = await fs.readdir(path.join(storeDir, 'projects'), { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const project of entries.filter(e => e.isDirectory()).map(e => e.name).sort()) {
    const recFile = path.join(storeDir, 'projects', project, 'project.json');
    const rec = await readTolerant(recFile, { json: true, log: ctx.log });
    if (rec === UNREADABLE) { ctx.unreadable.push(recFile); continue; }
    const loc = rec?.location;
    if (!loc) continue;
    if (loc.kind !== 'local') { ctx.summary.remoteProjectsNotChecked.push(project); continue; }
    const file = path.join(loc.path, 'CONVENTIONS.md');
    const text = await readTolerant(file, { json: false, log: ctx.log });
    if (text === UNREADABLE) { ctx.unreadable.push(file); continue; }
    if (text === null) continue;
    const nl = text.indexOf('\n');
    const line1 = nl === -1 ? text : text.slice(0, nl);
    const m = MARKER_RE.exec(line1);
    if (!m) continue;
    const slugs = m[1].split(',').map(s => s.trim()).filter(Boolean);
    if (!slugs.some(s => s.startsWith(`${OLD}/`))) continue;
    const next = [...new Set(slugs.map(renameSlug))];
    const marker = `<!-- cc:conventions ${next.join(',')} -->`;
    await writeAtomic(file, marker + (nl === -1 ? '' : text.slice(nl)));
    ctx.summary.markers.push(project);
  }
}

async function rewriteDenyLists(storeDir, ctx) {
  for (const scope of ['conductor', 'workspace']) {
    const file = path.join(storeDir, 'conventions', `${scope}.json`);
    const store = await readTolerant(file, { json: true, log: ctx.log });
    if (store === UNREADABLE) { ctx.unreadable.push(file); continue; }
    if (!Array.isArray(store?.disabled) || !store.disabled.some(s => renameSlug(s) !== s)) continue;
    store.disabled = [...new Set(store.disabled.map(renameSlug))];
    await writeAtomic(file, jsonText(store));
    ctx.summary.disabled.push(scope);
  }
}

async function rewriteRoleSettings(storeDir, backupDir, ctx) {
  const file = path.join(storeDir, 'settings.json');
  const settings = await readTolerant(file, { json: true, log: ctx.log });
  if (settings === UNREADABLE) { ctx.unreadable.push(file); return; }
  const displaced = {};
  let changed = false;
  for (const key of ['roleBackend', 'roleEffort']) {
    const map = settings?.models?.[key];
    if (!map || typeof map !== 'object') continue;
    for (const role of Object.keys(map)) {
      const renamed = renameSlug(role);
      if (renamed === role) continue;
      if (renamed in map) (displaced[key] ??= {})[role] = map[role];
      else map[renamed] = map[role];
      delete map[role];
      changed = true;
      ctx.summary.roles.push(`${key}.${role}`);
    }
  }
  if (!changed) return;
  if (Object.keys(displaced).length > 0) {
    await writeAtomic(path.join(backupDir, 'settings-roles.json'), jsonText(displaced));
  }
  // settings.json is written without a trailing newline (src/appSettings.ts).
  await writeAtomic(file, JSON.stringify(settings, null, 2));
}

async function moveRuntimeRecord(storeDir, ctx) {
  const file = path.join(storeDir, 'plugins', 'runtime.json');
  const runtime = await readTolerant(file, { json: true, log: ctx.log });
  if (runtime === UNREADABLE) { ctx.unreadable.push(file); return; }
  if (!runtime?.[OLD]) return;
  if (runtime[NEW]) {
    const { pid, pgid, port } = runtime[OLD];
    ctx.summary.runtimeLeftInPlace = { pid, pgid, port, repair: `a '${NEW}' backend record already exists; if pid ${pid} is still the old '${OLD}' backend on port ${port}, stop it with: kill -- -${pgid}` };
    return;
  }
  runtime[NEW] = runtime[OLD];
  delete runtime[OLD];
  await writeAtomic(file, jsonText(runtime));
  ctx.summary.runtime = 'moved';
}

export async function run({ root, log = () => {} } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const storeDir = path.join(projectsRoot, '.code-conductor');
  const backupDir = path.join(storeDir, 'migrated-backup-0038');
  const registryFile = path.join(storeDir, 'plugins', 'registry.json');

  const registry = await readTolerant(registryFile, { json: true, log });
  if (registry === UNREADABLE) return { applied: false };
  const oldRec = registry?.plugins?.[OLD];
  if (!oldRec) return { applied: false };
  const blocked = typeof oldRec.project === 'string'
    ? await gate(storeDir, oldRec.project, log)
    : { warn: `its registry record names no project` };
  if (blocked) {
    if (blocked.warn) {
      log(`  ! ${name}: deferred — ${blocked.warn}. Repair: make that project's conductor.plugin.json declare '${NEW}', or re-key '${OLD}' → '${NEW}' in ${registryFile} by hand.`);
    }
    return { applied: false };
  }

  const summary = { markers: [], disabled: [], roles: [], remoteProjectsNotChecked: [] };
  const ctx = { log, summary, unreadable: [] };
  await rewriteMarkers(storeDir, ctx);
  await rewriteDenyLists(storeDir, ctx);
  await rewriteRoleSettings(storeDir, backupDir, ctx);
  await moveRuntimeRecord(storeDir, ctx);

  // LAST, and only when every step could read what it needed: removing the old
  // key is what marks this migration done.
  if (ctx.unreadable.length > 0) {
    log(`  ! ${name}: ${ctx.unreadable.length} file(s) unreadable; '${OLD}' kept in ${registryFile} so the next boot retries`);
    const wrote = summary.markers.length + summary.disabled.length + summary.roles.length > 0 || !!summary.runtime;
    return wrote ? { applied: true, summary: { ...summary, unreadable: ctx.unreadable } } : { applied: false };
  }
  if (registry.plugins[NEW]) {
    await writeAtomic(path.join(backupDir, `registry-${OLD}.json`), jsonText(oldRec));
    summary.registry = `kept existing '${NEW}' record; old record backed up`;
  } else {
    registry.plugins[NEW] = oldRec;
    summary.registry = 'moved';
  }
  delete registry.plugins[OLD];
  await writeAtomic(registryFile, jsonText(registry));
  return { applied: true, summary };
}
