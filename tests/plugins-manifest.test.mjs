import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateManifest, readManifest } from '../src/plugins/manifest.js';
import { readFixtureManifest } from './plugin-helpers.mjs';

function base(overrides = {}) {
  return {
    id: 'my-plugin', name: 'My Plugin', version: '1.0.0', pluginApi: 1,
    ...overrides,
  };
}

test('minimal manifest (no backend) validates and normalizes', () => {
  const r = validateManifest(base());
  assert.equal(r.errors, undefined);
  assert.deepEqual(r.manifest, { id: 'my-plugin', name: 'My Plugin', version: '1.0.0', pluginApi: 1 });
});

test('the fixture manifest validates', async () => {
  const r = validateManifest(await readFixtureManifest());
  assert.equal(r.errors, undefined);
  assert.equal(r.manifest.id, 'fake-plugin');
  assert.equal(r.manifest.mcp.scope, 'project');
  assert.equal(r.manifest.mcp.timeoutMs, 30000);
  assert.equal(r.manifest.frontend.navLabel, 'Fake');
});

test('id rules: shape, charset, length', () => {
  for (const id of ['Bad', '1abc', 'has_underscore', 'a'.repeat(41), '', undefined]) {
    const r = validateManifest(base({ id }));
    assert.ok(r.errors?.some(e => e.includes("'id'")), `id=${id} should be rejected`);
  }
  assert.equal(validateManifest(base({ id: 'a-b-c9' })).errors, undefined);
});

test('required top-level fields', () => {
  assert.ok(validateManifest(base({ name: '' })).errors.some(e => e.includes("'name'")));
  assert.ok(validateManifest(base({ version: 7 })).errors.some(e => e.includes("'version'")));
  assert.ok(validateManifest(base({ pluginApi: '1' })).errors.some(e => e.includes("'pluginApi'")));
});

test('unsupported pluginApi is flagged incompatible, not merely invalid', () => {
  const r = validateManifest(base({ pluginApi: 2 }));
  assert.equal(r.incompatible, true);
  assert.ok(r.errors[0].includes('unsupported pluginApi 2'));
});

test('unknown top-level keys rejected; settings still inert-allowed', () => {
  assert.ok(validateManifest(base({ bogus: 1 })).errors.some(e => e.includes("unknown key 'bogus'")));
  const r = validateManifest(base({ settings: {} }));
  assert.equal(r.errors, undefined);
  assert.equal(r.manifest.settings, undefined); // inert: validated-but-not-normalized
});

test('conventions: contributions-only manifest (no backend) validates and normalizes', () => {
  const conventions = [{ slug: 'vis-check', name: 'Visual check', description: 'verify UX', file: 'conventions/vis.md', scope: 'project' }];
  const r = validateManifest(base({ conventions }));
  assert.equal(r.errors, undefined);
  assert.deepEqual(r.manifest.conventions, conventions);
  assert.equal(r.manifest.backend, undefined);
});

test('conventions: invalid shapes rejected', () => {
  const g = (entry) => validateManifest(base({ conventions: [entry] }));
  assert.ok(g({ slug: 'Bad', name: 'n', description: 'd', file: 'g.md', scope: 'project' }).errors.some(e => e.includes('.slug')));
  assert.ok(g({ slug: 'ok', name: '', description: 'd', file: 'g.md', scope: 'project' }).errors.some(e => e.includes('.name')));
  assert.ok(g({ slug: 'ok', name: 'n', description: '', file: 'g.md', scope: 'project' }).errors.some(e => e.includes('.description')));
  assert.ok(g({ slug: 'ok', name: 'n', description: 'd', file: 'g.txt', scope: 'project' }).errors.some(e => e.includes("must end with '.md'")));
  assert.ok(g({ slug: 'ok', name: 'n', description: 'd', file: '../escape.md', scope: 'project' }).errors.some(e => e.includes("no '..'")));
  assert.ok(g({ slug: 'ok', name: 'n', description: 'd', file: '/abs.md', scope: 'project' }).errors.some(e => e.includes("no '..'")));
  assert.ok(g({ slug: 'ok', name: 'n', description: 'd', file: 'g.md', scope: 'project', bogus: 1 }).errors.some(e => e.includes("unknown key 'conventions[0].bogus'")));
  assert.ok(validateManifest(base({ conventions: [] })).errors.some(e => e.includes('non-empty array')));
  const dup = [{ slug: 's', name: 'n', description: 'd', file: 'a.md', scope: 'project' }, { slug: 's', name: 'n', description: 'd', file: 'b.md', scope: 'project' }];
  assert.ok(validateManifest(base({ conventions: dup })).errors.some(e => e.includes("duplicate convention slug 's'")));
});

