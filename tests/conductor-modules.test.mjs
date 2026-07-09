// Tests for conductor convention modules: compose (core + enabled + footer),
// global selection state, custom-module CRUD, the generated .conduct/CONDUCT.md,
// the REST surface, and the list_conductor_modules MCP tool.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  SEED_MODULES, getCatalog, getSelection, setSelection,
  addCustomModule, deleteCustomModule, composeConduct, composeCurrentConduct,
} from '../src/conductModules.js';

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

test('SEED_MODULES has 8 built-in modules with metadata (no inline body)', () => {
  assert.equal(SEED_MODULES.length, 8);
  for (const m of SEED_MODULES) {
    assert.ok(m.slug && m.name && m.description);
    assert.equal(m.body, undefined);
  }
});

test('getCatalog loads bodies from conduct/modules/*.md, builtin:true', async () => {
  const cat = await getCatalog();
  assert.equal(cat.length, 8);
  for (const m of cat) {
    assert.equal(m.builtin, true);
    assert.ok(m.body && m.body.startsWith('## '), `${m.slug} has a heading body`);
  }
});

test('composeConduct(all) = core + all module bodies + footer', async () => {
  const all = SEED_MODULES.map(m => m.slug);
  const doc = await composeConduct(all);
  assert.ok(doc.startsWith('# Conductor role'), 'core first');
  assert.match(doc, /## MCP toolbelt/, 'core section');
  assert.match(doc, /## Optional guidelines on project creation/, 'core-hoisted section');
  assert.match(doc, /## Canonical workflow/);
  assert.match(doc, /## Worker lifecycle/);
  assert.match(doc, /generated from `conduct\/core\.md`/, 'footer last');
});

test('composeConduct([]) = core + footer only (no module headings)', async () => {
  const doc = await composeConduct([]);
  assert.ok(doc.startsWith('# Conductor role'));
  assert.doesNotMatch(doc, /## Canonical workflow/);
  assert.match(doc, /generated from `conduct\/core\.md`/);
});

// ── Selection (unit) ─────────────────────────────────────────────────────────

test('default selection = all built-in slugs (store absent)', async () => {
  const sel = await getSelection();
  assert.deepEqual([...sel].sort(), SEED_MODULES.map(m => m.slug).sort());
});

test('setSelection persists; composeCurrentConduct honours it', async () => {
  await setSelection(['canonical-workflow']);
  assert.deepEqual(await getSelection(), ['canonical-workflow']);
  const doc = await composeCurrentConduct();
  assert.match(doc, /## Canonical workflow/);
  assert.doesNotMatch(doc, /## Worker lifecycle/);
});

test('setSelection with an unknown slug → 400', async () => {
  await assert.rejects(() => setSelection(['nope']), e => { assert.equal(e.statusCode, 400); return true; });
});

// ── Custom module CRUD (unit) ────────────────────────────────────────────────

test('addCustomModule appears in catalog; enabling it composes its body', async () => {
  await addCustomModule({ slug: 'house-style', name: 'House style', description: 'd', body: '## House style\n- be nice' });
  const cat = await getCatalog();
  assert.equal(cat.length, 9);
  assert.equal(cat.find(c => c.slug === 'house-style').builtin, false);
  await setSelection(['house-style']);
  const doc = await composeCurrentConduct();
  assert.match(doc, /## House style/);
});

test('deleteCustomModule drops the slug from the enabled selection', async () => {
  await addCustomModule({ slug: 'temp-mod', name: 'Temp', description: 'd', body: '## Temp' });
  await setSelection(['canonical-workflow', 'temp-mod']);
  await deleteCustomModule('temp-mod');
  assert.deepEqual(await getSelection(), ['canonical-workflow']);
  assert.ok(!(await getCatalog()).some(c => c.slug === 'temp-mod'));
});

// ── Generated .conduct/CONDUCT.md ─────────────────────────────────────────────

test('PUT selection regenerates .conduct/CONDUCT.md to match', async () => {
  await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  const conductMd = path.join(projectsRoot, '.conduct', 'CONDUCT.md');
  // Default: all modules present.
  assert.match(await fs.readFile(conductMd, 'utf8'), /## Worker lifecycle/);

  const r = await api(baseUrl, 'PUT', '/api/settings/conductor-modules/selection', {
    enabled: ['canonical-workflow'],
  });
  assert.equal(r.status, 200);
  const content = await fs.readFile(conductMd, 'utf8');
  assert.match(content, /## Canonical workflow/);
  assert.doesNotMatch(content, /## Worker lifecycle/);
  // Core + footer always present.
  assert.ok(content.startsWith('# Conductor role'));
  assert.match(content, /generated from `conduct\/core\.md`/);
});

// ── REST API ───────────────────────────────────────────────────────────────

test('GET /api/settings/conductor-modules returns core + 8 modules + enabled', async () => {
  const r = await api(baseUrl, 'GET', '/api/settings/conductor-modules');
  assert.equal(r.status, 200);
  assert.ok(r.body.core && r.body.core.name);
  assert.equal(r.body.modules.length, 8);
  assert.equal(r.body.enabled.length, 8); // default all-on
  for (const m of r.body.modules) assert.equal(m.builtin, true);
});

test('POST creates a custom module (201); PUT /:slug updates; DELETE removes', async () => {
  const add = await api(baseUrl, 'POST', '/api/settings/conductor-modules', {
    slug: 'rest-mod', name: 'REST mod', description: 'via REST', body: '## REST mod',
  });
  assert.equal(add.status, 201);
  assert.equal(add.body.module.slug, 'rest-mod');
  assert.equal(add.body.module.builtin, false);

  const upd = await api(baseUrl, 'PUT', '/api/settings/conductor-modules/rest-mod', {
    name: 'REST mod v2', description: 'updated',
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.module.name, 'REST mod v2');

  const del = await api(baseUrl, 'DELETE', '/api/settings/conductor-modules/rest-mod');
  assert.equal(del.status, 200);
  const list = await api(baseUrl, 'GET', '/api/settings/conductor-modules');
  assert.ok(!list.body.modules.find(m => m.slug === 'rest-mod'));
});

test('PUT/DELETE a built-in module → 400; PUT selection with unknown slug → 400', async () => {
  const put = await api(baseUrl, 'PUT', '/api/settings/conductor-modules/canonical-workflow', { name: 'X' });
  assert.equal(put.status, 400);
  const del = await api(baseUrl, 'DELETE', '/api/settings/conductor-modules/canonical-workflow');
  assert.equal(del.status, 400);
  const sel = await api(baseUrl, 'PUT', '/api/settings/conductor-modules/selection', { enabled: ['nope'] });
  assert.equal(sel.status, 400);
});

// ── MCP tool ─────────────────────────────────────────────────────────────────

test('list_conductor_modules MCP tool returns modules with enabled flag, no body', async () => {
  const { buildTools } = await import('../src/mcp/tools.js');
  const tool = buildTools().find(t => t.name === 'list_conductor_modules');
  assert.ok(tool, 'list_conductor_modules tool registered');
  const result = await tool.handler({}, { instances });
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 8);
  for (const m of result) {
    assert.ok(m.slug && m.name && m.description);
    assert.equal(m.builtin, true);
    assert.equal(m.enabled, true); // default all-on
    assert.equal(m.body, undefined);
  }
});
