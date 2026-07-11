// Tests for project convention modules (formerly "optional guidelines"):
// catalog, custom CRUD, compose, per-project snapshot at creation, the REST
// surface (/api/settings/project-conventions), and the MCP tools
// (list_project_conventions + create_project's `conventions` param).

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  getCatalog, addCustomConvention, deleteCustomConvention,
  composeProjectConventionsBlock, SEED_PROJECT_CONVENTIONS,
} from '../src/projectConventions.js';
import { createProject } from '../src/projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home, projectsRoot;

before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  projectsRoot = r.projectsRoot;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
});
afterEach(async () => {
  await instances.shutdown();
  instances._idleSubscribers?.clear();
  await rmrf(home);
});

// ── Catalog (unit) ─────────────────────────────────────────────────────────

test('SEED_PROJECT_CONVENTIONS has 4 entries with expected slugs', () => {
  assert.equal(SEED_PROJECT_CONVENTIONS.length, 4);
  const slugs = SEED_PROJECT_CONVENTIONS.map(r => r.slug);
  assert.ok(slugs.includes('design-guidelines'));
  assert.ok(slugs.includes('testing-guidelines'));
  assert.ok(slugs.includes('documentation-guidelines'));
  assert.ok(slugs.includes('migration-guidelines'));
  for (const r of SEED_PROJECT_CONVENTIONS) {
    assert.ok(r.name, 'seed convention has name');
    assert.ok(r.description, 'seed convention has description');
  }
});

test('SEED_PROJECT_CONVENTIONS order is design → testing → documentation → migration-guidelines', () => {
  assert.equal(SEED_PROJECT_CONVENTIONS[0].slug, 'design-guidelines');
  assert.equal(SEED_PROJECT_CONVENTIONS[1].slug, 'testing-guidelines');
  assert.equal(SEED_PROJECT_CONVENTIONS[2].slug, 'documentation-guidelines');
  assert.equal(SEED_PROJECT_CONVENTIONS[3].slug, 'migration-guidelines');
});

test('getCatalog seed bodies (loaded from .md fragments) have correct ## headings', async () => {
  const catalog = await getCatalog();
  const byslug = Object.fromEntries(catalog.map(r => [r.slug, r]));
  for (const r of catalog) assert.ok(r.body, 'catalog entry has body');
  assert.ok(byslug['design-guidelines'].body.startsWith('## Design guidelines'));
  assert.ok(byslug['testing-guidelines'].body.startsWith('## Testing guidelines'));
  assert.ok(byslug['documentation-guidelines'].body.startsWith('## Documentation guidelines'));
  assert.ok(byslug['migration-guidelines'].body.startsWith('## Migration guidelines'));
});

test('design-guidelines body includes a YAGNI bullet', async () => {
  const catalog = await getCatalog();
  const design = catalog.find(r => r.slug === 'design-guidelines');
  assert.match(design.body, /YAGNI/);
});

test('getCatalog returns seeds only when no custom conventions', async () => {
  const catalog = await getCatalog();
  assert.equal(catalog.length, SEED_PROJECT_CONVENTIONS.length);
  for (const r of catalog) assert.equal(r.builtin, true);
});

test('getCatalog merges custom conventions with builtin:false', async () => {
  await addCustomConvention({ slug: 'my-convention', name: 'My Convention', description: 'desc', body: '## My Convention\n- item' });
  const catalog = await getCatalog();
  assert.equal(catalog.length, SEED_PROJECT_CONVENTIONS.length + 1);
  const custom = catalog.find(r => r.slug === 'my-convention');
  assert.ok(custom);
  assert.equal(custom.builtin, false);
});

// ── Custom convention CRUD (unit) ────────────────────────────────────────────

test('addCustomConvention persists and returns the new convention', async () => {
  const rule = await addCustomConvention({ slug: 'test-convention', name: 'Test Convention', description: 'A test', body: '## Test\n- x' });
  assert.equal(rule.slug, 'test-convention');
  assert.equal(rule.name, 'Test Convention');
  assert.equal(rule.builtin, false);
  const catalog = await getCatalog();
  assert.ok(catalog.find(r => r.slug === 'test-convention'));
});

test('addCustomConvention rejects duplicate slug', async () => {
  await addCustomConvention({ slug: 'dupe', name: 'A', description: 'b', body: 'c' });
  await assert.rejects(
    () => addCustomConvention({ slug: 'dupe', name: 'A2', description: 'b2', body: 'c2' }),
    { message: /already exists/ },
  );
});

