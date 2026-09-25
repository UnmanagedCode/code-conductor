// ONE CLI CONFIG DIRECTORY PER REMOTE, and the transcript isolation that falls
// out of it.
//
// The CLI names `<configDir>/projects/<encodeCwd(getcwd())>/` from its cwd. Under
// the FUSE union a remote-backed worker runs at the REMOTE's own path spelling,
// so the cwd carries nothing identifying which machine it is: two projects at
// `/root/app3` on two boxes derive ONE directory. cc does not rename that
// directory — it points each remote's CLI at a config directory of its own, so
// the cwd-derived name is scoped by a root that already differs.
//
// `encodeCwd` is UNCHANGED for every place, local and remote. What changes is
// the root it is joined to, and for a local place that root is exactly what it
// was (T5, the control).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { api, bootServer, freshProjectsRoot, rmrf, seedSessionJsonl, waitFor } from './helpers.mjs';
import { bindRemoteSystem, seedRepo } from './remoteSystem.mjs';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import {
  adoptProject, claudeConfigFarmRoot, claudeProjectsRoot, createProject, encodeCwd,
  findOrphanedTranscript, findSessionLocation, listSessionsForCwd, localPlace,
  projectRootPlace, remoteConfigDir, remoteConfigDirName, sessionFilePath,
  subAgentDirPath, transcriptRoot,
} from '../src/projects.ts';
import { ensureRemoteConfigDir } from '../src/claudeConfigFarm.ts';

describe('the per-remote CLI config directory', () => {
  let home;
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { await rmrf(home); });

  // ── T4: the directory name is filesystem-safe for a hostile remoteId ──
  //
  // `validateRemoteId` DELIBERATELY permits `_`, `.`, `/` and `..` — a remote id
  // is a container name, a hostname or a VM id, and those legitimately carry
  // them. So a raw remoteId is a path-traversal hazard the moment it is used as
  // a directory name, and the sanitising is load-bearing rather than cosmetic.
  describe('T4: dirName is filesystem-safe for a hostile remoteId', () => {
    const hostile = [
      ['parent traversal', '../escape'],
      ['deep traversal', '../../../../etc/passwd'],
      ['a path separator', 'a/b'],
      ['a bare dot', '.'],
      ['a bare double dot', '..'],
      ['a leading dot', '.hidden'],
      ['128 characters', 'x'.repeat(128)],
      ['dots and slashes only', './../.'],
      ['a null-ish mix', 'a.b_c-d/e'],
      ['no remote id at all', null],
    ];

    for (const [label, remoteId] of hostile) {
      test(`stays under the farm root: ${label}`, () => {
        const dir = remoteConfigDir({ system: 'box', remoteId });
        const farm = claudeConfigFarmRoot();
        // The containment claim, made on a NORMALISED path so a surviving `..`
        // cannot satisfy it by string prefix alone.
        assert.equal(path.normalize(dir), dir, `dirName left a traversable segment: ${dir}`);
        assert.ok(dir.startsWith(farm + path.sep), `${dir} escaped ${farm}`);
        // Exactly two components below the farm root: `<dirName>/.claude`.
        const rel = path.relative(farm, dir).split(path.sep);
        assert.equal(rel.length, 2, `expected <dirName>/.claude, got ${rel.join('/')}`);
        assert.equal(rel[1], '.claude');
        assert.doesNotMatch(rel[0], /[^A-Za-z0-9-]/, `dirName has unsafe characters: ${rel[0]}`);
      });
    }

    // The digest is the whole of the uniqueness claim; the slug is a
    // readability hint that truncation may eat. Two ids that sanitise to the
    // SAME slug must still get different directories, or the traversal fix
    // would have quietly created a collision of its own.
    test('two remote ids that sanitise alike still differ', () => {
      const a = remoteConfigDirName('box', 'a/b');
      const b = remoteConfigDirName('box', 'a.b');
      assert.notEqual(a, b);
    });

    test('the system id is part of the identity, not just the remote id', () => {
      assert.notEqual(remoteConfigDirName('box1', 'r'), remoteConfigDirName('box2', 'r'));
    });

    // Stability is what makes the directory findable again after a restart: it
    // depends on the persisted coordinate and nothing else.
    test('the name is stable for one (system, remoteId)', () => {
      assert.equal(remoteConfigDirName('box', 'r'), remoteConfigDirName('box', 'r'));
      assert.equal(remoteConfigDirName('box', null), remoteConfigDirName('box', null));
    });

    // A truncated slug must not swallow the digest — the long-id case is
    // exactly where a naive `slice(0, N)` on the whole name would.
    test('a 128-character remote id keeps its digest', () => {
      const long = remoteConfigDirName('box', 'y'.repeat(128));
      const other = remoteConfigDirName('box', 'y'.repeat(127) + 'z');
      assert.notEqual(long, other);
    });
  });
});

