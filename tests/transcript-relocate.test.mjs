// MOVING A SESSION'S TRANSCRIPTS TO A NEW CWD — the primitive, on its own.
//
// The CLI keys its transcript directory off getcwd(), so a session whose cwd
// moves finds nothing unless its files move with it. `relocateSessionTranscripts`
// is what moves them, and this file pins it away from the instance: no server,
// no provider, no subprocess — a temp `CLAUDE_PROJECTS_ROOT` and two synthetic
// cwds.
//
// THE PROPERTY THAT NEEDED A MECHANISM RATHER THAN A SENTENCE: the loop is over
// `sessionIds × {jsonl, subagent dir}`, so a failure AFTER a success is
// reachable two independent ways — a rotated session with several segments, and
// a single-segment session that used a subagent (two renames for one id). The
// answer is all-or-nothing by rollback, and the caller's refusal derives its
// claim from what the rollback achieved rather than asserting one
// (card 2026-0279).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';
import { encodeCwd, sessionFilePath, subAgentDirPath, claudeProjectsRoot } from '../src/projects.ts';
import { relocateSessionTranscripts, TranscriptRelocationError } from '../src/transcript.ts';

// Two BACKING ids (uuids, not minted public ids — sessionFilePath asserts on
// those). Two of them because a renewed session's history is spread across its
// lineage and every segment has to move.
const IDS = ['9746ee72-0000-4000-8000-00000000aaaa', 'c0000000-0000-4000-8000-00000000bbbb'];

