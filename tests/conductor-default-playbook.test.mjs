// The dynamic default-playbook convention: selection state, the generated
// rendering, and its composition into the conductor role prompt.
//
// The property under test is DRIFT-IMPOSSIBILITY. The convention body is
// generated from the playbook definition at compose time, so there is nothing to
// keep in sync — mutate a definition and the rendering must follow. Every drift
// test therefore mutates a definition file and recomposes; a test that asserted
// only against fixed text would pass just as happily against a hand-authored
// body, which is the bug this surface exists to prevent.
//
// Fixtures are USER-OVERLAY playbooks (<store>/playbooks/*.json), never the
// built-in seeds: fragmentCatalog caches seed bodies for the process lifetime,
// so a mutated seed would be invisible and the drift proof would be vacuous.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  SEED_CONVENTIONS, setSelection, composeCurrentConduct,
  getDefaultPlaybook, setDefaultPlaybook, defaultPlaybookConvention, playbookListing,
} from '../src/conductorConventions.ts';
import { renderPlaybookConvention } from '../src/playbookConvention.ts';
import { loadPlaybooks } from '../src/playbooks.ts';
import { orchStoreRoot } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');
const CONVENTIONS_DIR = path.join(__dirname, '..', 'conventions', 'conductor');
const ALL_SLUGS = SEED_CONVENTIONS.map(m => m.slug);

let ctx, baseUrl, instances, home;

before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  ctx.projectsRoot = r.projectsRoot; ctx.claudeProjectsRoot = r.claudeProjectsRoot;
});
afterEach(async () => {
  await instances.shutdown();
  instances._idleSubscribers?.clear();
  await rmrf(home);
});

// ── fixture helpers ──────────────────────────────────────────────────────────

const FIXTURE_ID = 'driftpb';

// A two-stage overlay playbook exercising every render branch: authored stage
// descriptions, workers:"many", an `on`-driven edge and a bare
// (send_prompt-driven) one. It also carries `tools`/`needs` — not because they
// are rendered (they are not, deliberately), but so the fixture stays a
// realistic definition the validator accepts.
function fixture({ alphaDesc, betaDesc }) {
  return {
    id: FIXTURE_ID,
    name: 'Drift fixture',
    description: 'Overlay playbook used by the drift proof.',
    entryStages: ['alpha'],
    stages: {
      alpha: {
        description: alphaDesc,
        tools: { spawn_instance: { require: { mode: 'plan' } } },
      },
      beta: {
        description: betaDesc,
        needs: [{ stage: 'alpha', position: ['*'], liveness: 'any' }],
        workers: 'many',
        tools: { spawn_instance: 'allow' },
      },
    },
    transitions: [
      { from: 'alpha', to: 'beta', on: 'approve_plan' },
      { from: 'beta', to: 'alpha' },
    ],
  };
}

