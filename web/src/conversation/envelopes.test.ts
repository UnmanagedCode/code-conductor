import { beforeAll, describe, expect, it } from 'vitest';
import { ConversationModel, type AssistantNode, type GroupNode, type ToolNode, type AssistantChild, type GroupChild } from './model';
import { assistants, groupsOf, serverModules, users } from './testkit';
import { describeToolInput } from './format';

let S: Awaited<ReturnType<typeof serverModules>>;
beforeAll(async () => { S = await serverModules(); });

const se = (event: object) => ({ type: 'stream_event', event });
function feed(m: ConversationModel, frames: any[], parser = new S.Parser()) {
  for (const f of frames) for (const ev of parser.handleObject(f)) m.apply(ev);
  return parser;
}
const toolStream = (_msgId: string, id: string, name: string, json: string, index = 0) => [
  se({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } }),
  se({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } }),
  se({ type: 'content_block_stop', index }),
];
const tools = (w: AssistantNode) => groupsOf(w).flatMap((g) => g.children).filter((c): c is ToolNode => c.type === 'tool');
const flat = (w: AssistantNode): (AssistantChild | GroupChild)[] => w.children.flatMap((c): (AssistantChild | GroupChild)[] => (c.type === 'group' ? (c as GroupNode).children : [c]));

