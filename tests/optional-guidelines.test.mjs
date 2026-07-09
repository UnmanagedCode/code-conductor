import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  getCatalog, addCustomGuideline, deleteCustomGuideline, composeGuidelinesBlock, SEED_GUIDELINES,
} from '../src/optionalGuidelines.js';
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

test('SEED_GUIDELINES has 4 entries with expected slugs', () => {
  assert.equal(SEED_GUIDELINES.length, 4);
  const slugs = SEED_GUIDELINES.map(r => r.slug);
  assert.ok(slugs.includes('design-guidelines'));
  assert.ok(slugs.includes('testing-guidelines'));
  assert.ok(slugs.includes('documentation-guidelines'));
  assert.ok(slugs.includes('migrations-over-compat'));
  // SEED_GUIDELINES is metadata-only now; bodies live in guidelines/<slug>.md.
  for (const r of SEED_GUIDELINES) {
    assert.ok(r.name, 'seed guideline has name');
    assert.ok(r.description, 'seed guideline has description');
  }
});

test('SEED_GUIDELINES order is design → testing → documentation → migrations-over-compat', () => {
  assert.equal(SEED_GUIDELINES[0].slug, 'design-guidelines');
  assert.equal(SEED_GUIDELINES[1].slug, 'testing-guidelines');
  assert.equal(SEED_GUIDELINES[2].slug, 'documentation-guidelines');
  assert.equal(SEED_GUIDELINES[3].slug, 'migrations-over-compat');
});

test('getCatalog seed bodies (loaded from .md fragments) have correct ## headings', async () => {
  const catalog = await getCatalog();
  const byslug = Object.fromEntries(catalog.map(r => [r.slug, r]));
  for (const r of catalog) assert.ok(r.body, 'catalog entry has body');
  assert.ok(byslug['design-guidelines'].body.startsWith('## Design guidelines'));
  assert.ok(byslug['testing-guidelines'].body.startsWith('## Testing guidelines'));
  assert.ok(byslug['documentation-guidelines'].body.startsWith('## Documentation guidelines'));
  assert.ok(byslug['migrations-over-compat'].body.startsWith('## Migration guidelines'));
});

test('design-guidelines body includes a YAGNI bullet', async () => {
  const catalog = await getCatalog();
  const design = catalog.find(r => r.slug === 'design-guidelines');
  assert.match(design.body, /YAGNI/);
});

test('getCatalog returns seeds only when no custom guidelines', async () => {
  const catalog = await getCatalog();
  assert.equal(catalog.length, SEED_GUIDELINES.length);
  for (const r of catalog) assert.equal(r.builtin, true);
});

test('getCatalog merges custom guidelines with builtin:false', async () => {
  await addCustomGuideline({ slug: 'my-guideline', name: 'My Guideline', description: 'desc', body: '## My Guideline\n- item' });
  const catalog = await getCatalog();
  assert.equal(catalog.length, SEED_GUIDELINES.length + 1);
  const custom = catalog.find(r => r.slug === 'my-guideline');
  assert.ok(custom);
  assert.equal(custom.builtin, false);
});

// ── Custom guideline CRUD (unit) ────────────────────────────────────────────

test('addCustomGuideline persists and returns the new guideline', async () => {
  const rule = await addCustomGuideline({ slug: 'test-guideline', name: 'Test Guideline', description: 'A test', body: '## Test\n- x' });
  assert.equal(rule.slug, 'test-guideline');
  assert.equal(rule.name, 'Test Guideline');
  assert.equal(rule.builtin, false);
  const catalog = await getCatalog();
  assert.ok(catalog.find(r => r.slug === 'test-guideline'));
});

test('addCustomGuideline rejects duplicate slug', async () => {
  await addCustomGuideline({ slug: 'dupe', name: 'A', description: 'b', body: 'c' });
  await assert.rejects(
    () => addCustomGuideline({ slug: 'dupe', name: 'A2', description: 'b2', body: 'c2' }),
    { message: /already exists/ },
  );
});

test('addCustomGuideline rejects a builtin slug', async () => {
  await assert.rejects(
    () => addCustomGuideline({ slug: 'testing-guidelines', name: 'X', description: 'y', body: 'z' }),
    { message: /already exists/ },
  );
});

test('addCustomGuideline rejects invalid slug', async () => {
  await assert.rejects(
    () => addCustomGuideline({ slug: 'UPPER', name: 'X', description: 'y', body: 'z' }),
    { message: /invalid slug/ },
  );
});

