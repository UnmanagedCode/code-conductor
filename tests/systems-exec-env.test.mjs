// WHAT ENVIRONMENT A COMMAND RUNS IN, and where cc's own environment stops.
//
// cc sends NO `env` frame field — on a derived command (cc's own plumbing) and
// on a caller's command alike. Every command runs in THE PROVIDER'S OWN
// ENVIRONMENT, which is the far side's: its PATH, its HOME, its toolchain. A
// caller that needs a variable ships it in argv through `env(1)`, the same way
// the derivations ship `LC_ALL=C`.
//
// THE RULE HAS A STATIC HALF AND A LIVE HALF, and they need different
// instruments.
//
// STATIC — what the two environments CONTAIN (PATH, HOME, the toolchain).
// Those values coincide whenever the provider sits on cc's own machine, which
// is every fixture in this file and precisely why the old default survived so
// long. The instrument for that half is a real boundary:
// tests/systems-docker-boundary.real.test.mjs, behind `RUN_DOCKER_SYSTEM=1`.
// NOT CLAIMED HERE.
//
// LIVE — a variable cc sets AFTER the provider launched is in cc's environment
// and in no other, so a command answers differently depending on whether cc
// sent its own environment, even on a same-machine provider. T3 is the
// instrument for that half, and it reads the difference off a RESULT rather
// than off the wire.
//
// The NO-EMISSION claims — T1 and T5 — are about a field cc must not put on a
// frame at all. A same-machine result cannot settle those either way, so they
// are made on the bytes that crossed the pipe
// (tests/fixtures/recordingProvider.mjs). T2 and T4 are not of that kind:
// each NAMES an `env` deliberately, so what it claims is observable here — a
// replaced environment in the child (and, for T2, the frame that carried it),
// and an interpreter a PATH-less `env` leaves unresolvable.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { seedRepo } from './remoteSystem.mjs';
import { IS_REFERENCE_PROVIDER, makeProviderSystem } from './referenceProviderHarness.mjs';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles, systemById } from '../src/systems/registry.ts';
import { adoptProject } from '../src/projects.ts';
import { createWorktree, runGit } from '../src/worktrees.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECORDER = path.join(__dirname, 'fixtures', 'recordingProvider.mjs');

