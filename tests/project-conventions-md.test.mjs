// Tests for the per-project in-tree CONVENTIONS.md regeneration contract
// (src/projectClaudeMd.js). The file is app-owned + self-describing: line 1 is a
// `<!-- cc:conventions … -->` marker that is the source of truth for the
// selection, so any cc instance can regenerate the body from the file alone.
// Regeneration is NO-OP-SAFE — it only overwrites when every marker slug
// resolves locally; a missing file, a non-marker first line, or an unresolvable
// slug leaves the committed file untouched (never blanks it).

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { createProject } from '../src/projects.js';
import { addCustomConvention } from '../src/projectConventions.js';
import {
  buildMarker, parseMarker, composeProjectConventionsDoc,
  conventionsTargetPath, ensureProjectConventionsMd, regenerateAllProjectConventions,
} from '../src/projectClaudeMd.js';

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

const conventionsPath = (name) => path.join(projectsRoot, name, 'CONVENTIONS.md');

// ── marker helpers (unit) ────────────────────────────────────────────────────

test('buildMarker / parseMarker round-trip', () => {
  assert.equal(buildMarker(['a', 'b']), '<!-- cc:conventions a,b -->');
  assert.deepEqual(parseMarker('<!-- cc:conventions a,b -->'), ['a', 'b']);
  assert.deepEqual(parseMarker(buildMarker(['x'])), ['x']);
});

test('parseMarker: empty marker → [] ; non-marker / blank → null', () => {
  assert.deepEqual(parseMarker('<!-- cc:conventions -->'), []);
  assert.deepEqual(parseMarker(buildMarker([])), []);
  assert.equal(parseMarker('# Just a heading'), null);
  assert.equal(parseMarker(''), null);
  assert.equal(parseMarker('@../CLAUDE.md'), null);
});