test('conventions: scope is required and explicit', () => {
  const mk = (scope) => validateManifest(base({ conventions: [{ slug: 'ok', name: 'n', description: 'd', file: 'g.md', ...(scope !== undefined ? { scope } : {}) }] }));
  // Missing scope → required error (no silent default).
  assert.ok(mk(undefined).errors.some(e => e.includes("'conventions[0].scope' is required")));
  assert.ok(mk('').errors.some(e => e.includes("'conventions[0].scope' is required")));
  // project → valid.
  assert.equal(mk('project').errors, undefined);
  // conductor → valid.
  assert.equal(mk('conductor').errors, undefined);
});

test('conventions: workspace scope rejected as not-yet-supported', () => {
  const mk = (scope) => validateManifest(base({ conventions: [{ slug: 'ok', name: 'n', description: 'd', file: 'g.md', scope }] }));
  assert.ok(mk('workspace').errors.some(e => e === 'scope "workspace" not yet supported (only "project", "conductor" are currently accepted)'));
  // An unrecognised value gets the standard invalid-enum error, not the planned-scope hint.
  const bogus = mk('galaxy');
  assert.ok(bogus.errors.some(e => e.includes("'conventions[0].scope' must be one of: project, conductor")));
  assert.ok(!bogus.errors.some(e => e.includes('not yet supported')));
});

test('conventions: scaffold facet — fragment-only, scaffold-only, both; "at least one" enforced', () => {
  // fragment only (no scaffold facet) — unchanged shape.
  const fragOnly = validateManifest(base({ conventions: [{ slug: 'frag', name: 'n', description: 'd', file: 'conventions/g.md', scope: 'project' }] }));
  assert.equal(fragOnly.errors, undefined);
  assert.equal(fragOnly.manifest.conventions[0].scaffold, undefined);

  // scaffold only (no fragment file) — inline text.
  const scaffoldOnly = validateManifest(base({ conventions: [{ slug: 'sc', name: 'n', description: 'd', scope: 'project', scaffold: { text: 'go build the wrapper' } }] }));
  assert.equal(scaffoldOnly.errors, undefined);
  assert.equal(scaffoldOnly.manifest.conventions[0].file, undefined);
  assert.deepEqual(scaffoldOnly.manifest.conventions[0].scaffold, { text: 'go build the wrapper' });

  // both facets, scaffold via file (mirrors code-playwright's real shape).
  const both = validateManifest(base({ conventions: [{ slug: 'harness', name: 'Harness', description: 'd', file: 'conventions/harness.md', scope: 'project', scaffold: { file: 'scaffold/harness.md' } }] }));
  assert.equal(both.errors, undefined);
  assert.deepEqual(both.manifest.conventions[0], { slug: 'harness', name: 'Harness', description: 'd', file: 'conventions/harness.md', scope: 'project', scaffold: { file: 'scaffold/harness.md' } });
  assert.equal(both.manifest.backend, undefined); // no backend required

  // neither fragment nor scaffold → rejected.
  assert.ok(validateManifest(base({ conventions: [{ slug: 'empty', name: 'n', description: 'd', scope: 'project' }] }))
    .errors.some(e => e.includes("requires at least one of 'file' or 'scaffold'")));
});

