// Tests for workspace convention modules: compose (core + enabled), global
// selection state, custom-module CRUD, projects-root CLAUDE.md regeneration,
// and the REST surface. Analog of tests/conductor-modules.test.mjs.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  SEED_MODULES, getCatalog, getSelection, setSelection,
  addCustomModule, deleteCustomModule, composeWorkspace, composeCurrentWorkspace,
} from '../src/workspaceModules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home, projectsRoot;

before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home; projectsRoot = r.projectsRoot;
  ctx.projectsRoot = r.projectsRoot; ctx.claudeProjectsRoot = r.claudeProjectsRoot;
});
afterEach(async () => {
  await instances.shutdown();
  instances._idleSubscribers?.clear();
  await rmrf(home);
});

// ── Catalog + compose (unit) ─────────────────────────────────────────────────

test('SEED_MODULES has 4 built-in modules with metadata (no inline body)', () => {
  assert.equal(SEED_MODULES.length, 4);
  for (const m of SEED_MODULES) {
    assert.ok(m.slug && m.name && m.description);
    assert.equal(m.body, undefined);
  }
});

test('getCatalog loads bodies from baseline/modules/*.md, builtin:true', async () => {
  const cat = await getCatalog();
  assert.equal(cat.length, 4);
  for (const m of cat) {
    assert.equal(m.builtin, true);
    assert.ok(m.body && m.body.startsWith('## '), `${m.slug} has a heading body`);
  }
});

test('composeWorkspace(all) = core + all module bodies', async () => {
  const all = SEED_MODULES.map(m => m.slug);
  const doc = await composeWorkspace(all);
  assert.ok(doc.startsWith('# Project workspace conventions'), 'core first');
  assert.match(doc, /## Git hygiene/);
  assert.match(doc, /## README maintenance/);
  assert.match(doc, /## System-prompt docs/);
  assert.match(doc, /## Opening URLs/);
});

test('composeWorkspace([]) = core only (no module headings)', async () => {
  const doc = await composeWorkspace([]);
  assert.ok(doc.startsWith('# Project workspace conventions'));
  assert.doesNotMatch(doc, /## Git hygiene/);
});

// ── Selection (unit) ─────────────────────────────────────────────────────────

test('default selection = all built-in slugs (store absent)', async () => {
  const sel = await getSelection();
  assert.deepEqual([...sel].sort(), SEED_MODULES.map(m => m.slug).sort());
});

test('setSelection persists; composeCurrentWorkspace honours it', async () => {
  await setSelection(['git-hygiene']);
  assert.deepEqual(await getSelection(), ['git-hygiene']);
  const doc = await composeCurrentWorkspace();
  assert.match(doc, /## Git hygiene/);
  assert.doesNotMatch(doc, /## Opening URLs/);
});

test('setSelection with an unknown slug → 400', async () => {
  await assert.rejects(() => setSelection(['nope']), e => { assert.equal(e.statusCode, 400); return true; });
});

// ── Custom module CRUD (unit) ────────────────────────────────────────────────

test('addCustomModule appears in catalog; enabling it composes its body', async () => {
  await addCustomModule({ slug: 'house-rule', name: 'House rule', description: 'd', body: '## House rule\n- be nice' });
  const cat = await getCatalog();
  assert.equal(cat.length, 5);
  assert.equal(cat.find(c => c.slug === 'house-rule').builtin, false);
  await setSelection(['house-rule']);
  assert.match(await composeCurrentWorkspace(), /## House rule/);
});

test('deleteCustomModule drops the slug from the enabled selection', async () => {
  await addCustomModule({ slug: 'temp-mod', name: 'Temp', description: 'd', body: '## Temp' });
  await setSelection(['git-hygiene', 'temp-mod']);
  await deleteCustomModule('temp-mod');
  assert.deepEqual(await getSelection(), ['git-hygiene']);
  assert.ok(!(await getCatalog()).some(c => c.slug === 'temp-mod'));
});

// ── REST API ───────────────────────────────────────────────────────────────

test('GET /api/settings/workspace-conventions returns core + 4 modules + enabled', async () => {
  const r = await api(baseUrl, 'GET', '/api/settings/workspace-conventions');
  assert.equal(r.status, 200);
  assert.ok(r.body.core && r.body.core.name);
  assert.equal(r.body.modules.length, 4);
  assert.equal(r.body.enabled.length, 4);
});

test('POST creates a custom module (201); PUT /:slug updates; DELETE removes; each regenerates root CLAUDE.md', async () => {
  const rootClaudeMd = path.join(projectsRoot, 'CLAUDE.md');

  const add = await api(baseUrl, 'POST', '/api/settings/workspace-conventions', {
    slug: 'rest-mod', name: 'REST mod', description: 'via REST', body: '## REST mod',
  });
  assert.equal(add.status, 201);
  assert.equal(add.body.module.builtin, false);
  // Custom modules are off by default (not in the default all-builtins selection),
  // so the body is present in the catalog but not yet in the composed file.
  await api(baseUrl, 'PUT', '/api/settings/workspace-conventions/selection', {
    enabled: [...SEED_MODULES.map(m => m.slug), 'rest-mod'],
  });
  assert.match(await fs.readFile(rootClaudeMd, 'utf8'), /## REST mod/);

  const upd = await api(baseUrl, 'PUT', '/api/settings/workspace-conventions/rest-mod', {
    name: 'REST mod v2', description: 'updated', body: '## REST mod v2',
  });
  assert.equal(upd.status, 200);
  assert.match(await fs.readFile(rootClaudeMd, 'utf8'), /## REST mod v2/);

  const del = await api(baseUrl, 'DELETE', '/api/settings/workspace-conventions/rest-mod');
  assert.equal(del.status, 200);
  assert.doesNotMatch(await fs.readFile(rootClaudeMd, 'utf8'), /## REST mod/);
});
