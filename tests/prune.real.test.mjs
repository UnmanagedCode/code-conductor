// Real-claude regression test for Prune's harness-state contract.
// Skipped by default — opt-in via `RUN_REAL_CLAUDE=1`.
//
// This is the test that matters for Prune. The whole feature rests on how the
// Claude CLI reconstructs state from a transcript on resume, which is not
// documented anywhere and cannot be checked by inspecting the transformed
// jsonl. Both halves of the read-before-edit contract are asserted against the
// live binary:
//
//   1. A pruned Read's tool_use keeps `input.file_path` (invariant 1). If it
//      didn't, the harness would lose the file entirely and Edits would fail for
//      the wrong reason — indistinguishable from (2) unless you also assert (3).
//   2. A pruned Read's tool_result is a BLOCK ARRAY, so the harness drops the
//      readFileState entry and the read-before-edit guard RE-ARMS: an Edit with
//      no fresh Read is refused with the CLI's own message.
//   3. Re-Reading clears it and the Edit goes through — the guard is doing its
//      job, not permanently wedging the session.
//
// Pinned to claude-haiku-4-5 deliberately: the guard is only enforced for a
// fixed set of models (haiku-4-5, sonnet-4-5/4-0, opus ≤4-6, 3-x). Newer models
// let the Edit through with a note, so running this on Sonnet 5 or Opus 5 would
// pass vacuously and stop being a regression test.
//
// Run with:  RUN_REAL_CLAUDE=1 node tests/run.mjs tests/prune.real.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bootServer, api, waitFor } from './helpers.mjs';

const ENABLED = !!process.env.RUN_REAL_CLAUDE;
const t = ENABLED ? test : test.skip.bind(test);

const GUARD_MODEL = 'claude-haiku-4-5';
const TURN_TIMEOUT = 120_000;

const fileBody = Array.from({ length: 80 },
  (_, i) => `line ${String(i).padStart(3, '0')}: the quick brown fox jumps over the lazy dog`).join('\n') + '\n';

// The reconciled `assistant_message` carries the final block list; `text_delta`
// is the streaming form. Read both so a turn is captured either way.
function textOf(events) {
  const parts = [];
  for (const e of events) {
    if (e.kind === 'text_delta' && typeof e.text === 'string') parts.push(e.text);
    if (e.kind === 'assistant_message' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) if (b?.type === 'text') parts.push(b.text ?? '');
    }
  }
  return parts.join('\n');
}

t('real claude: a pruned session resumes, re-arms read-before-edit, and recovers on re-Read', async () => {
  const ctx = await bootServer({ useRealClaude: true });
  // bootServer points CLAUDE_PROJECTS_ROOT at a temp home, but the REAL claude
  // binary always writes its transcript under the real `~/.claude/projects`
  // (HOME is not overridden for the child). Prune reads the jsonl server-side,
  // so the two have to agree — unlike the other real-claude tests, which only
  // ever look at the event stream. ctx.close() restores this to the safe root.
  process.env.CLAUDE_PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
  const sessionIds = [];
  let projectPath = null;
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'prune-real' });
    projectPath = path.join(ctx.projectsRoot, 'prune-real');
    const target = path.join(projectPath, 'target.txt');
    await fs.writeFile(target, fileBody);

    const collected = [];
    ctx.instances.on('event', ({ id, ev }) => collected.push({ id, ev }));
    const since = () => collected.length;
    const drain = (from, id) => collected.slice(from).filter(e => e.id === id).map(e => e.ev);

    const created = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'prune-real', mode: 'bypassPermissions', model: GUARD_MODEL,
    });
    const id = created.body.id;
    await waitFor(() => ctx.instances.get(id)?.status === 'idle', { timeout: 10_000 });
    const inst = ctx.instances.get(id);

    async function runTurn(text) {
      const from = since();
      await inst.prompt(text);
      await waitFor(() => collected.slice(from).some(e => e.id === id && e.ev.kind === 'turn_end'),
        { timeout: TURN_TIMEOUT, interval: 150 });
      return drain(from, id);
    }

    // Turn 1: read the file so the session genuinely holds its content.
    await runTurn(`Use the Read tool on ${target}, then reply with just DONE.`);
    // Turn 2: gives the prune something to cut while leaving a newest turn.
    await runTurn('Reply with just READY.');
    sessionIds.push(inst.sessionId);

    // The Read output must actually be worth pruning, else the shrink-only guard
    // skips it and the rest of this test would pass for the wrong reason.
    const analysis = await api(ctx.baseUrl, 'GET', `/api/instances/${id}/prune/analysis`);
    assert.equal(analysis.status, 200);
    assert.ok(analysis.body.turnCount >= 2, `need ≥2 turns, got ${analysis.body.turnCount}`);
    assert.ok(analysis.body.turns[0].toolOutput > 200,
      `the Read output should dominate turn 0 (got ${analysis.body.turns[0].toolOutput})`);

    const pr = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/prune`, {
      cutTurnIndex: analysis.body.turnCount - 1, pruneThinking: true, inputMode: 'truncate',
    });
    assert.equal(pr.status, 200);
    sessionIds.push(pr.body.newSessionId);
    await waitFor(() => ctx.instances.get(id)?.status === 'idle', { timeout: 30_000 });
    assert.equal(inst.sessionId, pr.body.newSessionId, 'the pruned session is now attached');

    // The pruned session is genuinely LIVE, not merely loadable.
    const alive = await runTurn('Reply with just ALIVE.');
    assert.match(textOf(alive), /ALIVE/i, 'the pruned session did not resume cleanly');

    // (1)+(2): the guard re-armed. The model is told not to Read so the refusal
    // is the CLI's, not the model's own caution.
    const refused = await runTurn(
      `Use the Edit tool to change 'line 005' to 'LINE 005' in ${target}. `
      + 'Do NOT Read the file first. Report the exact tool result or error text verbatim.',
    );
    assert.match(
      textOf(refused), /has not been read yet/i,
      'a pruned Read must re-arm read-before-edit — got: ' + textOf(refused).slice(0, 400),
    );
    assert.equal(await fs.readFile(target, 'utf8'), fileBody, 'the refused Edit must not have applied');

    // (3): re-Reading recovers — the guard is self-healing, not a wall.
    const applied = await runTurn(
      `Read ${target}, then use the Edit tool to change 'line 005' to 'LINE 005'.`,
    );
    assert.doesNotMatch(textOf(applied), /has not been read yet/i,
      're-Reading should clear the guard');
    assert.match(await fs.readFile(target, 'utf8'), /^LINE 005:/m,
      'the Edit should have applied after a fresh Read');
  } finally {
    await ctx.close();
    if (projectPath) {
      const encoded = projectPath.replace(/[^A-Za-z0-9-]/g, '-');
      const dir = path.join(os.homedir(), '.claude', 'projects', encoded);
      for (const sid of sessionIds.filter(Boolean)) {
        await fs.rm(path.join(dir, `${sid}.jsonl`), { force: true }).catch(() => {});
        await fs.rm(path.join(dir, sid), { recursive: true, force: true }).catch(() => {});
      }
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
});
