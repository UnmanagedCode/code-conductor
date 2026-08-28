// THE SEAM TEST: no direct `fs` call and no directly-spawned process reaches a
// project tree — every one goes through the project's System.
//
// Phase 1 of Systems (docs/systems-design.md §8, §10) threads a System handle
// through every project-scoped operation. A leak — one surviving `fs.readFile`
// or `spawn` against a project path — is exactly what would keep working today
// and silently do the wrong thing the moment that project lives on another
// machine. So this file does not inspect the code: it WATCHES the two escape
// hatches while real operations run, and fails on any call that reached the
// watched tree without a `src/systems/localSystem.ts` frame beneath it.
//
// THE FIXTURE IS AN ADOPTED (external) PROJECT ON PURPOSE. Its tree sits in its
// own temp dir, far from the projects root, so "reached the project tree" is a
// pure path test with nothing to disentangle: cc's store, the `.external/<name>`
// symlink record and the worktree directory all live under the projects root
// and are LOCAL PLACEMENT — not part of any system — while the adopted repo
// itself is the project tree. (`external` has no relationship to remote
// systems; it is the fixture that separates the two path spaces cleanly.)
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
function spyOnSystem(LocalSystem) {
  for (const name of Object.getOwnPropertyNames(LocalSystem.prototype)) {
    if (name === 'constructor') continue;
    const orig = LocalSystem.prototype[name];
    if (typeof orig !== 'function') continue;
    LocalSystem.prototype[name] = function (...args) {
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
  };
  spyOnSystem(mods.localSystem.LocalSystem);

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
async function drive(label, fn) {
  watched = [target];
  systemOps = [];
  const before = leaks.length;
  try {
    return await fn();
  } finally {
    const escaped = leaks.slice(before);
    watched = [];
    assert.deepEqual(escaped, [],
      `${label}: reached the project tree without going through its System:\n  ${escaped.join('\n  ')}`);
    assert.ok(systemOps.length > 0,
      `${label}: no System operation touched the project tree — the test drove nothing`);
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
