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
import path from 'node:path';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  claudeConfigFarmRoot, remoteConfigDir, remoteConfigDirName,
} from '../src/projects.ts';

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
