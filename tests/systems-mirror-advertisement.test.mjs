// THE MIRROR ADVERTISEMENT: what a provider may say about how much of its
// filesystem cc mirrors, what cc refuses to believe, and what it never asks.
//
// A provider answers `describeRemote` with `{mirrorRoot, exclude}` — the far
// end of the prefix rule, resolved PER TARGET because one endpoint serves many.
// cc's side of that is three things and this file pins all three: the shape it
// validates, the project-relative refusals it raises at spawn, and the single
// round trip per connection generation it costs.
//
// The advertisement is the provider's claim, not cc's derivation, so every
// assertion here is about how cc HANDLES a claim. Nothing here asserts that a
// real provider would make one.
//
// D-P7-10 form: not applicable — no assertion in this file is of the
// "identical to today" kind. Every expectation is a literal written by hand.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { bindRemoteSystem, referenceLaunch } from './remoteSystem.mjs';
import { addSystem, updateSystem } from '../src/appSettings.ts';
import { disposeSystemHandles, systemById } from '../src/systems/registry.ts';
import { MIRROR_EXCLUDE_MAX, MIRROR_PATH_MAX } from '../src/systems/protocol.ts';
import {
  noMirror, resolveMirrorScope, validateAdvertisement, isExcluded, withinPosix, mirrorOffsets,
} from '../src/systems/mirror.ts';
import { encodeCwd } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECORDER = path.join(__dirname, 'fixtures', 'recordingProvider.mjs');