test('conventions: scaffold facet invalid shapes rejected', () => {
  const sc = (scaffold) => validateManifest(base({ conventions: [{ slug: 'ok', name: 'n', description: 'd', scope: 'project', scaffold }] }));
  // both text+file
  assert.ok(sc({ text: 't', file: 's.md' }).errors.some(e => e.includes("scaffold' requires exactly one of 'text' or 'file'")));
  // neither
  assert.ok(sc({}).errors.some(e => e.includes("scaffold' requires exactly one of 'text' or 'file'")));
  // empty text
  assert.ok(sc({ text: '   ' }).errors.some(e => e.includes("scaffold.text' must be a non-empty string")));
  // bad file shape
  assert.ok(sc({ file: 's.txt' }).errors.some(e => e.includes("must end with '.md'")));
  assert.ok(sc({ file: '../x.md' }).errors.some(e => e.includes("no '..'")));
  // unknown key in facet
  assert.ok(sc({ text: 't', bogus: 1 }).errors.some(e => e.includes("unknown key 'conventions[0].scaffold.bogus'")));
  // non-object facet
  assert.ok(sc('nope').errors.some(e => e.includes("scaffold' must be an object")));
});

test("scaffolds: the retired top-level 'scaffolds' key is now unknown", () => {
  assert.ok(validateManifest(base({ scaffolds: [{ slug: 's', name: 'n', description: 'd', text: 't' }] }))
    .errors.some(e => e === "unknown key 'scaffolds'"));
});

test('readManifest: missing convention fragment / scaffold file → invalid', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manif-frag-'));
  try {
    const manifest = base({
      conventions: [{ slug: 'g', name: 'n', description: 'd', file: 'conventions/g.md', scope: 'project', scaffold: { file: 'scaffold/g.md' } }],
    });
    await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify(manifest));
    // Files do not exist yet → invalid, both refs reported.
    let r = await readManifest(dir);
    assert.ok(r.errors.some(e => e.includes("conventions 'g' file")), 'missing convention fragment is a load error');
    assert.ok(r.errors.some(e => e.includes("conventions 'g' scaffold file")), 'missing scaffold file is a load error');
    // Create them → valid.
    await fs.mkdir(path.join(dir, 'conventions'), { recursive: true });
    await fs.writeFile(path.join(dir, 'conventions', 'g.md'), '## G\n');
    await fs.mkdir(path.join(dir, 'scaffold'), { recursive: true });
    await fs.writeFile(path.join(dir, 'scaffold', 'g.md'), 'do the thing\n');
    r = await readManifest(dir);
    assert.equal(r.errors, undefined);
    assert.equal(r.manifest.conventions[0].slug, 'g');
    assert.deepEqual(r.manifest.conventions[0].scaffold, { file: 'scaffold/g.md' });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('frontend and mcp require backend', () => {
  const noBackend = base({ frontend: { path: '/' } });
  assert.ok(validateManifest(noBackend).errors.some(e => e.includes("'frontend' requires 'backend'")));
  const noBackendMcp = base({ mcp: { endpoint: '/mcp', tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }] } });
  assert.ok(validateManifest(noBackendMcp).errors.some(e => e.includes("'mcp' requires 'backend'")));
});

test('backend validation: start required, readyWhen must compile, healthPath shape', () => {
  assert.ok(validateManifest(base({ backend: {} })).errors.some(e => e.includes("'backend.start'")));
  assert.ok(validateManifest(base({ backend: { start: 'x', readyWhen: '(' } })).errors.some(e => e.includes('not a valid regex')));
  assert.ok(validateManifest(base({ backend: { start: 'x', healthPath: 'health' } })).errors.some(e => e.includes("'backend.healthPath'")));
  assert.equal(validateManifest(base({ backend: { start: 'npm start', healthPath: '/h', readyWhen: 'listening' } })).errors, undefined);
});

test('frontend defaults: path=/ and navLabel=name', () => {
  const r = validateManifest(base({ backend: { start: 'x' }, frontend: {} }));
  assert.equal(r.errors, undefined);
  assert.deepEqual(r.manifest.frontend, { path: '/', navLabel: 'My Plugin' });
});

