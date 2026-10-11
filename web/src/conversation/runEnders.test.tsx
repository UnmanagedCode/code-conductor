// What ends a machinery run and what does not: a compaction folds the run and the
// open run of a sub-agent; a prompt reaches a sub-agent's run too; a process exit
// folds the run whatever its exit code; a note the turn survives leaves the run open
// and still collecting; and the reader's clicks inside an open group are clicks on
// what they hit, never on the group, so the run's end still folds it.
import { describe, expect, it } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { ConversationModel, type GroupNode, type ToolNode } from './model';
import { flush, renderModel } from './renderModel';
import { assistants, feed, groupsOf, groupText, text, tool } from './testkit';
import type { UiEvent } from '@/state/types';

const onlyGroup = (m: ConversationModel) => groupsOf(assistants(m)[0])[0];

/** An Agent call whose sub-agent has started a Read and is still running. */
function runningSubAgent(): ConversationModel {
  const m = new ConversationModel();
  feed(m, [
    ...tool('m1', 0, 'A', 'Agent', { result: null, input: { description: 'survey' } }),
    { kind: 'assistant_message', msgId: 's1', parentToolUseId: 'A', message: { content: [{ type: 'tool_use', id: 'sr1', name: 'Read', input: {} }] } },
  ]);
  return m;
}
const subGroups = (m: ConversationModel): GroupNode[] => {
  const agent = onlyGroup(m).children[0] as ToolNode;
  return agent.sub ? assistants(agent.sub).flatMap(groupsOf) : [];
};

describe('run-enders', () => {
  it('a compaction folds a trailing machinery run', () => {
    const m = new ConversationModel();
    feed(m, [...tool('m1', 0, 'tu1', 'Bash'), ...tool('m1', 1, 'tu2', 'Read')]);
    const g = onlyGroup(m);
    expect(g.open, 'precondition: the run is open while it collects').toBe(true);
    m.apply({ kind: 'compaction', trigger: 'auto', preTokens: 1, postTokens: 1, durationMs: 1 });
    expect(g.open).toBe(false);
  });

  it("a prompt reaches a sub-agent's open run and folds it, as a turn's end does", () => {
    for (const closer of [{ kind: 'user_echo', text: 'next prompt', userIndex: 1 }, { kind: 'turn_end', subtype: 'success' }] as UiEvent[]) {
      const m = runningSubAgent();
      const [sub] = subGroups(m);
      expect(groupText(sub), `${closer.kind}: fixture check: the sub-agent's own run`).toBe('1 action · Read');
      expect(sub.open, `${closer.kind}: precondition: open while the sub-agent runs`).toBe(true);
      m.apply(closer);
      expect(sub.open, closer.kind).toBe(false);
    }
  });

  it("a compaction folds a sub-agent's open run, and the sub-agent's later work opens a new one beside it", () => {
    const m = runningSubAgent();
    const [first] = subGroups(m);
    expect(first.open, 'precondition: open while the sub-agent runs').toBe(true);
    m.apply({ kind: 'compaction', trigger: 'auto', preTokens: 1, postTokens: 1, durationMs: 1 });
    expect(first.open, 'the compaction folds it').toBe(false);
    m.apply({ kind: 'assistant_message', msgId: 's1', parentToolUseId: 'A', message: { content: [{ type: 'tool_use', id: 'sb1', name: 'Bash', input: {} }] } });
    const groups = subGroups(m);
    expect(groups.map(groupText)).toEqual(['1 action · Read', '1 action · Bash']);
    expect(groups.map((g) => g.open)).toEqual([false, true]);
  });

  it('a process exit folds the collecting run, a clean exit as well as a failed one', () => {
    for (const code of [1, 0]) {
      const m = new ConversationModel();
      feed(m, [...tool('m1', 0, 'tu1', 'Bash'), { kind: 'thinking_start', msgId: 'm1', blockIdx: 1 }]);
      const g = onlyGroup(m);
      expect(g.open, `exit ${code}: precondition: open`).toBe(true);
      m.apply({ kind: 'system', subtype: 'exit', data: { code, signal: null } });
      expect(g.open, `exit ${code}`).toBe(false);
    }
  });

  it('a note the turn survives leaves the run open and still collecting: an auto-resume, a stderr line, a cache miss', () => {
    const notes = [
      { kind: 'system', subtype: 'auto_resume', data: { count: 2 } },
      { kind: 'system', subtype: 'stderr', data: { line: 'a warning from the CLI' } },
      { kind: 'system', subtype: 'cache_miss', data: { cacheCreation: 10, cacheRead: 2 } },
    ] as UiEvent[];
    for (const note of notes) {
      const m = new ConversationModel();
      feed(m, tool('m1', 0, 'tu1', 'Bash'));
      const g = onlyGroup(m);
      m.apply(note);
      expect(m.items.some((i) => i.type === 'system' && i.ev.subtype === note.subtype), `${note.subtype}: fixture check: the note is shown`).toBe(true);
      expect(g.open, `${note.subtype}: open`).toBe(true);
      feed(m, tool('m1', 1, 'tu2', 'Read'));
      expect(groupsOf(assistants(m)[0]), `${note.subtype}: one run`).toEqual([g]);
      expect(groupText(g), `${note.subtype}: still collecting`).toBe('2 actions · Bash, Read');
    }
  });
});

describe("the reader's clicks inside an open group", () => {
  it("open and close what they hit, never mark the group as the reader's, so prose still folds it", async () => {
    const m = new ConversationModel();
    feed(m, [
      ...tool('m1', 0, 'A', 'Agent', { result: null, input: { description: 'survey' } }),
      { kind: 'text_delta', msgId: 'ms', blockIdx: 0, text: 'sub reply', parentToolUseId: 'A' },
      { kind: 'text_end', msgId: 'ms', blockIdx: 0, parentToolUseId: 'A' },
      { kind: 'tool_result', toolUseId: 'A', content: 'done', isError: false },
    ]);
    const g = onlyGroup(m);
    const agent = g.children[0] as ToolNode;
    const { root } = renderModel(m);
    await flush();
    const groupTrigger = root.querySelector('[data-group-trigger]') as HTMLElement;
    expect(groupTrigger.getAttribute('data-state'), 'precondition: the run is open while it collects').toBe('open');

    fireEvent.click(root.querySelector('[data-tool-trigger]') as HTMLElement);
    await flush();
    for (const hook of ['data-tool-args', 'data-tool-result']) {
      fireEvent.click(root.querySelector(`[${hook}] > summary`) as HTMLElement);
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
    fireEvent.click(root.querySelector('[data-sub-trigger]') as HTMLElement);
    await flush();
    expect(agent.reader, 'fixture check: every click landed on what it hit').toEqual({ open: true, subOpen: false, argsOpen: true });
    expect(agent.result!.reader.open, 'fixture check: the Result was collapsed').toBe(false);
    expect(g.userToggled).toBe(false);

    feed(m, text('m1', 1, 'prose ends the run'));
    await flush();
    expect(g.open).toBe(false);
    expect(groupTrigger.getAttribute('data-state')).toBe('closed');
  });
});
