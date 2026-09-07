// THE FILE-TOOL SEAM: which path a redirected session's Read/Write/Edit may
// name, and the four sentences it reads when it may not.
//
// The failure mode every assertion here defends against is ONE: a model that
// mistakes a refusal for file-not-found concludes the file is absent instead of
// using the channel that works. That is why the wordings are asserted clause by
// clause rather than by a `/deny/` match — the decision and the sentence are
// both the deliverable.
//
// THERE ARE FOUR WORDINGS AND NOT ONE. Every one of them points at Bash — that
// is uniform — and what differs is what each has to say about the answer Bash
// gives:
//   excluded / outside the mirror root  — Bash execs on the system and reaches
//     the path under no such restriction. `outside` additionally names the
//     project's own tree, which is what the worker actually wanted.
//   a bind mount                        — additionally WHOSE KERNEL, because a
//     file tool there would answer about the orchestrator's.
//   host-pinned (and this session's scaffolding) — additionally WHICH MACHINE,
//     because the same path exists on both. A shell on the system returns the
//     system's file at that path: right for an /etc question, and emphatically
//     not cc's copy for a cc-shaped path. An unqualified "use Bash instead"
//     would have the agent read that real file as the one cc refused.
//
// EVERYTHING HERE IS DECIDED IN MEMORY. `classifyForTool` never opens a file,
// and one test below asserts that structurally rather than by inspection.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildTierTable, renderPinsFile, classifyForTool, resolveTierEntry, BIND_MOUNTS } from '../src/systems/fuse/tierTable.ts';
import { buildFusePlan } from '../src/systems/fuse/plan.ts';
import { SessionRedirect, FILE_TOOLS } from '../src/systems/toolRedirect.ts';
import { withinPosix } from '../src/systems/mirror.ts';
import { tierFixtureInput } from './tierFixture.mjs';

const SYSTEM_ID = 'prod-box';
const SYSTEM_PATH = '/srv/app';
const MIRROR_ROOT = '/srv';
const RUN_DIR = '/workspaces/cc-projects/.code-conductor/systems/fuse/run/inst-1';

// Two excludes INSIDE the project (legal, active) and one that is also a bind
// mount, plus one OUTSIDE the mirror root, which criterion 4 calls inert.
const EXCLUDE = ['/srv/app/secrets', '/proc', '/var/lib/elsewhere'];

// The novel pair is what makes the ALLOW-set test a derivation test: neither
// prefix appears in any product source, so a hook that re-hard-coded the allow
// list cannot know about them.
const LOCAL_ROOTS = [
  ...tierFixtureInput().localRoots,
  { prefix: '/opt/novel-allow', access: 'allow', why: 'invented by this fixture' },
  { prefix: '/opt/novel-deny', access: 'deny', why: 'invented by this fixture' },
];

function fixture(over = {}) {
  const input = tierFixtureInput({
    localRoots: LOCAL_ROOTS,
    runDir: RUN_DIR,
    systemPath: SYSTEM_PATH,
    mirrorRoot: MIRROR_ROOT,
    exclude: EXCLUDE,
    ...over,
  });
  const tiers = buildTierTable(input);
  const session = {
    exclude: input.exclude, mirrorRoot: input.mirrorRoot,
    systemId: SYSTEM_ID, systemPath: input.systemPath,
  };
  return { input, tiers, session, classify: (p) => classifyForTool(tiers, session, p) };
}

const denied = (r, cls) => {
  assert.equal(r.decision, 'deny', `expected a deny, got ${JSON.stringify(r)}`);
  assert.equal(r.class, cls);
  return r.reason;
};