test('mcp normalization: scope default, timeoutMs cap at 120000', () => {
  const mcp = { endpoint: '/api/mcp', timeoutMs: 999999, tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }] };
  const r = validateManifest(base({ backend: { start: 'x' }, mcp }));
  assert.equal(r.errors, undefined);
  assert.equal(r.manifest.mcp.scope, 'project');
  assert.equal(r.manifest.mcp.timeoutMs, 120000);
});

test('mcp tools: name shape, duplicates, empty list', () => {
  const backend = { start: 'x' };
  const tool = (name) => ({ name, description: 'd', inputSchema: { type: 'object' } });
  assert.ok(validateManifest(base({ backend, mcp: { endpoint: '/m', tools: [] } })).errors.some(e => e.includes("'mcp.tools'")));
  assert.ok(validateManifest(base({ backend, mcp: { endpoint: '/m', tools: [tool('bad name')] } })).errors.some(e => e.includes('name')));
  assert.ok(validateManifest(base({ backend, mcp: { endpoint: '/m', tools: [tool('a'), tool('a')] } })).errors.some(e => e.includes("duplicate tool name 'a'")));
});

test('inputSchema subset: combinators, nested properties, non-object root rejected', () => {
  const mk = (inputSchema) => base({ backend: { start: 'x' }, mcp: { endpoint: '/m', tools: [{ name: 't', description: 'd', inputSchema }] } });
  assert.ok(validateManifest(mk({ type: 'string' })).errors.some(e => e.includes("must be 'object'")));
  assert.ok(validateManifest(mk({ type: 'object', oneOf: [] })).errors.some(e => e.includes("unsupported 'oneOf'")));
  assert.ok(validateManifest(mk({ type: 'object', properties: { x: { $ref: '#/x' } } })).errors.some(e => e.includes("unsupported '$ref'")));
  assert.ok(validateManifest(mk({ type: 'object', properties: { x: { type: 'object', properties: {} } } })).errors.some(e => e.includes("nested 'properties'")));
  assert.ok(validateManifest(mk({ type: 'object', properties: { x: { type: 'array', items: { type: 'string', minLength: 2 } } } })).errors.some(e => e.includes("items' supports only 'type'")));
});

test('inputSchema subset: boolean additionalProperties accepted and ignored', () => {
  const mk = (inputSchema) => base({ backend: { start: 'x' }, mcp: { endpoint: '/m', tools: [{ name: 't', description: 'd', inputSchema }] } });
  assert.equal(validateManifest(mk({ type: 'object', additionalProperties: false, properties: { x: { type: 'string' } } })).errors, undefined);
  assert.equal(validateManifest(mk({ type: 'object', additionalProperties: true })).errors, undefined);
  assert.ok(validateManifest(mk({ type: 'object', additionalProperties: {} })).errors.some(e => e.includes('additionalProperties')));
});

test('inputSchema subset: full validateArgs vocabulary accepted', () => {
  const schema = {
    type: 'object',
    required: ['a'],
    properties: {
      a: { type: 'string', minLength: 1, maxLength: 5, pattern: '^x' },
      b: { type: 'integer', minimum: 0, maximum: 10 },
      c: { type: ['string', 'null'], enum: ['x', 'y', null] },
      d: { type: 'array', items: { type: 'string' } },
    },
  };
  const r = validateManifest(base({ backend: { start: 'x' }, mcp: { endpoint: '/m', tools: [{ name: 't', description: 'd', inputSchema: schema }] } }));
  assert.equal(r.errors, undefined);
});

test('readManifest: absent → null, bad JSON → errors, invalid keeps id for display', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manif-'));
  try {
    assert.equal(await readManifest(dir), null);
    await fs.writeFile(path.join(dir, 'conductor.plugin.json'), '{nope');
    assert.ok((await readManifest(dir)).errors[0].includes('not valid JSON'));
    await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify(base({ name: '' })));
    const r = await readManifest(dir);
    assert.ok(r.errors.length > 0);
    assert.equal(r.id, 'my-plugin');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
