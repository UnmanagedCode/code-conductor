// THE SEAM TEST: no direct `fs` call and no directly-spawned process reaches a
// project tree — every one goes through the project's System.
//
// Phase 1 of Systems threads a System handle through every project-scoped
// operation. A leak — one surviving `fs.readFile` or `spawn` against a project
// path — is exactly what would keep working today and silently do the wrong
// thing the moment that project lives on another machine. So this file does not
// inspect the code: it WATCHES the two escape hatches while real operations
// run, and fails on any call that reached the watched tree without a
// `src/systems/localSystem.ts` frame beneath it.
//
// BOTH PLACEMENTS ARE DRIVEN, and they cover different code. The ADOPTED
// (external) fixture is the clean one: its tree sits in its own temp dir, far
// from the projects root, so "reached the project tree" is a pure path test with
// nothing to disentangle — cc's store, the `.external/<name>` symlink record and
// the worktree directory all live under the projects root and are LOCAL
// PLACEMENT, not part of any system. (`external` has no relationship to remote
// systems; it is the fixture that separates the two path spaces cleanly.) But
// resolveProjectDir's IN-ROOT branch, createProject and deleteProject's
// tree-removal branch are only reachable from an in-root project, and a suite
// that drove only the adopted one would call them covered while never running
// them — so the last test drives an in-root project end to end, watching
// `<projectsRoot>/<name>` alone (the store and the worktree dir are siblings of
// it, not children, so they stay outside the watch by construction).
//
// THE INTERCEPTORS, and why they are installed the way they are:
//   - `fs.promises` is one shared object and src modules call `fs.readFile(…)`
//     by property lookup, so wrapping its methods is visible to code already
//     imported (the pattern tests/external-projects.test.mjs already uses).
//   - `node:child_process` is NOT: an ESM `import { spawn }` binds the function
//     at instantiation, so a later patch is invisible to a module that was
//     already loaded. Hence every src module here is imported DYNAMICALLY,
//     after the patch — the file must not statically import any of them.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { rmrf } from './rmrf.mjs';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');

// The call chain from a leaf `fs`/`spawn` call up to LocalSystem is several
// frames deep (LocalSystem.exec → runGroupedCommand → Promise executor → spawn),
// and V8's default of 10 frames can cut the frame this test looks for.
Error.stackTraceLimit = 60;

// Absolute roots whose subtree may only be reached through a System. Empty
// until the fixture is built, so setup does not report itself.
let watched = [];
// Calls that reached a watched path without a LocalSystem frame beneath them.
const leaks = [];
// Every System operation, with the arguments that name a path — the positive
// half: an operation that touched nothing proves nothing.
let systemOps = [];

function underWatched(v) {
  if (typeof v !== 'string' || v === '') return false;
  return watched.some(root => v === root || v.startsWith(root + path.sep));
}

function argTouches(a) {
  if (typeof a === 'string') return underWatched(a);
  if (Array.isArray(a)) return a.some(argTouches);
  if (a && typeof a === 'object') return underWatched(a.cwd) || underWatched(a.path);
  return false;
}

function viaSystem() {
  return (new Error().stack || '').includes(`systems${path.sep}localSystem.ts`);
}

function record(kind, name, args) {
  if (!watched.length) return;
  if (!args.some(argTouches)) return;
  if (viaSystem()) return;
  leaks.push(`${kind}.${name}(${args.map(a => {
    if (typeof a === 'string') return JSON.stringify(a);
    if (Array.isArray(a)) return JSON.stringify(a);
    if (a && typeof a === 'object' && a.cwd) return `{cwd:${JSON.stringify(a.cwd)}}`;
    return typeof a;
  }).join(', ')})`);
}

function installInterceptors() {
  for (const name of Object.keys(fsp)) {
    const orig = fsp[name];
    if (typeof orig !== 'function') continue;
    fsp[name] = function (...args) {
      record('fs', name, args);
      return orig.apply(this, args);
    };
  }
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const orig = childProcess[name];
    if (typeof orig !== 'function') continue;
    childProcess[name] = function (...args) {
      record('child_process', name, args);
      return orig.apply(this, args);
    };
  }
}

// Wrap every System method so the operations that DID go through the seam are
// observable. Wrapping the prototype catches the singleton the registry already
// built — a handle is looked up per call, so there is nothing to re-inject.
function spyOnSystem(SystemClass) {
  const proto = SystemClass.prototype;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    // Descriptor, not a property read: a System implementation may expose
    // ACCESSORS (ProviderSystem's `handshake`/`capabilities`), and reading one
    // off the prototype invokes it with no instance behind it.
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (typeof desc?.value !== 'function') continue;
    const orig = desc.value;
    proto[name] = function (...args) {
      if (args.some(argTouches)) systemOps.push(`${name}:${args.find(argTouches)}`);
      return orig.apply(this, args);
    };
  }
}

