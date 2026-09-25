// Unit tests for migration 0038 (rename the wiki plugin id code-karpathy-wiki →
// code-wiki across every store keyed by it). See
// migrations/0038-rename-wiki-plugin-id.mjs for the defer rule and the
// done-flag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';
import * as m0038 from '../migrations/0038-rename-wiki-plugin-id.mjs';

const OLD = 'code-karpathy-wiki';
const NEW = 'code-wiki';
const OLD_REC = { project: OLD, enabled: true, activeVersion: { type: 'main' } };
const RUNTIME_REC = { pid: 4242, pgid: 4242, port: 36017, startedAt: '2026-01-01T00:00:00.000Z', gitHead: 'abc' };
const BODY = '\n\n# Workspace conventions\n\nbody text\n';

async function writeJson(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj, null, 2) + '\n');
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

// A store with the plugin registered + running, one project selecting its
// convention, and the plugin checkout declaring `manifestId`.
async function mkStore(manifestId, { registry = { [OLD]: OLD_REC }, runtime = { [OLD]: RUNTIME_REC } } = {}) {
  const root = await mkdtemp('cc-m0038-');
  const store = path.join(root, '.code-conductor');
  const pluginDir = path.join(root, '.plugins', OLD);
  const appDir = path.join(root, 'app');
  await writeJson(path.join(pluginDir, 'conductor.plugin.json'), { id: manifestId, name: 'Wiki' });
  await writeJson(path.join(store, 'projects', OLD, 'project.json'), { location: { kind: 'local', path: pluginDir } });
  await writeJson(path.join(store, 'projects', 'app', 'project.json'), { location: { kind: 'local', path: appDir } });
  await fs.mkdir(appDir, { recursive: true });
  await fs.writeFile(path.join(appDir, 'CONVENTIONS.md'), `<!-- cc:conventions design-guidelines,${OLD}/project-wiki,code-playwright/visual-verification -->${BODY}`);
  await writeJson(path.join(store, 'plugins', 'registry.json'), { plugins: { 'code-hub': { project: 'code-hub', enabled: true }, ...registry } });
  await writeJson(path.join(store, 'plugins', 'runtime.json'), runtime);
  return { root, store, appDir };
}

// Every file under the root, path → bytes.
async function snapshot(root) {
  const out = {};
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else out[path.relative(root, p)] = await fs.readFile(p, 'utf8');
    }
  }
  await walk(root);
  return out;
}

test('defers without writing while the discovered manifest still declares the old id', async () => {
  const { root } = await mkStore(OLD);
  const before = await snapshot(root);
  assert.deepEqual(await m0038.run({ root }), { applied: false });
  assert.deepEqual(await snapshot(root), before);
});

test('moves the registry record to the new key with every field intact', async () => {
  const { root, store } = await mkStore(NEW);
  assert.equal((await m0038.run({ root })).applied, true);
  const { plugins } = await readJson(path.join(store, 'plugins', 'registry.json'));
  assert.deepEqual(plugins[NEW], OLD_REC);
  assert.equal(OLD in plugins, false);
});

test('an existing new-id registry record wins; the old one is backed up and removed', async () => {
  const existing = { project: OLD, enabled: false, activeVersion: { type: 'main' } };
  const { root, store } = await mkStore(NEW, { registry: { [OLD]: OLD_REC, [NEW]: existing } });
  await m0038.run({ root });
  const { plugins } = await readJson(path.join(store, 'plugins', 'registry.json'));
  assert.deepEqual(plugins[NEW], existing);
  assert.equal(OLD in plugins, false);
  assert.deepEqual(await readJson(path.join(store, 'migrated-backup-0038', `registry-${OLD}.json`)), OLD_REC);
});

test('moves the runtime record to the new key so boot can adopt the live backend', async () => {
  const { root, store } = await mkStore(NEW);
  await m0038.run({ root });
  assert.deepEqual(await readJson(path.join(store, 'plugins', 'runtime.json')), { [NEW]: RUNTIME_REC });
});