// THE NEGATIVE RULE, applied to all four wordings and not only to the one that
// documents it: a refusal a model reads as file-not-found is the whole failure
// mode, whatever words carry it.
//
// THE WORD FAMILY, NOT THE ONE INFLECTION. Round 1 caught this row failing its
// own documented killer: `cc will not bridge` → `cc could not find` leaves the
// `\b`-delimited word `found` ABSENT, because `find` is not `found`, so the
// mutation survived. The rule is about the CLAIM, so it forbids the claim's
// whole vocabulary.
//
// `absent` and `exists` are deliberately NOT forbidden: the contract's own
// anti-ENOENT clause says "NOT the file being absent" and "says nothing about
// whether it exists", so banning either word would forbid the wording it exists
// to protect. `does not exist` is banned as a PHRASE for the same reason.
const ABSENCE_CLAIMS = [
  /\b(?:found|find|finds|finding)\b/i,
  /does ?n(?:o|')t exist/i,
  /\bno such file\b/i,
  /\bmissing\b/i,
  /\bnot there\b/i,
];
const neverClaimsAbsence = (reason) => {
  for (const bad of ABSENCE_CLAIMS) assert.doesNotMatch(reason, bad, reason);
};

// THE SECOND RULE EVERY REFUSAL OBEYS, and the one the host-pin wording turns
// on: a refusal that points at Bash must say WHICH MACHINE Bash answers from.
//
// It matters most exactly where the same path exists on both. `cat ~/.claude/…`
// through Bash returns a real file — the SYSTEM's, not cc's — and an
// unqualified "use Bash instead" would have the agent read it as the file cc
// just refused. The qualifier is what keeps one sentence true for an `/etc`
// path (where the system's copy IS what was wanted) and for a cc-shaped path
// (where it is emphatically not).
//
// Enumerated as a FAMILY on both sides, not as one instance: the pointer may be
// spelled `Bash runs on 'x'` or `Bash runs ON SYSTEM 'x'`, and either satisfies
// it only when the system id is inside the same sentence as `Bash`.
const namesBashOnTheSystem = (reason, systemId) => {
  assert.match(reason, /\bBash\b/, `no Bash pointer at all: ${reason}`);
  const sentences = reason.split(/(?<=\.)\s+/).filter(x => /\bBash\b/.test(x));
  assert.ok(sentences.length > 0, reason);
  assert.ok(
    sentences.some(x => x.includes(`'${systemId}'`)),
    `the Bash pointer does not name the machine it answers from: ${sentences.join(' | ')}`,
  );
};

describe('the four file-tool refusals', () => {
  // A1 — PINS every clause of the excluded refusal, restored verbatim from the
  // deleted file bridge (a83bb40d^:src/systems/mirror.ts). Each clause earns its
  // place against the one failure mode; deleting the anti-ENOENT clause leaves
  // a sentence a model reads as "absent".
  test('A1: the excluded refusal carries every clause', () => {
    const { classify } = fixture();
    const reason = denied(classify('/srv/app/secrets/key.pem'), 'excluded');
    assert.match(reason, /cc will not bridge/);
    assert.match(reason, /'\/srv\/app\/secrets'/, 'the PREFIX, so the model generalises');
    assert.match(reason, /NOT the file being absent/);
    assert.match(reason, /cc has not looked/);
    assert.match(reason, /Bash runs on/);
    assert.match(reason, /`cat`/);
    assert.match(reason, /`sed -i`/);
    assert.match(reason, new RegExp(`'${SYSTEM_ID}'`));
  });

  // A2 — PINS the negative half of the same contract, which no positive
  // assertion can cover: rewording "cc will not bridge" into "cc could not
  // find" keeps every clause above and inverts the meaning.
  test('A2: no refusal claims the file was not there, in any of the four classes', () => {
    const { classify, input } = fixture();
    const seen = new Set();
    for (const p of ['/srv/app/secrets/key.pem', '/opt/elsewhere/x', '/proc/cpuinfo',
      '/home/node/.claude/settings.json', path.join(input.runDir, 'pins.txt')]) {
      const r = classify(p);
      assert.equal(r.decision, 'deny', p);
      neverClaimsAbsence(r.reason);
      // THE POSITIVE HALF, so a DUPLICATION dies too: appending "cc could not
      // find …" to an intact refusal leaves `will not bridge` present, which is
      // all A1 checks, and only the negative rule above catches it. Asserting
      // both here means neither a replacement nor an addition survives.
      assert.match(r.reason, /cc will not bridge/, r.reason);
      seen.add(r.class);
    }
    // ALL FOUR CLASSES were exercised above, so the rule is not being checked
    // against one wording four times.
    assert.deepEqual([...seen].sort(),
      ['bind-mount', 'excluded', 'host-pinned', 'outside-mirror-root']);
  });

  // A2b — PINS the OTHER uniform rule, and it replaces a BAN that used to sit
  // on the host-pinned wording. Every one of the four points at Bash, and every
  // one names the machine Bash answers from. The host pin was the exception —
  // a dead end that never mentioned Bash — and it is not any more: the dead end
  // bought no concealment (a worker reaches the system's home through `ls ~/`
  // regardless) while costing the agent its next move.
  test('A2b: every refusal points at Bash and names the machine Bash answers from', () => {
    const { classify, input } = fixture();
    const seen = new Set();
    for (const p of ['/srv/app/secrets/key.pem', '/opt/elsewhere/x', '/proc/cpuinfo',
      '/home/node/.claude/settings.json', path.join(input.runDir, 'pins.txt')]) {
      const r = classify(p);
      assert.equal(r.decision, 'deny', p);
      namesBashOnTheSystem(r.reason, SYSTEM_ID);
      seen.add(r.class);
    }
    assert.deepEqual([...seen].sort(),
      ['bind-mount', 'excluded', 'host-pinned', 'outside-mirror-root']);
  });

  // …AND THAT RULE'S OWN DISCRIMINATION, same shape as the absence rule's below.
  // A wording that says only "use Bash" is the failure the qualifier exists to
  // prevent, so the rule must reject it — otherwise the rule is satisfied by
  // the very sentence it was added to forbid.
  test('the Bash-pointer rule rejects a wording that drops the machine', () => {
    const intact = fixture().classify('/home/node/.claude/settings.json').reason;
    // THE MUTANTS HAVE TO DROP THE MACHINE, not merely reword around it. A
    // first cut of this test replaced only the opening clause and left
    // `'prod-box'` standing later in the same sentence — the rule passed it,
    // correctly, and the weak mutant was the defect. Sentence-level surgery.
    const sentences = intact.split(/(?<=\.)\s+/);
    const bashAt = sentences.findIndex(x => /\bBash\b/.test(x));
    assert.ok(bashAt >= 0, intact);
    const swap = (replacement) =>
      sentences.map((x, i) => (i === bashAt ? replacement : x)).filter(Boolean).join(' ');
    const mutants = [
      // The failure the qualifier exists to prevent, in the owner's own words.
      swap('Use Bash instead.'),
      swap('Bash runs under no such restriction: read it with `cat` there instead.'),
      // The pointer removed outright, which leaves the agent with no channel.
      swap(''),
    ];
    for (const m of mutants) {
      assert.throws(() => namesBashOnTheSystem(m, SYSTEM_ID), /AssertionError/,
        `the rule accepted a wording with no machine named: ${m.slice(-120)}`);
    }
    // And it accepts every shipped wording, so it is discriminating rather than
    // merely strict.
    const { classify, input } = fixture();
    for (const p of ['/srv/app/secrets/key.pem', '/opt/elsewhere/x', '/proc/cpuinfo',
      '/home/node/.claude/settings.json', path.join(input.runDir, 'pins.txt')]) {
      namesBashOnTheSystem(classify(p).reason, SYSTEM_ID);
    }
  });

  // THE GUARD'S OWN DISCRIMINATION, asserted rather than hand-run once.
  //
  // Round 1's finding was not that a refusal was wrong — it was that the ROW's
  // documented killer did not kill. A row whose mutation survives is worse than
  // no row, because a prover and a future author both trust it. So the mutant
  // wordings are data here: each must be REJECTED by the rule, and the shipped
  // wordings must be ACCEPTED by it, which is what stops the fix from being a
  // regex that rejects everything.
  test('the absence rule rejects the mutations it exists to catch', () => {
    const intact = fixture().classify('/srv/app/secrets/key.pem').reason;
    const mutants = [
      // The plan's stated killer, and the one that survived round 1.
      intact.replace('cc will not bridge', 'cc could not find'),
      // Its inflections, which a single-word ban would also have missed.
      intact.replace('cc will not bridge', 'cc did not find'),
      intact.replace('cc will not bridge', 'cc found no'),
      // A DUPLICATION rather than a replacement — A1 survives this one.
      `${intact} cc could not find it.`,
      // The phrase form, both spellings.
      `${intact} The file does not exist.`,
      `${intact} The file doesn't exist.`,
      `${intact} No such file.`,
      `${intact} The file is missing.`,
    ];
    for (const m of mutants) {
      assert.throws(() => neverClaimsAbsence(m), /AssertionError/,
        `the absence rule accepted a mutant that claims absence: ${m.slice(-90)}`);
    }
    // …and it accepts every wording actually shipped, so it is discriminating
    // rather than merely strict. This is the half that fails if the fix were a
    // regex matching everything.
    const { classify, input } = fixture();
    for (const p of ['/srv/app/secrets/key.pem', '/opt/elsewhere/x', '/proc/cpuinfo',
      '/home/node/.claude/settings.json', path.join(input.runDir, 'pins.txt')]) {
      neverClaimsAbsence(classify(p).reason);
    }
  });

  // THE DELIBERATELY-LEGAL HALF, mutated rather than eyeballed.
  //
  // `absent` and `exists` must stay OUT of the ban family, because the
  // contract's own anti-ENOENT clauses are "NOT the file being absent" and
  // "says nothing about whether it exists" — a family that banned either would
  // forbid the very wording it protects. Round 2 left that resting on the
  // accept-half holding by inspection: no mutant added `absent` to the family.
  //
  // So the over-tight family is DATA here: adding either word must make the
  // shipped wordings fail. That is what makes the accept-half load-bearing
  // instead of decorative, and it fails at authoring time if a future editor
  // tightens the family onto the contract.
  test('banning `absent` or `exists` would reject the contract, so the accept-half bites', () => {
    const { classify, input } = fixture();
    const shipped = ['/srv/app/secrets/key.pem', '/opt/elsewhere/x', '/proc/cpuinfo',
      '/home/node/.claude/settings.json', path.join(input.runDir, 'pins.txt')]
      .map((p) => classify(p).reason);

    for (const [word, overTight] of [['absent', /\babsent\b/i], ['exists', /\bexists\b/i]]) {
      const family = [...ABSENCE_CLAIMS, overTight];
      const rejected = shipped.filter((r) => family.some((bad) => bad.test(r)));
      assert.ok(rejected.length > 0,
        `banning \`${word}\` rejected NO shipped wording, so the carve-out is not load-bearing `
        + `and the accept-half would not have caught it`);
    }
    // And the honest scope of that: `absent` is in EVERY shipped wording,
    // `exists` in most — so the carve-out is protecting live text, not a
    // hypothetical.
    assert.equal(shipped.filter((r) => /\babsent\b/i.test(r)).length, shipped.length);
    assert.ok(shipped.filter((r) => /\bexists\b/i.test(r)).length >= 4);
  });

  // A3 — PINS that the refusal covers the WHOLE tool family, reads and writes
  // alike, enumerated from the exported map rather than transcribed. A branch
  // that let `Read` through would leak an -ENOENT for exactly the tool a model
  // reaches for first.
  test('A3: every FILE_TOOLS key is refused on an excluded path', async () => {
    const { tiers, session } = fixture();
    const redirect = new SessionRedirect({
      system: { execOneShot: async () => ({ code: 0, stdout: '', stderr: '' }) },
      systemId: SYSTEM_ID, systemPath: SYSTEM_PATH,
      tiers, exclude: session.exclude, mirrorRoot: session.mirrorRoot,
      forwarderUrl: 'http://127.0.0.1:1/x', emit: () => {},
    });
    assert.ok(Object.keys(FILE_TOOLS).length >= 4, 'the map is not empty');
    for (const [tool, key] of Object.entries(FILE_TOOLS)) {
      const d = await redirect.preToolUse(tool, { [key]: '/srv/app/secrets/key.pem' });
      assert.equal(d.decision, 'deny', tool);
      assert.match(d.reason, /excluded from file mirroring/, tool);
    }
    // THE CONTROL: the same tools inside the project are allowed, so this is not
    // passing by denying everything.
    for (const [tool, key] of Object.entries(FILE_TOOLS)) {
      assert.deepEqual(await redirect.preToolUse(tool, { [key]: '/srv/app/src/main.js' }),
        { decision: 'allow' }, tool);
    }
  });

  // A4 — PINS the host-pin wording, and the assertion that matters is now the
  // REMOTE QUALIFIER rather than the ban that used to be here.
  //
  // The ban is gone because the dead end it enforced prevented nothing: a
  // worker reaches the system's `~/` through Bash whether the sentence mentions
  // it or not. What replaces it is the property that makes naming Bash safe
  // here — the wording states which machine Bash answers from, so an agent
  // reading the system's copy of a cc-shaped path cannot take it for cc's.
  //
  // Reusing `excludedRefusal` for this class still fails: that wording names no
  // orchestrator and no pin prefix.
  test('A4: a host-pinned path names Bash AND the machine Bash answers from', () => {
    const { classify, input } = fixture();
    const reason = denied(classify('/home/node/.claude/settings.json'), 'host-pinned');
    assert.match(reason, /'\/home\/node\/.claude'/, 'it names the prefix');
    assert.match(reason, /settings/, "it names the class, from the entry's own `why`");
    assert.match(reason, /ORCHESTRATOR/, 'it says whose machine the pin is on');
    namesBashOnTheSystem(reason, SYSTEM_ID);
    // THE CLAUSE THAT KEEPS THE POINTER HONEST: it must not offer Bash as a
    // route to the SAME file. Naming the system's own copy as a different file
    // is what stops the agent reading it as authoritative.
    assert.match(reason, /is NOT the orchestrator's copy/, reason);
    neverClaimsAbsence(reason);

    // The session's own hidden scaffolding is the same class and the same
    // wording — the pin is the orchestrator's either way.
    const hidden = denied(classify(path.join(input.runDir, 'pins.txt')), 'host-pinned');
    namesBashOnTheSystem(hidden, SYSTEM_ID);
    assert.match(hidden, /scaffolding/);
  });

  // A5 — PINS the outside-the-boundary wording. It must name the mirror root,
  // because that is the rule the model has to generalise from, and it must point
  // at Bash, which execs on the system and does reach the path.
  test('A5: outside the mirror root names the root and points at Bash', () => {
    const reason = denied(fixture().classify('/opt/elsewhere/x'), 'outside-mirror-root');
    assert.match(reason, /cc will not bridge/);
    assert.match(reason, new RegExp(`'${MIRROR_ROOT}'`), 'the mirror root is not named');
    assert.match(reason, /mirror root/);
    // …and the project's own tree, which is where the worker actually wanted to
    // be. A refusal that only says "not that one" costs a call to find out.
    assert.match(reason, new RegExp(`'${SYSTEM_PATH}'`), "the project's tree is not named");
    assert.match(reason, /Bash runs on/);
    neverClaimsAbsence(reason);
    // A path INSIDE the root but outside the project is the control: it is
    // `project` tier and allowed, so the refusal above is about the boundary and
    // not about being outside the project.
    assert.deepEqual(fixture().classify('/srv/other/file'), { decision: 'allow' });
  });

  // A6 — PINS the bind-mount wording's extra clause: `/proc` inside the chroot
  // is the ORCHESTRATOR's, bind-mounted so the CLI works, so a file tool there
  // answers about the wrong kernel while Bash answers the same question about
  // the right one. Dropping BIND_MOUNTS from the table makes this an
  // outside-the-root refusal that says nothing about kernels.
  test('A6: a bind mount is denied naming whose kernel it is', () => {
    const { classify } = fixture();
    for (const b of BIND_MOUNTS) {
      const reason = denied(classify(`${b}/anything`), 'bind-mount');
      assert.match(reason, /kernel/, reason);
      assert.match(reason, /ORCHESTRATOR/, reason);
      assert.match(reason, /Bash runs on/, reason);
      neverClaimsAbsence(reason);
    }
    assert.match(denied(classify('/proc/cpuinfo'), 'bind-mount'), /'\/proc'/);
  });

  // A7 — PINS criterion 11's deny-by-absence clause STRUCTURALLY: the decision
  // comes from the table, never from probing the mirror. A path inside the
  // project that exists nowhere on this machine is ALLOWED — the union
  // materialises it when the CLI opens it, so an `existsSync` gate would deny
  // the first read of every file in the project.
  test('A7: a project path absent from every filesystem is allowed', () => {
    const { classify } = fixture();
    assert.deepEqual(classify('/srv/app/does/not/exist/anywhere.txt'), { decision: 'allow' });
    // WHAT THE LINE BELOW DOES AND DOES NOT ESTABLISH, stated exactly because an
    // earlier wording here claimed "there is nothing to probe with" and an arity
    // number cannot establish that. It is a TRIPWIRE on the signature: it kills
    // "add a `mirrorFs`/`existsSync` parameter", and nothing else. It does NOT
    // rule out an `import fs` inside the module, and it does NOT rule out a
    // filesystem handle smuggled onto the existing third parameter.
    //
    // The discriminating assertion is the one ABOVE: a project path that exists
    // on no filesystem anywhere is ALLOWED, so any probe-before-allow — however
    // it reached a filesystem — flips it to deny and this test fails.
    assert.equal(classifyForTool.length, 3);
  });

  // A8 — PINS that the ALLOW set is DERIVED from `localRoots` and from nothing
  // else, parameterised over the fixture's own array including two prefixes that
  // appear in no product source. Replacing the derivation with a literal list
  // cannot know about them.
  test('A8: the allow set is derived from localRoots, novel entries included', () => {
    const { classify } = fixture();
    let allows = 0, denies = 0;
    for (const r of LOCAL_ROOTS) {
      const under = path.join(r.prefix, 'child.txt');
      if (r.access === 'allow') {
        assert.deepEqual(classify(under), { decision: 'allow' }, r.prefix);
        allows++;
      } else {
        denied(classify(under), 'host-pinned');
        denies++;
      }
    }
    // Both arms were exercised, so this cannot pass on an array of one kind.
    assert.ok(allows > 0 && denies > 0, `${allows} allow / ${denies} deny`);
    assert.deepEqual(classify('/opt/novel-allow/x'), { decision: 'allow' });
    denied(classify('/opt/novel-deny/x'), 'host-pinned');
  });

  // A21 — THE GATE ITSELF, over the WHOLE TABLE, because the owner calls it the
  // most important property in the system: a file tool aimed at any host-pinned
  // path must DENY, and the `localRoots` allow bit must be the only way a
  // non-project path becomes tool-readable.
  //
  // A8 already proves the allow set is DERIVED from `localRoots`. What A8
  // cannot say is that no OTHER entry allows — it iterates the declaration, so
  // a stray `toolAccess: 'allow'` on an `/etc` pin is invisible to it. This
  // iterates the TABLE, which is the other direction, and it is the direction
  // the owner's invariant is stated in: *no local file served as if it were a
  // remote file*.
  //
  // NON-VACUITY IS THE WHOLE RISK HERE, so three things are asserted about the
  // enumeration itself and not only about its members: that the table is large,
  // that both outcomes occur, and that the allow set computed FROM THE TABLE is
  // exactly the one the declaration asked for — set equality, so a missing
  // entry and an extra one both fail.
  test('A21: every non-project entry denies, and the allow set is exactly the declaration', () => {
    const { classify, input } = fixture();
    const tiers = buildTierTable(input);

    // A path under each entry, at a component boundary so longest-prefix picks
    // that entry and not a shorter one. Entries that a LONGER entry shadows are
    // skipped by construction: `resolveTierEntry` is asked which entry owns the
    // probe, and only the ones it names are judged here.
    const owned = new Map();
    for (const e of tiers) {
      const probe = e.prefix === '/' ? '/probe-a21.txt' : path.join(e.prefix, 'probe-a21.txt');
      const owner = resolveTierEntry(tiers, probe);
      if (owner?.prefix !== e.prefix) continue;      // shadowed; its own probe judges it
      owned.set(e.prefix, { entry: e, probe });
    }
    assert.ok(owned.size >= 40, `only ${owned.size} entries were reachable by their own probe`);

    const allowedPrefixes = new Set();
    let denies = 0;
    for (const { entry, probe } of owned.values()) {
      const d = classify(probe);
      if (d.decision === 'allow') { allowedPrefixes.add(entry.prefix); continue; }
      denies++;
      // Every deny carries a wording, and every wording obeys both rules.
      assert.ok(d.reason && d.reason.length > 80, `${entry.prefix}: ${d.reason}`);
      neverClaimsAbsence(d.reason);
      namesBashOnTheSystem(d.reason, SYSTEM_ID);
    }
    assert.ok(denies > 30, `only ${denies} entries denied`);

    // THE SET EQUALITY. The only prefixes that allow are the `project` entries
    // and the `localRoots` that declared `allow` — computed from the table on
    // one side and from the declaration on the other.
    const wantAllowed = new Set([
      ...tiers.filter(e => e.tier === 'project').map(e => e.prefix),
      ...input.localRoots.filter(r => r.access === 'allow').map(r => r.prefix),
    ].filter(pfx => owned.has(pfx)));
    assert.deepEqual([...allowedPrefixes].sort(), [...wantAllowed].sort());

    // And no `host`, `hide`, `bind` or `fail` entry carries an allow bit at all,
    // which is the invariant one layer below the decision: `classifyForTool`
    // reads `toolAccess`, so a stray bit would allow before any wording is
    // chosen. Stated over the table, with the declaration's allows excluded by
    // name rather than by tier.
    const declaredAllow = new Set(input.localRoots.filter(r => r.access === 'allow').map(r => r.prefix));
    for (const e of tiers) {
      if (e.tier === 'project' || declaredAllow.has(e.prefix)) continue;
      assert.equal(e.toolAccess, 'deny', `${e.tier} ${e.prefix} carries toolAccess: allow`);
    }
  });

  // A9 — PINS longest-prefix resolution across the WHOLE table, which is what
  // lets an `allow` sit inside a `deny` region: plan mode's Write lands in
  // `~/.claude/plans` under a denied `~/.claude`. First-match-wins instead of
  // longest-prefix breaks plan mode for every remote-backed worker.
  test('A9: ~/.claude/plans is allowed under a denied ~/.claude', () => {
    const { classify } = fixture();
    assert.deepEqual(classify('/home/node/.claude/plans/a-plan.md'), { decision: 'allow' });
    denied(classify('/home/node/.claude/projects/x/y.jsonl'), 'host-pinned');
    denied(classify('/home/node/.claude/.credentials.json'), 'host-pinned');
    // And the component boundary is respected — a prefix-SHARING sibling of the
    // allowed directory is not allowed.
    denied(classify('/home/node/.claude/plans-backup/x.md'), 'host-pinned');
  });

  // A10 — PINS CRITERION 15, in the only two ways it can be pinned:
  //   (i)  IDENTITY. The array the hook decides from is the same OBJECT the
  //        pins file was rendered from. A `SessionRedirect` that called
  //        `buildTierTable` itself would hold an equal array that can later stop
  //        being equal.
  //   (ii) A bespoke entry appended to the table changes BOTH surfaces. This is
  //        the anti-drift property itself: a hook reading its own hard-coded
  //        list would answer the same either way.
  test('A10: the pins file and the hook decide from ONE array', () => {
    const { tiers, session } = fixture();
    const redirect = new SessionRedirect({
      system: { execOneShot: async () => ({ code: 0, stdout: '', stderr: '' }) },
      systemId: SYSTEM_ID, systemPath: SYSTEM_PATH,
      tiers, exclude: session.exclude, mirrorRoot: session.mirrorRoot,
      forwarderUrl: 'http://127.0.0.1:1/x', emit: () => {},
    });
    const plan = buildFusePlan({
      instanceId: 'inst-1', cwdInside: SYSTEM_PATH,
      fakeRemoteRoot: '/', markPath: '/usr/local/bin/claude', tiers,
    });
    assert.equal(redirect.tiers, plan.tiers, 'the hook and the plan hold different arrays');
    assert.equal(plan.tiers, tiers);
    // WHY IDENTITY IS UNFORGEABLE BY A SECOND CALL, which is what makes the
    // live assertion in tests/systems-remote-worker.test.mjs lethal rather than
    // decorative: `buildTierTable` returns a FRESH array every time, so a second
    // call anywhere in the create path cannot satisfy `===` however equal its
    // contents are. Asserted, not reasoned about — if it ever memoised, the
    // live identity check would start passing for the wrong reason.
    const a = buildTierTable(tierFixtureInput());
    const b = buildTierTable(tierFixtureInput());
    assert.notEqual(a, b, 'buildTierTable memoises, so `===` no longer proves one construction site');
    assert.deepEqual(a, b, '…and the two are equal, so identity is the only thing separating them');

    // (ii) One append, two observable changes.
    const bespoke = { tier: 'fail', prefix: '/srv/bespoke', why: 'appended by this test', toolAccess: 'deny' };
    const grown = [...tiers, bespoke];
    assert.ok(!renderPinsFile(tiers).includes('/srv/bespoke'));
    assert.ok(renderPinsFile(grown).includes('fail\t/srv/bespoke'), 'the pins file did not grow');
    assert.deepEqual(classifyForTool(tiers, session, '/srv/bespoke/x'), { decision: 'allow' },
      'the control: without the entry the path is inside the mirror root and allowed');
    denied(classifyForTool(grown, session, '/srv/bespoke/x'), 'excluded');
  });

  // A11/A12 — the never-merge rule AT THE SEAM. The pins-file half of both is in
  // tests/fuse-lifecycle.test.mjs; what is new here is that each mechanism
  // reaches the HOOK, and that an exclude which is also a bind mount is denied
  // with the bind wording rather than silently allowed.
  test('A11/A12: both mechanisms deny at the seam, and neither derives the other', () => {
    // Excluded AND bind-mounted: the daemon keeps `bind` (the launch needs the
    // directory to exist), and the tool is still denied.
    denied(fixture().classify('/proc/self/status'), 'bind-mount');
    // Excluded and NOT bind-mounted: denied, and by the exclude mechanism.
    denied(fixture().classify('/srv/app/secrets/x'), 'excluded');
    // Clearing every exclude leaves the bind denials untouched — the bind set is
    // a constant, not a derivation from the advertisement.
    const noExcludes = fixture({ exclude: [] });
    for (const b of BIND_MOUNTS) denied(noExcludes.classify(`${b}/x`), 'bind-mount');
    // …and the excluded path is then merely inside the project, i.e. allowed,
    // which is the control proving the exclude denial above came from `exclude`.
    assert.deepEqual(noExcludes.classify('/srv/app/secrets/x'), { decision: 'allow' });
  });

  // A12-COMPETING — PINS first-occurrence-wins AT THE SEAM, where the fixture
  // above cannot reach it.
  //
  // WHY THIS EXISTS: a mutation round reordered `buildTierTable`'s two `add`
  // loops (fail before bind) and killed only the pins-file assertion — A11/A12
  // stayed GREEN. The reason is geometry: the default fixture's mirror root is
  // `/srv`, so its excluded `/proc` is OUTSIDE the root and inert by criterion 4,
  // and no `fail /proc` entry is ever built to compete with `bind /proc`. The
  // hook half of the never-merge rule was proved on one surface only.
  //
  // HERE THEY GENUINELY COMPETE: the mirror root is `/`, so the excluded `/proc`
  // IS inside it and a `fail /proc` entry really would be built — first
  // occurrence is the only thing deciding which survives.
  //
  // THE MUTATION THIS MUST DIE UNDER: swapping the BIND_MOUNTS and exclude loops
  // in buildTierTable. Under it dedupe keeps `fail /proc`, the hook answers
  // `excluded` instead of `bind-mount`, and the launch loses the directory
  // `bootstrap.sh` binds over.
  test('A12-competing: with a wide mirror root, bind still wins /proc at the seam', () => {
    const wide = fixture({ mirrorRoot: '/', exclude: ['/proc', '/srv/app/secrets'] });

    // The exclude is genuinely active here — NOT inert — which is the whole
    // difference from the fixture above. Without this the case would silently
    // degenerate back into the uncompeted one.
    assert.notEqual(withinPosix('/proc', '/'), null, 'the exclude must be inside the mirror root');

    // THE SEAM: bind wins, so the worker is told whose kernel it would have read
    // rather than that the path was excluded.
    const reason = denied(wide.classify('/proc/cpuinfo'), 'bind-mount');
    assert.match(reason, /kernel/, reason);
    // …and the OTHER exclude, which is not a bind mount, still answers by the
    // exclude mechanism — so this is about the collision and not about `fail`
    // having stopped working.
    denied(wide.classify('/srv/app/secrets/x'), 'excluded');

    // AND THE SAME CLAIM ON THE RENDERED FILE, in the one place both entries
    // compete, so criterion 3 is proved on both surfaces from one fixture.
    const lines = renderPinsFile(wide.tiers).split('\n').filter((l) => l && !l.startsWith('#'));
    assert.ok(lines.includes('bind\t/proc'), lines.join(' | '));
    assert.ok(!lines.includes('fail\t/proc'), 'the fail spelling shadowed the bind one');
    assert.ok(lines.includes('fail\t/srv/app/secrets'), 'the non-colliding exclude lost its fail line');
  });

  // A13 — PINS criterion 4's third clause AT THE SEAM: an exclude outside the
  // mirror root is INERT. `/var/lib/elsewhere` is in the fixture's advertised
  // exclude list, and a path under it is refused for being outside the mirror
  // root — never with the excluded wording, which would make the "no effect"
  // diagnostic cc already emits a lie.
  test('A13: an exclude outside the mirror root is inert at the seam', () => {
    const reason = denied(fixture().classify('/var/lib/elsewhere/x'), 'outside-mirror-root');
    assert.doesNotMatch(reason, /excluded from file mirroring/, reason);
  });

  // PINS the absolute-path refusal, restored from the deleted bridge. The CLI
  // was measured resolving every file path to an absolute one before the hook
  // fires, so this is unreachable today — but the tier table is a longest-prefix
  // rule over ABSOLUTE paths, so a relative path would be classified
  // "outside the mirror root", which is a sentence about the wrong thing.
  test('a relative or missing path is refused by name, not classified', async () => {
    const { tiers, session } = fixture();
    const redirect = new SessionRedirect({
      system: { execOneShot: async () => ({ code: 0, stdout: '', stderr: '' }) },
      systemId: SYSTEM_ID, systemPath: SYSTEM_PATH,
      tiers, exclude: session.exclude, mirrorRoot: session.mirrorRoot,
      forwarderUrl: 'http://127.0.0.1:1/x', emit: () => {},
    });
    for (const bad of ['src/main.js', './x', '', undefined, 42]) {
      const d = await redirect.preToolUse('Read', { file_path: bad });
      assert.equal(d.decision, 'deny', JSON.stringify(bad));
      assert.match(d.reason, /needs an absolute path/);
      assert.match(d.reason, /could name a file on either machine/);
      assert.doesNotMatch(d.reason, /mirror root/, 'it was classified instead of refused');
    }
  });

  // PINS: a tool cc does not own is untouched. The seam widened to Read in S2,
  // and a branch that classified every tool's every string input would refuse
  // WebFetch and TodoWrite calls that have nothing to do with the filesystem.
  test('a non-file tool is not classified at all', async () => {
    const { tiers, session } = fixture();
    const redirect = new SessionRedirect({
      system: { execOneShot: async () => ({ code: 0, stdout: '', stderr: '' }) },
      systemId: SYSTEM_ID, systemPath: SYSTEM_PATH,
      tiers, exclude: session.exclude, mirrorRoot: session.mirrorRoot,
      forwarderUrl: 'http://127.0.0.1:1/x', emit: () => {},
    });
    assert.deepEqual(await redirect.preToolUse('TodoWrite', { file_path: '/home/node/.claude/x' }),
      { decision: 'allow' });
  });
});