let home, projectsRoot, target, mods;

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    childProcess.execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

before(async () => {
  installInterceptors();
  // Dynamic, and only after the patch above — see the header.
  mods = {
    projects: await import('../src/projects.ts'),
    worktrees: await import('../src/worktrees.ts'),
    gitDiff: await import('../src/gitDiff.ts'),
    projectClaudeMd: await import('../src/projectClaudeMd.ts'),
    handlers: await import('../src/mcp/handlers.ts'),
    localSystem: await import('../src/systems/localSystem.ts'),
    providerSystem: await import('../src/systems/providerSystem.ts'),
  };
  // BOTH implementations of `System`. Which one the registry hands out depends
  // on CC_LOCAL_SYSTEM_PROVIDER (tests/systemHandle.mjs), and spying only the
  // in-process one would leave the positive half of every assertion below
  // observing nothing under the provider configuration.
  spyOnSystem(mods.localSystem.LocalSystem);
  spyOnSystem(mods.providerSystem.ProviderSystem);

  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-systems-seam-'));
  projectsRoot = path.join(home, 'projects');
  await fsp.mkdir(projectsRoot, { recursive: true });
  process.env.PROJECTS_ROOT = projectsRoot;
  process.env.CLAUDE_PROJECTS_ROOT = path.join(home, 'claude-projects');

  // The adopted repo, in its own dir OUTSIDE the projects root.
  const repo = path.join(home, 'the-repo');
  await fsp.mkdir(repo, { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await fsp.writeFile(path.join(repo, 'README.md'), '# the repo\n');
  // An in-tree post-worktree hook, deliberately without the executable bit, so
  // the hook path exercises stat + chmod + exec inside the project tree.
  await fsp.mkdir(path.join(repo, '.code-conductor'), { recursive: true });
  await fsp.writeFile(path.join(repo, '.code-conductor', 'post-worktree-create.sh'), '#!/bin/bash\necho hook ran\n');
  await fsp.chmod(path.join(repo, '.code-conductor', 'post-worktree-create.sh'), 0o644);
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'initial');
  target = await fsp.realpath(repo);

  const adopted = await mods.projects.adoptProject('ext', repo);
  assert.equal(adopted.ok, true, `adopt failed: ${JSON.stringify(adopted)}`);
});

after(async () => { await rmrf(home); });

// Run one real operation with the tree under watch, and report both halves:
// what the System saw, and what got past it.
// `expectSystemOps: false` is for an operation that legitimately touches nothing
// inside the tree — it still must not leak, but there is nothing to route.
async function drive(label, fn, { tree = target, expectSystemOps = true } = {}) {
  watched = [tree];
  systemOps = [];
  const before = leaks.length;
  try {
    return await fn();
  } finally {
    const escaped = leaks.slice(before);
    watched = [];
    assert.deepEqual(escaped, [],
      `${label}: reached the project tree without going through its System:\n  ${escaped.join('\n  ')}`);
    if (expectSystemOps) {
      assert.ok(systemOps.length > 0,
        `${label}: no System operation touched the project tree — the test drove nothing`);
    }
  }
}

test('resolving and listing a project reaches its tree only through the System', async () => {
  await drive('getProject', async () => {
    const proj = await mods.projects.getProject('ext');
    assert.equal(proj.path, target);
    assert.equal(proj.system.id, 'local', 'the resolver hands the caller a System handle');
  });
  await drive('listProjects', async () => {
    const names = (await mods.projects.listProjects()).map(p => p.name);
    assert.deepEqual(names, ['ext']);
  });
});

test('git reaches the project tree only through the System', async () => {
  await drive('getProjectCommits', async () => {
    const r = await mods.worktrees.getProjectCommits('ext');
    assert.equal(r.branch, 'main');
    assert.equal(r.commits.length, 1);
  });
  await drive('getProjectUncommittedDiff', async () => {
    const r = await mods.gitDiff.getProjectUncommittedDiff('ext');
    assert.deepEqual(r.files, []);
  });
});

test('creating a worktree — git, the in-tree hook, its chmod and its exec — stays on the System', async () => {
  const wt = await drive('createWorktree', async () => {
    const created = await mods.worktrees.createWorktree('ext');
    assert.equal(created.postWorktreeCreate.ran, true,
      'the in-tree hook must have run — it is what puts stat/chmod/exec on a project path under test');
    assert.match(created.postWorktreeCreate.output, /hook ran/);
    return created;
  });
  await drive('listWorktrees', async () => {
    const list = await mods.worktrees.listWorktrees('ext');
    assert.deepEqual(list.map(w => w.worktreeName), [wt.worktreeName]);
  });
  await drive('removeWorktree', () => mods.worktrees.removeWorktree('ext', wt.worktreeName));
});

test('the project_* tools read the project tree only through the System', async () => {
  await drive('projectStatus', async () => {
    const r = await mods.handlers.projectStatus({ project: 'ext' });
    assert.match(JSON.stringify(r), /README\.md/);
  });
  await drive('projectRead', async () => {
    const r = await mods.handlers.projectRead({ project: 'ext', relativePath: 'README.md' });
    assert.match(JSON.stringify(r), /# the repo/);
  });
});

test('regenerating CONVENTIONS.md writes into the project tree only through the System', async () => {
  await drive('ensureProjectConventionsMd', async () => {
    const r = await mods.projectClaudeMd.ensureProjectConventionsMd('ext');
    assert.equal(r.regenerated, true);
  });
  assert.match(await fsp.readFile(path.join(target, 'CLAUDE.md'), 'utf8'), /@CONVENTIONS\.md/);
});

test('deleting the project reaches the tree only through the System', async () => {
  await drive('deleteProject', async () => {
    const r = await mods.projects.deleteProject('ext');
    assert.equal(r.path, target);
  });
  assert.ok((await fsp.stat(target)).isDirectory(), 'the adopted repo survives — it was unregistered');
});

test('an IN-ROOT project reaches its tree only through the System, from create to delete', async () => {
  const name = 'inroot';
  const tree = path.join(projectsRoot, name);

  // createProject is itself under watch: the mkdir, the `git init` and both
  // seed-file writes land in the tree it is creating.
  await drive('createProject', async () => {
    const created = await mods.projects.createProject(name);
    assert.equal(created.path, tree);
  }, { tree });
  assert.match(await fsp.readFile(path.join(tree, 'CLAUDE.md'), 'utf8'), /@CONVENTIONS\.md/);

  // Give it a commit so the git surface has something to report. Test-side
  // setup, so it runs outside any watch.
  await fsp.writeFile(path.join(tree, 'README.md'), '# in-root\n');
  await git(tree, 'config', 'user.email', 'test@example.com');
  await git(tree, 'config', 'user.name', 'test');
  await git(tree, 'config', 'commit.gpgsign', 'false');
  await git(tree, 'add', '.');
  await git(tree, 'commit', '-q', '-m', 'initial');

  // resolveProjectDir's IN-ROOT branch — a different stat from the adopted
  // path's, and the one every in-root project in a real install goes through.
  await drive('getProject (in-root)', async () => {
    const proj = await mods.projects.getProject(name);
    assert.equal(proj.path, tree);
    assert.equal(proj.external, false);
  }, { tree });
  // Listing an IN-ROOT project touches nothing inside its tree — the path is
  // composed from the root enumeration, never probed — so there is no System op
  // to expect here, only nothing to leak. That is exactly why the root
  // `fs.readdir` is a sanctioned exception rather than a routing target.
  await drive('listProjects (in-root)', async () => {
    assert.deepEqual((await mods.projects.listProjects()).map(p => p.name), [name]);
  }, { tree, expectSystemOps: false });
  await drive('getProjectCommits (in-root)', async () => {
    const r = await mods.worktrees.getProjectCommits(name);
    assert.equal(r.commits.length, 1);
  }, { tree });
  await drive('projectRead (in-root)', async () => {
    const r = await mods.handlers.projectRead({ project: name, relativePath: 'README.md' });
    assert.match(JSON.stringify(r), /# in-root/);
  }, { tree });
  await drive('ensureProjectConventionsMd (in-root)', async () => {
    assert.equal((await mods.projectClaudeMd.ensureProjectConventionsMd(name)).regenerated, true);
  }, { tree });
  const wt = await drive('createWorktree (in-root)', () => mods.worktrees.createWorktree(name), { tree });
  assert.equal(path.dirname(wt.worktreePath), projectsRoot, 'the worktree dir is a SIBLING, not inside the watched tree');
  await drive('removeWorktree (in-root)', () => mods.worktrees.removeWorktree(name, wt.worktreeName), { tree });

  // deleteProject's other branch: an in-root project's tree really is removed,
  // through the System. The adopted fixture can only ever prove the opposite.
  await drive('deleteProject (in-root)', () => mods.projects.deleteProject(name), { tree });
  await assert.rejects(() => fsp.stat(tree), 'the in-root tree is removed — the unlink branch must not have swallowed this one');
});
