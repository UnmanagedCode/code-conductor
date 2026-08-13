// Tests for the per-project in-tree CONVENTIONS.md regeneration contract
// (src/projectClaudeMd.ts). The file is app-owned + self-describing: line 1 is a
// `<!-- cc:conventions … -->` marker that is the source of truth for the
// selection, so any cc instance can regenerate the body from the file alone.
// Regeneration composes whichever marker slugs resolve locally and names the
// rest in a visible in-body note, keeping them in the marker so they recover
// verbatim if they resolve again. The committed file is left untouched (never
// blanked) whenever writing it would strip real text: a missing file, a
// non-marker first line, a zero-slug marker, a degraded catalog (can't tell
// "gone" from "temporarily unreachable"), or a marker where NOTHING resolves
// to a body — whether because every slug is unresolvable, or because every
// slug resolves but none of them carries one.

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

// ── grandfathering / never-blanks ─────────────────────────────────────────────

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

test('ensureProjectConventionsMd freezes (never blanks) when every slug fails to resolve to a body', async () => {
  await createProject('portable');
  const target = conventionsPath('portable');
  // A single-slug marker referencing a slug this instance's catalog does not
  // know (e.g. a custom convention that only existed on the originating
  // install): nothing resolves to a body, so — real last-known-good body
  // below it — the file is left exactly as committed, not because the slug
  // is unresolvable per se, but because that leaves nothing to compose.
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

  // DELETE fans out to regenerate — 'doomed' is now unresolvable and it's the
  // marker's only slug, so nothing resolves to a body; the committed
  // CONVENTIONS.md must be preserved exactly (never blanked — see the more
  // general "nothing resolves to a body" freeze pinned further below, which
  // this is one specific way of reaching).
  const del = await api(baseUrl, 'DELETE', '/api/settings/conventions/project/doomed');
  assert.equal(del.status, 200);
  assert.equal(await fs.readFile(target, 'utf8'), before, 'committed content preserved byte-for-byte');

  // A direct re-run of the fan-out is likewise a no-op on this project.
  await regenerateAllProjectConventions();
  assert.equal(await fs.readFile(target, 'utf8'), before);
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

test('unresolved-slug note has exact wording and sits above the resolvable bodies', async () => {
  await createProject('exact-note');
  const target = conventionsPath('exact-note');
  await fs.writeFile(target, '<!-- cc:conventions ghost-slug,design-guidelines -->\n\nSTALE\n');

  await ensureProjectConventionsMd('exact-note');

  const expected = '<!-- cc:conventions ghost-slug,design-guidelines -->\n\n'
    + '> Convention unavailable: `ghost-slug`.\n'
    + await composeProjectConventionsBlock(['design-guidelines']);
  assert.equal(await fs.readFile(target, 'utf8'), expected);
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
  const committed = await fs.readFile(target, 'utf8');

  // Now the plugin provider throws outright — 'plug/foo' becomes unresolvable,
  // but the catalog can't tell whether it's gone for good or just transiently
  // unreachable, so the write must be declined rather than dropping its text.
  setPluginConventionsProvider(async () => { throw new Error('transient plugin host failure'); });
  try {
    const res = await ensureProjectConventionsMd('degraded-and-affected');
    assert.equal(res.skipped, 'catalog-degraded');
    assert.deepEqual(res.missing, ['plug/foo']);
    assert.equal(await fs.readFile(target, 'utf8'), committed, 'never blank/rewrite a slug the degraded catalog can\'t vouch for');
  } finally {
    setPluginConventionsProvider(null);
  }
});

test('a marker whose only survivor is a scaffold-only (body-less) plugin convention still freezes', async () => {
  setPluginConventionsProvider(async () => [
    { slug: 'plug/scaffold-only', name: 'Scaffold only', description: 'x', body: '', scaffold: 'do a thing', plugin: 'plug' },
  ]);
  try {
    await createProject('scaffold-frozen');
    const target = conventionsPath('scaffold-frozen');
    const committed = '<!-- cc:conventions plug/scaffold-only,ghost-slug -->\n\n## Real body\n- keep me\n';
    await fs.writeFile(target, committed);

    const res = await ensureProjectConventionsMd('scaffold-frozen');
    assert.equal(res.skipped, 'unresolvable');
    assert.deepEqual(res.missing, ['ghost-slug']);
    assert.equal(await fs.readFile(target, 'utf8'), committed, 'never trade committed text for a bare note');
  } finally {
    setPluginConventionsProvider(null);
  }
});

test('a marker whose slugs ALL resolve but none carries a body still freezes (not "unresolvable" — nothing is missing)', async () => {
  setPluginConventionsProvider(async () => [
    { slug: 'plug/scaffold-only', name: 'Scaffold only', description: 'x', body: '', scaffold: 'do a thing', plugin: 'plug' },
  ]);
  try {
    await createProject('all-resolve-no-body');
    const target = conventionsPath('all-resolve-no-body');
    const committed = '<!-- cc:conventions plug/scaffold-only -->\n\n## Real body\n- keep me\n';
    await fs.writeFile(target, committed);

    const res = await ensureProjectConventionsMd('all-resolve-no-body');
    assert.equal(res.skipped, 'no-body');
    assert.equal(res.missing, undefined, 'nothing is actually unresolvable, so no missing list is reported');
    assert.equal(await fs.readFile(target, 'utf8'), committed, 'never blank the file just because every survivor is scaffold-only');
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

test('deleting a custom convention that leaves a project all-unresolvable logs the freeze reason', async () => {
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

  assert.ok(
    lines.includes("CONVENTIONS.md left as-is for 'logged-refholder': unresolvable doomed3"),
    `expected the freeze log line to be emitted; got: ${JSON.stringify(lines)}`,
  );
});
