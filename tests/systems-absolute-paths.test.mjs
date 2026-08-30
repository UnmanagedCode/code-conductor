// cc NEVER SENDS A RELATIVE PATH TO A SYSTEM — enforced, not merely declared.
//
// docs/systems-protocol.md §1 states the invariant, and nothing held anyone to
// it: `ProviderSystem` would ship whatever string a caller composed. Twice now
// the same defect has been the gap between a guarded resolver and an unguarded
// one — a call site that resolved only the SYSTEM, then composed a path from a
// project row that had none, producing `path.join('', 'CONVENTIONS.md')` →
// `'CONVENTIONS.md'`. A relative path on the wire resolves against wherever the
// provider process happens to run, so a WRITE lands in a directory nobody chose
// and the call reports success.
//
// A relative path reaching a System is cc's OWN bug, never a provider's, so it
// fails hard and loudly rather than returning a refusal a caller might swallow.
// This guard is what should have caught both instances.
//
// IT IS ENFORCED ON BOTH IMPLEMENTATIONS, and the table below runs against
// both. The invariant is a property of cc's CALLERS, not of a transport:
// guarding only the wire would leave production `local` — the system every
// ordinary project uses — unguarded, where the identical composition bug writes
// into cc's own process cwd and reports success. `npm run gate:systems` routes
// `local` through `ProviderSystem`, but `npm test` is the stated bar and would
// then say nothing about this class on the local path.
//
// The two halves below are deliberately separate: the boundary guard (does the
// rule hold at all?) and the call site it was breached at (does the sweep still
// reach it?).

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { bindRemoteSystem, seedRepo } from './remoteSystem.mjs';
import { adoptProject, projectStoreDir, listProjects, findSelfProject } from '../src/projects.ts';
import { regenerateAllProjectConventions, ensureProjectConventionsMd } from '../src/projectClaudeMd.ts';
import { disposeSystemHandles, systemById } from '../src/systems/registry.ts';
import { LocalSystem } from '../src/systems/localSystem.ts';
import { addSystem } from '../src/appSettings.ts';

// This repo's own root — what the fence exists to keep relative writes out of.
const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

async function exists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}

async function writeRecord(name, record) {
  await fs.mkdir(projectStoreDir(name), { recursive: true });
  await fs.writeFile(path.join(projectStoreDir(name), 'project.json'), JSON.stringify(record, null, 2) + '\n');
}

// Every path-taking entry point, as (label, call). Shared by both
// implementations so neither can grow a hole the other does not have.
const PATH_OPS = (sys) => [
  ['stat', () => sys.stat('CONVENTIONS.md')],
  ['readFile', () => sys.readFile('CONVENTIONS.md')],
  ['readFileBytes', () => sys.readFileBytes('CONVENTIONS.md')],
  ['writeFile', () => sys.writeFile('CONVENTIONS.md', 'x')],
  ['readDir', () => sys.readDir('sub')],
  ['realpath', () => sys.realpath('')],
  ['mkdir', () => sys.mkdir('sub')],
  ['removeTree', () => sys.removeTree('sub')],
  ['unlink', () => sys.unlink('f')],
  ['chmod', () => sys.chmod('f', 0o755)],
];

