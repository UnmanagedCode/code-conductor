// Tests for the per-project in-tree CONVENTIONS.md regeneration contract
// (src/projectClaudeMd.ts). The file is app-owned + self-describing: line 1 is a
// `<!-- cc:conventions … -->` marker that is the source of truth for the PROJECT
// selection, so any cc instance can regenerate that part from the file alone;
// the WORKSPACE conventions folded in above it compose unconditionally from the
// installation-wide store. Regeneration composes whichever marker slugs resolve
// locally and names the rest in a visible in-body note, keeping them in the
// marker so they recover verbatim if they resolve again. Every project is
// written — no file, a non-marker first line and a zero-slug marker all mean
// "no project selection recorded", not "skip me". The single exception is a
// transient one: a degraded catalog holding an unresolvable marker slug freezes
// the whole file (workspace block included) until the next regenerate.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { createProject } from '../src/projects.ts';
import {
  addCustomConvention, deleteCustomConvention, composeProjectConventionsBlock, setPluginConventionsProvider,
} from '../src/projectConventions.ts';
import {
  buildMarker, parseMarker, composeProjectConventionsDoc,
  conventionsTargetPath, ensureProjectConventionsMd, regenerateAllProjectConventions,
} from '../src/projectClaudeMd.ts';
import { composeCurrentWorkspace } from '../src/workspaceConventions.ts';

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
const claudeMdPath = (name) => path.join(projectsRoot, name, 'CLAUDE.md');

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
  assert.ok(doc.indexOf('# Workspace conventions') < doc.indexOf('# Project conventions'),
    'the workspace block sits above the project one');
  // Empty selection → marker + the workspace block, and NO project heading.
  const empty = await composeProjectConventionsDoc([]);
  assert.equal(empty, '<!-- cc:conventions -->\n\n' + await composeCurrentWorkspace());
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

// ── every project is written (no skip branches but the transient one) ────────