test('addCustomConvention rejects a builtin slug', async () => {
  await assert.rejects(
    () => addCustomConvention({ slug: 'testing-guidelines', name: 'X', description: 'y', body: 'z' }),
    { message: /already exists/ },
  );
});

test('addCustomConvention rejects invalid slug', async () => {
  await assert.rejects(
    () => addCustomConvention({ slug: 'UPPER', name: 'X', description: 'y', body: 'z' }),
    { message: /invalid slug/ },
  );
});

test('deleteCustomConvention removes the convention', async () => {
  await addCustomConvention({ slug: 'to-delete', name: 'A', description: 'b', body: 'c' });
  await deleteCustomConvention('to-delete');
  const catalog = await getCatalog();
  assert.ok(!catalog.find(r => r.slug === 'to-delete'));
});

test('deleteCustomConvention rejects builtin', async () => {
  await assert.rejects(
    () => deleteCustomConvention('testing-guidelines'),
    { message: /cannot delete built-in/ },
  );
});

// ── composeProjectConventionsBlock (unit) ─────────────────────────────────────

test('composeProjectConventionsBlock returns empty string for empty array', async () => {
  const block = await composeProjectConventionsBlock([]);
  assert.equal(block, '');
});

test('composeProjectConventionsBlock inserts a blank line + body for one seed convention', async () => {
  const block = await composeProjectConventionsBlock(['documentation-guidelines']);
  assert.ok(block.startsWith('\n'));
  assert.ok(block.includes('## Documentation guidelines'));
});

test('composeProjectConventionsBlock joins multiple conventions with blank line separator', async () => {
  const block = await composeProjectConventionsBlock(['documentation-guidelines', 'design-guidelines']);
  assert.ok(block.includes('## Documentation guidelines'));
  assert.ok(block.includes('## Design guidelines'));
  assert.ok(block.includes('\n\n'));
});

test('composeProjectConventionsBlock throws 400 on unknown slug', async () => {
  const err = await composeProjectConventionsBlock(['nonexistent-slug']).catch(e => e);
  assert.equal(err.statusCode, 400);
  assert.match(err.message, /unknown convention slug/);
});

// ── createProject with conventions (unit) ─────────────────────────────────────

test('createProject with no conventions seeds only @../CLAUDE.md', async () => {
  const { path: projPath } = await createProject('plain-proj');
  const content = await fs.readFile(path.join(projPath, 'CLAUDE.md'), 'utf8');
  assert.equal(content, '@../CLAUDE.md\n');
});

test('createProject with conventions appends convention bodies', async () => {
  const appendToCLAUDEmd = await composeProjectConventionsBlock(['documentation-guidelines']);
  const { path: projPath } = await createProject('convention-proj', { appendToCLAUDEmd });
  const content = await fs.readFile(path.join(projPath, 'CLAUDE.md'), 'utf8');
  assert.ok(content.startsWith('@../CLAUDE.md\n'));
  assert.ok(content.includes('## Documentation guidelines'));
});

// ── REST API ───────────────────────────────────────────────────────────────

test('GET /api/settings/project-conventions returns 4 seed conventions', async () => {
  const r = await api(baseUrl, 'GET', '/api/settings/project-conventions');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.rules));
  assert.equal(r.body.rules.length, SEED_PROJECT_CONVENTIONS.length);
  for (const rule of r.body.rules) assert.equal(rule.builtin, true);
});

