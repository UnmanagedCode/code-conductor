// Tests for workspace conventions: compose (core + enabled), global
// selection state, custom-convention CRUD, the per-project fan-out that
// delivers the composed text, and the REST surface. Analog of
// tests/conductor-conventions.test.mjs.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { createProject } from '../src/projects.ts';
import { composeProjectConventionsDoc } from '../src/projectClaudeMd.ts';
import {
  SEED_CONVENTIONS, getCatalog, getSelection, setSelection,
  addCustomConvention, deleteCustomConvention, composeWorkspace, composeCurrentWorkspace,
} from '../src/workspaceConventions.ts';

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

test('SEED_CONVENTIONS has 4 built-in conventions with metadata (no inline body)', () => {
  assert.equal(SEED_CONVENTIONS.length, 4);
  for (const m of SEED_CONVENTIONS) {
    assert.ok(m.slug && m.name && m.description);
    assert.equal(m.body, undefined);
  }
});

test('getCatalog loads bodies from conventions/workspace/*.md, builtin:true', async () => {
  const cat = await getCatalog();
  assert.equal(cat.length, 4);
  for (const m of cat) {
    assert.equal(m.builtin, true);
    assert.ok(m.body && m.body.startsWith('## '), `${m.slug} has a heading body`);
  }
});

test('composeWorkspace(all) = core + all convention bodies', async () => {
  const all = SEED_CONVENTIONS.map(m => m.slug);
  const doc = await composeWorkspace(all);
  assert.ok(doc.startsWith('# Workspace conventions'), 'core first');
  assert.match(doc, /## Git hygiene/);
  assert.match(doc, /## README maintenance/);
  assert.match(doc, /## System-prompt docs/);
  assert.match(doc, /## Opening URLs/);
});

test('composeWorkspace([]) = core only (no convention headings)', async () => {
  const doc = await composeWorkspace([]);
  assert.ok(doc.startsWith('# Workspace conventions'));
  assert.doesNotMatch(doc, /## Git hygiene/);
});

// ── Selection (unit) ─────────────────────────────────────────────────────────

test('default selection = all built-in slugs (store absent)', async () => {
  const sel = await getSelection();
  assert.deepEqual([...sel].sort(), SEED_CONVENTIONS.map(m => m.slug).sort());
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

// ── Custom convention CRUD (unit) ────────────────────────────────────────────

test('addCustomConvention appears in catalog; enabling it composes its body', async () => {
  await addCustomConvention({ slug: 'house-rule', name: 'House rule', description: 'd', body: '## House rule\n- be nice' });
  const cat = await getCatalog();
  assert.equal(cat.length, 5);
  assert.equal(cat.find(c => c.slug === 'house-rule').builtin, false);
  await setSelection(['house-rule']);
  assert.match(await composeCurrentWorkspace(), /## House rule/);
});

test('deleteCustomConvention drops the slug from the enabled selection', async () => {
  await addCustomConvention({ slug: 'temp-mod', name: 'Temp', description: 'd', body: '## Temp' });
  await setSelection(['git-hygiene', 'temp-mod']);
  await deleteCustomConvention('temp-mod');
  assert.deepEqual(await getSelection(), ['git-hygiene']);
  assert.ok(!(await getCatalog()).some(c => c.slug === 'temp-mod'));
});

// ── REST API ───────────────────────────────────────────────────────────────

test('GET /api/settings/conventions/workspace returns core + 4 built-in conventions + enabled', async () => {
  const r = await api(baseUrl, 'GET', '/api/settings/conventions/workspace');
  assert.equal(r.status, 200);
  assert.ok(r.body.core && r.body.core.name);
  assert.equal(r.body.conventions.length, 4);
  assert.equal(r.body.enabled.length, 4);
  for (const m of r.body.conventions) assert.equal(m.builtin, true);
});

// Two projects with different project-scope selections — the workspace block is
// installation-wide, so BOTH must carry every workspace mutation.
const conventionsPath = (name) => path.join(projectsRoot, name, 'CONVENTIONS.md');
async function twoProjects() {
  await createProject('with-conv', { conventionsDoc: await composeProjectConventionsDoc(['design-guidelines']) });
  await createProject('without-conv');   // no CONVENTIONS.md at creation
  return ['with-conv', 'without-conv'];
}
async function bothFiles(names) {
  return Promise.all(names.map(n => fs.readFile(conventionsPath(n), 'utf8')));
}

test('PUT selection fans out to EVERY project\'s CONVENTIONS.md; built-in edit/delete → 400; unknown slug → 400', async () => {
  const names = await twoProjects();
  const r = await api(baseUrl, 'PUT', '/api/settings/conventions/workspace/selection', { enabled: ['git-hygiene'] });
  assert.equal(r.status, 200);
  for (const content of await bothFiles(names)) {
    assert.match(content, /## Git hygiene/);
    assert.doesNotMatch(content, /## Opening URLs/);
    assert.match(content, /# Workspace conventions/);
  }

  const put = await api(baseUrl, 'PUT', '/api/settings/conventions/workspace/git-hygiene', { name: 'X' });
  assert.equal(put.status, 400);
  const del = await api(baseUrl, 'DELETE', '/api/settings/conventions/workspace/git-hygiene');
  assert.equal(del.status, 400);
  const bad = await api(baseUrl, 'PUT', '/api/settings/conventions/workspace/selection', { enabled: ['nope'] });
  assert.equal(bad.status, 400);
});

test('POST creates a custom convention (201); PUT /:slug updates; DELETE removes; each fans out to every project', async () => {
  const names = await twoProjects();

  const add = await api(baseUrl, 'POST', '/api/settings/conventions/workspace', {
    slug: 'rest-mod', name: 'REST mod', description: 'via REST', body: '## REST mod',
  });
  assert.equal(add.status, 201);
  assert.equal(add.body.convention.builtin, false);
  // A custom convention is enabled the moment it is created (nothing switches
  // it off, and the persisted state is a deny-list), so its body is already in
  // the composed text. The explicit save below is the round trip, not the
  // enablement.
  await api(baseUrl, 'PUT', '/api/settings/conventions/workspace/selection', {
    enabled: [...SEED_CONVENTIONS.map(m => m.slug), 'rest-mod'],
  });
  for (const content of await bothFiles(names)) assert.match(content, /## REST mod/);

  const upd = await api(baseUrl, 'PUT', '/api/settings/conventions/workspace/rest-mod', {
    name: 'REST mod v2', description: 'updated', body: '## REST mod v2',
  });
  assert.equal(upd.status, 200);
  for (const content of await bothFiles(names)) assert.match(content, /## REST mod v2/);

  const del = await api(baseUrl, 'DELETE', '/api/settings/conventions/workspace/rest-mod');
  assert.equal(del.status, 200);
  for (const content of await bothFiles(names)) assert.doesNotMatch(content, /## REST mod/);
});
