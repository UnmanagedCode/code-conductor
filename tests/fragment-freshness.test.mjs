// A fragment edited on disk reaches the NEXT composition, with no orchestrator
// restart — across the whole composition path, not just the catalog helper.
//
// The stake is not staleness alone. Every document these composers feed is
// app-owned and REGENERATED OVER a committed file (src/conduct.ts before every
// conductor spawn/resume, src/projectClaudeMd.ts on boot and after every
// workspace-settings save), so a body memoised at first read gets written back
// over the correct committed text: the edit lands and silently reverts.
//
// WHY THE fs SEAM. CONVENTIONS_DIR in src/workspaceConventions.ts and
// src/conductorConventions.ts is hard-resolved from import.meta.url and offers
// no injection point, and the committed fragments must not be written to — this
// working tree is shared with every other test file in the run, and siblings
// assert byte-identical composed docs. Substituting one absolute path's bytes at
// the fs boundary is process-local and deterministic. (The mechanism-level claim
// — that createFragmentCatalog holds no memo at all — is proved against a real
// filesystem with no mock in tests/fragment-catalog.test.mjs.)

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { createProject } from '../src/projects.ts';
import { composeCurrentWorkspace } from '../src/workspaceConventions.ts';
import { composeCurrentConduct } from '../src/conductorConventions.ts';
import { composeProjectConventionsDoc, ensureProjectConventionsMd, conventionsTargetPath } from '../src/projectClaudeMd.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fragment = (...parts) => path.join(REPO, 'conventions', ...parts);

let home, projectsRoot;
beforeEach(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await rmrf(home); });

// Substitute the bytes of the named absolute paths for the duration of fn.
// Every other read — listProjects, resolveProjectDir, system.readFile(target),
// the playbook definitions — delegates to the real readFile. Restoration is in
// a finally, so a failing assertion inside the window cannot leak the patch.
async function withFragments(t, bodies, fn) {
  const real = fsp.readFile;
  t.mock.method(fsp, 'readFile', async (p, ...rest) => {
    const substitute = bodies[String(p)];
    return substitute === undefined ? real.call(fsp, p, ...rest) : substitute;
  });
  try { return await fn(); } finally { t.mock.restoreAll(); }
}

const withFragment = (t, absPath, body, fn) => withFragments(t, { [absPath]: body }, fn);

// ── Each scope covers the always-on fragment read that sits OUTSIDE the catalog
//    helper (core.md, footer.md) AND one catalog seed, so a fix reaching only
//    the factory's memo leaves these red.
//
// One SUBTEST per fragment, not one loop: a row that aborts must not take the
// next row's assertion with it, so each fragment is observed on its own.
async function eachFragment(t, scope, rows, compose, what) {
  for (const [file, heading] of rows) {
    await t.test(`${scope}/${path.basename(file)}`, async (tt) => {
      const sentinel = `cc-0415-${scope}-${path.basename(file, '.md')}`;
      const before = await compose();                   // warms every cache in the path
      assert.ok(!before.includes(sentinel), 'the sentinel is not in the committed text');
      const after = await withFragment(tt, file, `${heading}\n\n- ${sentinel}\n`, compose);
      assert.match(after, new RegExp(sentinel), `${what} carries the CURRENT bytes of the fragment`);
    });
  }
}

test('a workspace fragment edited mid-process appears in the next composeCurrentWorkspace()', async (t) => {
  await eachFragment(t, 'workspace', [
    [fragment('workspace', 'core.md'), '# Workspace conventions'],  // the always-on read
    [fragment('workspace', 'git-hygiene.md'), '## Git hygiene'],    // a catalog seed
  ], composeCurrentWorkspace, 'the workspace block');
});

test('a conductor core/footer edit appears in the next composeCurrentConduct()', async (t) => {
  await eachFragment(t, 'conductor', [
    [fragment('conductor', 'core.md'), '# Conductor'],
    [fragment('conductor', 'footer.md'), '## Footer'],
  ], composeCurrentConduct, 'the role doc');
});

// The defect exactly as reported: a regeneration in a long-lived process writing
// pre-edit text back over a correct committed CONVENTIONS.md.
test('regeneration in the same process writes the CURRENT fragment text', async (t) => {
  const SENTINEL = 'cc-0415-regen';
  await createProject('regen', { conventionsDoc: await composeProjectConventionsDoc(['design-guidelines']) });
  await ensureProjectConventionsMd('regen');            // warms every cache in the path
  const target = conventionsTargetPath(path.join(projectsRoot, 'regen'));
  const first = await fsp.readFile(target, 'utf8');
  assert.ok(!first.includes(SENTINEL), 'the sentinel is not in the committed text');

  await withFragments(t, {
    [fragment('workspace', 'git-hygiene.md')]: `## Git hygiene\n\n- ${SENTINEL}-ws\n`,
    [fragment('project', 'design-guidelines.md')]: `## Design guidelines\n\n- ${SENTINEL}-proj\n`,
  }, () => ensureProjectConventionsMd('regen'));

  // Both scopes in ONE assertion so a failure names every scope that reverted,
  // rather than stopping at the first.
  const second = await fsp.readFile(target, 'utf8');
  assert.deepEqual(
    { workspace: second.includes(`${SENTINEL}-ws`), project: second.includes(`${SENTINEL}-proj`) },
    { workspace: true, project: true },
    'the regenerated file carries the CURRENT workspace and project fragments, not the ones read at boot');
});