function guardSuite(label, make) {
  describe(`${label} refuses a relative path`, () => {
    let home, sys, prevCwd;
    // A RELATIVE WRITE LANDS IN THE CURRENT DIRECTORY. These probes write
    // `CONVENTIONS.md`, and with the guard absent that is this repo's own
    // tracked `CONVENTIONS.md` — a system-prompt surface — for the LocalSystem
    // half in this process, and for the ProviderSystem half in the provider,
    // which inherits this cwd. A test that can clobber a tracked file whenever
    // the code under test regresses is a hazard for every mutation run, so the
    // probes are fenced into a scratch directory the same way the sweep tests
    // are. The assertions are unchanged; only the blast radius is.
    beforeEach(async () => {
      ({ home } = await freshProjectsRoot());
      prevCwd = process.cwd();
      process.chdir(await fs.mkdtemp(path.join(home, 'relative-write-fence-')));
      sys = await make();
    });
    afterEach(async () => {
      process.chdir(prevCwd);
      disposeSystemHandles();
      await rmrf(home);
    });

    // PINS: every path-taking operation refuses a relative path, so no future
    // call site can silently repeat the defect through a different method.
    test('every path-taking operation refuses one', async () => {
      for (const [name, call] of PATH_OPS(sys)) {
        await assert.rejects(call, (e) => /absolute/i.test(e.message) && e.message.includes(name),
          `${name} must refuse a relative path, naming itself`);
      }
    });

    // PINS: the empty string is the shape the defect actually took — it is not
    // absolute, and `path.join('', x)` is what produced it.
    test('the empty path — the shape the defect took — is refused', async () => {
      await assert.rejects(() => sys.writeFile('', 'x'), (e) => /absolute/i.test(e.message));
      await assert.rejects(() => sys.stat(''), (e) => /absolute/i.test(e.message));
    });

    // PINS: `exec`'s cwd is guarded too — a command run in a relative directory
    // lands wherever the process happens to be, exactly like a relative write.
    test("exec's cwd is guarded as well", async () => {
      await assert.rejects(() => sys.exec({ argv: ['pwd'] }, { cwd: 'sub' }),
        (e) => /absolute/i.test(e.message) && /cwd/.test(e.message));
    });

    // PINS: it is a THROW, not a returned refusal — `exec` otherwise never
    // rejects, and swallowing cc's own bug as a result the caller inspects is
    // how this class stays invisible.
    test('it throws rather than resolving to a result exec callers would inspect', async () => {
      let threw = false;
      try { await sys.exec({ argv: ['pwd'] }, { cwd: 'relative' }); } catch { threw = true; }
      assert.equal(threw, true, 'exec rejects here even though it never rejects otherwise');
    });

    // PINS THE FENCE ITSELF. Without this the fence is an untested assumption
    // that a later fixture restructure would silently drop, bringing back a
    // suite that clobbers the repo's own tracked CONVENTIONS.md the moment the
    // guard regresses — which is exactly when nobody is looking at the fixture.
    test('a relative write from here cannot reach the repo', async () => {
      await fs.writeFile('CONVENTIONS.md', 'fence probe');
      assert.equal(await fs.readFile(path.join(process.cwd(), 'CONVENTIONS.md'), 'utf8'), 'fence probe');
      assert.ok(!process.cwd().startsWith(REPO_ROOT),
        `the relative-write probes must not run inside the repo: ${process.cwd()}`);
    });

    // PINS: the guard does not touch the normal path — an absolute one works.
    test('an absolute path is unaffected', async () => {
      const f = path.join(home, 'ok.txt');
      await sys.writeFile(f, 'hello');
      assert.equal(await sys.readFile(f), 'hello');
      assert.equal((await sys.exec({ argv: ['pwd'] }, { cwd: home })).stdout.trim(), home);
    });
  });
}

// The in-process implementation, constructed directly rather than via
// localSystem(): under the systems gate that accessor hands back a
// ProviderSystem, and this half exists precisely to cover the one `npm test`
// alone reaches.
guardSuite('LocalSystem', async () => new LocalSystem());

guardSuite('ProviderSystem', async () => {
  await addSystem({
    id: 'refbox', label: 'Reference',
    launch: (await import('./remoteSystem.mjs')).referenceLaunch(),
  });
  return systemById('refbox', 'test');
});

// The PERSISTENT SHELL is a second entry into an `exec` frame, and it carried
// its own `cwd` past the guard: `execOneShot` goes through `exec` and was
// covered, `openStream` did not. It is the entry a redirected Bash session
// drives, so a hole there is the one that matters most.
describe('the persistent shell carries its cwd through the same guard', () => {
  let home, sys, prevCwd;
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    // Same fence as guardSuite: an unguarded relative cwd resolves against the
    // process's own directory, which must never be the repo.
    prevCwd = process.cwd();
    process.chdir(await fs.mkdtemp(path.join(home, 'relative-cwd-fence-')));
    await addSystem({
      id: 'refbox', label: 'Reference',
      launch: (await import('./remoteSystem.mjs')).referenceLaunch(),
    });
    sys = await systemById('refbox', 'test');
  });
  afterEach(async () => { process.chdir(prevCwd); disposeSystemHandles(); await rmrf(home); });

  // PINS: openStream refuses a relative cwd. Unguarded, a shell either failed
  // from the FAR side (the relative path had crossed the wire) or — with a
  // directory of that name present where the provider ran — happily served
  // commands from a directory nobody chose, reporting success.
  test('openStream refuses a relative cwd', async () => {
    await assert.rejects(
      () => sys.openStream({ argv: ['/bin/sh', '-l'] }, { cwd: 'relative' }, {
        onStdout: () => {}, onStderr: () => {}, onExit: () => {}, onDown: () => {},
      }),
      (e) => /absolute/i.test(e.message) && /cwd/.test(e.message),
    );
  });

  // PINS the same through `shell()`, the surface a caller actually uses — the
  // guard has to fire before a command can run, not merely on the raw entry.
  test('shell() refuses one before a command can run', async () => {
    const shell = sys.shell({ cwd: 'relative' });
    await assert.rejects(() => shell.run('pwd'), (e) => /absolute/i.test(e.message) && /cwd/.test(e.message));
  });

  // PINS: an absolute cwd still opens a working shell, so the guard did not
  // close the persistent-shell path itself.
  test('an absolute cwd still opens a working shell', async () => {
    const shell = sys.shell({ cwd: home });
    const r = await shell.run('pwd');
    assert.equal(r.code, 0, JSON.stringify(r));
    assert.equal(r.stdout.trim(), home);
    shell.forget?.();
  });
});

