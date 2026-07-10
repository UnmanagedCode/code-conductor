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

test('guidelines: conventions-only manifest (no backend) validates and normalizes', () => {
  const guidelines = [{ slug: 'vis-check', name: 'Visual check', description: 'verify UX', file: 'guidelines/vis.md' }];
  const r = validateManifest(base({ guidelines }));
  assert.equal(r.errors, undefined);
  assert.deepEqual(r.manifest.guidelines, guidelines);
  assert.equal(r.manifest.backend, undefined);
});

test('guidelines: invalid shapes rejected', () => {
  const g = (entry) => validateManifest(base({ guidelines: [entry] }));
  assert.ok(g({ slug: 'Bad', name: 'n', description: 'd', file: 'g.md' }).errors.some(e => e.includes('.slug')));
  assert.ok(g({ slug: 'ok', name: '', description: 'd', file: 'g.md' }).errors.some(e => e.includes('.name')));
  assert.ok(g({ slug: 'ok', name: 'n', description: '', file: 'g.md' }).errors.some(e => e.includes('.description')));
  assert.ok(g({ slug: 'ok', name: 'n', description: 'd', file: 'g.txt' }).errors.some(e => e.includes("must end with '.md'")));
  assert.ok(g({ slug: 'ok', name: 'n', description: 'd', file: '../escape.md' }).errors.some(e => e.includes("no '..'")));
  assert.ok(g({ slug: 'ok', name: 'n', description: 'd', file: '/abs.md' }).errors.some(e => e.includes("no '..'")));
  assert.ok(validateManifest(base({ guidelines: [] })).errors.some(e => e.includes('non-empty array')));
  const dup = [{ slug: 's', name: 'n', description: 'd', file: 'a.md' }, { slug: 's', name: 'n', description: 'd', file: 'b.md' }];
  assert.ok(validateManifest(base({ guidelines: dup })).errors.some(e => e.includes("duplicate guideline slug 's'")));
});

test('scaffolds: multiple per plugin, inline text + file forms, exactly-one enforced', () => {
  const scaffolds = [
    { slug: 'harness-wrapper', name: 'Harness wrapper', description: 'build a wrapper', text: 'go build the wrapper' },
    { slug: 'seed-config', name: 'Seed config', description: 'seed config', file: 'scaffolds/seed.md' },
  ];
  const r = validateManifest(base({ scaffolds }));
  assert.equal(r.errors, undefined);
  assert.equal(r.manifest.scaffolds.length, 2);
  assert.deepEqual(r.manifest.scaffolds[0], { slug: 'harness-wrapper', name: 'Harness wrapper', description: 'build a wrapper', text: 'go build the wrapper' });
  assert.equal(r.manifest.scaffolds[1].file, 'scaffolds/seed.md');
  assert.equal(r.manifest.backend, undefined); // no backend required
});

test('scaffolds: invalid shapes rejected', () => {
  const s = (entry) => validateManifest(base({ scaffolds: [entry] }));
  assert.ok(s({ slug: 'Bad', name: 'n', description: 'd', text: 't' }).errors.some(e => e.includes('.slug')));
  assert.ok(s({ slug: 'ok', name: '', description: 'd', text: 't' }).errors.some(e => e.includes('.name')));
  assert.ok(s({ slug: 'ok', name: 'n', description: '', text: 't' }).errors.some(e => e.includes('.description')));
  // both text+file
  assert.ok(s({ slug: 'ok', name: 'n', description: 'd', text: 't', file: 's.md' }).errors.some(e => e.includes("exactly one of 'text' or 'file'")));
  // neither
  assert.ok(s({ slug: 'ok', name: 'n', description: 'd' }).errors.some(e => e.includes("exactly one of 'text' or 'file'")));
  // bad file shape
  assert.ok(s({ slug: 'ok', name: 'n', description: 'd', file: 's.txt' }).errors.some(e => e.includes("must end with '.md'")));
  assert.ok(s({ slug: 'ok', name: 'n', description: 'd', file: '../x.md' }).errors.some(e => e.includes("no '..'")));
  // empty array
  assert.ok(validateManifest(base({ scaffolds: [] })).errors.some(e => e.includes('non-empty array')));
  // duplicate slug
  const dup = [{ slug: 's', name: 'n', description: 'd', text: 't' }, { slug: 's', name: 'n', description: 'd', text: 'u' }];
  assert.ok(validateManifest(base({ scaffolds: dup })).errors.some(e => e.includes("duplicate scaffold slug 's'")));
});

test('readManifest: missing guideline/scaffold file → invalid', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manif-frag-'));
  try {
    const manifest = base({
      guidelines: [{ slug: 'g', name: 'n', description: 'd', file: 'guidelines/g.md' }],
      scaffolds: [{ slug: 'sc', name: 'n', description: 'd', file: 'scaffolds/sc.md' }],
    });
    await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify(manifest));
    // Files do not exist yet → invalid, both refs reported.
    let r = await readManifest(dir);
    assert.ok(r.errors.some(e => e.includes("guidelines 'g' file")), 'missing guideline file is a load error');
    assert.ok(r.errors.some(e => e.includes("scaffolds 'sc' file")), 'missing scaffold file is a load error');
    // Create them → valid.
    await fs.mkdir(path.join(dir, 'guidelines'), { recursive: true });
    await fs.writeFile(path.join(dir, 'guidelines', 'g.md'), '## G\n');
    await fs.mkdir(path.join(dir, 'scaffolds'), { recursive: true });
    await fs.writeFile(path.join(dir, 'scaffolds', 'sc.md'), 'do the thing\n');
    r = await readManifest(dir);
    assert.equal(r.errors, undefined);
    assert.equal(r.manifest.guidelines[0].slug, 'g');
    assert.equal(r.manifest.scaffolds[0].slug, 'sc');
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
