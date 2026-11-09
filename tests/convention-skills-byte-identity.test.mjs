// The composed system-prompt docs carry only inline parts: whatever skill parts
// the shipped fragments hold, and however many more are added, the text of the
// conductor role doc, the workspace block and a project's CONVENTIONS.md does
// not change. Run against the real `conventions/` tree.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { splitSkillPart } from '../src/skillPart.ts';
import { composeConductParts, SEED_CONVENTIONS as CONDUCTOR_SEEDS } from '../src/conductorConventions.ts';
import { composeWorkspaceParts, SEED_CONVENTIONS as WORKSPACE_SEEDS } from '../src/workspaceConventions.ts';
import { SEED_PROJECT_CONVENTIONS } from '../src/projectConventions.ts';
import { composeProjectConventionsDoc, projectSessionConventionSkills } from '../src/projectClaudeMd.ts';
import { localSystem } from '../src/systems/registry.ts';
import { SHIPPED_CONVENTIONS, SCOPES, scopeFiles, copyConventions, useConventionsDir } from './conventionsTree.mjs';

const SEEDS = {
  conductor: CONDUCTOR_SEEDS.map(s => s.slug),
  workspace: WORKSPACE_SEEDS.map(s => s.slug),
  project: SEED_PROJECT_CONVENTIONS.map(s => s.slug),
};
const explicitName = f => (f === 'core.md' ? 'required' : 'forbidden');

let home;
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await rmrf(home); });

test('every .md under conventions/<scope>/ is a seed, the core, or the conductor footer', async () => {
  for (const scope of SCOPES) {
    const allowed = new Set([...SEEDS[scope].map(s => `${s}.md`), ...(scope === 'project' ? [] : ['core.md']),
      ...(scope === 'conductor' ? ['footer.md'] : [])]);
    for (const f of await scopeFiles(SHIPPED_CONVENTIONS, scope)) {
      assert.ok(allowed.has(f), `conventions/${scope}/${f} is read by nothing — its text (and any skill part) would never ship`);
    }
  }
});

test('every shipped fragment parses, and a marker-less one parses to exactly the seed transform', async () => {
  for (const scope of SCOPES) {
    for (const f of await scopeFiles(SHIPPED_CONVENTIONS, scope)) {
      if (f === 'footer.md') continue;
      const raw = await fs.readFile(path.join(SHIPPED_CONVENTIONS, scope, f), 'utf8');
      const split = splitSkillPart(raw, { explicitName: explicitName(f) });
      if (!split.skill) assert.deepEqual(split, { inline: raw.replace(/\s+$/, '') }, `conventions/${scope}/${f}`);
    }
  }
});

// The three documents, composed from whatever tree CC_CONVENTIONS_DIR names
// (the shipped one when unset), with every seed of every scope selected.
async function composeAll() {
  const conduct = await composeConductParts(SEEDS.conductor);
  const workspace = await composeWorkspaceParts(SEEDS.workspace);
  const project = await composeProjectConventionsDoc({ mode: 'selected', slugs: SEEDS.project });
  return { conduct, workspace, project };
}

test('appending a skill part to every fragment and core leaves every composed doc byte-identical', async () => {
  const shipped = await composeAll();
  // The shipped tree's own skill bodies (if any) are absent from its docs.
  for (const s of [...shipped.conduct.skills, ...shipped.workspace.skills]) {
    for (const doc of [shipped.conduct.text, shipped.workspace.text, shipped.project]) {
      assert.ok(!doc.includes(s.body), `skill '${s.name}' body leaked into a composed doc`);
    }
  }
  for (const doc of [shipped.conduct.text, shipped.workspace.text, shipped.project]) {
    assert.doesNotMatch(doc, /^<!-- cc:skill/m, 'no skill marker reaches a composed doc');
  }

  const root = await copyConventions();
  const appended = { conductor: 0, workspace: 0, project: 0 };
  for (const scope of SCOPES) {
    for (const f of await scopeFiles(root, scope)) {
      if (f === 'footer.md') continue;
      const file = path.join(root, scope, f);
      const raw = await fs.readFile(file, 'utf8');
      // A fragment already carrying a skill part keeps it (a second marker is
      // an error); every other one gains one.
      if (splitSkillPart(raw, { explicitName: explicitName(f) }).skill) continue;
      const name = f === 'core.md' ? `:fixture-${scope}-core` : '';
      await fs.appendFile(file, `\n<!-- cc:skill${name} Fixture skill for ${scope}/${f}. -->\n\nFIXTURE-SKILL-BODY ${scope}/${f}\n`);
      appended[scope]++;
    }
  }
  assert.ok(appended.conductor > 0 && appended.workspace > 0 && appended.project > 0,
    `fixture check: every scope gained a skill part (${JSON.stringify(appended)})`);

  const restore = useConventionsDir(root);
  let withSkills;
  try { withSkills = await composeAll(); }
  finally { restore(); }

  assert.equal(withSkills.conduct.text, shipped.conduct.text, 'conductor role doc');
  assert.equal(withSkills.workspace.text, shipped.workspace.text, 'workspace block');
  assert.equal(withSkills.project, shipped.project, 'project CONVENTIONS.md');
  // Positive control: the appended parts did become skills, so the equality
  // above is about where they went, not about them being ignored. (Project
  // skills reach a session through its marker — the next test.)
  assert.equal(withSkills.conduct.skills.length, shipped.conduct.skills.length + appended.conductor, 'conductor skills');
  assert.equal(withSkills.workspace.skills.length, shipped.workspace.skills.length + appended.workspace, 'workspace skills');
});

// The project scope's skills reach a session through its CONVENTIONS.md marker,
// so they are counted there.
test('a project marker selecting every seed delivers each appended project skill', async () => {
  const root = await copyConventions({ stripSkills: true });
  for (const slug of SEEDS.project) {
    await fs.appendFile(path.join(root, 'project', `${slug}.md`), `\n<!-- cc:skill d ${slug} -->\nBODY ${slug}\n`);
  }
  const restore = useConventionsDir(root);
  try {
    const cwd = path.join(home, 'proj');
    await fs.mkdir(cwd, { recursive: true });
    const doc = await composeProjectConventionsDoc({ mode: 'selected', slugs: SEEDS.project });
    await fs.writeFile(path.join(cwd, 'CONVENTIONS.md'), doc);
    const groups = await projectSessionConventionSkills(localSystem(), cwd);
    assert.deepEqual(groups.find(g => g.scope === 'project').skills.map(s => s.name), SEEDS.project);
    assert.ok(!SEEDS.project.some(s => doc.includes(`BODY ${s}`)), 'no project skill body in the document');
  } finally { restore(); }
});
