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
import { api, bootServer, freshProjectsRoot, rmrf, waitFor } from './helpers.mjs';
import { bindRemoteSystem, seedRepo } from './remoteSystem.mjs';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import {
  adoptProject, claudeConfigFarmRoot, createProject, remoteConfigDir, remoteConfigDirName,
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

  // The three carve-outs, each for its own reason: `projects` is the isolation
  // itself, `.claude.json` is the cwd-keyed file whose divergent lock loses
  // writes, and `.credentials.json` is reached through
  // CLAUDE_SECURESTORAGE_CONFIG_DIR instead.
  test('never links projects, .claude.json or .credentials.json', async () => {
    const snap = await snapshot(await ensureRemoteConfigDir(place));
    assert.equal(snap['.claude.json'], undefined);
    assert.equal(snap['.credentials.json'], undefined);
    assert.notEqual(snap['projects'], `link:${path.join(source, 'projects')}`);
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

  // The CLI creates its own entries inside the config dir it is handed
  // (measured: .claude.json, policy-limits.json, remote-settings.json,
  // backups/, sessions/). cc did not create them and destroying them is not
  // cc's call — so a real entry wins over the link cc would otherwise make.
  test('a real entry cc did not create is left alone', async () => {
    const cfg = await ensureRemoteConfigDir(place);
    await fsp.rm(path.join(cfg, 'settings.json'));
    await fsp.writeFile(path.join(cfg, 'settings.json'), '{"local":true}');
    await ensureRemoteConfigDir(place);
    const snap = await snapshot(cfg);
    assert.equal(snap['settings.json'], 'file');
    assert.equal(await fsp.readFile(path.join(cfg, 'settings.json'), 'utf8'), '{"local":true}');
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
