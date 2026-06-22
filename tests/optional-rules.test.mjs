import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  getCatalog, addCustomRule, deleteCustomRule, composeRulesBlock, SEED_RULES,
} from '../src/optionalRules.js';
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

test('SEED_RULES has 3 entries with expected slugs', () => {
  assert.equal(SEED_RULES.length, 3);
  const slugs = SEED_RULES.map(r => r.slug);
  assert.ok(slugs.includes('testing-conventions'));
  assert.ok(slugs.includes('design-principles'));
  assert.ok(slugs.includes('doc-hygiene'));
  for (const r of SEED_RULES) {
    assert.equal(r.builtin, true);
    assert.ok(r.name, 'seed rule has name');
    assert.ok(r.description, 'seed rule has description');
    assert.ok(r.body, 'seed rule has body');
  }
});

test('getCatalog returns seeds only when no custom rules', async () => {
  const catalog = await getCatalog();
  assert.equal(catalog.length, SEED_RULES.length);
  for (const r of catalog) assert.equal(r.builtin, true);
});

test('getCatalog merges custom rules with builtin:false', async () => {
  await addCustomRule({ slug: 'my-rule', name: 'My Rule', description: 'desc', body: '## My Rule\n- item' });
  const catalog = await getCatalog();
  assert.equal(catalog.length, SEED_RULES.length + 1);
  const custom = catalog.find(r => r.slug === 'my-rule');
  assert.ok(custom);
  assert.equal(custom.builtin, false);
});

// ── Custom rule CRUD (unit) ────────────────────────────────────────────────

test('addCustomRule persists and returns the new rule', async () => {
  const rule = await addCustomRule({ slug: 'test-rule', name: 'Test Rule', description: 'A test', body: '## Test\n- x' });
  assert.equal(rule.slug, 'test-rule');
  assert.equal(rule.name, 'Test Rule');
  assert.equal(rule.builtin, false);
  const catalog = await getCatalog();
  assert.ok(catalog.find(r => r.slug === 'test-rule'));
});

test('addCustomRule rejects duplicate slug', async () => {
  await addCustomRule({ slug: 'dupe', name: 'A', description: 'b', body: 'c' });
  await assert.rejects(
    () => addCustomRule({ slug: 'dupe', name: 'A2', description: 'b2', body: 'c2' }),
    { message: /already exists/ },
  );
});

test('addCustomRule rejects a builtin slug', async () => {
  await assert.rejects(
    () => addCustomRule({ slug: 'testing-conventions', name: 'X', description: 'y', body: 'z' }),
    { message: /already exists/ },
  );
});

test('addCustomRule rejects invalid slug', async () => {
  await assert.rejects(
    () => addCustomRule({ slug: 'UPPER', name: 'X', description: 'y', body: 'z' }),
    { message: /invalid slug/ },
  );
});

test('deleteCustomRule removes the rule', async () => {
  await addCustomRule({ slug: 'to-delete', name: 'A', description: 'b', body: 'c' });
  await deleteCustomRule('to-delete');
  const catalog = await getCatalog();
  assert.ok(!catalog.find(r => r.slug === 'to-delete'));
});

test('deleteCustomRule rejects builtin', async () => {
  await assert.rejects(
    () => deleteCustomRule('testing-conventions'),
    { message: /cannot delete built-in/ },
  );
});

// ── composeRulesBlock (unit) ───────────────────────────────────────────────

test('composeRulesBlock returns empty string for empty array', async () => {
  const block = await composeRulesBlock([]);
  assert.equal(block, '');
});

test('composeRulesBlock inserts a blank line + body for one seed rule', async () => {
  const block = await composeRulesBlock(['doc-hygiene']);
  assert.ok(block.startsWith('\n'));
  assert.ok(block.includes('## Documentation hygiene'));
});

test('composeRulesBlock joins multiple rules with blank line separator', async () => {
  const block = await composeRulesBlock(['doc-hygiene', 'design-principles']);
  assert.ok(block.includes('## Documentation hygiene'));
  assert.ok(block.includes('## Design principles'));
  // Blank line between bodies.
  assert.ok(block.includes('\n\n'));
});

test('composeRulesBlock throws 400 on unknown slug', async () => {
  const err = await composeRulesBlock(['nonexistent-slug']).catch(e => e);
  assert.equal(err.statusCode, 400);
  assert.match(err.message, /unknown rule slug/);
});

// ── createProject with rules (unit) ───────────────────────────────────────

test('createProject with no rules seeds only @../CLAUDE.md', async () => {
  const { path: projPath } = await createProject('plain-proj');
  const content = await fs.readFile(path.join(projPath, 'CLAUDE.md'), 'utf8');
  assert.equal(content, '@../CLAUDE.md\n');
});

test('createProject with rules appends rule bodies', async () => {
  const appendToCLAUDEmd = await composeRulesBlock(['doc-hygiene']);
  const { path: projPath } = await createProject('ruled-proj', { appendToCLAUDEmd });
  const content = await fs.readFile(path.join(projPath, 'CLAUDE.md'), 'utf8');
  assert.ok(content.startsWith('@../CLAUDE.md\n'));
  assert.ok(content.includes('## Documentation hygiene'));
});

// ── REST API ───────────────────────────────────────────────────────────────

test('GET /api/settings/optional-rules returns 3 seed rules', async () => {
  const r = await api(baseUrl, 'GET', '/api/settings/optional-rules');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.rules));
  assert.equal(r.body.rules.length, SEED_RULES.length);
  for (const rule of r.body.rules) assert.equal(rule.builtin, true);
});