test('composeProjectConventionsDoc: marker on line 1, then composed bodies', async () => {
  const doc = await composeProjectConventionsDoc(['documentation-guidelines']);
  assert.equal(doc.split('\n', 1)[0], '<!-- cc:conventions documentation-guidelines -->');
  assert.match(doc, /## Documentation guidelines/);
  // Empty selection → marker + trailing newline, no bodies.
  const empty = await composeProjectConventionsDoc([]);
  assert.equal(empty, '<!-- cc:conventions -->\n\n');
});

// ── regeneration (refresh improved text) ──────────────────────────────────────

test('ensureProjectConventionsMd rewrites a mangled body back to canonical; marker preserved', async () => {
  const doc = await composeProjectConventionsDoc(['documentation-guidelines']);
  await createProject('refresh-proj', { conventionsDoc: doc });
  const target = conventionsPath('refresh-proj');

  // Simulate a stale / hand-mangled body under an intact marker.
  await fs.writeFile(target, '<!-- cc:conventions documentation-guidelines -->\n\nOLD STALE TEXT\n');
  const res = await ensureProjectConventionsMd('refresh-proj');
  assert.equal(res.regenerated, true);
  assert.equal(await fs.readFile(target, 'utf8'), doc);
});

// ── grandfathering / no-op-safety ─────────────────────────────────────────────

test('ensureProjectConventionsMd skips a project with no CONVENTIONS.md', async () => {
  await createProject('plain');            // no conventions → no CONVENTIONS.md
  const res = await ensureProjectConventionsMd('plain');
  assert.equal(res.skipped, 'no-file');
});

test('ensureProjectConventionsMd skips (untouched) a CONVENTIONS.md with no marker', async () => {
  await createProject('legacy');
  const target = conventionsPath('legacy');
  const handwritten = '# My own conventions\n\nnot managed by cc\n';
  await fs.writeFile(target, handwritten);
  const res = await ensureProjectConventionsMd('legacy');
  assert.equal(res.skipped, 'no-marker');
  assert.equal(await fs.readFile(target, 'utf8'), handwritten, 'left byte-for-byte');
});

test('ensureProjectConventionsMd skips (untouched) a zero-slug marker', async () => {
  await createProject('empty-marker');
  const target = conventionsPath('empty-marker');
  // A hand-authored file whose marker lists no slugs: recomposing would blank
  // the body, so it must be left as-is (the zero-slug marker is vacuously
  // "fully resolvable" but recomposition would still be destructive).
  const committed = '<!-- cc:conventions -->\n\n## Hand-written\n- keep me\n';
  await fs.writeFile(target, committed);
  const res = await ensureProjectConventionsMd('empty-marker');
  assert.equal(res.skipped, 'empty-marker');
  assert.equal(await fs.readFile(target, 'utf8'), committed, 'left byte-for-byte');
});

test('ensureProjectConventionsMd is no-op-safe for an unresolvable slug (never blanks)', async () => {
  await createProject('portable');
  const target = conventionsPath('portable');
  // A marker referencing a slug this instance's catalog does not know (e.g. a
  // custom convention that only existed on the originating install), with real
  // last-known-good bodies below it.
  const committed = '<!-- cc:conventions ghost-slug -->\n\n## Ghost\n- committed body\n';
  await fs.writeFile(target, committed);
  const res = await ensureProjectConventionsMd('portable');
  assert.equal(res.skipped, 'unresolvable');
  assert.deepEqual(res.missing, ['ghost-slug']);
  assert.equal(await fs.readFile(target, 'utf8'), committed, 'committed content preserved');
});

// ── boot sweep ────────────────────────────────────────────────────────────────

test('regenerateAllProjectConventions refreshes split-model projects, skips grandfathered', async () => {
  await createProject('split', { conventionsDoc: await composeProjectConventionsDoc(['design-guidelines']) });
  await createProject('grand');            // grandfathered — no CONVENTIONS.md
  await fs.writeFile(conventionsPath('split'), '<!-- cc:conventions design-guidelines -->\n\nSTALE\n');

  const results = await regenerateAllProjectConventions();
  const byName = Object.fromEntries(results.map(r => [r.name, r]));
  assert.equal(byName['split'].regenerated, true);
  assert.equal(byName['grand'].skipped, 'no-file');
  assert.match(await fs.readFile(conventionsPath('split'), 'utf8'), /## Design guidelines/);
});

// ── fan-out on custom-convention mutation (HTTP) ──────────────────────────────

test('editing a custom convention body fans out to projects that selected it', async () => {
  await addCustomConvention({ slug: 'house-style', name: 'House style', description: 'x', body: '## House style\n- v1 rule' });
  const created = await api(baseUrl, 'POST', '/api/projects', { name: 'styled', conventions: ['house-style'] });
  assert.equal(created.status, 201);
  const target = conventionsPath('styled');
  assert.match(await fs.readFile(target, 'utf8'), /v1 rule/);

  const upd = await api(baseUrl, 'PUT', '/api/settings/conventions/project/house-style', {
    name: 'House style', description: 'x', body: '## House style\n- v2 rule',
  });
  assert.equal(upd.status, 200);
  const after = await fs.readFile(target, 'utf8');
  assert.match(after, /v2 rule/);
  assert.doesNotMatch(after, /v1 rule/);
});

test('deleting a custom convention leaves a project that referenced it byte-for-byte', async () => {
  await addCustomConvention({ slug: 'doomed', name: 'Doomed', description: 'x', body: '## Doomed\n- committed body' });
  const created = await api(baseUrl, 'POST', '/api/projects', { name: 'refholder', conventions: ['doomed'] });
  assert.equal(created.status, 201);
  const target = conventionsPath('refholder');
  const before = await fs.readFile(target, 'utf8');
  assert.match(before, /committed body/);

  // DELETE fans out to regenerate — but the project's slug is now unresolvable,
  // so its committed CONVENTIONS.md must be preserved exactly (never blanked).
  const del = await api(baseUrl, 'DELETE', '/api/settings/conventions/project/doomed');
  assert.equal(del.status, 200);
  assert.equal(await fs.readFile(target, 'utf8'), before, 'committed content preserved byte-for-byte');

  // A direct re-run of the fan-out is likewise a no-op on this project.
  await regenerateAllProjectConventions();
  assert.equal(await fs.readFile(target, 'utf8'), before);
});