test('POST /api/settings/project-conventions creates a custom convention', async () => {
  const r = await api(baseUrl, 'POST', '/api/settings/project-conventions', {
    slug: 'rest-convention', name: 'REST Convention', description: 'via REST', body: '## REST\n- item',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.rule.slug, 'rest-convention');
  assert.equal(r.body.rule.builtin, false);

  const list = await api(baseUrl, 'GET', '/api/settings/project-conventions');
  assert.equal(list.body.rules.length, SEED_PROJECT_CONVENTIONS.length + 1);
});

test('POST /api/settings/project-conventions rejects duplicate slug', async () => {
  await api(baseUrl, 'POST', '/api/settings/project-conventions', {
    slug: 'dup', name: 'A', description: 'b', body: 'c',
  });
  const r = await api(baseUrl, 'POST', '/api/settings/project-conventions', {
    slug: 'dup', name: 'A2', description: 'b2', body: 'c2',
  });
  assert.equal(r.status, 409);
});

test('PUT /api/settings/project-conventions/:slug updates name/description', async () => {
  await api(baseUrl, 'POST', '/api/settings/project-conventions', {
    slug: 'upd-convention', name: 'Old', description: 'old desc', body: '## Old',
  });
  const r = await api(baseUrl, 'PUT', '/api/settings/project-conventions/upd-convention', {
    name: 'New', description: 'new desc',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.rule.name, 'New');
  assert.equal(r.body.rule.description, 'new desc');
});

test('PUT /api/settings/project-conventions/:slug rejects builtin', async () => {
  const r = await api(baseUrl, 'PUT', '/api/settings/project-conventions/documentation-guidelines', {
    name: 'Hacked',
  });
  assert.equal(r.status, 400);
});

test('DELETE /api/settings/project-conventions/:slug removes custom convention', async () => {
  await api(baseUrl, 'POST', '/api/settings/project-conventions', {
    slug: 'del-convention', name: 'A', description: 'b', body: 'c',
  });
  const del = await api(baseUrl, 'DELETE', '/api/settings/project-conventions/del-convention');
  assert.equal(del.status, 200);
  const list = await api(baseUrl, 'GET', '/api/settings/project-conventions');
  assert.ok(!list.body.rules.find(r => r.slug === 'del-convention'));
});

test('DELETE /api/settings/project-conventions/:slug rejects builtin', async () => {
  const r = await api(baseUrl, 'DELETE', '/api/settings/project-conventions/testing-guidelines');
  assert.equal(r.status, 400);
});

test('POST /api/projects with conventions appends bodies to CLAUDE.md', async () => {
  const r = await api(baseUrl, 'POST', '/api/projects', {
    name: 'proj-with-conventions',
    conventions: ['documentation-guidelines', 'design-guidelines'],
  });
  assert.equal(r.status, 201);
  const content = await fs.readFile(path.join(projectsRoot, 'proj-with-conventions', 'CLAUDE.md'), 'utf8');
  assert.ok(content.startsWith('@../CLAUDE.md\n'));
  assert.ok(content.includes('## Documentation guidelines'));
  assert.ok(content.includes('## Design guidelines'));
});

test('POST /api/projects with unknown convention slug returns 400', async () => {
  const r = await api(baseUrl, 'POST', '/api/projects', {
    name: 'bad-proj', conventions: ['nonexistent-convention'],
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unknown convention slug/);
});

test('POST /api/projects with no conventions seeds only @../CLAUDE.md', async () => {
  const r = await api(baseUrl, 'POST', '/api/projects', { name: 'bare-proj' });
  assert.equal(r.status, 201);
  const content = await fs.readFile(path.join(projectsRoot, 'bare-proj', 'CLAUDE.md'), 'utf8');
  assert.equal(content, '@../CLAUDE.md\n');
});

// ── MCP tools ─────────────────────────────────────────────────────────────

test('list_project_conventions MCP tool returns seeds (no body field)', async () => {
  const { buildTools } = await import('../src/mcp/tools.js');
  const tools = buildTools();
  const tool = tools.find(t => t.name === 'list_project_conventions');
  assert.ok(tool, 'list_project_conventions tool registered');
  const result = await tool.handler({}, { instances });
  assert.ok(Array.isArray(result));
  assert.equal(result.length, SEED_PROJECT_CONVENTIONS.length);
  for (const r of result) {
    assert.ok(r.slug);
    assert.ok(r.name);
    assert.ok(r.description);
    assert.equal(r.builtin, true);
    assert.equal(r.body, undefined);
  }
});

test('list_project_conventions reflects a newly added custom convention', async () => {
  await addCustomConvention({ slug: 'mcp-custom', name: 'MCP Custom', description: 'test', body: '## MCP\n- x' });
  const { buildTools } = await import('../src/mcp/tools.js');
  const tools = buildTools();
  const tool = tools.find(t => t.name === 'list_project_conventions');
  const result = await tool.handler({}, { instances });
  assert.ok(Array.isArray(result));
  const custom = result.find(r => r.slug === 'mcp-custom');
  assert.ok(custom);
  assert.equal(custom.builtin, false);
});

test('create_project MCP tool with conventions appends bodies to CLAUDE.md', async () => {
  const { buildTools } = await import('../src/mcp/tools.js');
  const tools = buildTools();
  const tool = tools.find(t => t.name === 'create_project');
  assert.ok(tool);
  const result = await tool.handler({ name: 'mcp-guided', conventions: ['documentation-guidelines'] }, { instances });
  assert.equal(result.name, 'mcp-guided');
  const content = await fs.readFile(path.join(projectsRoot, 'mcp-guided', 'CLAUDE.md'), 'utf8');
  assert.ok(content.startsWith('@../CLAUDE.md\n'));
  assert.ok(content.includes('## Documentation guidelines'));
});

// ── Plugin-contributed conventions (+ optional scaffold facet) ─────────────
// These exercise the provider seam directly (no real plugin host): the
// fragment-catalog extraProvider (projectConventions). A plugin convention
// entry carries `body` (fragment, '' when scaffold-only) and an optional
// `scaffold` (resolved directive text). The provider is a module-level
// singleton — set per test, reset after.

import {
  setPluginConventionsProvider, composeProjectScaffold,
} from '../src/projectConventions.js';

afterEach(() => {
  // Reset the provider so a fake never leaks into a later test.
  setPluginConventionsProvider(null);
});

test('plugin conventions merge into the catalog with namespaced slugs', async () => {
  setPluginConventionsProvider(async () => [
    { slug: 'playwright-harness/visual-verification', name: 'Visual verification', description: 'verify UX', body: '## Visual verification\n- verify', plugin: 'playwright-harness' },
  ]);
  const catalog = await getCatalog();
  const entry = catalog.find(r => r.slug === 'playwright-harness/visual-verification');
  assert.ok(entry, 'plugin convention present in catalog');
  assert.equal(entry.builtin, false);
  assert.equal(entry.plugin, 'playwright-harness');
  // Seeds still present alongside.
  assert.ok(catalog.some(r => r.slug === 'design-guidelines'));
});

test('compose resolves a plugin convention slug; create_project snapshots it inline', async () => {
  setPluginConventionsProvider(async () => [
    { slug: 'playwright-harness/visual-verification', name: 'Visual verification', description: 'verify UX', body: '## Visual verification\n- always verify UX', plugin: 'playwright-harness' },
  ]);
  const block = await composeProjectConventionsBlock(['playwright-harness/visual-verification']);
  assert.ok(block.includes('## Visual verification'));

  await createProject('plugin-guided', { appendToCLAUDEmd: block });
  const content = await fs.readFile(path.join(projectsRoot, 'plugin-guided', 'CLAUDE.md'), 'utf8');
  assert.ok(content.includes('always verify UX'));

  // Applied copy survives the plugin going away (provider empties).
  setPluginConventionsProvider(async () => []);
  const after = await fs.readFile(path.join(projectsRoot, 'plugin-guided', 'CLAUDE.md'), 'utf8');
  assert.ok(after.includes('always verify UX'), 'snapshot survives disable/uninstall');
  // And the catalog no longer offers it.
  const catalog = await getCatalog();
  assert.ok(!catalog.some(r => r.slug === 'playwright-harness/visual-verification'));
});

test('compose rejects an unknown/unavailable plugin slug (400)', async () => {
  setPluginConventionsProvider(async () => []);
  await assert.rejects(
    () => composeProjectConventionsBlock(['playwright-harness/gone']),
    (e) => e.statusCode === 400,
  );
});

// Fake plugin conventions carrying scaffold facets: one with both a fragment
// body and a scaffold, one scaffold-only (no fragment body), plus a plain
// fragment-only convention.
const FAKE_CONVENTIONS = [
  { slug: 'playwright-harness/harness-wrapper', name: 'Harness wrapper', description: 'build a wrapper', body: '## Harness\n- use the wrapper', scaffold: 'Build a project-local harness wrapper', plugin: 'playwright-harness' },
  { slug: 'playwright-harness/seed-config', name: 'Seed config', description: 'seed config', body: '', scaffold: 'Write a default config', plugin: 'playwright-harness' },
  { slug: 'playwright-harness/plain', name: 'Plain', description: 'fragment only', body: '## Plain\n- rule', plugin: 'playwright-harness' },
];

test('list_project_conventions carries hasScaffold', async () => {
  setPluginConventionsProvider(async () => FAKE_CONVENTIONS);
  const { buildTools } = await import('../src/mcp/tools.js');
  const tool = buildTools().find(t => t.name === 'list_project_conventions');
  const list = await tool.handler({}, { instances });
  const bySlug = Object.fromEntries(list.map(e => [e.slug, e]));
  assert.equal(bySlug['playwright-harness/harness-wrapper'].hasScaffold, true);
  assert.equal(bySlug['playwright-harness/seed-config'].hasScaffold, true);
  assert.equal(bySlug['playwright-harness/plain'].hasScaffold, false);
  // Built-in seeds are fragment-only → hasScaffold:false.
  assert.equal(bySlug['design-guidelines'].hasScaffold, false);
  // No directive body leaks through the list.
  assert.equal(bySlug['playwright-harness/harness-wrapper'].scaffold, undefined);
});

test('a scaffold-only convention appends nothing to CLAUDE.md', async () => {
  setPluginConventionsProvider(async () => FAKE_CONVENTIONS);
  const block = await composeProjectConventionsBlock(['playwright-harness/seed-config']);
  assert.equal(block, '', 'scaffold-only convention contributes no fragment');
  // A fragment-bearing convention still composes.
  const both = await composeProjectConventionsBlock(['playwright-harness/harness-wrapper', 'playwright-harness/seed-config']);
  assert.match(both, /## Harness/);
});

test('composeProjectScaffold frames scaffold-bearing conventions in order; unknown → 400; none → ""', async () => {
  setPluginConventionsProvider(async () => FAKE_CONVENTIONS);
  // Selection order preserved (seed-config first); a fragment-only convention in
  // the selection contributes no step.
  const block = await composeProjectScaffold('demo', ['playwright-harness/seed-config', 'playwright-harness/plain', 'playwright-harness/harness-wrapper']);
  assert.match(block, /Project "demo" was created with these setup steps/);
  assert.match(block, /1\) Write a default config/);
  assert.match(block, /2\) Build a project-local harness wrapper/);
  assert.ok(block.indexOf('Write a default config') < block.indexOf('Build a project-local harness wrapper'));

  // No scaffold-bearing pick → empty string.
  assert.equal(await composeProjectScaffold('demo', ['playwright-harness/plain']), '');
  // Unknown slug → 400.
  await assert.rejects(() => composeProjectScaffold('demo', ['playwright-harness/gone']), (e) => e.statusCode === 400);
});

test('create_project RETURNS the composed scaffold directive from picked conventions (no persistence)', async () => {
  setPluginConventionsProvider(async () => FAKE_CONVENTIONS);
  const { buildTools } = await import('../src/mcp/tools.js');
  const tool = buildTools().find(t => t.name === 'create_project');
  const result = await tool.handler({ name: 'sc-proj', conventions: ['playwright-harness/harness-wrapper', 'playwright-harness/seed-config'] }, { instances });
  assert.match(result.scaffold, /Project "sc-proj" was created with these setup steps/);
  assert.match(result.scaffold, /1\) Build a project-local harness wrapper/);
  assert.match(result.scaffold, /2\) Write a default config/);
  // The fragment-bearing convention still snapshots into CLAUDE.md.
  const content = await fs.readFile(path.join(projectsRoot, 'sc-proj', 'CLAUDE.md'), 'utf8');
  assert.match(content, /## Harness/);
  // Nothing persisted — the project meta stays clean, no spawn coupling.
  const { readProjectMeta } = await import('../src/projects.js');
  assert.deepEqual(await readProjectMeta('sc-proj'), { workspace: null });
});

test('REST POST /api/projects returns the scaffold directive in the 201 body', async () => {
  setPluginConventionsProvider(async () => FAKE_CONVENTIONS);
  const r = await api(baseUrl, 'POST', '/api/projects', { name: 'sc-rest', conventions: ['playwright-harness/harness-wrapper'] });
  assert.equal(r.status, 201);
  assert.match(r.body.scaffold, /Build a project-local harness wrapper/);
});

test('create_project with no scaffold-bearing conventions omits the scaffold field', async () => {
  setPluginConventionsProvider(async () => FAKE_CONVENTIONS);
  const { buildTools } = await import('../src/mcp/tools.js');
  const tool = buildTools().find(t => t.name === 'create_project');
  const result = await tool.handler({ name: 'sc-none', conventions: ['playwright-harness/plain'] }, { instances });
  assert.equal(result.scaffold, undefined);
});