// T1 — a project with no CONVENTIONS.md at all (the common grandfathered shape)
// gets one created. Pins acceptance condition 2 for that shape.
test('a project with no CONVENTIONS.md gets one created, workspace block and all', async () => {
  await createProject('plain');            // no conventions → no CONVENTIONS.md
  const res = await ensureProjectConventionsMd('plain');
  assert.equal(res.regenerated, true);
  assert.deepEqual(res.missing, []);
  const content = await fs.readFile(conventionsPath('plain'), 'utf8');
  assert.equal(content.split('\n', 1)[0], '<!-- cc:conventions -->', 'a zero-slug marker is written');
  assert.match(content, /# Workspace conventions/);
  assert.doesNotMatch(content, /# Project conventions/, 'no project part, so no project heading');
});

// T2 — a non-marker first line is NOT a "leave it alone" signal any more: the
// file is cc-owned, so it is rewritten and the hand-authored text is gone.
test('a CONVENTIONS.md with no marker is rewritten, not preserved', async () => {
  await createProject('legacy');
  const target = conventionsPath('legacy');
  await fs.writeFile(target, '# My own conventions\n\nnot managed by cc\n');
  const res = await ensureProjectConventionsMd('legacy');
  assert.equal(res.regenerated, true);
  const content = await fs.readFile(target, 'utf8');
  assert.equal(content, await composeProjectConventionsDoc([]), 'the composed zero-slug document');
  assert.doesNotMatch(content, /not managed by cc/, 'the hand-authored body is discarded');
});

// T3 — a zero-slug marker keeps its marker verbatim, gains the workspace block,
// and loses its hand-authored body.
test('a zero-slug marker keeps the marker, gains the workspace block, drops the hand body', async () => {
  await createProject('empty-marker');
  const target = conventionsPath('empty-marker');
  await fs.writeFile(target, '<!-- cc:conventions -->\n\n## Hand-written\n- keep me\n');
  const res = await ensureProjectConventionsMd('empty-marker');
  assert.equal(res.regenerated, true);
  const content = await fs.readFile(target, 'utf8');
  assert.equal(content.split('\n', 1)[0], '<!-- cc:conventions -->', 'marker verbatim');
  assert.match(content, /# Workspace conventions/);
  assert.doesNotMatch(content, /keep me/);
});

// T4 — the `unresolvable` freeze is retired, but the recovery guarantee it used
// to carry is not: the slug stays in the marker so its text returns verbatim.
test('an all-unresolvable marker regenerates to note + workspace, marker verbatim', async () => {
  await createProject('portable');
  const target = conventionsPath('portable');
  await fs.writeFile(target, '<!-- cc:conventions ghost-slug -->\n\n## Ghost\n- committed body\n');
  const res = await ensureProjectConventionsMd('portable');
  assert.equal(res.regenerated, true);
  assert.deepEqual(res.missing, ['ghost-slug']);
  const content = await fs.readFile(target, 'utf8');
  assert.equal(content.split('\n', 1)[0], '<!-- cc:conventions ghost-slug -->', 'the unresolvable slug stays in the marker');
  assert.match(content, /> Convention unavailable: `ghost-slug`\./);
  assert.match(content, /# Workspace conventions/);
  assert.doesNotMatch(content, /committed body/);
});

// T11 — the import line is what makes any of this reach a session. A project
// whose CLAUDE.md predates the split has no `@CONVENTIONS.md` line at all.
test('regeneration ensures the @CONVENTIONS.md import, prepending it and never duplicating it', async () => {
  await createProject('needs-import');
  const claudeMd = claudeMdPath('needs-import');
  await fs.writeFile(claudeMd, '# mine\n');

  await ensureProjectConventionsMd('needs-import');
  const first = await fs.readFile(claudeMd, 'utf8');
  assert.equal(first.split('\n').filter(l => l.trim() === '@CONVENTIONS.md').length, 1);
  assert.match(first, /# mine/, 'the user\'s own content survives');

  await ensureProjectConventionsMd('needs-import');
  const second = await fs.readFile(claudeMd, 'utf8');
  assert.equal(second, first, 'a repeat ensure is a byte-identical no-op');
  assert.equal(second.split('\n').filter(l => l.trim() === '@CONVENTIONS.md').length, 1, 'no duplicate import');
});

// T12 — the workspace block cannot accumulate across regenerations.
test('repeated regeneration is byte-identical and the workspace block appears exactly once', async () => {
  await createProject('repeat', { conventionsDoc: await composeProjectConventionsDoc(['design-guidelines']) });
  const target = conventionsPath('repeat');
  await ensureProjectConventionsMd('repeat');
  const first = await fs.readFile(target, 'utf8');
  await ensureProjectConventionsMd('repeat');
  await ensureProjectConventionsMd('repeat');
  const third = await fs.readFile(target, 'utf8');
  assert.equal(third, first);
  assert.equal(third.split('# Workspace conventions').length - 1, 1);
  assert.equal(third.split('# Project conventions').length - 1, 1);
});

// ── boot sweep ────────────────────────────────────────────────────────────────

// T5 — the sweep skips nobody: a project with a marker doc and one with no
// CONVENTIONS.md at all both come out carrying the workspace block.
test('regenerateAllProjectConventions covers every project, marker or not', async () => {
  await createProject('split', { conventionsDoc: await composeProjectConventionsDoc(['design-guidelines']) });
  await createProject('grand');            // no CONVENTIONS.md at all
  await fs.writeFile(conventionsPath('split'), '<!-- cc:conventions design-guidelines -->\n\nSTALE\n');

  const results = await regenerateAllProjectConventions();
  const byName = Object.fromEntries(results.map(r => [r.name, r]));
  assert.equal(byName['split'].regenerated, true);
  assert.equal(byName['grand'].regenerated, true);
  const splitDoc = await fs.readFile(conventionsPath('split'), 'utf8');
  assert.match(splitDoc, /## Design guidelines/);
  assert.match(splitDoc, /# Workspace conventions/);
  assert.match(await fs.readFile(conventionsPath('grand'), 'utf8'), /# Workspace conventions/);
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

// T6 — the HTTP fan-out on delete: the marker survives verbatim (so the text
// returns if the convention does), the body becomes the note, and the workspace
// block is freshly composed rather than frozen.
test('deleting a custom convention keeps the marker verbatim and refreshes the workspace block', async () => {
  await addCustomConvention({ slug: 'doomed', name: 'Doomed', description: 'x', body: '## Doomed\n- committed body' });
  const created = await api(baseUrl, 'POST', '/api/projects', { name: 'refholder', conventions: ['doomed'] });
  assert.equal(created.status, 201);
  const target = conventionsPath('refholder');
  assert.match(await fs.readFile(target, 'utf8'), /committed body/);

  const del = await api(baseUrl, 'DELETE', '/api/settings/conventions/project/doomed');
  assert.equal(del.status, 200);
  const after = await fs.readFile(target, 'utf8');
  assert.equal(after.split('\n', 1)[0], '<!-- cc:conventions doomed -->', 'the marker keeps the deleted slug');
  assert.match(after, /> Convention unavailable: `doomed`\./);
  assert.doesNotMatch(after, /committed body/);
  assert.match(after, /# Workspace conventions/);

  // A direct re-run of the fan-out is byte-identical.
  await regenerateAllProjectConventions();
  assert.equal(await fs.readFile(target, 'utf8'), after);
});

// ── partial resolution: resolvable slugs refresh, unresolvable ones get a note ──

test('ensureProjectConventionsMd regenerates the resolvable remainder when only some slugs are unresolvable', async () => {
  await createProject('partial');
  const target = conventionsPath('partial');
  await fs.writeFile(target, '<!-- cc:conventions ghost-slug,design-guidelines -->\n\nSTALE\n');

  const res = await ensureProjectConventionsMd('partial');
  assert.equal(res.regenerated, true);
  assert.deepEqual(res.missing, ['ghost-slug']);

  const content = await fs.readFile(target, 'utf8');
  assert.equal(content.split('\n', 1)[0], '<!-- cc:conventions ghost-slug,design-guidelines -->', 'marker keeps the unresolvable slug verbatim');
  assert.match(content, /## Design guidelines/);
  assert.doesNotMatch(content, /STALE/);
});

// T9 — the whole document, byte for byte: marker, blank line, workspace block,
// the `# Project conventions` H1 separator, the note, then the bodies.
test('the composed document is byte-exact: marker, workspace block, project heading, note, bodies', async () => {
  await createProject('exact-note');
  const target = conventionsPath('exact-note');
  await fs.writeFile(target, '<!-- cc:conventions ghost-slug,design-guidelines -->\n\nSTALE\n');

  await ensureProjectConventionsMd('exact-note');

  const expected = '<!-- cc:conventions ghost-slug,design-guidelines -->\n\n'
    + await composeCurrentWorkspace()
    + '\n# Project conventions\n\n'
    + '> Convention unavailable: `ghost-slug`.\n'
    + await composeProjectConventionsBlock(['design-guidelines']);
  assert.equal(await fs.readFile(target, 'utf8'), expected);
});

// T10 — the same ordering, pinned independently of whitespace.
test('the workspace block precedes the project heading, which precedes the project bodies', async () => {
  await createProject('order-scopes');
  const target = conventionsPath('order-scopes');
  await fs.writeFile(target, '<!-- cc:conventions design-guidelines -->\n\nSTALE\n');
  await ensureProjectConventionsMd('order-scopes');

  const c = await fs.readFile(target, 'utf8');
  const ws = c.indexOf('# Workspace conventions');
  const pr = c.indexOf('# Project conventions');
  const body = c.indexOf('## Design guidelines');
  assert.ok(ws >= 0 && pr > ws && body > pr, `expected workspace < project < body, got ${ws}/${pr}/${body}`);
});

test('regeneration with an unresolvable slug is idempotent across repeated runs', async () => {
  await createProject('idempotent');
  const target = conventionsPath('idempotent');
  await fs.writeFile(target, '<!-- cc:conventions ghost-slug,design-guidelines -->\n\nSTALE\n');

  await ensureProjectConventionsMd('idempotent');
  const first = await fs.readFile(target, 'utf8');
  await ensureProjectConventionsMd('idempotent');
  await ensureProjectConventionsMd('idempotent');
  const third = await fs.readFile(target, 'utf8');

  assert.equal(third, first, 'Nth regeneration is byte-identical to the 1st');
  assert.equal(third.split('> Convention unavailable: `ghost-slug`.').length - 1, 1, 'the note never accumulates');
});

test('the note disappears and the real text returns byte-identically once the slug resolves again', async () => {
  await addCustomConvention({ slug: 'house-style', name: 'House style', description: 'x', body: '## House style\n- v1 rule' });
  const clean = await composeProjectConventionsDoc(['house-style', 'design-guidelines']);
  await createProject('recovers', { conventionsDoc: clean });
  const target = conventionsPath('recovers');

  await deleteCustomConvention('house-style');
  const res1 = await ensureProjectConventionsMd('recovers');
  assert.equal(res1.regenerated, true);
  const midway = await fs.readFile(target, 'utf8');
  assert.match(midway, /> Convention unavailable: `house-style`\./);
  assert.doesNotMatch(midway, /House style/);

  await addCustomConvention({ slug: 'house-style', name: 'House style', description: 'x', body: '## House style\n- v1 rule' });
  const res2 = await ensureProjectConventionsMd('recovers');
  assert.deepEqual(res2.missing, []);
  assert.equal(await fs.readFile(target, 'utf8'), clean, 'restored file is byte-identical to the never-broken original');
});

test('a degraded catalog does NOT freeze a marker whose slugs all resolve — the failure is unrelated to this project', async () => {
  await createProject('degraded-but-unaffected', { conventionsDoc: await composeProjectConventionsDoc(['design-guidelines']) });
  const target = conventionsPath('degraded-but-unaffected');
  await fs.writeFile(target, '<!-- cc:conventions design-guidelines -->\n\nSTALE\n');

  setPluginConventionsProvider(async () => { throw new Error('transient plugin host failure'); });
  try {
    const res = await ensureProjectConventionsMd('degraded-but-unaffected');
    assert.equal(res.regenerated, true, 'a plugin failure elsewhere in the catalog must not freeze a project with no plugin slug');
    assert.match(await fs.readFile(target, 'utf8'), /## Design guidelines/);
  } finally {
    setPluginConventionsProvider(null);
  }
});

// T7 — D4: a degraded catalog cannot block a project that has no project slugs
// to drop, so it can never leave a project with no conventions file at all.
test('a degraded catalog does NOT block a project with no project slugs', async () => {
  await createProject('degraded-no-slugs');            // no CONVENTIONS.md at all
  await createProject('degraded-zero-marker');
  await fs.writeFile(conventionsPath('degraded-zero-marker'), '<!-- cc:conventions -->\n\nSTALE\n');

  setPluginConventionsProvider(async () => { throw new Error('transient plugin host failure'); });
  try {
    for (const name of ['degraded-no-slugs', 'degraded-zero-marker']) {
      const res = await ensureProjectConventionsMd(name);
      assert.equal(res.regenerated, true, `${name} must still be written`);
      assert.match(await fs.readFile(conventionsPath(name), 'utf8'), /# Workspace conventions/);
    }
  } finally {
    setPluginConventionsProvider(null);
  }
});

test('a degraded catalog DOES freeze a marker that has an unresolvable slug — can\'t tell "gone" from "temporarily unreachable"', async () => {
  setPluginConventionsProvider(async () => [
    { slug: 'plug/foo', name: 'Foo', description: 'x', body: '## Foo\n- v1', plugin: 'plug' },
  ]);
  let target;
  try {
    const doc = await composeProjectConventionsDoc(['plug/foo', 'design-guidelines']);
    await createProject('degraded-and-affected', { conventionsDoc: doc });
    target = conventionsPath('degraded-and-affected');
  } finally {
    setPluginConventionsProvider(null);
  }
  // Stage the committed file as a copy that PREDATES the workspace block, so
  // the assertion below can tell "frozen whole-file" from "workspace region
  // refreshed anyway" — the honest statement of this decline's cost (D4).
  const committed = '<!-- cc:conventions plug/foo,design-guidelines -->\n\nSTALE — no workspace block here\n';
  await fs.writeFile(target, committed);

  // Now the plugin provider throws outright — 'plug/foo' becomes unresolvable,
  // but the catalog can't tell whether it's gone for good or just transiently
  // unreachable, so the write must be declined rather than dropping its text.
  setPluginConventionsProvider(async () => { throw new Error('transient plugin host failure'); });
  try {
    const res = await ensureProjectConventionsMd('degraded-and-affected');
    assert.equal(res.skipped, 'catalog-degraded');
    assert.deepEqual(res.missing, ['plug/foo']);
    const frozen = await fs.readFile(target, 'utf8');
    assert.equal(frozen, committed, 'never blank/rewrite a slug the degraded catalog can\'t vouch for');
    assert.doesNotMatch(frozen, /# Workspace conventions/,
      'the freeze is whole-file: the workspace region stays stale for this cycle too');
  } finally {
    setPluginConventionsProvider(null);
  }
});

// The retired `unresolvable` freeze reached through a body-less survivor: it
// too now regenerates (permanent condition — freezing would starve the project
// of workspace-convention updates forever).
test('a marker whose only survivor is a scaffold-only (body-less) plugin convention regenerates', async () => {
  setPluginConventionsProvider(async () => [
    { slug: 'plug/scaffold-only', name: 'Scaffold only', description: 'x', body: '', scaffold: 'do a thing', plugin: 'plug' },
  ]);
  try {
    await createProject('scaffold-frozen');
    const target = conventionsPath('scaffold-frozen');
    await fs.writeFile(target, '<!-- cc:conventions plug/scaffold-only,ghost-slug -->\n\n## Real body\n- keep me\n');

    const res = await ensureProjectConventionsMd('scaffold-frozen');
    assert.equal(res.regenerated, true);
    assert.deepEqual(res.missing, ['ghost-slug']);
    const content = await fs.readFile(target, 'utf8');
    assert.equal(content.split('\n', 1)[0], '<!-- cc:conventions plug/scaffold-only,ghost-slug -->');
    assert.match(content, /> Convention unavailable: `ghost-slug`\./);
    assert.match(content, /# Workspace conventions/);
    assert.doesNotMatch(content, /keep me/);
  } finally {
    setPluginConventionsProvider(null);
  }
});

// The retired `no-body` freeze: every slug resolves, none carries a body, so
// there is no note and no project part — just the marker and the workspace
// block, and the `# Project conventions` heading is omitted entirely.
test('a marker whose slugs ALL resolve but none carries a body regenerates to marker + workspace only', async () => {
  setPluginConventionsProvider(async () => [
    { slug: 'plug/scaffold-only', name: 'Scaffold only', description: 'x', body: '', scaffold: 'do a thing', plugin: 'plug' },
  ]);
  try {
    await createProject('all-resolve-no-body');
    const target = conventionsPath('all-resolve-no-body');
    await fs.writeFile(target, '<!-- cc:conventions plug/scaffold-only -->\n\n## Real body\n- keep me\n');

    const res = await ensureProjectConventionsMd('all-resolve-no-body');
    assert.equal(res.regenerated, true);
    assert.deepEqual(res.missing, []);
    const content = await fs.readFile(target, 'utf8');
    assert.equal(content,
      '<!-- cc:conventions plug/scaffold-only -->\n\n' + await composeCurrentWorkspace(),
      'marker + workspace block, no note and no project heading');
  } finally {
    setPluginConventionsProvider(null);
  }
});

test('a dropped slug does not reorder the surviving conventions; the note stays above the bodies', async () => {
  await createProject('order-check');
  const target = conventionsPath('order-check');
  await fs.writeFile(target, '<!-- cc:conventions documentation-guidelines,ghost-slug,design-guidelines -->\n\nSTALE\n');

  await ensureProjectConventionsMd('order-check');
  const content = await fs.readFile(target, 'utf8');
  const noteIdx = content.indexOf('Convention unavailable:');
  const docIdx = content.indexOf('## Documentation guidelines');
  const designIdx = content.indexOf('## Design guidelines');
  assert.ok(noteIdx >= 0 && noteIdx < docIdx && noteIdx < designIdx, 'note sits above both bodies');
  assert.ok(docIdx < designIdx, 'marker order preserved, not catalog order');
});

test('multiple unresolvable slugs are listed in marker order, not sorted', async () => {
  await createProject('multi-missing');
  const target = conventionsPath('multi-missing');
  await fs.writeFile(target, '<!-- cc:conventions ghost-b,design-guidelines,ghost-a -->\n\nSTALE\n');

  const res = await ensureProjectConventionsMd('multi-missing');
  assert.deepEqual(res.missing, ['ghost-b', 'ghost-a']);
  const content = await fs.readFile(target, 'utf8');
  assert.ok(content.includes('`ghost-b`, `ghost-a`'), 'note lists slugs in marker order, comma-joined');
});

test('deleting a custom convention through the HTTP fan-out leaves a note and keeps the rest resolvable', async () => {
  await addCustomConvention({ slug: 'doomed2', name: 'Doomed2', description: 'x', body: '## Doomed2\n- committed body' });
  const created = await api(baseUrl, 'POST', '/api/projects', { name: 'mixed-refholder', conventions: ['doomed2', 'design-guidelines'] });
  assert.equal(created.status, 201);
  const target = conventionsPath('mixed-refholder');

  const del = await api(baseUrl, 'DELETE', '/api/settings/conventions/project/doomed2');
  assert.equal(del.status, 200);

  const content = await fs.readFile(target, 'utf8');
  assert.equal(content.split('\n', 1)[0], '<!-- cc:conventions doomed2,design-guidelines -->');
  assert.match(content, /> Convention unavailable: `doomed2`\./);
  assert.match(content, /## Design guidelines/);

  // The fan-out path is idempotent, not just the direct call.
  await regenerateAllProjectConventions();
  assert.equal(await fs.readFile(target, 'utf8'), content);
});

test('deleting a custom convention that leaves a project all-unresolvable logs the regenerate line', async () => {
  await addCustomConvention({ slug: 'doomed3', name: 'Doomed3', description: 'x', body: '## Doomed3\n- committed body' });
  const created = await api(baseUrl, 'POST', '/api/projects', { name: 'logged-refholder', conventions: ['doomed3'] });
  assert.equal(created.status, 201);

  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); originalLog(...args); };
  try {
    const del = await api(baseUrl, 'DELETE', '/api/settings/conventions/project/doomed3');
    assert.equal(del.status, 200);
  } finally {
    console.log = originalLog;
  }

  const target = conventionsPath('logged-refholder');
  assert.ok(
    lines.includes(`CONVENTIONS.md regenerated without unresolvable doomed3: ${target}`),
    `expected the regenerate log line to be emitted; got: ${JSON.stringify(lines)}`,
  );
});