// ── T3: the farm is built, and refreshed idempotently ─────────────────
//
// The CLI adds top-level entries over time, so a once-only snapshot silently
// stops sharing them. `ensureRemoteConfigDir` runs before EVERY spawn, and each
// of these cases is a state it has to converge from without destroying anything
// it did not create.
describe('T3: ensureRemoteConfigDir builds and refreshes the symlink farm', () => {
  let home, source, place;

  // A full picture of the farm directory: name -> 'link:<target>' | 'file' | 'dir'.
  // Compared whole, so an unexpected addition or removal fails as loudly as a
  // changed target.
  async function snapshot(dir) {
    const out = {};
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      out[e.name] = e.isSymbolicLink() ? `link:${await fsp.readlink(path.join(dir, e.name))}`
        : e.isDirectory() ? 'dir' : 'file';
    }
    return out;
  }

  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    source = path.join(home, 'real-claude');
    await fsp.mkdir(path.join(source, 'plans'), { recursive: true });
    await fsp.mkdir(path.join(source, 'plugins'), { recursive: true });
    await fsp.writeFile(path.join(source, 'settings.json'), '{}');
    await fsp.writeFile(path.join(source, '.credentials.json'), '{}');
    await fsp.writeFile(path.join(source, '.claude.json'), '{}');
    await fsp.mkdir(path.join(source, 'projects'), { recursive: true });
    await fsp.mkdir(path.join(source, 'backups'), { recursive: true });
    await fsp.writeFile(path.join(source, 'backups', '.claude.json.backup.1789899569616'), '{}');
    process.env.CLAUDE_CONFIG_DIR = source;
    place = { system: 'box', remoteId: 'r1' };
  });
  afterEach(async () => { delete process.env.CLAUDE_CONFIG_DIR; await rmrf(home); });

  test('links the shared entries and creates a REAL private projects dir', async () => {
    const cfg = await ensureRemoteConfigDir(place);
    assert.equal(cfg, remoteConfigDir(place));
    const snap = await snapshot(cfg);
    assert.equal(snap['settings.json'], `link:${path.join(source, 'settings.json')}`);
    assert.equal(snap['plans'], `link:${path.join(source, 'plans')}`);
    assert.equal(snap['plugins'], `link:${path.join(source, 'plugins')}`);
    // The point of the exercise: transcripts are PRIVATE to this remote, so
    // `projects` must be a real directory and never a link to the shared one.
    assert.equal(snap['projects'], 'dir');
  });

  // Each carve-out for its own reason: `projects` is the isolation itself,
  // `.claude.json` is the cwd-keyed file whose divergent lock loses writes, and
  // `.credentials.json` is reached through CLAUDE_SECURESTORAGE_CONFIG_DIR
  // instead.
  test('never links projects, .claude.json or .credentials.json', async () => {
    const snap = await snapshot(await ensureRemoteConfigDir(place));
    assert.equal(snap['.claude.json'], undefined);
    assert.equal(snap['.credentials.json'], undefined);
    assert.notEqual(snap['projects'], `link:${path.join(source, 'projects')}`);
  });

  // `backups/` holds the global-config class one level down — every entry in it
  // is a `.claude.json` backup. Shared, the CLI's missing-config recovery reads
  // it and offers ANOTHER config for restore, which is the cwd-keyed `projects`
  // map leaking by a second route.
  test('never links the backups directory, and never creates one', async () => {
    // Anti-vacuity: the assertion below is only meaningful if the host dir has
    // something to link.
    assert.equal((await fsp.stat(path.join(source, 'backups'))).isDirectory(), true,
      'fixture: the host config dir must have a backups dir');

    const snap = await snapshot(await ensureRemoteConfigDir(place));
    assert.equal(snap['backups'], undefined, 'backups was linked into the farm');
  });

  test('a second call changes nothing', async () => {
    const cfg = await ensureRemoteConfigDir(place);
    const before = await snapshot(cfg);
    await ensureRemoteConfigDir(place);
    assert.deepEqual(await snapshot(cfg), before);
  });

  test('a new entry in the real config dir is linked on the next call', async () => {
    const cfg = await ensureRemoteConfigDir(place);
    assert.equal((await snapshot(cfg))['skills'], undefined);
    await fsp.mkdir(path.join(source, 'skills'), { recursive: true });
    await ensureRemoteConfigDir(place);
    assert.equal((await snapshot(cfg))['skills'], `link:${path.join(source, 'skills')}`);
  });

  // A DANGLING link is worse than absence: reads get ENOENT, and the CLI's
  // symlink-resolving writer would resolve to a path whose parent may not exist.
  test('an entry that disappears leaves no dangling link', async () => {
    const cfg = await ensureRemoteConfigDir(place);
    assert.equal((await snapshot(cfg))['plugins'], `link:${path.join(source, 'plugins')}`);
    await rmrf(path.join(source, 'plugins'));
    await ensureRemoteConfigDir(place);
    assert.equal((await snapshot(cfg))['plugins'], undefined);
  });

  // The CLI creates its own files and directories at names cc would otherwise
  // link (measured: policy-limits.json, remote-settings.json, sessions/). cc
  // did not create them and destroying them is not cc's call — so a real entry
  // wins over the link cc would otherwise make.
  test('a real entry cc did not create is left alone', async () => {
    const cfg = await ensureRemoteConfigDir(place);
    await fsp.rm(path.join(cfg, 'settings.json'));
    await fsp.writeFile(path.join(cfg, 'settings.json'), '{"local":true}');
    await ensureRemoteConfigDir(place);
    const snap = await snapshot(cfg);
    assert.equal(snap['settings.json'], 'file');
    assert.equal(await fsp.readFile(path.join(cfg, 'settings.json'), 'utf8'), '{"local":true}');
  });

  // PINS "cc NEVER DESTROYS WHAT IT DID NOT CREATE" ON THE CREATE PATH.
  //
  // The CLI creates real files inside a config dir it is handed, and it can do
  // so between cc's `lstat` and cc's write. A `rename`-based create would
  // silently clobber the arrival; `symlink` + EEXIST re-evaluates and lands it
  // on the leave-alone rule instead. Simulated by letting the entry exist in
  // the source but pre-creating the REAL file in the farm first, which is the
  // state that write would have had to survive.
  test('a real file occupying the name is never clobbered by the create path', async () => {
    const cfg = remoteConfigDir(place);
    await fsp.mkdir(cfg, { recursive: true });
    await fsp.writeFile(path.join(cfg, 'settings.json'), '{"written-by":"the CLI"}');

    await ensureRemoteConfigDir(place, { log: { warn() {} } });

    const snap = await snapshot(cfg);
    assert.equal(snap['settings.json'], 'file', 'cc replaced a real file with its own link');
    assert.equal(await fsp.readFile(path.join(cfg, 'settings.json'), 'utf8'), '{"written-by":"the CLI"}');
  });

  // Same invariant for a real DIRECTORY, which is what `sessions/` arrives as.
  test('a real directory occupying the name is never clobbered', async () => {
    const cfg = remoteConfigDir(place);
    await fsp.mkdir(path.join(cfg, 'plans', 'mine'), { recursive: true });
    await fsp.writeFile(path.join(cfg, 'plans', 'mine', 'p.md'), '# plan\n');

    await ensureRemoteConfigDir(place, { log: { warn() {} } });

    assert.equal((await snapshot(cfg))['plans'], 'dir');
    assert.equal(await fsp.readFile(path.join(cfg, 'plans', 'mine', 'p.md'), 'utf8'), '# plan\n');
  });

  // PINS THE CREATE BRANCH SPECIFICALLY, and it needs scaffolding to reach.
  //
  // The two tests above pre-create the occupier, so `lstat` sees it and they
  // exercise the REFRESH branch — the create branch runs only when the name is
  // absent at check time, which is precisely the window the CLI's own writes
  // land in. Nothing in an ordinary test can be inside that window, so the
  // occupier's arrival is simulated by making the FIRST `lstat` of that one
  // path report ENOENT while the real file is genuinely on disk.
  //
  // EVERYTHING AFTER THAT IS REAL: `symlink` gets a real EEXIST from the real
  // filesystem, the re-`lstat` reads the real occupier, and the leave-alone
  // rule does the rest. A create that replaced the name instead of
  // re-evaluating — a `rename`, say — destroys the occupier here and nowhere
  // else in the suite.
  //
  // THE FILE ARM IS THE ONE THAT CATCHES IT. A rename of a symlink ONTO a
  // directory fails with ENOTDIR/EISDIR, so the directory arm below would
  // survive such a create; it is here because `sessions/` arrives as a
  // directory and the rule has to hold for it, not because it discerns the two
  // creates.
  async function withFirstLstatMissing(target, body) {
    const nodeFs = await import('node:fs');
    const real = nodeFs.promises.lstat;
    let lied = false;
    nodeFs.promises.lstat = async (p, ...rest) => {
      if (!lied && String(p) === target) {
        lied = true;
        throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${p}'`), { code: 'ENOENT' });
      }
      return real.call(nodeFs.promises, p, ...rest);
    };
    try { await body(); } finally { nodeFs.promises.lstat = real; }
    assert.equal(lied, true, 'the create branch was never reached — the scaffolding did not fire');
  }

  test('a real FILE that arrives during the create window is not clobbered', async () => {
    const cfg = remoteConfigDir(place);
    const link = path.join(cfg, 'settings.json');
    await fsp.mkdir(cfg, { recursive: true });
    await fsp.writeFile(link, '{"written-by":"the CLI"}');

    await withFirstLstatMissing(link, () => ensureRemoteConfigDir(place, { log: { warn() {} } }));

    assert.equal((await fsp.lstat(link)).isSymbolicLink(), false,
      'cc replaced a real file with its own link on the create path');
    assert.equal(await fsp.readFile(link, 'utf8'), '{"written-by":"the CLI"}');
  });

  test('a real DIRECTORY that arrives during the create window is not clobbered', async () => {
    const cfg = remoteConfigDir(place);
    const link = path.join(cfg, 'plans');
    await fsp.mkdir(path.join(link, 'mine'), { recursive: true });
    await fsp.writeFile(path.join(link, 'mine', 'p.md'), '# plan\n');

    await withFirstLstatMissing(link, () => ensureRemoteConfigDir(place, { log: { warn() {} } }));

    assert.equal((await fsp.lstat(link)).isDirectory(), true);
    assert.equal(await fsp.readFile(path.join(link, 'mine', 'p.md'), 'utf8'), '# plan\n');
  });

  // NON-VACUITY for the pair above: with the name genuinely absent in that same
  // window, the create branch still does its job. Without this, a create that
  // simply gave up on EEXIST — or never created anything at all — would satisfy
  // both tests above.
  test('the create branch still links when the name really is absent', async () => {
    const cfg = remoteConfigDir(place);
    const link = path.join(cfg, 'settings.json');
    await fsp.mkdir(cfg, { recursive: true });

    await withFirstLstatMissing(link, () => ensureRemoteConfigDir(place, { log: { warn() {} } }));

    assert.equal(await fsp.readlink(link), path.join(source, 'settings.json'));
  });

  // The real config dir moved (the host set CLAUDE_CONFIG_DIR, or changed it).
  // A link still pointing at the old one would serve stale settings forever.
  test('a link to a different target is repointed', async () => {
    const cfg = await ensureRemoteConfigDir(place);
    await fsp.rm(path.join(cfg, 'settings.json'));
    await fsp.symlink('/somewhere/else/settings.json', path.join(cfg, 'settings.json'));
    await ensureRemoteConfigDir(place);
    assert.equal((await snapshot(cfg))['settings.json'], `link:${path.join(source, 'settings.json')}`);
  });

  // Never deletes what it did not make, even when the source entry is gone.
  test('a real entry survives its source disappearing', async () => {
    const cfg = await ensureRemoteConfigDir(place);
    await fsp.rm(path.join(cfg, 'settings.json'));
    await fsp.writeFile(path.join(cfg, 'settings.json'), '{"local":true}');
    await rmrf(path.join(source, 'settings.json'));
    await ensureRemoteConfigDir(place);
    assert.equal((await snapshot(cfg))['settings.json'], 'file');
  });

  // Transcripts already written into the private projects dir must survive a
  // refresh — the farm is rebuilt before every spawn, including resumes.
  test('a refresh preserves the private projects dir contents', async () => {
    const cfg = await ensureRemoteConfigDir(place);
    const seeded = path.join(cfg, 'projects', '-root-app3');
    await fsp.mkdir(seeded, { recursive: true });
    await fsp.writeFile(path.join(seeded, 'sid.jsonl'), '{}\n');
    await ensureRemoteConfigDir(place);
    assert.equal(await fsp.readFile(path.join(seeded, 'sid.jsonl'), 'utf8'), '{}\n');
  });

  // ── THE CONCURRENT CASE ──────────────────────────────────────────
  //
  // `ensureRemoteConfigDir` runs before every spawn and nothing serialises
  // launches across sessions on ONE remote — the create lock is per-session. Two
  // `spawn_instance` calls fanning out onto a fresh remote is an ordinary
  // conductor pattern, and with a bare check-then-act `symlink` the loser throws
  // EEXIST out of `launch()` and the spawn dies with a raw errno.
  //
  // Sequential idempotence does NOT cover this: the interleave is the whole
  // subject, so the farm must not exist when the calls start.
  test('concurrent builds of one remote all resolve, and the farm is correct', async () => {
    // Enough entries that the per-entry awaits really interleave.
    for (let i = 0; i < 12; i++) await fsp.writeFile(path.join(source, `extra-${i}.json`), '{}');
    const cfg = remoteConfigDir(place);
    assert.equal(await fsp.access(cfg).then(() => true, () => false), false, 'the farm must not pre-exist');

    const results = await Promise.all(Array.from({ length: 8 }, () => ensureRemoteConfigDir(place)));
    assert.deepEqual([...new Set(results)], [cfg], 'every call returned the same farm');

    const snap = await snapshot(cfg);
    assert.equal(snap['settings.json'], `link:${path.join(source, 'settings.json')}`);
    assert.equal(snap['projects'], 'dir');
    for (let i = 0; i < 12; i++) {
      assert.equal(snap[`extra-${i}.json`], `link:${path.join(source, `extra-${i}.json`)}`);
    }
    // No half-built temp link survived a racing rename.
    assert.deepEqual(Object.keys(snap).filter(n => n.includes('.cc-tmp-')), []);
  });

  // The repoint path races the same way: `unlink`+`symlink` leaves the loser an
  // ENOENT and a window with no link at all.
  test('concurrent REPOINTS of one remote all resolve', async () => {
    await ensureRemoteConfigDir(place);
    const moved = path.join(home, 'moved-claude');
    await fsp.mkdir(moved, { recursive: true });
    await fsp.writeFile(path.join(moved, 'settings.json'), '{"moved":true}');
    process.env.CLAUDE_CONFIG_DIR = moved;

    await Promise.all(Array.from({ length: 8 }, () => ensureRemoteConfigDir(place)));
    const snap = await snapshot(remoteConfigDir(place));
    assert.equal(snap['settings.json'], `link:${path.join(moved, 'settings.json')}`);
  });

  // And the prune: two refreshes both deciding to unlink the same vanished link.
  test('concurrent PRUNES of one remote all resolve', async () => {
    await ensureRemoteConfigDir(place);
    await rmrf(path.join(source, 'plugins'));
    await Promise.all(Array.from({ length: 8 }, () => ensureRemoteConfigDir(place)));
    assert.equal((await snapshot(remoteConfigDir(place)))['plugins'], undefined);
  });

  // ── THE GLOBAL-CONFIG CLASS ──────────────────────────────────────
  //
  // `.claude.json` is one spelling of a class the CLI's own bundle matches with
  // `^\.claude(-[a-z-]+)?\.json(\.backup)?$`, plus `.config.json` (the same file
  // under its legacy name) and the write dance's transient siblings. Every
  // member carries the cwd-keyed `projects` map, so linking ANY of them leaks
  // allowed tools and trust acceptance between remotes — and the farm would do
  // it silently at the next spawn.
  test('no member of the global-config class is ever linked', async () => {
    const members = [
      // The anchored names.
      '.claude.json', '.claude.json.backup', '.claude-dev.json', '.claude-staging.json',
      '.config.json',
      // THE WRITE DANCE'S SIBLINGS, which need the PREFIX rule rather than the
      // anchored one: `.lock` is a DIRECTORY that outlives the write it guards,
      // and sharing one across remotes makes them serialise against each other
      // while writing different files.
      '.claude.json.lock', '.claude.json.tmp.1234.abcdef',
      // The legacy spelling's siblings. On a host that has `.config.json` it is
      // the ACTIVE global config, because the CLI's resolver prefers it.
      '.config.json.lock', '.config.json.tmp.5678.beefcafe',
      // The oauth-suffixed variants' siblings.
      '.claude-dev.json.lock', '.claude-staging.json.tmp.99.aa',
      // Credentials are not linked, so neither are their temp files.
      '.credentials.json.tmp.4242.f00d',
    ];
    for (const m of members) await fsp.writeFile(path.join(source, m), '{}');

    const snap = await snapshot(await ensureRemoteConfigDir(place));
    for (const m of members) assert.equal(snap[m], undefined, `${m} was linked into the farm`);
  });

  // The lock is a DIRECTORY on disk, not a file — the shape the CLI actually
  // creates — so the exclusion must hold for a dirent too.
  test('a lock DIRECTORY of the global-config class is not linked', async () => {
    await fsp.mkdir(path.join(source, '.claude.json.lock'), { recursive: true });
    await fsp.mkdir(path.join(source, '.config.json.lock'), { recursive: true });
    const snap = await snapshot(await ensureRemoteConfigDir(place));
    assert.equal(snap['.claude.json.lock'], undefined);
    assert.equal(snap['.config.json.lock'], undefined);
  });

  // The control that keeps the pattern from being an always-true predicate: a
  // name that merely LOOKS adjacent is still shared.
  test('a neighbouring name that is NOT the global config is still linked', async () => {
    const shared = [
      'claude.json', 'settings.json.backup', 'claude-config.json', '.claudeignore',
      // Adjacent to the PREFIX rule specifically: a dot-leading name that
      // merely starts with the same letters, and one whose prefix stops short
      // of the `.json`. A rule matching either would stop sharing real config.
      '.claude.jsonl', '.claudex.json.lock', '.config.jsonc', '.credentials.jsonx',
      // Adjacent to the `backups` exact-name exclusion: a name that extends it
      // and a dot-leading near-miss. `backups` is an EXACT name, not a prefix.
      'backups.json', '.backups',
    ];
    for (const n of shared) await fsp.writeFile(path.join(source, n), '{}');

    const snap = await snapshot(await ensureRemoteConfigDir(place));
    for (const n of shared) {
      assert.equal(snap[n], `link:${path.join(source, n)}`, `${n} should be shared`);
    }
  });

  test('two remotes get two farms', async () => {
    const a = await ensureRemoteConfigDir({ system: 'box', remoteId: 'r1' });
    const b = await ensureRemoteConfigDir({ system: 'box', remoteId: 'r2' });
    assert.notEqual(a, b);
    assert.equal((await snapshot(a))['settings.json'], `link:${path.join(source, 'settings.json')}`);
    assert.equal((await snapshot(b))['settings.json'], `link:${path.join(source, 'settings.json')}`);
  });
});