async function wire(file) {
  let raw = '';
  try { raw = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

describe('the mirror advertisement', () => {
  let home;
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { disposeSystemHandles(); await rmrf(home); });

  // ── card 2026-0259 §2.4, shape ──────────────────────────────────────

  // PINS: every malformed advertisement in card 2026-0259 §2.4's table is refused
  // MIRROR_ADVERTISEMENT_INVALID with the offending value quoted, and every
  // valid one resolves. cc never normalises on the provider's behalf: a
  // normalised-away `..` is exactly how a hostile root would be smuggled past a
  // containment test.
  //
  // NOT CLAIMING: that a provider would ever send these. It asserts cc's
  // handling of a claim, not provider behaviour.
  test('a malformed advertisement is refused by name, quoting the value', () => {
    const bad = [
      [{ mirrorRoot: 5 }, '5'],
      [{ mirrorRoot: '' }, '""'],
      [{ mirrorRoot: '   ' }, '"   "'],
      [{ mirrorRoot: 'app' }, '"app"'],
      [{ mirrorRoot: './app' }, '"./app"'],
      [{ mirrorRoot: '../x' }, '"../x"'],
      [{ mirrorRoot: '/app/..' }, '"/app/.."'],
      [{ mirrorRoot: '/app/./x' }, '"/app/./x"'],
      [{ mirrorRoot: '//app' }, '"//app"'],
      [{ mirrorRoot: '/app/' }, '"/app/"'],
      [{ mirrorRoot: '/app', exclude: 'proc' }, '"proc"'],
      [{ mirrorRoot: '/app', exclude: [7] }, '7'],
      [{ mirrorRoot: '/app', exclude: [''] }, '""'],
      [{ mirrorRoot: '/app', exclude: ['proc'] }, '"proc"'],
      [{ mirrorRoot: '/app', exclude: ['/proc/'] }, '"/proc/"'],
      [{ mirrorRoot: '/app', exclude: ['/a/../b'] }, '"/a/../b"'],
    ];
    for (const [raw, quoted] of bad) {
      let err = null;
      try { validateAdvertisement('prod-box', raw); } catch (e) { err = e; }
      assert.ok(err, `${JSON.stringify(raw)} should have been refused`);
      assert.equal(err.code, 'MIRROR_ADVERTISEMENT_INVALID', JSON.stringify(raw));
      assert.equal(err.statusCode, 502, 'the far side ANSWERED, and answered badly');
      assert.ok(err.message.includes(quoted),
        `${JSON.stringify(raw)}: message must quote ${quoted}, got ${err.message}`);
      assert.ok(err.message.includes('prod-box'), 'and name the system');
    }
    // An index, so a reader knows WHICH entry.
    let idxErr = null;
    try { validateAdvertisement('b', { mirrorRoot: '/', exclude: ['/proc', 'dev'] }); }
    catch (e) { idxErr = e; }
    assert.match(idxErr.message, /\b1\b/, 'the offending exclude entry names its index');
  });

  // PINS: the valid shapes, including the three spellings of "I advertise
  // nothing" — absent, null, and a bare `{}`.
  //
  // NOT CLAIMING: anything about what the resolved scope then is; that is
  // resolveMirrorScope's job, below.
  test('a well-formed advertisement is accepted, and an empty one means nothing', () => {
    assert.deepEqual(validateAdvertisement('b', {}), { mirrorRoot: null, exclude: [] });
    assert.deepEqual(validateAdvertisement('b', { mirrorRoot: null }), { mirrorRoot: null, exclude: [] });
    assert.deepEqual(validateAdvertisement('b', { mirrorRoot: '/' }), { mirrorRoot: '/', exclude: [] });
    assert.deepEqual(validateAdvertisement('b', { mirrorRoot: '/srv/x' }), { mirrorRoot: '/srv/x', exclude: [] });
    assert.deepEqual(
      validateAdvertisement('b', { mirrorRoot: '/', exclude: ['/proc', '/dev', '/sys'] }),
      { mirrorRoot: '/', exclude: ['/proc', '/dev', '/sys'] },
    );
    // `/` is its own normal form even though it ends in a separator.
    assert.deepEqual(validateAdvertisement('b', { mirrorRoot: '/', exclude: ['/'] }),
      { mirrorRoot: '/', exclude: ['/'] });
  });

  // PINS: a path carrying an embedded NUL is refused. Traced INERT today —
  // nothing downstream splits on it — but a provider that meant `/proc` and
  // sent `/proc\0` would silently exclude nothing while looking correct, and
  // the byte rides into refusal prose read by a model. Refusing is the only
  // reading that cannot be silently wrong.
  //
  // NOT CLAIMING: that any current provider can produce one. It is a wire
  // field, and cc validates what arrives rather than what it expects.
  test('a path with an embedded NUL is refused, in the root and in an exclude', () => {
    for (const bad of [{ mirrorRoot: '/app\u0000x' }, { mirrorRoot: '/app', exclude: ['/proc\u0000'] }]) {
      assert.throws(
        () => validateAdvertisement('box', bad),
        (e) => e.code === 'MIRROR_ADVERTISEMENT_INVALID',
        JSON.stringify(bad),
      );
    }
  });

  // PINS: a path longer than the cap is refused rather than carried into the
  // manifest, the path map and every refusal string built from it. Exercised
  // from both sides so it is a real edge, not an inequality that happens to
  // hold.
  //
  // NOT CLAIMING: that the cap matches any filesystem's PATH_MAX. It is a fence
  // on what cc will hold and repeat, and it sits far above any real path.
  test('an absurdly long path is refused; one at the cap is not', () => {
    const at = `/${'a'.repeat(MIRROR_PATH_MAX - 1)}`;
    assert.equal(at.length, MIRROR_PATH_MAX);
    assert.equal(validateAdvertisement('box', { mirrorRoot: at }).mirrorRoot, at);
    assert.throws(() => validateAdvertisement('box', { mirrorRoot: `${at}a` }),
      (e) => e.code === 'MIRROR_ADVERTISEMENT_INVALID');
    assert.throws(() => validateAdvertisement('box', { mirrorRoot: '/app', exclude: [`${at}a`] }),
      (e) => e.code === 'MIRROR_ADVERTISEMENT_INVALID');
  });

  // PINS: the exclude list is fenced at MIRROR_EXCLUDE_MAX, and the fence is
  // exclusive of the limit itself — exactly MAX entries is accepted, MAX+1 is
  // refused.
  //
  // NOT CLAIMING: that 64 is the right number. It is a fence with headroom, not
  // a performance budget.
  test('an exclude list past the cap is refused, and exactly at the cap is not', () => {
    const at = Array.from({ length: MIRROR_EXCLUDE_MAX }, (_, i) => `/x${i}`);
    assert.equal(validateAdvertisement('b', { mirrorRoot: '/', exclude: at }).exclude.length, MIRROR_EXCLUDE_MAX);
    assert.throws(
      () => validateAdvertisement('b', { mirrorRoot: '/', exclude: [...at, '/one-too-many'] }),
      (e) => e.code === 'MIRROR_ADVERTISEMENT_INVALID' && e.message.includes(String(MIRROR_EXCLUDE_MAX)),
    );
  });

  // ── card 2026-0259 §3, geometry, and §2.4's two refusals ────────────

  // PINS: the offset table in card 2026-0259 §3, including the prefix-SHARING sibling
  // (`/app` vs `/app-backup`) that a string prefix would wrongly claim.
  // Containment is decided with path.posix.relative, never startsWith.
  //
  // NOT CLAIMING: which HTTP status a route ends up surfacing. It asserts the
  // code, and that nothing is narrowed to fit.
  test('the mirror root fixes the offset, and a root that excludes the project refuses', () => {
    const scope = (mirrorRoot, systemPath, exclude = []) => resolveMirrorScope({
      systemId: 'prod-box', project: 'api', systemPath, advertisement: { mirrorRoot, exclude },
    });

    assert.deepEqual(scope('/app', '/app').scope, { mirrorRoot: '/app', exclude: [], offset: '' });
    assert.deepEqual(scope('/', '/app').scope, { mirrorRoot: '/', exclude: [], offset: 'app' });
    assert.deepEqual(scope('/srv', '/srv/thing').scope, { mirrorRoot: '/srv', exclude: [], offset: 'thing' });
    assert.deepEqual(scope('/', '/').scope, { mirrorRoot: '/', exclude: [], offset: '' });

    for (const [root, project] of [['/srv/other', '/srv/thing'], ['/app', '/app-backup'], ['/app2', '/app']]) {
      let err = null;
      try { scope(root, project); } catch (e) { err = e; }
      assert.ok(err, `${root} vs ${project} should refuse`);
      assert.equal(err.code, 'MIRROR_ROOT_EXCLUDES_PROJECT');
      assert.equal(err.statusCode, 501);
      assert.ok(err.systemRefusal, 'it joins the system-refusal family');
      assert.ok(err.message.includes(root) && err.message.includes(project) && err.message.includes('api'),
        err.message);
      assert.ok(/will not narrow/.test(err.message), 'and says cc will not narrow the mirror to fit');
    }
  });

  // PINS: an exclude that COVERS OR EQUALS the project path is a named refusal
  // — no file in the project could be read or written — while one strictly
  // INSIDE the project is legal and stays active, and one OUTSIDE the mirror
  // root is inert and reported. Three outcomes, one predicate.
  //
  // NOT CLAIMING: that the inert entry is logged in any particular channel; the
  // diagnostic is not the invariant, the absence of a refusal is.
  test('an exclude covering the project refuses; inside it is active; outside the root is inert', () => {
    const scope = (exclude) => resolveMirrorScope({
      systemId: 'prod-box', project: 'api', systemPath: '/srv/thing',
      advertisement: { mirrorRoot: '/srv', exclude },
    });

    for (const cover of ['/srv/thing', '/srv', '/']) {
      let err = null;
      try { scope([cover]); } catch (e) { err = e; }
      assert.ok(err, `${cover} should refuse`);
      assert.equal(err.code, 'MIRROR_EXCLUDE_COVERS_PROJECT');
      assert.equal(err.statusCode, 501);
      assert.ok(err.systemRefusal);
      assert.ok(err.message.includes(cover) && err.message.includes('/srv/thing'), err.message);
    }
    // Strictly inside the project: legal, active, not inert. This is what the
    // allow-list walk's target filter then reads.
    const inside = scope(['/srv/thing/.claude/skills']);
    assert.deepEqual(inside.scope.exclude, ['/srv/thing/.claude/skills']);
    assert.deepEqual(inside.inert, []);
    // Outside the mirror root entirely: inert.
    const r = scope(['/proc']);
    assert.deepEqual(r.scope, { mirrorRoot: '/srv', exclude: ['/proc'], offset: 'thing' });
    assert.equal(r.inert.length, 1, 'and it is reported as inert');
    assert.ok(r.inert[0].includes('/proc'), r.inert[0]);
    // A sibling INSIDE the mirror root but outside the project is neither.
    const sib = scope(['/srv/other']);
    assert.deepEqual(sib.inert, []);
    assert.deepEqual(sib.scope.exclude, ['/srv/other']);
  });

  // PINS: an absent advertisement resolves to the project's own path with an
  // empty exclude list and a zero offset — the D10 geometry, produced by ONE
  // named helper so the fallback cannot be spelled two ways.
  //
  // NOT CLAIMING: that the composed session root is then identical to today's;
  // tests/systems-mirror-fallback.test.mjs owns that.
  test('no advertisement resolves to the project path, offset zero', () => {
    assert.deepEqual(noMirror('/srv/thing'), { mirrorRoot: '/srv/thing', exclude: [], offset: '' });
    const r = resolveMirrorScope({
      systemId: 'b', project: 'api', systemPath: '/srv/thing',
      advertisement: { mirrorRoot: null, exclude: [] },
    });
    assert.deepEqual(r.scope, noMirror('/srv/thing'));
    assert.deepEqual(r.inert, []);
  });

  // ── card 2026-0287: the offsets one project can occupy ──────────────

  // The NORMAL-FORM systemPaths the two tests below run over: depth 1, depth 8,
  // one whose segments carry `_`, `-`, `.` and a space, and the filesystem root.
  const GEOMETRIES = [
    '/',
    '/srv',
    '/a/b/c/d/e/f/g/proj',
    '/srv/my_app-v1.2/deep dir/proj',
  ];

  // And the non-normal ones. `validatePlacementInput` (src/projects.ts) requires
  // only that a systemPath be ABSOLUTE, so these are legal project paths on a
  // system, and `mirrorOffsets` enumerates the raw segment-suffixes of whatever
  // it is given.
  const NON_NORMAL = ['/a/./b/proj', '/a/../b/proj'];

  // Every ancestor of `p`, deepest first — the mirror roots a provider could
  // legally advertise for a project at `p`.
  const ancestors = (p) => {
    const out = [];
    for (let d = p; ; d = path.posix.dirname(d)) { out.push(d); if (d === '/') break; }
    return out;
  };

  const IMAGE_ROOT = '/store/systems/sys/sessions/api';

  // Every cwd a provider could put a session at, taken through the PRODUCTION
  // resolver rather than re-derived, so the two cannot agree by sharing a
  // mistake.
  const reachableCwds = (systemPath) => {
    const offs = new Set(ancestors(systemPath)
      .map(mirrorRoot => {
        try {
          return resolveMirrorScope({
            systemId: 'prod-box', project: 'api', systemPath,
            advertisement: { mirrorRoot, exclude: [] },
          }).scope.offset;
        } catch { return null; } // MIRROR_ROOT_EXCLUDES_PROJECT: not a legal root here
      })
      .filter(o => o !== null));
    // A provider that advertises nothing: `noMirror`, offset ''.
    offs.add(resolveMirrorScope({
      systemId: 'prod-box', project: 'api', systemPath,
      advertisement: { mirrorRoot: null, exclude: [] },
    }).scope.offset);
    return new Set([...offs].map(o => path.join(IMAGE_ROOT, o)));
  };

  // PINS COMPLETENESS, which is the one property the create path's candidate
  // scan rests on: every cwd `resolveMirrorScope` can produce for a systemPath
  // is `path.join(imageRoot, o)` for some `o` in `mirrorOffsets(systemPath)` —
  // so no legal advertisement can put a session at a cwd the scan does not
  // probe. Asserted on the JOINED cwds, not the raw offset strings, because
  // that is the form the scan actually uses.
  //
  // PINS THE LIMIT TOO: over a NORMAL-FORM systemPath the two sets are equal,
  // and over a non-normal one the candidate set is a strict SUPERSET —
  // `/a/../b/proj` yields a candidate outside the image root. Complete is the
  // contract; exact is not.
  //
  // NOT CLAIMING that a provider would advertise any of these roots, nor
  // anything about a root OUTSIDE the ancestor chain: that is refused
  // MIRROR_ROOT_EXCLUDES_PROJECT by the test above, which is what makes the
  // chain exhaustive.
  test('every cwd resolveMirrorScope can produce is one the offsets cover', () => {
    for (const systemPath of [...GEOMETRIES, ...NON_NORMAL]) {
      const reachable = reachableCwds(systemPath);
      const candidates = new Set(mirrorOffsets(systemPath).map(o => path.join(IMAGE_ROOT, o)));
      for (const cwd of reachable) {
        assert.equal(candidates.has(cwd), true,
          `${systemPath}: a reachable cwd ${cwd} is not in the candidate set`);
      }
    }
    // Normal form ⇒ exact.
    for (const systemPath of GEOMETRIES) {
      assert.deepEqual(
        [...new Set(mirrorOffsets(systemPath).map(o => path.join(IMAGE_ROOT, o)))].sort(),
        [...reachableCwds(systemPath)].sort(),
        `the candidate set is not the reachable set for ${systemPath}`,
      );
    }
    // Non-normal ⇒ a strict superset, and one member is outside the image root.
    const extra = [...new Set(mirrorOffsets('/a/../b/proj').map(o => path.join(IMAGE_ROOT, o)))]
      .filter(c => !reachableCwds('/a/../b/proj').has(c));
    assert.deepEqual(extra, [path.join(path.dirname(IMAGE_ROOT), 'b', 'proj')],
      'the non-normal candidate set no longer carries the out-of-root extra this test documents');
  });

  // PINS WHAT THE `break` DOES NOT REST ON, which is the point of this arm. The
  // create path's scan stops at its first hit, and the licence for that is NOT
  // that the candidates are pairwise distinct — it is that one session ran at
  // one cwd, so every candidate a probe for its id answers YES for resolves to
  // that one encoded directory. This test therefore pins the distinctness only
  // where it actually holds, and pins the non-normal case COLLAPSING rather
  // than diverging: two offsets that differ as strings join to the SAME
  // directory, which is one place probed twice and not a second answer.
  //
  // The count assertion is what stops the distinctness checks holding vacuously
  // on a set of one.
  //
  // NOT CLAIMING that no two candidates ever coincide — `/a/./b/proj` is the
  // arm where two do. NOT CLAIMING that two DIFFERENT image roots cannot
  // collide: that is a property of `sessionRootPath`'s key, not of this set,
  // and the scan is confined to one image root. That half is answered
  // elsewhere — `sessionRootKeyCollision` refuses a colliding key at creation
  // (card 2026-0293 §10) — so it is a closed non-claim, not an open one.
  test('the offsets of a normal-form systemPath never name one transcript directory', () => {
    for (const systemPath of GEOMETRIES) {
      const offs = mirrorOffsets(systemPath);
      assert.equal(offs.length, systemPath.split('/').filter(Boolean).length + 1,
        `one offset per ancestor, '' included, for ${systemPath}`);
      const dirs = offs.map(off => encodeCwd(path.join(IMAGE_ROOT, off)));
      assert.equal(new Set(dirs).size, offs.length, `two candidates encode alike for ${systemPath}`);
      assert.equal(new Set(dirs.map(d => d.length)).size, offs.length,
        `two candidates have one length for ${systemPath}`);
    }
    // A non-normal systemPath: two offsets, ONE directory. `path.join`
    // normalises, so the duplicate is the same place rather than a rival hit.
    const offs = mirrorOffsets('/a/./b/proj');
    assert.equal(offs.includes('b/proj') && offs.includes('./b/proj'), true,
      `both spellings should be enumerated, got ${JSON.stringify(offs)}`);
    assert.equal(
      encodeCwd(path.join(IMAGE_ROOT, 'b/proj')),
      encodeCwd(path.join(IMAGE_ROOT, './b/proj')),
      'the two spellings do not collapse onto one transcript directory',
    );
  });

  // PINS: exclusion is containment, not a string prefix — `/proc` must not
  // claim `/procfs/x` — and the matching PREFIX is what comes back, so a
  // refusal can name the rule rather than only the path.
  //
  // NOT CLAIMING: anything about which tool consults it.
  test('an exclude matches by containment and reports the prefix that matched', () => {
    const ex = ['/proc', '/dev'];
    assert.equal(isExcluded('/proc', ex), '/proc');
    assert.equal(isExcluded('/proc/1/status', ex), '/proc');
    assert.equal(isExcluded('/dev/null', ex), '/dev');
    assert.equal(isExcluded('/procfs/x', ex), null, 'a prefix-SHARING sibling is not inside');
    assert.equal(isExcluded('/proc-backup', ex), null);
    assert.equal(isExcluded('/srv/app/x', ex), null);
    // `/` as an exclude covers everything, which is the degenerate case the
    // project-relative check refuses before it can bite.
    assert.equal(isExcluded('/anything', ['/']), '/');
    // The shared predicate, exercised directly: '' when equal, null when out.
    assert.equal(withinPosix('/a/b', '/a'), 'b');
    assert.equal(withinPosix('/a', '/a'), '');
    assert.equal(withinPosix('/a-backup', '/a'), null);
  });

  // ── The round trip ──────────────────────────────────────────────────

  // PINS: `describeRemote` costs ONE frame per connection generation however
  // many times the mirror is resolved, and a provider restart re-asks — the
  // advertisement is a property of the live connection, not of the handle.
  //
  // NOT CLAIMING: that the memo is keyed on handshake object identity
  // specifically. It asserts the observable frame count, which is the fact
  // callers depend on.
  test('describeRemote is asked once per connection generation, and again after a restart', async () => {
    const rec = path.join(await mkdtemp('cc-wire-'), 'frames.jsonl');
    const root = await fs.realpath(await mkdtemp('cc-mirror-'));
    await addSystem({
      id: 'box', label: 'box',
      launch: ['node', RECORDER, '--record', rec, '--mirror', root],
    });
    const sys = await systemById('box', null, 'test');

    const a = await sys.mirror();
    const b = await sys.mirror();
    const c = await sys.mirror();
    assert.deepEqual(a, { mirrorRoot: root, exclude: [] });
    assert.deepEqual(b, a);
    assert.deepEqual(c, a);
    assert.equal((await wire(rec)).filter(f => f.type === 'describeRemote').length, 1,
      'three resolutions, one frame');

    // A provider restart is a new connection generation. Changing the launch
    // argv disposes the live handle, which is how the suite forces one.
    await updateSystem('box', { launch: ['node', RECORDER, '--record', rec, '--mirror', `${root}`, '--exclude', '/proc'] });
    const fresh = await systemById('box', null, 'test');
    assert.deepEqual(await fresh.mirror(), { mirrorRoot: root, exclude: ['/proc'] });
    assert.equal((await wire(rec)).filter(f => f.type === 'describeRemote').length, 2,
      'the new generation re-asks');
  });

  // PINS: a provider that advertises `remoteDescriptors` and then answers
  // EUNSUPPORTED takes the no-advertisement path rather than failing the spawn.
  // Belt and braces: the capability is the gate, and this is what happens when
  // the gate lies.
  //
  // NOT CLAIMING: that any real provider does this.
  test('a provider that advertises the capability and then refuses resolves to nothing', async () => {
    const fixture = path.join(__dirname, 'fixtures', 'mirrorFixtureProvider.mjs');
    await addSystem({ id: 'liar', label: 'liar', launch: ['node', fixture, '--lie-remote-descriptors'] });
    const sys = await systemById('liar', null, 'test');
    assert.equal(sys.handshake.capabilities.remoteDescriptors, true, 'it really does advertise it');
    assert.deepEqual(await sys.mirror(), { mirrorRoot: null, exclude: [] });
  });

  // PINS: the capability tracks the provider's configuration — a reference
  // provider given no mirror flag does not advertise it, and one given a flag
  // does. A capability that is always on is not a capability.
  //
  // NOT CLAIMING: that cc withholds the frame when it is off; that is
  // tests/systems-mirror-fallback.test.mjs's subject, measured on the wire.
  test('the remoteDescriptors capability tracks the provider flags', async () => {
    const bare = await bindRemoteSystem({ id: 'bare' });
    const withMirror = await bindRemoteSystem({ id: 'wide', flags: ['--mirror', '/'] });
    assert.equal((await systemById(bare.id, null, 'test')).handshake.capabilities.remoteDescriptors, false);
    assert.equal((await systemById(withMirror.id, null, 'test')).handshake.capabilities.remoteDescriptors, true);
  });

  // PINS: the advertisement resolves PER TARGET on one endpoint — the reason it
  // is a frame and not a handshake field. Two remotes on one provider process
  // answer with their own roots.
  //
  // NOT CLAIMING: that the two targets are different machines; the reference
  // provider is one machine, and the per-target ROOT is what distinguishes them.
  test('two remotes on one endpoint advertise different mirror roots', async () => {
    const a = await fs.realpath(await mkdtemp('cc-rem-a-'));
    const b = await fs.realpath(await mkdtemp('cc-rem-b-'));
    await addSystem({
      id: 'many', label: 'many',
      launch: referenceLaunch(
        '--remote', `a=${a}`, '--remote', `b=${b}`,
        '--mirror', `a=${a}`, '--mirror', `b=${b}`, '--exclude', `b=${path.join(b, 'skip')}`,
      ),
    });
    const ha = await systemById('many', 'a', 'test');
    const hb = await systemById('many', 'b', 'test');
    assert.deepEqual(await ha.mirror(), { mirrorRoot: a, exclude: [] });
    assert.deepEqual(await hb.mirror(), { mirrorRoot: b, exclude: [path.join(b, 'skip')] });
  });

  // PINS THE FLAG SEPARATION, which is the whole reason `--mirror` is not
  // `--remote`'s root: a target may advertise a mirror WIDER than the fence it
  // is scoped to, cc consumes the ADVERTISEMENT rather than deriving geometry
  // from the fence, and the fence still refuses what lies outside it. The two
  // are independent knobs and this is the configuration that proves it.
  //
  // NOT CLAIMING: that a real provider should be configured this way. It is the
  // discriminating case — a cc that read the fence instead of the advertisement
  // would produce `mirrorRoot === narrow` and pass every other test in this
  // file.
  test('a mirror root wider than the remote fence is consumed, and the fence still binds', async () => {
    const narrow = await fs.realpath(await mkdtemp('cc-fenced-'));
    await addSystem({
      id: 'fenced', label: 'fenced',
      launch: referenceLaunch('--remote', `a=${narrow}`, '--mirror', 'a=/'),
    });
    const h = await systemById('fenced', 'a', 'test');

    // The advertisement is the whole filesystem, not the fence.
    assert.deepEqual(await h.mirror(), { mirrorRoot: '/', exclude: [] });
    assert.notEqual(narrow, '/', 'the two really differ, or the assertion is vacuous');

    // And the fence is untouched by the advertisement: inside it reads, outside
    // it refuses EACCES.
    await fs.writeFile(path.join(narrow, 'inside.txt'), 'fenced-bytes');
    assert.equal(String(await h.readFile(path.join(narrow, 'inside.txt'))), 'fenced-bytes');
    const outside = path.join(await fs.realpath(await mkdtemp('cc-outside-')), 'x.txt');
    await fs.writeFile(outside, 'not-yours');
    await assert.rejects(() => h.readFile(outside), (e) => e.code === 'EACCES');
  });

  // PINS: an unknown remote's describeRemote is answered ENOREMOTE and
  // ID-ADDRESSED, so one dead target cannot tear down the connection every
  // other target's work is on.
  //
  // NOT CLAIMING: that the error reaches any particular cc surface; the code on
  // the throw is the contract.
  test('describeRemote for an unknown remote is ENOREMOTE, not a dead connection', async () => {
    const a = await fs.realpath(await mkdtemp('cc-rem-a-'));
    await addSystem({
      id: 'many2', label: 'many',
      launch: referenceLaunch('--remote', `a=${a}`, '--mirror', `a=${a}`),
    });
    const good = await systemById('many2', 'a', 'test');
    // A handle bound some other way than through the registry, which refuses an
    // unknown remote before it can get here.
    const bad = good.bindRemote('nope');
    await assert.rejects(() => bad.mirror(), (e) => e.code === 'ENOREMOTE');
    // The connection survives it.
    assert.deepEqual(await good.mirror(), { mirrorRoot: a, exclude: [] });
  });
});