describe('relocating a session transcript to a new cwd', () => {
  let prevRoot, FROM, TO;

  // Synthetic cwds, never created on disk: only `encodeCwd` reads them, and the
  // point of the primitive is that it touches nothing but the transcript root.
  beforeEach(async () => {
    prevRoot = process.env.CLAUDE_PROJECTS_ROOT;
    process.env.CLAUDE_PROJECTS_ROOT = await mkdtemp('cc-reloc-');
    const box = await mkdtemp('cc-reloc-cwd-');
    FROM = box;
    TO = path.join(box, 'proj');
  });

  afterEach(() => {
    if (prevRoot === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
    else process.env.CLAUDE_PROJECTS_ROOT = prevRoot;
  });

  // Both paths for one id: the jsonl the CLI resumes from, and the sibling
  // sub-agent directory its sidechains live in.
  async function seed(cwd, id) {
    const file = sessionFilePath(cwd, id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `{"id":"${id}"}\n`);
    const dir = subAgentDirPath(cwd, id);
    await fs.mkdir(path.join(dir, 'subagents'), { recursive: true });
    await fs.writeFile(path.join(dir, 'subagents', 'agent-a.jsonl'), '{"a":1}\n');
  }
  const exists = (p) => fs.stat(p).then(() => true, () => false);
  // Everything one id owns, at one cwd: [jsonl?, subagent dir?].
  const where = async (cwd, id) => [await exists(sessionFilePath(cwd, id)), await exists(subAgentDirPath(cwd, id))];
  const encodedDir = (cwd) => path.join(claudeProjectsRoot(), encodeCwd(cwd));

  // PINS: every SEGMENT moves, and both paths per segment — a relocation that
  // carried only the current backing id, or only the jsonl, leaves the rest of
  // the session's history at a cwd nothing will look at again.
  //
  // NOT CLAIMING that the CLI resumes from the moved files — that is the
  // instance-level test's subject; what is pinned here is where the bytes are.
  test('every segment’s jsonl and subagent dir moves', async () => {
    for (const id of IDS) await seed(FROM, id);

    await relocateSessionTranscripts({ from: FROM, to: TO, sessionIds: IDS });

    for (const id of IDS) {
      assert.deepEqual(await where(TO, id), [true, true], `${id} did not arrive whole`);
      assert.deepEqual(await where(FROM, id), [false, false], `${id} was left behind`);
    }
    assert.equal(await fs.readFile(sessionFilePath(TO, IDS[0]), 'utf8'), `{"id":"${IDS[0]}"}\n`);
    assert.equal(
      await fs.readFile(path.join(subAgentDirPath(TO, IDS[1]), 'subagents', 'agent-a.jsonl'), 'utf8'),
      '{"a":1}\n',
    );
  });

  // PINS THE EXACT ON-DISK STATE THE 502 CLAIMS, not the message text: when the
  // SECOND id cannot move, the FIRST id's already-moved paths are put BACK, and
  // `stranded` is empty — which is what makes the caller's "Nothing was moved"
  // sentence a derivation rather than an assertion.
  //
  // NOT CLAIMING anything about the non-empty-`stranded` wording branch: that
  // needs a rename back to a path cc vacated microseconds earlier to fail, which
  // this filesystem offers no seam for. The branch exists so the refusal cannot
  // assert a state it did not verify.
  test('a failure on the second id rolls the first one back, and nothing was moved', async () => {
    for (const id of IDS) await seed(FROM, id);
    // A DIRECTORY at the second id's destination jsonl: `rename(file, dir)` is
    // EISDIR even when the directory is empty, so this blocks forever rather
    // than clearing on a retry — which is why rollback beats "describe the
    // partial state".
    await fs.mkdir(sessionFilePath(TO, IDS[1]), { recursive: true });

    await assert.rejects(
      relocateSessionTranscripts({ from: FROM, to: TO, sessionIds: IDS }),
      (e) => {
        assert.ok(e instanceof TranscriptRelocationError, `wrong error type: ${e}`);
        assert.deepEqual(e.stranded, [], 'the rollback put everything back, so nothing is stranded');
        return true;
      },
    );

    assert.deepEqual(await where(FROM, IDS[0]), [true, true], 'the first id was rolled back whole');
    assert.deepEqual(await where(FROM, IDS[1]), [true, true], 'the second id never moved');
    assert.deepEqual(await where(TO, IDS[0]), [false, false], 'and nothing of the first id was left at the destination');
    // Only the planted blocker is at the destination.
    assert.deepEqual((await fs.readdir(encodedDir(TO))).sort(), [`${IDS[1]}.jsonl`]);
  });

  // PINS idempotence end to end: the refusal leaves a state the operator can
  // retry, and the retry completes. A rollback that half-restored, or a first
  // attempt that consumed something, would fail here rather than in the arm
  // above.
  //
  // NOT CLAIMING that cc retries by itself — it refuses the relaunch and the
  // next one tries again.
  test('a retry after the blocker is cleared completes the move', async () => {
    for (const id of IDS) await seed(FROM, id);
    const blocker = sessionFilePath(TO, IDS[1]);
    await fs.mkdir(blocker, { recursive: true });
    await assert.rejects(relocateSessionTranscripts({ from: FROM, to: TO, sessionIds: IDS }));

    await fs.rm(blocker, { recursive: true, force: true });
    await relocateSessionTranscripts({ from: FROM, to: TO, sessionIds: IDS });

    for (const id of IDS) {
      assert.deepEqual(await where(TO, id), [true, true], `${id} did not arrive on the retry`);
      assert.deepEqual(await where(FROM, id), [false, false], `${id} was left behind on the retry`);
    }
  });

  // PINS: a session with nothing to move writes NOTHING — in particular it does
  // not create the destination's encoded directory. A fresh spawn has no
  // transcript, and an empty encoded dir per such session is litter under the
  // CLI's own root that only the CLI is supposed to create.
  //
  // NOT CLAIMING that a MISSING source is otherwise special: it is also the
  // already-moved half of a retry and a session with no subagents, and all three
  // are the same non-failure.
  test('a session with no transcript relocates to nothing and creates no directory', async () => {
    await relocateSessionTranscripts({ from: FROM, to: TO, sessionIds: IDS });
    await assert.rejects(fs.readdir(encodedDir(TO)), /ENOENT/,
      'the destination directory was created for a session that had nothing to move');
  });

  // PINS that the ONE `mkdir` is inside the rollback's `try`: a destination
  // parent that cannot be created must refuse with both sources intact, not
  // throw past the rollback. A file planted where the encoded directory belongs
  // is the cheapest way to make that mkdir fail.
  //
  // NOT CLAIMING which errno a real-world parent failure carries — EEXIST here,
  // EACCES or ENOSPC elsewhere; the invariant is that the sources survive it.
  test('a destination parent that cannot be created refuses with both sources intact', async () => {
    for (const id of IDS) await seed(FROM, id);
    await fs.mkdir(claudeProjectsRoot(), { recursive: true });
    await fs.writeFile(encodedDir(TO), 'not a directory\n');

    await assert.rejects(
      relocateSessionTranscripts({ from: FROM, to: TO, sessionIds: IDS }),
      (e) => {
        assert.ok(e instanceof TranscriptRelocationError, `wrong error type: ${e}`);
        assert.deepEqual(e.stranded, [], 'nothing had moved yet, so nothing can be stranded');
        return true;
      },
    );

    for (const id of IDS) assert.deepEqual(await where(FROM, id), [true, true], `${id} survived the refusal`);
  });
});