async function writeFixture(def) {
  const dir = path.join(orchStoreRoot(), 'playbooks');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${FIXTURE_ID}.json`), JSON.stringify(def, null, 2));
}

// Render the fixture the way a spawn would: through the selection + the real
// load path, not by handing the renderer an object built in the test.
async function renderFixture(def) {
  await writeFixture(def);
  await setDefaultPlaybook(FIXTURE_ID);
  return defaultPlaybookConvention();
}

// ── selection state ──────────────────────────────────────────────────────────

test('default playbook is unset by default; set/clear round-trips', async () => {
  assert.equal(await getDefaultPlaybook(), null);
  assert.equal(await setDefaultPlaybook('solo'), 'solo');
  assert.equal(await getDefaultPlaybook(), 'solo');
  assert.equal(await setDefaultPlaybook(null), null);
  assert.equal(await getDefaultPlaybook(), null);
});

test('an unknown playbook id is refused 400 and does not change the stored value', async () => {
  await setDefaultPlaybook('solo');
  await assert.rejects(() => setDefaultPlaybook('nope'), e => {
    assert.equal(e.statusCode, 400);
    assert.match(e.message, /unknown playbook id 'nope'/);
    return true;
  });
  assert.equal(await getDefaultPlaybook(), 'solo');
});

test('a user-overlay playbook is selectable (one catalog, not a second discovery layer)', async () => {
  await writeFixture(fixture({ alphaDesc: 'A.', betaDesc: 'B.' }));
  assert.equal(await setDefaultPlaybook(FIXTURE_ID), FIXTURE_ID);
});

test('setting the default leaves the convention selection untouched', async () => {
  await setSelection(['playbooks']);
  await setDefaultPlaybook('solo');
  const store = JSON.parse(await fs.readFile(path.join(orchStoreRoot(), 'conventions', 'conductor.json'), 'utf8'));
  assert.deepEqual(store.enabled, ['playbooks']);
  assert.equal(store.defaultPlaybook, 'solo');
});

// ── composition ──────────────────────────────────────────────────────────────

test('no default selected ⇒ no convention in the composed prompt', async () => {
  const doc = await composeCurrentConduct();
  assert.ok(!doc.includes('## Default playbook'), 'section absent');
});

test('default selected ⇒ its stages and per-stage descriptions are in the composed prompt', async () => {
  await setDefaultPlaybook('solo');
  const doc = await composeCurrentConduct();
  assert.ok(doc.includes('## Default playbook — `solo`'), 'section present');
  // LOAD-BEARING ORDER. The section deliberately omits the playbook's
  // description and a describe_playbook pointer because the listing above
  // carries both; met cold, it would cost the conductor the very round-trip this
  // surface exists to remove.
  // Presence FIRST: a bare indexOf comparison passes vacuously when the listing
  // is absent (-1 < any index) — which is the forbidden state, not the safe one.
  assert.ok(doc.includes('**Available playbooks**'), 'the listing is present at all');
  assert.ok(doc.indexOf('**Available playbooks**') < doc.indexOf('## Default playbook'),
    'the available-playbooks listing precedes the default-playbook section');
  const { playbooks } = await loadPlaybooks();
  const pb = playbooks.get('solo');
  for (const [name, stage] of Object.entries(pb.stages)) {
    assert.ok(doc.includes(`- **${name}**`), `stage ${name} listed`);
    assert.ok(doc.includes(stage.description), `stage ${name} description present`);
  }
});

test('the convention rides the playbooks convention toggle', async () => {
  await setDefaultPlaybook('solo');
  await setSelection(ALL_SLUGS.filter(s => s !== 'playbooks'));
  assert.ok(!(await composeCurrentConduct()).includes('## Default playbook'), 'absent with playbooks off');
  await setSelection(ALL_SLUGS);
  assert.ok((await composeCurrentConduct()).includes('## Default playbook'), 'present with playbooks on');
});

test('a selected id that no longer resolves omits the section rather than failing the spawn', async () => {
  await writeFixture(fixture({ alphaDesc: 'A.', betaDesc: 'B.' }));
  await setDefaultPlaybook(FIXTURE_ID);
  await fs.rm(path.join(orchStoreRoot(), 'playbooks', `${FIXTURE_ID}.json`));
  assert.equal(await defaultPlaybookConvention(), '');
  await assert.doesNotReject(composeCurrentConduct());
});

// ── the drift proof ──────────────────────────────────────────────────────────

test('drift proof: changing a stage description changes the rendered convention', async () => {
  const before = await renderFixture(fixture({
    alphaDesc: 'Brief the alpha worker and end the turn.',
    betaDesc: 'Read the beta result.',
  }));
  assert.ok(before.includes('Brief the alpha worker and end the turn.'));

  const after = await renderFixture(fixture({
    alphaDesc: 'Brief the alpha worker, then wait for its sentinel.',
    betaDesc: 'Read the beta result.',
  }));
  assert.ok(after.includes('Brief the alpha worker, then wait for its sentinel.'), 'new text rendered');
  assert.ok(!after.includes('Brief the alpha worker and end the turn.'), 'old text gone');
});


test('drift proof: the composed prompt (not just the renderer) follows a definition edit', async () => {
  await renderFixture(fixture({ alphaDesc: 'First wording.', betaDesc: 'B.' }));
  assert.ok((await composeCurrentConduct()).includes('First wording.'));
  await writeFixture(fixture({ alphaDesc: 'Second wording.', betaDesc: 'B.' }));
  const doc = await composeCurrentConduct();
  assert.ok(doc.includes('Second wording.'), 'recomposed from the edited definition');
  assert.ok(!doc.includes('First wording.'), 'no cached body');
});

// ── rendering ────────────────────────────────────────────────────────────────

test('authored descriptions are passed through VERBATIM — never reflowed or truncated', async () => {
  // Long, punctuated, and backticked: everything a "helpful" renderer would be
  // tempted to normalise. One home for this text is the definition.
  const long = 'Spawn the worker in a fresh worktree — brief it with the scoped goal, the constraints, '
    + 'and the `IMPLEMENTATION_COMPLETE` sentinel — then end your turn; on its wake, decide whether the '
    + 'sentinel is genuine before you treat any of the work as reviewable, and re-brief in place if it is not.';
  const out = await renderFixture(fixture({ alphaDesc: long, betaDesc: 'B.' }));
  assert.ok(out.includes(long), 'the exact authored string appears in the rendering');
  assert.ok(!out.includes('…'), 'nothing was elided');
});

test('capacity and both transition drivers are rendered from the definition', async () => {
  const out = await renderFixture(fixture({ alphaDesc: 'A.', betaDesc: 'B.' }));
  assert.ok(out.includes('- **alpha** — A.'), 'workers:"one" carries no flag');
  assert.ok(out.includes('- **beta** (many workers) — B.'), 'workers:"many" flag');
  assert.ok(out.includes('`alpha → beta` on `approve_plan`'), 'declared driver');
  assert.ok(out.includes('`beta → alpha` on `send_prompt`'), 'bare edge defaults to send_prompt');
});




test('facts a refusal volunteers are left in the payload, not copied into the prompt', async () => {
  // tools policy → TOOL_DENIED_IN_STAGE, `needs` → NEEDS_UNSATISFIED,
  // spawnability → STAGE_NOT_SPAWNABLE (and list_playbooks' spawnableStages).
  // Each arrives at point of use and cannot go stale under a live worker;
  // snapshotting them here would be a copy that can.
  const out = await renderFixture(fixture({ alphaDesc: 'A.', betaDesc: 'B.' }));
  assert.ok(!out.includes('policy:'), 'no tools policy summary');
  assert.ok(!out.includes('spawn_instance'), 'no policy entries at all');
  assert.ok(!out.includes('needs:'), 'no needs summary');
  assert.ok(!out.includes('(spawnable'), 'no spawnability marker');
});

test('the rendering does not echo what the playbooks listing already carries', async () => {
  // The listing sits directly above this section in the same prompt.
  const out = await renderFixture(fixture({ alphaDesc: 'A.', betaDesc: 'B.' }));
  assert.ok(!out.includes('Overlay playbook used by the drift proof.'), 'no top-level description echo');
  assert.ok(!out.includes('describe_playbook'), 'no second pointer at the authority');
});


test('transition descriptions are rendered when authored', async () => {
  const def = fixture({ alphaDesc: 'A.', betaDesc: 'B.' });
  def.transitions[0].description = 'This edge needs a fresh spawn.';
  const out = await renderFixture(def);
  assert.ok(out.includes('`alpha → beta` — This edge needs a fresh spawn.'));
});

// ── the system-prompt gate: no duplication of the authored fragments ──────────

const NGRAM = 8;
const shingles = (text) => {
  const words = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
  const out = new Set();
  for (let i = 0; i + NGRAM <= words.length; i++) out.add(words.slice(i, i + NGRAM).join(' '));
  return out;
};

// Everything else the composed prompt carries about playbooks: the two authored
// fragments AND the generated available-playbooks listing, which sits directly
// above this section. Omitting the listing is how a section that echoes it
// passes a duplication test.
async function fragmentShingles() {
  const bodies = await Promise.all(['canonical-workflow.md', 'playbooks.md']
    .map(f => fs.readFile(path.join(CONVENTIONS_DIR, f), 'utf8')));
  return shingles([...bodies, await playbookListing()].join('\n'));
}

test('the renderer\'s own prose duplicates nothing in canonical-workflow.md / playbooks.md', async () => {
  // Neutral stage text isolates the SCAFFOLD — the headings, labels, scope and
  // closure lines this module authors. Authored stage descriptions are verbatim
  // pass-throughs it does not own (see the next test).
  const out = await renderFixture(fixture({
    alphaDesc: 'Fixture stage alpha does nothing observable.',
    betaDesc: 'Fixture stage beta does nothing observable either.',
  }));
  const frag = await fragmentShingles();
  const overlap = [...shingles(out)].filter(s => frag.has(s));
  assert.deepEqual(overlap, [], 'scaffold shares no 8-word run with the authored fragments');
});

// EMPTY, and it stays empty. It was a frozen ceiling of 3 shingles while
// canonical-workflow.md still carried the review→refine mechanics that
// solo/relay's review+refine descriptions also carry; 2026-0068 deleted that
// prose, so the authored fragments and the built-in descriptions now share no
// 8-word run at all. What a non-empty diff proves is narrower than "one home":
// only that a fragment and a stage description now share text VERBATIM. The
// shared-worktree hazard, for one, legitimately appears in both — the doc's
// universal form and each `review` description's pair form — and passes because
// it is reworded, not because it is stated once. Verbatim overlap is the
// mechanical floor; the editorial gate is the grep audit. Fix the duplication
// the diff names, never the list.
const KNOWN_OVERLAP = [];

test('the built-ins duplicate nothing in the authored fragments', async () => {
  const frag = await fragmentShingles();
  const { playbooks } = await loadPlaybooks();
  const seen = new Set();
  for (const pb of playbooks.values()) {
    for (const s of shingles(renderPlaybookConvention(pb))) if (frag.has(s)) seen.add(s);
  }
  const unexpected = [...seen].filter(s => !KNOWN_OVERLAP.includes(s)).sort();
  assert.deepEqual(unexpected, [], 'no duplication beyond the frozen list');
});

// ── REST ─────────────────────────────────────────────────────────────────────

test('GET conductor conventions carries the playbook catalog and the selected default', async () => {
  const r = await api(baseUrl, 'GET', '/api/settings/conventions/conductor');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.playbooks) && r.body.playbooks.length > 0, 'catalog listed');
  assert.ok(r.body.playbooks.some(p => p.id === 'solo'), 'built-ins listed');
  assert.deepEqual(r.body.playbookErrors, [], 'load errors reported');
  assert.equal(r.body.defaultPlaybook, null);
});

test('PUT default-playbook persists, clears, and refuses an unknown id', async () => {
  let r = await api(baseUrl, 'PUT', '/api/settings/conventions/conductor/default-playbook', { id: 'relay' });
  assert.equal(r.status, 200);
  assert.equal(r.body.defaultPlaybook, 'relay');
  assert.equal((await api(baseUrl, 'GET', '/api/settings/conventions/conductor')).body.defaultPlaybook, 'relay');

  // Must not be swallowed by the /:slug route — that would 404 as an unknown
  // convention instead of validating the id.
  r = await api(baseUrl, 'PUT', '/api/settings/conventions/conductor/default-playbook', { id: 'nope' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unknown playbook id 'nope'/);

  r = await api(baseUrl, 'PUT', '/api/settings/conventions/conductor/default-playbook', { id: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.defaultPlaybook, null);
});

test('PUT default-playbook with no `id` key is a 400, not a silent clear', async () => {
  await api(baseUrl, 'PUT', '/api/settings/conventions/conductor/default-playbook', { id: 'solo' });
  const r = await api(baseUrl, 'PUT', '/api/settings/conventions/conductor/default-playbook', {});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /id is required/);
  assert.equal((await api(baseUrl, 'GET', '/api/settings/conventions/conductor')).body.defaultPlaybook, 'solo',
    'the selection survived the malformed request');
});