test('an existing new-id runtime record leaves both records untouched and reports the old pid', async () => {
  const other = { ...RUNTIME_REC, pid: 5151, pgid: 5151, port: 40000 };
  const { root, store } = await mkStore(NEW, { runtime: { [OLD]: RUNTIME_REC, [NEW]: other } });
  const { summary } = await m0038.run({ root });
  assert.deepEqual(await readJson(path.join(store, 'plugins', 'runtime.json')), { [OLD]: RUNTIME_REC, [NEW]: other });
  assert.equal(summary.runtimeLeftInPlace.pid, RUNTIME_REC.pid);
});

test('rewrites only the line-1 marker of registered projects', async () => {
  const { root, appDir } = await mkStore(NEW);
  const strayDir = path.join(root, 'unregistered');
  const stray = `<!-- cc:conventions ${OLD}/project-wiki -->${BODY}`;
  await fs.mkdir(strayDir, { recursive: true });
  await fs.writeFile(path.join(strayDir, 'CONVENTIONS.md'), stray);
  await m0038.run({ root });
  assert.equal(
    await fs.readFile(path.join(appDir, 'CONVENTIONS.md'), 'utf8'),
    `<!-- cc:conventions design-guidelines,${NEW}/project-wiki,code-playwright/visual-verification -->${BODY}`,
  );
  assert.equal(await fs.readFile(path.join(strayDir, 'CONVENTIONS.md'), 'utf8'), stray);
});

test('renames the prefix in the convention deny-lists and role settings, keeping siblings', async () => {
  const { root, store } = await mkStore(NEW);
  await writeJson(path.join(store, 'conventions', 'conductor.json'), { disabled: [`${OLD}/orchestrator-wiki`, 'code-kanban/x'], defaultPlaybook: { mode: 'playbook', id: 'relay' } });
  await writeJson(path.join(store, 'conventions', 'workspace.json'), { disabled: [`${OLD}/y`], rules: [] });
  await writeJson(path.join(store, 'settings.json'), { models: { roleBackend: { [`${OLD}/r`]: 'b', planner: 'p' }, roleEffort: { [`${OLD}/r`]: 'high' } }, other: 1 });
  await m0038.run({ root });
  assert.deepEqual(await readJson(path.join(store, 'conventions', 'conductor.json')), { disabled: [`${NEW}/orchestrator-wiki`, 'code-kanban/x'], defaultPlaybook: { mode: 'playbook', id: 'relay' } });
  assert.deepEqual(await readJson(path.join(store, 'conventions', 'workspace.json')), { disabled: [`${NEW}/y`], rules: [] });
  assert.deepEqual(await readJson(path.join(store, 'settings.json')), { models: { roleBackend: { planner: 'p', [`${NEW}/r`]: 'b' }, roleEffort: { [`${NEW}/r`]: 'high' } }, other: 1 });
});

test('a run interrupted before the registry step completes on replay', async () => {
  const { root, store, appDir } = await mkStore(NEW);
  const rewritten = `<!-- cc:conventions ${NEW}/project-wiki -->${BODY}`;
  await fs.writeFile(path.join(appDir, 'CONVENTIONS.md'), rewritten);
  await writeJson(path.join(store, 'plugins', 'runtime.json'), { [NEW]: RUNTIME_REC });
  assert.equal((await m0038.run({ root })).applied, true);
  assert.deepEqual((await readJson(path.join(store, 'plugins', 'registry.json'))).plugins[NEW], OLD_REC);
  assert.equal(await fs.readFile(path.join(appDir, 'CONVENTIONS.md'), 'utf8'), rewritten);
});

test('a second run is a no-op', async () => {
  const { root } = await mkStore(NEW);
  await m0038.run({ root });
  const after = await snapshot(root);
  assert.deepEqual(await m0038.run({ root }), { applied: false });
  assert.deepEqual(await snapshot(root), after);
});