// ── T2: the spawn env points the CLI at the remote's own config dir ───
//
// This is the half that makes the isolation real: the farm can be built
// perfectly and change nothing unless the worker's CLI is actually launched
// against it.
describe('T2: the spawn env', () => {
  let home, baseUrl, instances, close, remote, tree, savedName;

  beforeEach(async () => {
    // A HOST-SET VALUE, PLANTED FIRST. `spawnEnv = {...process.env}` copies the
    // host environment wholesale (card 2026-0384), so an already-empty env
    // would make the delete below vacuous — the assertion has to be able to
    // fail. A host CLAUDE_CODE_PROJECT_DIR_NAME is the worst case there is: it
    // would redirect every session INSIDE the per-remote directory and
    // re-collapse exactly what this card fixes.
    savedName = process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
    process.env.CLAUDE_CODE_PROJECT_DIR_NAME = 'host_planted_key';
    ({ home } = await freshProjectsRoot());
    ({ baseUrl, instances, close } = await bootServer());
    remote = await bindRemoteSystem();
    tree = await seedRepo(path.join(remote.root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: remote.id })).ok, true);
    await createProject('localproj');
  });
  afterEach(async () => {
    if (savedName === undefined) delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
    else process.env.CLAUDE_CODE_PROJECT_DIR_NAME = savedName;
    delete process.env.CLAUDE_CONFIG_DIR;
    await instances?.shutdown();
    await close?.();
    disposeSystemHandles();
    await rmrf(home);
  });

  async function spawnIn(project) {
    const r = await api(baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inst = instances.get(r.body.id);
    await waitFor(() => inst._spawnEnv && Object.keys(inst._spawnEnv).length > 0);
    return inst;
  }

  test('a remote instance is pointed at its own config dir', async () => {
    const inst = await spawnIn('app');
    assert.equal(inst._spawnEnv.CLAUDE_CONFIG_DIR, remoteConfigDir({ system: remote.id, remoteId: null }));
    // Built, not merely named: the CLI would create a bare one and share nothing.
    assert.equal((await fsp.stat(path.join(inst._spawnEnv.CLAUDE_CONFIG_DIR, 'projects'))).isDirectory(), true);
  });

  // THE UNCONDITIONAL DELETE. Local spawns are covered too, and that is the
  // point: a host-set name would otherwise redirect them as well.
  test('the host CLAUDE_CODE_PROJECT_DIR_NAME never reaches the CLI', async () => {
    assert.equal(process.env.CLAUDE_CODE_PROJECT_DIR_NAME, 'host_planted_key', 'the fixture plants it');
    assert.equal((await spawnIn('app'))._spawnEnv.CLAUDE_CODE_PROJECT_DIR_NAME, undefined);
    assert.equal((await spawnIn('localproj'))._spawnEnv.CLAUDE_CODE_PROJECT_DIR_NAME, undefined);
  });

  // The control: a local session's config resolution is untouched, so its
  // global config, trust records and onboarding state stay where they were.
  test('a LOCAL instance is given neither variable', async () => {
    const inst = await spawnIn('localproj');
    assert.equal(inst._spawnEnv.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(inst._spawnEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined);
  });

  // The harnesses resolve plugins from this variable (harness/pluginDir.mjs).
  // A host value is planted first so the assertion can fail on a spawn that
  // merely inherits process.env. Remote workers get the HOST value unmapped:
  // their CLI runs on this machine.
  test('every worker, local and remote, is given the absolute projects root as CC_PROJECTS_ROOT', async () => {
    const saved = process.env.CC_PROJECTS_ROOT;
    process.env.CC_PROJECTS_ROOT = '/host/planted';
    try {
      assert.ok(path.isAbsolute(process.env.PROJECTS_ROOT), 'the fixture root is absolute');
      assert.equal((await spawnIn('app'))._spawnEnv.CC_PROJECTS_ROOT, process.env.PROJECTS_ROOT);
      assert.equal((await spawnIn('localproj'))._spawnEnv.CC_PROJECTS_ROOT, process.env.PROJECTS_ROOT);
    } finally {
      if (saved === undefined) delete process.env.CC_PROJECTS_ROOT;
      else process.env.CC_PROJECTS_ROOT = saved;
    }
  });

  // The same directory spelled relative to cwd, so project resolution is
  // unchanged while the value cc exports must still come out absolute.
  test('CC_PROJECTS_ROOT is absolute even when PROJECTS_ROOT is relative', async () => {
    const abs = process.env.PROJECTS_ROOT;
    const rel = path.relative(process.cwd(), abs);
    assert.equal(path.isAbsolute(rel), false, 'the fixture root is re-expressed relative');
    process.env.PROJECTS_ROOT = rel;
    try {
      assert.equal((await spawnIn('localproj'))._spawnEnv.CC_PROJECTS_ROOT, abs);
    } finally {
      process.env.PROJECTS_ROOT = abs;
    }
  });

  // ── the CLAUDE_SECURESTORAGE_CONFIG_DIR ternary, BOTH branches ──
  //
  // Credentials are NOT linked into the farm; they are reached through this
  // second lever. The EMPTY-STRING form resolves to `join(homedir(), '.claude')`
  // — NOT to the config dir — and, because the suffix is keyed on the
  // variable's presence rather than its value, it also produces the unsuffixed
  // secure-storage service name an unpinned CLI uses. It is therefore correct
  // ONLY while the host's real config dir is the default.
  test('default host config dir: the empty-string form', async () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    const inst = await spawnIn('app');
    assert.equal(inst._spawnEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR, '');
  });

  test('non-default host config dir: the explicit path', async () => {
    const elsewhere = path.join(home, 'elsewhere-claude');
    await fsp.mkdir(elsewhere, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = elsewhere;
    const inst = await spawnIn('app');
    // The explicit path, because '' would send the CLI to ~/.claude for
    // credentials the host does not keep there.
    assert.equal(inst._spawnEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR, elsewhere);
    // And the config dir is still the remote's own, not the host's.
    assert.notEqual(inst._spawnEnv.CLAUDE_CONFIG_DIR, elsewhere);
  });
});