// Every client frame the provider was sent, as decoded objects.
async function wire(file) {
  let raw = '';
  try { raw = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

const execFrames = async (file) => (await wire(file)).filter(f => f.type === 'exec');
// What a frame RAN, for a failure message that names the offending command
// rather than dumping a whole frame.
const ranWhat = (f) => (f.argv ? f.argv.join(' ') : `shell: ${f.shell}`);

describe('the environment on the wire', () => {
  let home, remoteRoot, rec;

  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    remoteRoot = await fs.realpath(await mkdtemp('cc-execenv-'));
    rec = path.join(home, 'wire.ndjson');
    await addSystem({ id: 'recbox', label: 'Recorder', launch: ['node', RECORDER, '--record', rec] });
  });
  afterEach(async () => { disposeSystemHandles(); await rmrf(home); });

  // T1 — PINS: no `exec` frame cc emits carries an `env` field, at every site
  // enumerated below. This is the whole contract, measured on the wire; every
  // other test in this file is about one edge of it.
  test('no exec frame cc sends carries an env field', async () => {
    const sys = await systemById('recbox', null, `project 'p'`);
    const repo = await seedRepo(path.join(remoteRoot, 'app'));

    // 1. runGit — the highest-volume caller shape in a whole-suite census.
    const g = await runGit(sys, repo, ['status', '--porcelain']);
    assert.equal(g.code, 0, g.stderr);
    // 2. the redirected Bash path: ProviderShell, one framed exec per command.
    //    A non-local `project_bash` takes this shape too — it sends
    //    `{shell: command}` (src/mcp/handlers.ts), not argv.
    const sh = await sys.shell({ cwd: repo }).run('echo hi');
    assert.equal(sh.code, 0, sh.stderr);
    // 3. the bare-argv shape, as the config-surface `find` in
    //    src/systems/sessionRoot.ts sends it.
    const one = await sys.exec({ argv: ['printf', 'ok'] }, { cwd: repo });
    assert.equal(one.stdout, 'ok');
    // 4. a derivation — already env-less before this rule was general, and
    //    pinned here so the rule is asserted as one rule and not as a caller
    //    policy that happens to agree with a separate derivation policy.
    assert.ok(await sys.stat(repo));
    // 5. cc's OWN reachability probe (`assertRemoteKnown`), which passes a
    //    literal null rather than falling through the default and so would
    //    survive a regression to it. Only a BOUND handle fires it, hence the
    //    second recorder. It lives HERE rather than beside the other bound-
    //    handle fixtures in tests/systems-remote-id.test.mjs because that
    //    file is about `remoteId` binding.
    const probeRec = path.join(home, 'probe.ndjson');
    await addSystem({
      id: 'boundbox', label: 'Bound',
      launch: ['node', RECORDER, '--record', probeRec, '--remote', `a=${remoteRoot}`],
    });
    await systemById('boundbox', 'a', `project 'p'`);

    const frames = [...await execFrames(rec), ...await execFrames(probeRec)];

    // ONE PRESENCE CHECK PER SITE, keyed on what only that site emits. A
    // spec-form floor (`some(f => f.argv) && some(f => f.shell)`) was MEASURED
    // to let three of the four argv sites vanish while the test stayed green,
    // so the header's "at every site enumerated below" was enforced by nothing.
    // Adding a sixth site means adding its line here in the same edit.
    const drove = (site, pred) => assert.ok(frames.some(pred), `site ${site} never reached the wire`);
    drove('1 (runGit)', f => f.argv?.[0] === 'git');
    drove('2 (the framed shell)', f => typeof f.shell === 'string');
    drove('3 (a bare-argv caller)', f => f.argv?.[0] === 'printf');
    drove('4 (a derivation)', f => f.argv?.[0] === 'env' && f.argv?.[1] === 'LC_ALL=C');
    drove('5 (the reachability probe)', f => f.cwd === '/' && f.argv?.[0] === 'true');

    assert.deepEqual(frames.filter(f => 'env' in f).map(ranWhat), []);
  });

  // T2 — PINS: `env`, when a CALLER names one, still REPLACES the environment
  // rather than overlaying it — on the wire (the frame carries exactly what was
  // named) and in the child (a variable cc's own process has is NOT visible).
  // The option's meaning is unchanged by the default's removal; §5's `env` row
  // and `ProviderSystem`'s `?? null` both depend on it.
  test('a caller-named env REPLACES, on the wire and in the child', async () => {
    // Set BEFORE the provider is launched, so a provider that overlaid the
    // frame onto its own environment would leak it into the child.
    process.env.CC_0317_AMBIENT = 'from-cc';
    try {
      const sys = await systemById('recbox', null, `project 'p'`);
      const named = { CC_0317_NAMED: 'named', PATH: process.env.PATH };
      const r = await sys.exec(
        { argv: ['sh', '-c', 'echo "[$CC_0317_NAMED][$CC_0317_AMBIENT]"'] },
        { cwd: remoteRoot, env: named },
      );
      assert.equal(r.stdout, '[named][]\n', 'the named env is the whole environment');

      const frames = await execFrames(rec);
      // AN ATTRIBUTION GUARD, NOT A COVERAGE PIN, and deliberately so. It makes
      // `frames[0]` well-defined and names which frame the deepEqual below read.
      // It is UNKILLABLE — weakened to `>= 1` the suite stays green, because
      // this fixture drives exactly one exec, so there is no second frame for a
      // mutant to expose — and
      // it is not meant to be killable: its value is realised on FAILURE, for a
      // debugger who arrives after the fixture starts emitting two. Leave it,
      // and do not re-report it as an uncovered assert.
      assert.equal(frames.length, 1);
      assert.deepEqual(frames[0].env, named, 'sent verbatim, not merged with cc\'s');
    } finally { delete process.env.CC_0317_AMBIENT; }
  });

  // T3 — PINS: a variable cc sets AFTER the provider launched is invisible to a
  // far-side command. THE LIVE HALF of the rule (see the file header), and the
  // half that needs no machine boundary: the variable is in cc's environment
  // and in no other, so the answer here differs depending on whether cc sent
  // its own environment. The connection is opened FIRST, deliberately —
  // `ProviderConnection` spawns lazily, so without the explicit connect the
  // provider would inherit the variable at launch and prove nothing.
  test('a variable set after the provider launched is invisible to its commands', async () => {
    const sys = makeProviderSystem([]);
    try {
      await sys.connect();
      process.env.CC_0317_LATE = 'set-after-the-provider-launched';
      const r = await sys.exec({ argv: ['sh', '-c', 'echo "[$CC_0317_LATE]"'] }, { cwd: os.tmpdir() });
      assert.equal(r.stdout.trim(), '[]',
        'the command runs in the environment of the machine it runs on, not cc\'s');
    } finally { delete process.env.CC_0317_LATE; sys.dispose(); }
  });

  // T4 — PINS: the reference provider spawns its `shell` interpreter
  // UNQUALIFIED, so a frame `env` without a usable PATH loses it. §5's `shell`
  // row describes that mechanism as the exemplar's and advises a provider that
  // honours `env` to name its interpreter absolutely; if someone qualifies this
  // one, this reds and the row is what must be edited with it.
  test('the exemplar resolves its shell interpreter through a frame env',
    { skip: IS_REFERENCE_PROVIDER ? false : 'asserts the reference provider\'s own interpreter spelling' },
    async () => {
      const noBin = await mkdtemp('cc-execenv-nopath-');
      const sys = makeProviderSystem([]);
      try {
        const r = await sys.exec({ shell: 'echo hi' }, { cwd: os.tmpdir(), env: { PATH: noBin } });
        assert.match(r.spawnError ?? '', /ENOENT/);
      } finally { sys.dispose(); }
    });

  // T5 — PINS: the post-worktree hook's `CC_*` vars ride in ARGV through
  // `env(1)`, and its frame carries no `env`. They are therefore ADDED to the
  // target's environment rather than replacing it — a hook that lost the
  // target's PATH could not run a build, which is most of what a hook is for.
  test('the post-worktree hook ships its CC_* vars in argv, not in a frame env', async () => {
    const tree = await seedRepo(path.join(remoteRoot, 'app'));
    const scriptPath = path.join(tree, '.code-conductor', 'post-worktree-create.sh');
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.writeFile(scriptPath, '#!/bin/sh\necho "project=$CC_PROJECT_NAME branch=$CC_BRANCH"\n', { mode: 0o755 });
    assert.equal((await adoptProject('app', tree, { system: 'recbox' })).ok, true);

    const wt = await createWorktree('app', { name: 'feature' });
    const h = wt.postWorktreeCreate;
    assert.equal(h.ran, true, JSON.stringify(h));
    assert.equal(h.exitCode, 0);
    assert.match(h.output, /project=app branch=code-conductor\//, 'the vars really reached the script');

    // Selected by CWD: the hook is the only exec sent with the worktree as its
    // cwd — the chmod/stat derivations naming the same script carry `/`.
    const hook = (await execFrames(rec)).find(f => f.cwd === wt.worktreePath);
    assert.ok(hook, 'the hook exec reached the wire');
    assert.equal('env' in hook, false, 'the hook carries no frame env');
    assert.deepEqual(hook.argv, [
      'env',
      `CC_WORKTREE_PATH=${wt.worktreePath}`,
      `CC_PROJECT_NAME=app`,
      `CC_BRANCH=${wt.branch}`,
      `CC_BASE_BRANCH=${wt.baseBranch}`,
      `CC_PARENT_PATH=${tree}`,
      'bash', scriptPath,
    ]);
  });
});
