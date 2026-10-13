import { describe, expect, it } from 'vitest';
import { ConversationModel, type GroupNode, type ToolNode } from './model';
import { assistants, feed, groupsOf, groupText, text, thinking, tool, toolResult, turnEnd } from './testkit';

const twoRunFeed = () => [
  ...thinking('m1', 0),
  ...tool('m1', 1, 'tu1', 'Bash'),
  ...tool('m1', 2, 'tu2', 'Read'),
  ...text('m1', 3, 'prose one'),
  ...tool('m1', 4, 'tu3', 'Edit'),
  ...tool('m1', 5, 'tu4', 'Grep'),
  ...text('m1', 6, 'prose two'),
];

const onlyGroup = (m: ConversationModel) => groupsOf(assistants(m)[0])[0];

describe('action groups', () => {
  it('each contiguous machinery run becomes exactly one group, prose stays outside', () => {
    const m = new ConversationModel();
    feed(m, twoRunFeed());
    expect(assistants(m)).toHaveLength(1);
    const wrap = assistants(m)[0];
    expect(wrap.children.map((c) => c.type)).toEqual(['group', 'text', 'group', 'text']);
    const [g1, g2] = groupsOf(wrap);
    expect(g1.children).toHaveLength(3);
    expect(g2.children).toHaveLength(2);
    expect(wrap.children.filter((c) => c.type === 'text').map((t: any) => t.buffer)).toEqual(['prose one', 'prose two']);
  });

  it('grouping wraps blocks without changing them: results attach to their tool, thinking finalizes', () => {
    const m = new ConversationModel();
    feed(m, twoRunFeed());
    const tools = groupsOf(assistants(m)[0]).flatMap((g) => g.children).filter((c): c is ToolNode => c.type === 'tool');
    expect(tools).toHaveLength(4);
    expect(tools.every((t) => t.result?.type === 'result' && t.status === 'done')).toBe(true);
    const th = groupsOf(assistants(m)[0])[0].children[0];
    expect(th).toMatchObject({ type: 'thinking', finalized: true, buffer: 'pondering' });
  });

  it('a run still accumulating is open; prose ends it and folds the same group', () => {
    const m = new ConversationModel();
    feed(m, [...thinking('m1', 0), ...tool('m1', 1, 'tu1', 'Bash')]);
    const g = onlyGroup(m);
    expect(g.open).toBe(true);
    feed(m, text('m1', 2, 'the prose'));
    expect(onlyGroup(m)).toBe(g);
    expect(g.open).toBe(false);
    expect(assistants(m)[0].children[1].type).toBe('text');
  });

  it("a user toggle is the user's choice: auto-collapse leaves it, appends never reopen it", () => {
    const m = new ConversationModel();
    feed(m, tool('m1', 0, 'tu1', 'Bash'));
    const g = onlyGroup(m);
    m.setGroupOpen(g, false);
    feed(m, [...tool('m1', 1, 'tu2', 'Read'), ...thinking('m1', 2)]);
    expect(g.open).toBe(false);
    expect(g.children).toHaveLength(3);
    m.setGroupOpen(g, true);
    feed(m, text('m1', 3, 'prose that would normally fold it'));
    expect(g.open).toBe(true);
    expect(g.userToggled).toBe(true);
  });

  const closers: [string, object][] = [
    ['user_echo', { kind: 'user_echo', text: 'next' }],
    ['turn_end', { kind: 'turn_end', durationMs: 1 }],
    ['plan_request', { kind: 'plan_request', toolUseId: 'p1', plan: 'x', planPath: null }],
    ['user_question', { kind: 'user_question', toolUseId: 'q1', questions: [] }],
    ['history_gap', { kind: 'history_gap' }],
    ['segment_seam', { kind: 'segment_seam', segmentId: 's2' }],
    ['history_replayed', { kind: 'system', subtype: 'history_replayed', data: { count: 2 } }],
    ['soft_interrupted', { kind: 'system', subtype: 'soft_interrupted', data: { text: 'user interrupt' } }],
    ['exit', { kind: 'system', subtype: 'exit', data: { code: 1 } }],
    ['compaction status', { kind: 'system', subtype: 'status', data: { status: 'compacting' } }],
  ];
  for (const [name, closer] of closers) {
    it(`${name} folds a trailing machinery run`, () => {
      const m = new ConversationModel();
      feed(m, [...tool('m1', 0, 'tu1', 'Bash'), ...tool('m1', 1, 'tu2', 'Read')]);
      const g = onlyGroup(m);
      expect(g.open).toBe(true);
      m.apply(closer as any);
      expect(g.open).toBe(false);
    });
    it(`${name} folds a group on the reused floating wrap`, () => {
      const m = new ConversationModel();
      feed(m, [
        toolResult({ toolUseId: 'orphan1', content: 'a' }),
        ...text('m1', 0, 'prose'),
        toolResult({ toolUseId: 'orphan2', content: 'b' }),
      ]);
      const stranded = groupsOf(assistants(m)[0])[1];
      expect(stranded.open).toBe(true);
      m.apply(closer as any);
      expect(stranded.open).toBe(false);
    });
  }

  it('a system note the turn survives does not collapse the group', () => {
    const m = new ConversationModel();
    feed(m, tool('m1', 0, 'tu1', 'Bash', { result: null }));
    m.apply({ kind: 'system', subtype: 'read_nudge', data: { text: 'read it' } });
    m.apply({ kind: 'system', subtype: 'playbook_warn', data: { tool: 'x' } });
    m.apply({ kind: 'system', subtype: 'task_notification', data: { notified: true, status: 'completed' } });
    expect(onlyGroup(m).open).toBe(true);
    feed(m, [toolResult({ toolUseId: 'tu1', content: 'ok' })]);
    expect((onlyGroup(m).children[0] as ToolNode).status).toBe('done');
  });

  it('the header tallies count, first-appearance names and errors', () => {
    const a = new ConversationModel();
    feed(a, [
      ...tool('m1', 0, 't1', 'Bash'), ...tool('m1', 1, 't2', 'Read'), ...tool('m1', 2, 't3', 'Bash'),
      ...thinking('m1', 3), ...tool('m1', 4, 't4', 'Read'), ...tool('m1', 5, 't5', 'Bash'),
    ]);
    expect(groupText(onlyGroup(a))).toBe('6 actions · Bash ×3, Read ×2, thinking');

    const b = new ConversationModel();
    feed(b, ['A', 'B', 'C', 'D', 'E', 'F'].flatMap((n, i) => tool('m1', i, `t${i}`, n)));
    expect(groupText(onlyGroup(b))).toBe('6 actions · A, B, C, D, +2 more');

    const c = new ConversationModel();
    feed(c, [...tool('m1', 0, 't1', 'Bash', { isError: true }), ...tool('m1', 1, 't2', 'Read')]);
    expect(groupText(onlyGroup(c))).toBe('2 actions · Bash, Read · 1 error');
  });

  it('labels keep first-appearance order even when a later one out-counts them', () => {
    const m = new ConversationModel();
    feed(m, [...tool('m1', 0, 't1', 'Bash'), ...tool('m1', 1, 't2', 'Read'), ...tool('m1', 2, 't3', 'Read'), ...tool('m1', 3, 't4', 'Read')]);
    expect(groupText(onlyGroup(m))).toBe('4 actions · Bash, Read ×3');
  });

  it('the header updates per block and never reorders itself', () => {
    const m = new ConversationModel();
    m.apply({ kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 't1', name: 'Bash' });
    const g = onlyGroup(m);
    expect(groupText(g)).toBe('1 action · Bash');
    m.apply({ kind: 'tool_use_start', msgId: 'm1', blockIdx: 1, toolUseId: 't2', name: 'Bash' });
    expect(groupText(g)).toBe('2 actions · Bash ×2');
    m.apply({ kind: 'tool_use_start', msgId: 'm1', blockIdx: 2, toolUseId: 't3', name: 'Read' });
    expect(groupText(g)).toBe('3 actions · Bash ×2, Read');
  });

  it('the header follows a tool renamed by its finalizing tool_use', () => {
    const m = new ConversationModel();
    m.apply({ kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tu1', name: 'Bash' });
    expect(groupText(onlyGroup(m))).toBe('1 action · Bash');
    m.apply({ kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tu1', name: 'BashOutput', input: {} });
    expect(groupText(onlyGroup(m))).toBe('1 action · BashOutput');
  });

  it('an MCP tool is tallied by its chip and label, not the raw name', () => {
    const m = new ConversationModel();
    feed(m, tool('m1', 0, 't1', 'mcp__code-conductor__spawn_instance'));
    expect(groupText(onlyGroup(m))).toBe('1 action · cc: Spawn instance');
  });

  it('an Agent block keeps its sub-conversation, which groups its own run', () => {
    const m = new ConversationModel();
    feed(m, [
      ...tool('m1', 0, 'agent1', 'Agent', { result: null, input: { description: 'd' } }),
      { kind: 'assistant_message', msgId: 's1', parentToolUseId: 'agent1', message: { content: [
        { type: 'thinking', thinking: 'nested pondering' },
        { type: 'tool_use', id: 'sub-t1', name: 'Read', input: {} },
      ] } },
    ]);
    const outer = onlyGroup(m);
    expect(groupText(outer)).toBe('1 action · Agent');
    const agent = outer.children[0] as ToolNode;
    const nested = groupsOf(assistants(agent.sub!)[0])[0];
    expect(groupText(nested)).toBe('2 actions · thinking, Read');
    expect((nested.children[0] as any).buffer).toBe('nested pondering');
  });

  it('an errored tool inside a sub-agent does not count against the outer group', () => {
    const m = new ConversationModel();
    feed(m, [
      ...tool('m1', 0, 'agent1', 'Agent', { result: null }),
      { kind: 'assistant_message', msgId: 's1', parentToolUseId: 'agent1', message: { content: [{ type: 'tool_use', id: 'sub-t1', name: 'Read', input: {} }] } },
      toolResult({ toolUseId: 'sub-t1', parentToolUseId: 'agent1', content: 'nope', isError: true }),
      toolResult({ toolUseId: 'agent1', content: 'done' }),
    ]);
    const outer = onlyGroup(m);
    const agent = outer.children[0] as ToolNode;
    expect(groupText(groupsOf(assistants(agent.sub!)[0])[0])).toBe('1 action · Read · 1 error');
    expect(groupText(outer)).toBe('1 action · Agent');
  });

  it("run-enders fold a sub-agent's groups too, two levels down", () => {
    const m = new ConversationModel();
    feed(m, [
      ...tool('m1', 0, 'a1', 'Agent', { result: null }),
      { kind: 'assistant_message', msgId: 's1', parentToolUseId: 'a1', message: { content: [{ type: 'tool_use', id: 'a2', name: 'Agent', input: {} }] } },
      { kind: 'assistant_message', msgId: 's2', parentToolUseId: 'a2', message: { content: [{ type: 'tool_use', id: 'deep', name: 'Read', input: {} }] } },
    ]);
    const a1 = onlyGroup(m).children[0] as ToolNode;
    const a2 = groupsOf(assistants(a1.sub!)[0])[0].children[0] as ToolNode;
    const deep = groupsOf(assistants(a2.sub!)[0])[0];
    expect(deep.open).toBe(true);
    m.apply(turnEnd());
    expect(deep.open).toBe(false);
  });

  it('an errored orphan tool_result counts toward the error clause', () => {
    const m = new ConversationModel();
    feed(m, [...tool('m1', 0, 't1', 'Bash'), toolResult({ toolUseId: 'nope', content: 'x', isError: true })]);
    expect(groupText(onlyGroup(m))).toBe('2 actions · Bash, tool_result · 1 error');
  });

  it('a tool_result or bare thinking_delta with no head still joins the group', () => {
    const m = new ConversationModel();
    feed(m, [
      toolResult({ toolUseId: 'nohead', content: 'x' }),
      { kind: 'thinking_delta', msgId: 'm1', blockIdx: 0, text: 'cut off mid-block' },
    ]);
    const wrap = assistants(m)[0];
    expect(wrap.children.map((c) => c.type)).toEqual(['group']);
    expect((wrap.children[0] as GroupNode).children.map((c) => c.type)).toEqual(['result', 'thinking']);
  });

  it('a group that left the wrap is replaced, not appended into', () => {
    const m = new ConversationModel();
    feed(m, tool('m1', 0, 'tu1', 'Bash'));
    const wrap = assistants(m)[0];
    const detached = wrap.children[0] as GroupNode;
    wrap.children = [];
    feed(m, tool('m1', 1, 'tu2', 'Read'));
    const fresh = wrap.children[0] as GroupNode;
    expect(fresh).not.toBe(detached);
    expect(fresh.children).toHaveLength(1);
    expect(detached.children).toHaveLength(1);
  });

  describe('yielded results (an interactive tool handed to the user)', () => {
    it('adds no error clause and reads "handed to user"', () => {
      const m = new ConversationModel();
      feed(m, tool('m1', 0, 't1', 'AskUserQuestion', { isError: true, yielded: true }));
      expect(groupText(onlyGroup(m))).toBe('1 action · AskUserQuestion');
      expect((onlyGroup(m).children[0] as ToolNode).status).toBe('handed to user');
    });
    it('the same errored result without the flag still counts', () => {
      const m = new ConversationModel();
      feed(m, tool('m1', 0, 't1', 'AskUserQuestion', { isError: true }));
      expect(groupText(onlyGroup(m))).toBe('1 action · AskUserQuestion · 1 error');
    });
    it('a yielded orphan result is not counted as an error; a real one beside it is', () => {
      const m = new ConversationModel();
      feed(m, [
        toolResult({ toolUseId: 'o1', content: 'x', isError: true, yielded: true }),
        ...tool('m1', 0, 't2', 'Bash', { isError: true }),
      ]);
      expect(groupText(onlyGroup(m))).toBe('2 actions · tool_result, Bash · 1 error');
    });
  });
});