// ── T1: THE test that goes red if a future editor reverts this ────────
//
// Two remote projects at ONE absolute path on TWO systems. Before the
// per-remote config directory this configuration could not even be
// registered — the guard 409'd TRANSCRIPT_DIR_COLLISION — and if it had been,
// both projects' sessions would have interleaved in one directory with
// nothing able to tell them apart.
//
// A revert fails this twice over: the second adopt refuses, and the two seeds
// land in one directory.
describe('T1: two remotes at one absolute path', () => {
  let home, baseUrl, instances, close, boxA, boxB, shared;

  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    ({ baseUrl, instances, close } = await bootServer());
    boxA = await bindRemoteSystem({ id: 'boxa' });
    boxB = await bindRemoteSystem({ id: 'boxb' });
    // The reference provider IS this machine, so ONE path string is reachable
    // on both — which is what makes the two cwds identical, the premise of the
    // whole card.
    shared = await seedRepo(path.join(home, 'shared-app'));
  });
  afterEach(async () => {
    await instances?.shutdown();
    await close?.();
    disposeSystemHandles();
    await rmrf(home);
  });

  test('both register, and each lists exactly its own sessions', async () => {
    assert.equal((await adoptProject('ona', shared, { system: boxA.id })).ok, true);
    const second = await adoptProject('onb', shared, { system: boxB.id });
    assert.equal(second.ok, true, `the second adopt was refused: ${JSON.stringify(second)}`);

    const placeA = await projectRootPlace('ona', shared);
    const placeB = await projectRootPlace('onb', shared);
    assert.equal(placeA.cwd, placeB.cwd, 'the premise: one absolute path, two machines');
    assert.notEqual(transcriptRoot(placeA), transcriptRoot(placeB));

    const sidA = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const sidB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
    await seedSessionJsonl(placeA, sidA);
    await seedSessionJsonl(placeB, sidB);

    // Each project lists exactly its own — not both, and not the other's.
    assert.deepEqual((await listSessionsForCwd(placeA)).map(r => r.sessionId), [sidA]);
    assert.deepEqual((await listSessionsForCwd(placeB)).map(r => r.sessionId), [sidB]);

    // And the reverse lookup attributes each session to the right project.
    assert.equal((await findSessionLocation(sidA))?.project, 'ona');
    assert.equal((await findSessionLocation(sidB))?.project, 'onb');
  });

  // PINS THE EXCLUSION-SET KEYING. `liveBackingIdsForPlace` /
  // `tempSessionIdsForPlace` feed the on-disk session walk its exclusion set,
  // and they used to match on a bare `i.cwd === cwd`. That no longer keys a
  // directory: a live worker on remote B at the shared path would be excluded
  // from remote A's listing — dropping a real row — while the walk itself read
  // a different directory entirely.
  //
  // ONE live worker is enough, and is the sharper probe: the same cwd queried
  // under the OTHER system's coordinate must not find it, while its own must.
  test('the live-exclusion helpers key on the place, not the cwd', async () => {
    assert.equal((await adoptProject('ona', shared, { system: boxA.id })).ok, true);
    assert.equal((await adoptProject('onb', shared, { system: boxB.id })).ok, true);

    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'ona', mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inst = instances.get(r.body.id);
    // LIVE, or the helper excludes it for being dead and both assertions pass
    // for the wrong reason.
    await waitFor(() => inst.status === 'idle' && inst.backingSessionId);

    const own = instances.liveBackingIdsForPlace(inst.transcriptPlace);
    assert.equal(own.has(inst.backingSessionId), true, "the worker is missing from its OWN place's set");

    // Same cwd, other machine — the exact query a bare-cwd match got wrong.
    const other = { system: boxB.id, remoteId: null, cwd: inst.cwd };
    assert.equal(inst.transcriptPlace.cwd, other.cwd, 'the premise: one cwd, two machines');
    assert.equal(instances.liveBackingIdsForPlace(other).has(inst.backingSessionId), false,
      "remote A's live worker leaked into remote B's exclusion set");

    // And the remoteId half: two targets of one system are two places too.
    const otherTarget = { system: boxA.id, remoteId: 'somewhere-else', cwd: inst.cwd };
    assert.equal(instances.liveBackingIdsForPlace(otherTarget).has(inst.backingSessionId), false);
  });

  // The same claim through the REST surface, so a reader cannot dismiss the
  // above as an internal-API artefact.
  test('the per-project sessions endpoint does not leak the other remote\'s session', async () => {
    assert.equal((await adoptProject('ona', shared, { system: boxA.id })).ok, true);
    assert.equal((await adoptProject('onb', shared, { system: boxB.id })).ok, true);
    await seedSessionJsonl(await projectRootPlace('ona', shared), 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');

    const a = await api(baseUrl, 'GET', '/api/projects/ona/sessions');
    const b = await api(baseUrl, 'GET', '/api/projects/onb/sessions');
    assert.equal(a.status, 200);
    assert.equal(a.body.length, 1);
    assert.deepEqual(b.body, [], "onb listed boxa's session as its own");
  });
});