test('deleteCustomGuideline removes the guideline', async () => {
  await addCustomGuideline({ slug: 'to-delete', name: 'A', description: 'b', body: 'c' });
  await deleteCustomGuideline('to-delete');
  const catalog = await getCatalog();
  assert.ok(!catalog.find(r => r.slug === 'to-delete'));
});

test('deleteCustomGuideline rejects builtin', async () => {
  await assert.rejects(
    () => deleteCustomGuideline('testing-guidelines'),
    { message: /cannot delete built-in/ },
  );
});

// ── composeGuidelinesBlock (unit) ─────────────────────────────────────────

test('composeGuidelinesBlock returns empty string for empty array', async () => {
  const block = await composeGuidelinesBlock([]);
  assert.equal(block, '');
});

test('composeGuidelinesBlock inserts a blank line + body for one seed guideline', async () => {
  const block = await composeGuidelinesBlock(['documentation-guidelines']);
  assert.ok(block.startsWith('\n'));
  assert.ok(block.includes('## Documentation guidelines'));
});

test('composeGuidelinesBlock joins multiple guidelines with blank line separator', async () => {
  const block = await composeGuidelinesBlock(['documentation-guidelines', 'design-guidelines']);
  assert.ok(block.includes('## Documentation guidelines'));
  assert.ok(block.includes('## Design guidelines'));
  assert.ok(block.includes('\n\n'));
});

test('composeGuidelinesBlock throws 400 on unknown slug', async () => {
  const err = await composeGuidelinesBlock(['nonexistent-slug']).catch(e => e);
  assert.equal(err.statusCode, 400);
  assert.match(err.message, /unknown guideline slug/);
});

// ── createProject with guidelines (unit) ─────────────────────────────────

test('createProject with no guidelines seeds only @../CLAUDE.md', async () => {
  const { path: projPath } = await createProject('plain-proj');
  const content = await fs.readFile(path.join(projPath, 'CLAUDE.md'), 'utf8');
  assert.equal(content, '@../CLAUDE.md\n');
});

test('createProject with guidelines appends guideline bodies', async () => {
  const appendToCLAUDEmd = await composeGuidelinesBlock(['documentation-guidelines']);
  const { path: projPath } = await createProject('guideline-proj', { appendToCLAUDEmd });
  const content = await fs.readFile(path.join(projPath, 'CLAUDE.md'), 'utf8');
  assert.ok(content.startsWith('@../CLAUDE.md\n'));
  assert.ok(content.includes('## Documentation guidelines'));
});

// ── REST API ───────────────────────────────────────────────────────────────

test('GET /api/settings/optional-guidelines returns 4 seed guidelines', async () => {
  const r = await api(baseUrl, 'GET', '/api/settings/optional-guidelines');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.rules));
  assert.equal(r.body.rules.length, SEED_GUIDELINES.length);
  for (const rule of r.body.rules) assert.equal(rule.builtin, true);
});