describe('assistant envelopes', () => {
  it('a sub-agent tool_use (no deltas) renders inside the Agent with its result attached', () => {
    const m = new ConversationModel();
    feed(m, [
      se({ type: 'message_start', message: { id: 'msg_outer', role: 'assistant' } }),
      ...toolStream('msg_outer', 'task_xyz', 'Agent', '{"description":"search","prompt":"go"}'),
      { type: 'assistant', parent_tool_use_id: 'task_xyz', message: { id: 'msg_sub', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_grep', name: 'Grep', input: { pattern: 'foo' } }] } },
      { type: 'user', parent_tool_use_id: 'task_xyz', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_grep', content: 'No matches found', is_error: false }] } },
    ]);
    const sub = m.toolBlocks.get('task_xyz')!.sub!;
    const [grep] = tools(assistants(sub)[0]);
    expect(grep.name).toBe('Grep');
    expect(describeToolInput(grep.name, grep.input)).toMatch(/foo/);
    expect(grep.result!.content).toBe('No matches found');
    expect(flat(assistants(sub)[0]).filter((c) => c.type === 'result')).toHaveLength(0);
  });

  it('a Bash result mistagged with a parent_tool_use_id attaches to the Bash call, no sub-agent panel', () => {
    const m = new ConversationModel();
    feed(m, [
      se({ type: 'message_start', message: { id: 'msg_bash', role: 'assistant' } }),
      ...toolStream('msg_bash', 'tu_bash_1', 'Bash', '{"command":"npm test 2>&1"}'),
      { type: 'user', parent_tool_use_id: 'tu_bash_1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_bash_1', content: '# pass 45', is_error: false }] } },
    ]);
    const bash = m.toolBlocks.get('tu_bash_1')!;
    expect(bash.sub).toBeNull();
    expect(bash.result!.content).toContain('# pass 45');
    expect(tools(assistants(m)[0])).toHaveLength(1);
  });

  it('parallel sub-agent tool_uses split across same-msgId envelopes both render with results attached', () => {
    const m = new ConversationModel();
    feed(m, [
      se({ type: 'message_start', message: { id: 'msg_outer', role: 'assistant' } }),
      ...toolStream('msg_outer', 'task_xyz', 'Agent', '{"description":"x"}'),
      { type: 'assistant', parent_tool_use_id: 'task_xyz', message: { id: 'msg_sub_shared', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_a', name: 'Bash', input: { command: 'ls /a' } }] } },
      { type: 'assistant', parent_tool_use_id: 'task_xyz', message: { id: 'msg_sub_shared', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_b', name: 'Bash', input: { command: 'ls /b' } }] } },
      { type: 'user', parent_tool_use_id: 'task_xyz', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_a', content: 'A out' }] } },
      { type: 'user', parent_tool_use_id: 'task_xyz', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_b', content: 'B out' }] } },
    ]);
    const ts = tools(assistants(m.toolBlocks.get('task_xyz')!.sub!)[0]);
    expect(ts.map((t) => t.result?.content)).toEqual(['A out', 'B out']);
  });

  it('sequential outer tool_uses sharing one msgId all render with their results attached', () => {
    const m = new ConversationModel();
    const id = 'msg_shared';
    const step = (tid: string, name: string, json: string, out: string) => [
      se({ type: 'message_start', message: { id, role: 'assistant' } }),
      ...toolStream(id, tid, name, json),
      se({ type: 'message_stop' }),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: out, is_error: false }] } },
    ];
    feed(m, [...step('tu_bash', 'Bash', '{"command":"ls"}', 'scenario-basic.json'), ...step('tu_ga', 'Grep', '{"pattern":"a"}', 'No files found'), ...step('tu_gb', 'Grep', '{"pattern":"b"}', 'none')]);
    const w = assistants(m)[0];
    expect(tools(w).map((t) => [t.name, t.result?.content])).toEqual([['Bash', 'scenario-basic.json'], ['Grep', 'No files found'], ['Grep', 'none']]);
    expect(flat(w).filter((c) => c.type === 'result')).toHaveLength(0);
  });

  it('the outer assistant envelope is a no-op: nothing duplicated, the streamed tool stays as it was', () => {
    const m = new ConversationModel();
    const id = 'msg_dup';
    feed(m, [
      se({ type: 'message_start', message: { id, role: 'assistant' } }),
      se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'planning' } }),
      se({ type: 'content_block_stop', index: 0 }),
      se({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
      se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Let me write the plan file.' } }),
      se({ type: 'content_block_stop', index: 1 }),
      ...toolStream(id, 'tu_write', 'Write', '{"file_path":"/tmp/plan.md","content":"hi"}', 2),
      se({ type: 'message_stop' }),
      { type: 'assistant', message: { id, role: 'assistant', content: [
        { type: 'thinking', thinking: 'planning' },
        { type: 'text', text: 'Let me write the plan file.' },
        { type: 'tool_use', id: 'tu_write', name: 'Write', input: { file_path: '/tmp/plan.md', content: 'hi' } },
      ] } },
    ]);
    const all = flat(assistants(m)[0]);
    expect(all.filter((c) => c.type === 'tool')).toHaveLength(1);
    expect(all.filter((c) => c.type === 'text')).toHaveLength(1);
    expect(all.filter((c) => c.type === 'thinking')).toHaveLength(1);
    expect(m.toolBlocks.get('tu_write')!.status).toBe('running');
  });

  it('async-worker per-block envelopes with a sandwiched result: one bubble, ordered blocks, results on their own tools', () => {
    const m = new ConversationModel();
    const id = 'msg_async';
    feed(m, [
      se({ type: 'message_start', message: { id, role: 'assistant' } }),
      se({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading both files.' } }),
      { type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text: 'Reading both files.' }] } },
      se({ type: 'content_block_stop', index: 0 }),
      se({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_r1', name: 'Read', input: {} } }),
      se({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/a"}' } }),
      { type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'tool_use', id: 'tu_r1', name: 'Read', input: { file_path: '/a' } }] } },
      se({ type: 'content_block_stop', index: 1 }),
      se({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu_r2', name: 'Read', input: {} } }),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_r1', content: 'contents of a', is_error: false }] } },
      se({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/b"}' } }),
      { type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'tool_use', id: 'tu_r2', name: 'Read', input: { file_path: '/b' } }] } },
      se({ type: 'content_block_stop', index: 2 }),
      se({ type: 'message_stop' }),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_r2', content: 'contents of b', is_error: false }] } },
    ]);
    expect(assistants(m)).toHaveLength(1);
    expect(flat(assistants(m)[0]).map((c) => c.type)).toEqual(['text', 'tool', 'tool']);
    expect(tools(assistants(m)[0]).map((t) => t.result?.content)).toEqual(['contents of a', 'contents of b']);
  });

  it('a streaming tool already summarizes its command from the partial JSON', () => {
    const m = new ConversationModel();
    feed(m, [
      se({ type: 'message_start', message: { id: 'mid', role: 'assistant' } }),
      se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_x', name: 'Bash', input: {} } }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"echo hi"}' } }),
    ]);
    const t = m.toolBlocks.get('tu_x')!;
    expect(t.status).toBe('streaming');
    expect(describeToolInput(t.name, t.input)).toBe('echo hi');
  });

  it('consecutive assistant turns group into one envelope; a user echo reopens it; a sub-agent groups its own turns', () => {
    const m = new ConversationModel();
    const turn = (id: string, tid: string) => [
      se({ type: 'message_start', message: { id, role: 'assistant' } }),
      ...toolStream(id, tid, 'Bash', '{"command":"date"}'),
      se({ type: 'message_stop' }),
    ];
    const p = feed(m, [...turn('msg_one', 't1'), ...turn('msg_two', 't2')]);
    expect(assistants(m)).toHaveLength(1);
    expect(tools(assistants(m)[0])).toHaveLength(2);
    m.apply({ kind: 'user_echo', text: 'hi again', attachments: [] });
    feed(m, turn('msg_three', 't3'), p);
    expect(assistants(m)).toHaveLength(2);
    expect(users(m)).toHaveLength(1);

    const a = new ConversationModel();
    feed(a, [
      se({ type: 'message_start', message: { id: 'msg_outer', role: 'assistant' } }),
      ...toolStream('msg_outer', 'tu_task', 'Agent', '{"description":"go"}'),
      se({ type: 'message_stop' }),
      { type: 'assistant', parent_tool_use_id: 'tu_task', message: { id: 's1', role: 'assistant', content: [{ type: 'tool_use', id: 'x1', name: 'Read', input: {} }] } },
      { type: 'assistant', parent_tool_use_id: 'tu_task', message: { id: 's2', role: 'assistant', content: [{ type: 'tool_use', id: 'x2', name: 'Grep', input: {} }] } },
    ]);
    const sub = a.toolBlocks.get('tu_task')!.sub!;
    expect(assistants(sub)).toHaveLength(1);
    expect(tools(assistants(sub)[0]).map((t) => t.name)).toEqual(['Read', 'Grep']);
  });

  it('empty thinking renders as redacted; assistant text finalizes for markdown on text_end', () => {
    const m = new ConversationModel();
    m.apply({ kind: 'assistant_message', msgId: 'x', blockIdx: 0, message: {} }); // outer envelope: ignored
    const sub = new ConversationModel({ isSub: true });
    sub.apply({ kind: 'assistant_message', msgId: 's', blockIdx: 0, message: { content: [{ type: 'thinking', thinking: '' }] } });
    expect(groupsOf(assistants(sub)[0])[0].children[0]).toMatchObject({ type: 'thinking', redacted: true });
    m.apply({ kind: 'text_delta', msgId: 'm', blockIdx: 0, text: 'see https://example.com' });
    expect(assistants(m)[0].children[0]).toMatchObject({ finalized: false });
    m.apply({ kind: 'text_end', msgId: 'm', blockIdx: 0 });
    expect(assistants(m)[0].children[0]).toMatchObject({ finalized: true });
  });
});
