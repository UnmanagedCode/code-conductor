// jsonl replay must re-derive an ExitPlanMode's plan-file path from the same
// session's Write line. A path-based handover that evaporates after ring
// eviction / reload looks like it works, which is worse than not having it —
// so the live tracker (src/planFile.ts) is threaded through the replay loop,
// same-turn guard included.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadPersistedTranscript } from '../src/transcript.ts';
import { encodeCwd } from '../src/projects.ts';

const SID = 'aaaaaaaa-1111-2222-3333-555555555555';

// Seed a session jsonl in a fresh temp claude-projects root and replay it.
// Returns the replayed plan_request events.
async function replay(lines, planFileContent) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tplan-'));
  const prevRoot = process.env.CLAUDE_PROJECTS_ROOT;
  process.env.CLAUDE_PROJECTS_ROOT = path.join(tmp, 'claude-projects');
  const planFile = path.join(tmp, '.claude', 'plans', 'the-plan.md');
  try {
    await fs.mkdir(path.dirname(planFile), { recursive: true });
    if (planFileContent !== null) await fs.writeFile(planFile, planFileContent);
    const cwd = path.join(tmp, 'proj');
    const sessionDir = path.join(process.env.CLAUDE_PROJECTS_ROOT, encodeCwd(cwd));
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, `${SID}.jsonl`),
      lines(planFile).map(l => JSON.stringify(l)).join('\n') + '\n',
    );
    const result = await loadPersistedTranscript({ cwd, sessionId: SID });
    assert.ok(result, 'transcript loaded');
    const events = result.lines.flatMap(l => l.events);
    return { planRequests: events.filter(e => e.kind === 'plan_request'), planFile };
  } finally {
    if (prevRoot === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
    else process.env.CLAUDE_PROJECTS_ROOT = prevRoot;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

const writeLine = (planFile) => ({
  type: 'assistant', uuid: 'a0',
  message: { id: 'm_w', role: 'assistant', content: [
    { type: 'tool_use', id: 'tu_w', name: 'Write', input: { file_path: planFile, content: '# Plan\n- Make X\n' } },
  ] },
});

// The line the CLI writes immediately after the Write — array content, but
// mid-turn. Every real jsonl has one between the plan-file Write and the
// ExitPlanMode, so every replay fixture here carries it.
const writeResultLine = {
  type: 'user', uuid: 'ur', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'tu_w', content: 'File written', is_error: false },
  ] },
};

test('replay derives planPath from the session\'s plan-file Write', async () => {
  const { planRequests, planFile } = await replay(
    (pf) => [
      { type: 'user', uuid: 'u0', message: { role: 'user', content: 'plan this' } },
      writeLine(pf),
      writeResultLine,
      { type: 'assistant', uuid: 'a1', message: { id: 'm_p', role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_exit', name: 'ExitPlanMode', input: {} },
      ] } },
    ],
    '# Plan\n- Make X\n',
  );
  assert.equal(planRequests.length, 1);
  assert.equal(planRequests[0].planPath, planFile, 'the Write earlier in this jsonl is found on replay');
  assert.equal(planRequests[0].plan, '# Plan\n- Make X\n', 'the file\'s contents become the plan text');
});

test('replay binds a same-turn plan-file Write to an INLINE plan across the tool_result line', async () => {
  // The tool_result the CLI writes after the Write is array-content but
  // mid-turn: if it counted as a turn boundary, branch 1's same-turn flag
  // would be cleared before the ExitPlanMode and the path would exist live
  // but vanish the moment the ring evicted the event.
  const { planRequests, planFile } = await replay(
    (pf) => [
      { type: 'user', uuid: 'u0', message: { role: 'user', content: 'plan this' } },
      writeLine(pf),
      writeResultLine,
      { type: 'assistant', uuid: 'a1', message: { id: 'm_p', role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_exit', name: 'ExitPlanMode', input: { plan: 'Step 1\nStep 2' } },
      ] } },
    ],
    '# Plan\n- Make X\n',
  );
  assert.equal(planRequests.length, 1);
  assert.equal(planRequests[0].planPath, planFile, 'a mid-turn tool_result must not unbind the write');
  assert.equal(planRequests[0].plan, 'Step 1\nStep 2', 'the model\'s own text stays the plan');
});

test('replay does not attach a path to an inline plan from a later turn', async () => {
  const { planRequests } = await replay(
    (pf) => [
      { type: 'user', uuid: 'u0', message: { role: 'user', content: 'plan this' } },
      writeLine(pf),
      writeResultLine,
      { type: 'assistant', uuid: 'a1', message: { id: 'm_p1', role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_exit1', name: 'ExitPlanMode', input: {} },
      ] } },
      // A genuine user prompt — and in the STRING-content shape, which is what
      // the CLI persists for a plain typed prompt. This line, not the
      // tool_result above, is what unbinds the write.
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'revise it' } },
      { type: 'assistant', uuid: 'a2', message: { id: 'm_p2', role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_exit2', name: 'ExitPlanMode', input: { plan: 'Step 1\nStep 2' } },
      ] } },
    ],
    '# Plan\n- Make X\n',
  );
  assert.equal(planRequests.length, 2);
  assert.ok(planRequests[0].planPath, 'turn 1\'s empty-input plan still gets the path');
  assert.equal(planRequests[1].plan, 'Step 1\nStep 2');
  assert.equal(planRequests[1].planPath, null, 'a stale path would silently name another task\'s plan');
});