// ── T5: CONTROL — a local place is byte-identical to before ───────────
//
// The scope of this card is remote-backed places only. If this drifts, every
// local project's history silently moves and nothing else in the suite would
// say so as plainly.
describe('T5: CONTROL — local places are untouched', () => {
  let home;
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { delete process.env.CLAUDE_CONFIG_DIR; await rmrf(home); });

  test('transcriptRoot for a local place IS claudeProjectsRoot()', () => {
    assert.equal(transcriptRoot(localPlace('/srv/app')), claudeProjectsRoot());
  });

  // The whole expression, not just the root: `<claudeProjectsRoot>/<encodeCwd(cwd)>`
  // is literally what cc computed before this card.
  test('the transcript path for a local place is the pre-card expression', () => {
    const cwd = '/srv/my_app.v2';
    const sid = '11111111-2222-4333-8444-555555555555';
    assert.equal(
      sessionFilePath(localPlace(cwd), sid),
      path.join(claudeProjectsRoot(), encodeCwd(cwd), `${sid}.jsonl`));
    assert.equal(
      subAgentDirPath(localPlace(cwd), sid),
      path.join(claudeProjectsRoot(), encodeCwd(cwd), sid));
  });

  // And it stays that way when the host moved its config dir — the local root
  // follows CLAUDE_CONFIG_DIR, it does not become a farm directory.
  test('a non-default host config dir moves the local root, not into the farm', () => {
    process.env.CLAUDE_CONFIG_DIR = '/opt/cfg';
    delete process.env.CLAUDE_PROJECTS_ROOT;
    assert.equal(transcriptRoot(localPlace('/srv/app')), path.join('/opt/cfg', 'projects'));
    assert.equal(transcriptRoot(localPlace('/srv/app')).startsWith(claudeConfigFarmRoot()), false);
  });
});