test('POST /api/settings/optional-guidelines creates a custom guideline', async () => {
  const r = await api(baseUrl, 'POST', '/api/settings/optional-guidelines', {
    slug: 'rest-guideline', name: 'REST Guideline', description: 'via REST', body: '## REST\n- item',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.rule.slug, 'rest-guideline');
  assert.equal(r.body.rule.builtin, false);

  const list = await api(baseUrl, 'GET', '/api/settings/optional-guidelines');
  assert.equal(list.body.rules.length, SEED_GUIDELINES.length + 1);
});

test('POST /api/settings/optional-guidelines rejects duplicate slug', async () => {
  await api(baseUrl, 'POST', '/api/settings/optional-guidelines', {
    slug: 'dup', name: 'A', description: 'b', body: 'c',
  });
  const r = await api(baseUrl, 'POST', '/api/settings/optional-guidelines', {
    slug: 'dup', name: 'A2', description: 'b2', body: 'c2',
  });
  assert.equal(r.status, 409);
});

test('PUT /api/settings/optional-guidelines/:slug updates name/description', async () => {
  await api(baseUrl, 'POST', '/api/settings/optional-guidelines', {
    slug: 'upd-guideline', name: 'Old', description: 'old desc', body: '## Old',
  });
  const r = await api(baseUrl, 'PUT', '/api/settings/optional-guidelines/upd-guideline', {
    name: 'New', description: 'new desc',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.rule.name, 'New');
  assert.equal(r.body.rule.description, 'new desc');
});

test('PUT /api/settings/optional-guidelines/:slug rejects builtin', async () => {
  const r = await api(baseUrl, 'PUT', '/api/settings/optional-guidelines/documentation-guidelines', {
    name: 'Hacked',
  });
  assert.equal(r.status, 400);
});

test('DELETE /api/settings/optional-guidelines/:slug removes custom guideline', async () => {
  await api(baseUrl, 'POST', '/api/settings/optional-guidelines', {
    slug: 'del-guideline', name: 'A', description: 'b', body: 'c',
  });
  const del = await api(baseUrl, 'DELETE', '/api/settings/optional-guidelines/del-guideline');
  assert.equal(del.status, 200);
  const list = await api(baseUrl, 'GET', '/api/settings/optional-guidelines');
  assert.ok(!list.body.rules.find(r => r.slug === 'del-guideline'));
});

test('DELETE /api/settings/optional-guidelines/:slug rejects builtin', async () => {
  const r = await api(baseUrl, 'DELETE', '/api/settings/optional-guidelines/testing-guidelines');
  assert.equal(r.status, 400);
});

test('POST /api/projects with guidelines appends bodies to CLAUDE.md', async () => {
  const r = await api(baseUrl, 'POST', '/api/projects', {
    name: 'proj-with-guidelines',
    guidelines: ['documentation-guidelines', 'design-guidelines'],
  });
  assert.equal(r.status, 201);
  const content = await fs.readFile(path.join(projectsRoot, 'proj-with-guidelines', 'CLAUDE.md'), 'utf8');
  assert.ok(content.startsWith('@../CLAUDE.md\n'));
  assert.ok(content.includes('## Documentation guidelines'));
  assert.ok(content.includes('## Design guidelines'));
});

test('POST /api/projects with unknown guideline slug returns 400', async () => {
  const r = await api(baseUrl, 'POST', '/api/projects', {
    name: 'bad-proj', guidelines: ['nonexistent-guideline'],
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unknown guideline slug/);
});

test('POST /api/projects with no guidelines seeds only @../CLAUDE.md', async () => {
  const r = await api(baseUrl, 'POST', '/api/projects', { name: 'bare-proj' });
  assert.equal(r.status, 201);
  const content = await fs.readFile(path.join(projectsRoot, 'bare-proj', 'CLAUDE.md'), 'utf8');
  assert.equal(content, '@../CLAUDE.md\n');
});

// ── MCP tools ─────────────────────────────────────────────────────────────

test('list_optional_guidelines MCP tool returns seeds (no body field)', async () => {
  const { buildTools } = await import('../src/mcp/tools.js');
  const tools = buildTools();
  const tool = tools.find(t => t.name === 'list_optional_guidelines');
  assert.ok(tool, 'list_optional_guidelines tool registered');
  const result = await tool.handler({}, { instances });
  assert.ok(Array.isArray(result));
  assert.equal(result.length, SEED_GUIDELINES.length);
  for (const r of result) {
    assert.ok(r.slug);
    assert.ok(r.name);
    assert.ok(r.description);
    assert.equal(r.builtin, true);
    assert.equal(r.body, undefined);
  }
});

test('list_optional_guidelines reflects a newly added custom guideline', async () => {
  await addCustomGuideline({ slug: 'mcp-custom', name: 'MCP Custom', description: 'test', body: '## MCP\n- x' });
  const { buildTools } = await import('../src/mcp/tools.js');
  const tools = buildTools();
  const tool = tools.find(t => t.name === 'list_optional_guidelines');
  const result = await tool.handler({}, { instances });
  assert.ok(Array.isArray(result));
  const custom = result.find(r => r.slug === 'mcp-custom');
  assert.ok(custom);
  assert.equal(custom.builtin, false);
});

test('create_project MCP tool with guidelines appends bodies to CLAUDE.md', async () => {
  const { buildTools } = await import('../src/mcp/tools.js');
  const tools = buildTools();
  const tool = tools.find(t => t.name === 'create_project');
  assert.ok(tool);
  const result = await tool.handler({ name: 'mcp-guided', guidelines: ['documentation-guidelines'] }, { instances });
  assert.equal(result.name, 'mcp-guided');
  const content = await fs.readFile(path.join(projectsRoot, 'mcp-guided', 'CLAUDE.md'), 'utf8');
  assert.ok(content.startsWith('@../CLAUDE.md\n'));
  assert.ok(content.includes('## Documentation guidelines'));
});