test('POST /api/settings/optional-rules creates a custom rule', async () => {
  const r = await api(baseUrl, 'POST', '/api/settings/optional-rules', {
    slug: 'rest-rule', name: 'REST Rule', description: 'via REST', body: '## REST\n- item',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.rule.slug, 'rest-rule');
  assert.equal(r.body.rule.builtin, false);

  const list = await api(baseUrl, 'GET', '/api/settings/optional-rules');
  assert.equal(list.body.rules.length, SEED_RULES.length + 1);
});

test('POST /api/settings/optional-rules rejects duplicate slug', async () => {
  await api(baseUrl, 'POST', '/api/settings/optional-rules', {
    slug: 'dup', name: 'A', description: 'b', body: 'c',
  });
  const r = await api(baseUrl, 'POST', '/api/settings/optional-rules', {
    slug: 'dup', name: 'A2', description: 'b2', body: 'c2',
  });
  assert.equal(r.status, 409);
});

test('PUT /api/settings/optional-rules/:slug updates name/description', async () => {
  await api(baseUrl, 'POST', '/api/settings/optional-rules', {
    slug: 'upd-rule', name: 'Old', description: 'old desc', body: '## Old',
  });
  const r = await api(baseUrl, 'PUT', '/api/settings/optional-rules/upd-rule', {
    name: 'New', description: 'new desc',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.rule.name, 'New');
  assert.equal(r.body.rule.description, 'new desc');
});

test('PUT /api/settings/optional-rules/:slug rejects builtin', async () => {
  const r = await api(baseUrl, 'PUT', '/api/settings/optional-rules/doc-hygiene', {
    name: 'Hacked',
  });
  assert.equal(r.status, 400);
});

test('DELETE /api/settings/optional-rules/:slug removes custom rule', async () => {
  await api(baseUrl, 'POST', '/api/settings/optional-rules', {
    slug: 'del-rule', name: 'A', description: 'b', body: 'c',
  });
  const del = await api(baseUrl, 'DELETE', '/api/settings/optional-rules/del-rule');
  assert.equal(del.status, 200);
  const list = await api(baseUrl, 'GET', '/api/settings/optional-rules');
  assert.ok(!list.body.rules.find(r => r.slug === 'del-rule'));
});

test('DELETE /api/settings/optional-rules/:slug rejects builtin', async () => {
  const r = await api(baseUrl, 'DELETE', '/api/settings/optional-rules/testing-conventions');
  assert.equal(r.status, 400);
});

test('POST /api/projects with rules appends bodies to CLAUDE.md', async () => {
  const r = await api(baseUrl, 'POST', '/api/projects', {
    name: 'proj-with-rules',
    rules: ['doc-hygiene', 'design-principles'],
  });
  assert.equal(r.status, 201);
  const content = await fs.readFile(path.join(projectsRoot, 'proj-with-rules', 'CLAUDE.md'), 'utf8');
  assert.ok(content.startsWith('@../CLAUDE.md\n'));
  assert.ok(content.includes('## Documentation hygiene'));
  assert.ok(content.includes('## Design principles'));
});

test('POST /api/projects with unknown rule slug returns 400', async () => {
  const r = await api(baseUrl, 'POST', '/api/projects', {
    name: 'bad-proj', rules: ['nonexistent-rule'],
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unknown rule slug/);
});

test('POST /api/projects with no rules seeds only @../CLAUDE.md', async () => {
  const r = await api(baseUrl, 'POST', '/api/projects', { name: 'bare-proj' });
  assert.equal(r.status, 201);
  const content = await fs.readFile(path.join(projectsRoot, 'bare-proj', 'CLAUDE.md'), 'utf8');
  assert.equal(content, '@../CLAUDE.md\n');
});

// ── MCP tools ─────────────────────────────────────────────────────────────

test('list_optional_rules MCP tool returns seeds (no body field)', async () => {
  const { buildTools } = await import('../src/mcp/tools.js');
  const tools = buildTools();
  const tool = tools.find(t => t.name === 'list_optional_rules');
  assert.ok(tool, 'list_optional_rules tool registered');
  const result = await tool.handler({}, { instances });
  assert.ok(Array.isArray(result));
  assert.equal(result.length, SEED_RULES.length);
  for (const r of result) {
    assert.ok(r.slug);
    assert.ok(r.name);
    assert.ok(r.description);
    assert.equal(r.builtin, true);
    // body is intentionally excluded from MCP output (discovery only)
    assert.equal(r.body, undefined);
  }
});

test('list_optional_rules reflects a newly added custom rule', async () => {
  await addCustomRule({ slug: 'mcp-custom', name: 'MCP Custom', description: 'test', body: '## MCP\n- x' });
  const { buildTools } = await import('../src/mcp/tools.js');
  const tools = buildTools();
  const tool = tools.find(t => t.name === 'list_optional_rules');
  const result = await tool.handler({}, { instances });
  assert.ok(Array.isArray(result));
  const custom = result.find(r => r.slug === 'mcp-custom');
  assert.ok(custom);
  assert.equal(custom.builtin, false);
});

test('create_project MCP tool with rules appends bodies to CLAUDE.md', async () => {
  const { buildTools } = await import('../src/mcp/tools.js');
  const tools = buildTools();
  const tool = tools.find(t => t.name === 'create_project');
  assert.ok(tool);
  const result = await tool.handler({ name: 'mcp-ruled', rules: ['doc-hygiene'] }, { instances });
  assert.equal(result.name, 'mcp-ruled');
  const content = await fs.readFile(path.join(projectsRoot, 'mcp-ruled', 'CLAUDE.md'), 'utf8');
  assert.ok(content.startsWith('@../CLAUDE.md\n'));
  assert.ok(content.includes('## Documentation hygiene'));
});