// ── F2: the orphan scan reaches a REMOTE's transcript root ────────────
//
// `findOrphanedTranscript` is the reverse scanner behind the SESSION_NOT_LIVE /
// SESSION_UNKNOWN distinction — "this session is retired and unreachable" versus
// "no such session". There is no single transcript root any more, so it must
// sweep every registered remote's as well as the local one.
//
// LEFT LOCAL-ONLY IT DEGRADES SILENTLY: every remote session that ends up under
// an unowned directory answers the bare SESSION_UNKNOWN, which tells a conductor
// the session never existed when its bytes are on disk. Both pre-existing orphan
// tests seed at a LOCAL place, so nothing else in the suite can see this.
// The MCP transport, local to this file — the refusal CODE is the subject, so
// the assertions have to read it off a real tools/call rather than a handler
// return.
let nextRpcId = 1;
async function callTool(baseUrl, name, args) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}
const unwrap = (result) => JSON.parse(result.content[0].text);

describe('F2: the orphan scan sweeps remote transcript roots', () => {
  let home, baseUrl, instances, close, remote, tree;

  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    ({ baseUrl, instances, close } = await bootServer());
    remote = await bindRemoteSystem();
    tree = await seedRepo(path.join(remote.root, 'orph'));
  });
  afterEach(async () => {
    await instances?.shutdown();
    await close?.();
    disposeSystemHandles();
    await rmrf(home);
  });

  // THE ORPHAN STATE, at a REMOTE's root: one project keeps the remote
  // registered — which is what puts its root in the sweep at all — while the
  // transcript sits under a cwd on that same remote that no project or
  // worktree is registered at. Directly analogous to the local orphan test's
  // `never-registered` cwd, one root over.
  //
  // A BOUNDARY WORTH NAMING, since it is the shape one might reach for first:
  // unregistering the LAST project on a remote takes that remote's root out of
  // the sweep entirely, because `transcriptRoots()` enumerates registered
  // projects. Such a transcript is unreachable rather than orphan-reported, and
  // that is not what this test is about.
  async function seedUnownedOnRemote(sid) {
    assert.equal((await adoptProject('orph', tree, { system: remote.id })).ok, true);
    const owned = await projectRootPlace('orph', tree);
    const unowned = { ...owned, cwd: path.join(remote.root, 'never-registered') };
    await seedSessionJsonl(unowned, sid);
    const seeded = path.join(transcriptRoot(unowned), encodeCwd(unowned.cwd), `${sid}.jsonl`);
    // The premise, asserted rather than assumed: the bytes are under the
    // REMOTE's root and not under the local one.
    await fsp.access(seeded);
    assert.notEqual(transcriptRoot(unowned), claudeProjectsRoot());
    return seeded;
  }

  test('findOrphanedTranscript finds a transcript under an unregistered remote root', async () => {
    const sid = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
    const seeded = await seedUnownedOnRemote(sid);

    // Nothing owns it any more...
    assert.equal(await findSessionLocation(sid), null);
    // ...but the scan still reaches the root it is under.
    assert.equal(await findOrphanedTranscript(sid), seeded);
  });

  // The consequence a conductor actually reads: the informative refusal, not
  // the bare one. A local-only sweep answers SESSION_UNKNOWN here.
  test('the read tools refuse it SESSION_NOT_LIVE, not SESSION_UNKNOWN', async () => {
    const sid = 'eeeeeeee-2222-4222-8222-eeeeeeeeeeee';
    await seedUnownedOnRemote(sid);

    const orphan = unwrap(await callTool(baseUrl, 'get_recent_messages', { sessionId: sid }));
    assert.equal(orphan.ok, false);
    assert.equal(orphan.code, 'SESSION_NOT_LIVE',
      'a remote session under an unowned directory read as never-existed');
    assert.match(orphan.reason, /no registered project or worktree owns/);

    // The control that keeps the above from passing on an always-NOT_LIVE
    // answer: an id nothing on disk answers to is still SESSION_UNKNOWN.
    const bogus = unwrap(await callTool(baseUrl, 'get_recent_messages',
      { sessionId: '00000000-dead-dead-dead-000000000000' }));
    assert.equal(bogus.code, 'SESSION_UNKNOWN');
  });
});