describe('the conventions sweep never writes to an unresolvable project', () => {
  let ctx, baseUrl, home, remote;
  before(async () => { ctx = await bootServer(); ({ baseUrl } = ctx); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    ctx.projectsRoot = process.env.PROJECTS_ROOT;
    remote = await bindRemoteSystem();
  });
  afterEach(async () => { await ctx.instances.shutdown(); disposeSystemHandles(); await rmrf(home); });

  // The provider inherits this process's cwd, so a RELATIVE write lands there.
  // Both sweep tests run under a scratch directory: unguarded, this defect
  // overwrites `CONVENTIONS.md` and prepends to `CLAUDE.md` in whatever
  // directory the run started in — which for this suite is the repo itself.
  async function sweepUnderScratchCwd() {
    const cwd = await fs.mkdtemp(path.join(home, 'provider-cwd-'));
    const prev = process.cwd();
    process.chdir(cwd);
    try { return { cwd, results: await regenerateAllProjectConventions() }; }
    finally { process.chdir(prev); }
  }

  // PINS THE DEFECT: a record naming a REACHABLE system with no `systemPath`
  // resolves its system fine, so a sweep that resolved only the system composed
  // `path.join('', …)` and reported `regenerated: true` for a write that went
  // nowhere anyone chose.
  test('a record with no systemPath is an error entry, never a success', async () => {
    await writeRecord('broken', { system: remote.id });
    const { results } = await sweepUnderScratchCwd();
    const row = results.find(r => r.name === 'broken');
    assert.ok(row, `the row is swept, not skipped: ${JSON.stringify(results)}`);
    assert.equal(row.regenerated, undefined, 'it must not report success');
    assert.match(String(row.error), /systemPath/,
      'the sweep records WHY, which is what the per-project catch is for');
  });

  // PINS: and nothing is written. The report and the filesystem are two separate
  // claims — the defect got the first one wrong BECAUSE it got the second wrong.
  test('nothing is written into the provider working directory', async () => {
    await writeRecord('broken', { system: remote.id });
    const { cwd } = await sweepUnderScratchCwd();
    assert.equal(await exists(path.join(cwd, 'CONVENTIONS.md')), false,
      'a relative write would have landed here');
    assert.equal(await exists(path.join(cwd, 'CLAUDE.md')), false);
  });

  // PINS: the single-project form refuses too — the sweep is not the only
  // caller (adopt and the convention-mutation routes reach it directly).
  test('ensureProjectConventionsMd refuses that project by name', async () => {
    await writeRecord('broken', { system: remote.id });
    await assert.rejects(() => ensureProjectConventionsMd('broken'), (e) => /systemPath/.test(e.message));
  });

  // PINS: one bad record does not stop the sweep reaching the healthy projects
  // beside it — the whole point of the per-project catch.
  test('a healthy project beside it is still regenerated', async () => {
    const tree = await seedRepo(path.join(remote.root, 'ok'));
    assert.equal((await adoptProject('ok', tree, { system: remote.id })).ok, true);
    await api(baseUrl, 'POST', '/api/projects', { name: 'localone' });
    await writeRecord('broken', { system: remote.id });

    const results = await regenerateAllProjectConventions();
    assert.equal(results.find(r => r.name === 'ok').regenerated, true);
    assert.equal(results.find(r => r.name === 'localone').regenerated, true);
    assert.ok(results.find(r => r.name === 'broken').error);
    assert.match(await fs.readFile(path.join(tree, 'CONVENTIONS.md'), 'utf8'), /cc:conventions/);
  });

  // PINS: the other consumer of a listing row's path skips an unresolvable one
  // rather than sending a relative path across and relying on the far side to
  // fail. Benign before the guard; a hard throw after it.
  test('findSelfProject skips an unresolvable row instead of probing it', async () => {
    await writeRecord('broken', { system: remote.id });
    assert.ok((await listProjects()).some(p => p.name === 'broken'), 'the row is present to be skipped');
    assert.equal(await findSelfProject(path.join(home, 'nowhere')), null,
      'the sweep completes and answers, rather than throwing on the bad row');
  });
});
