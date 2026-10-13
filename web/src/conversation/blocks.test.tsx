/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fireEvent } from '@testing-library/react';
import { ConversationModel, type ThinkingNode, type ToolNode } from './model';
import { thinkingLabel } from './tools';
import { assistants, groupsOf, serverModules, toolResult } from './testkit';
import { flush, renderModel } from './renderModel';
import type { UiEventOf } from '@shared/uiEvent';

const thinkingOf = (m: ConversationModel, i = 0) => groupsOf(assistants(m)[0])[0].children[i] as ThinkingNode;
const tokens = (n: number, seq?: number): UiEventOf<'system'> => ({ kind: 'system', subtype: 'thinking_tokens', ...(seq ? { _seq: seq } : {}), data: { estimated_tokens: n, estimated_tokens_delta: n } });

describe('thinking blocks', () => {
  it('a live token count shows while thinking; the last value wins', () => {
    const m = new ConversationModel();
    m.apply({ kind: 'thinking_start', msgId: 't', blockIdx: 0, _seq: 1 });
    expect(thinkingLabel(thinkingOf(m))).toBe('Thinking…');
    m.apply(tokens(100, 2));
    m.apply(tokens(350, 3));
    m.apply(tokens(750, 4));
    expect(thinkingLabel(thinkingOf(m))).toBe('Thinking… 750 tokens');
  });

  it('settles to a char count, not the token count', () => {
    const m = new ConversationModel();
    m.apply({ kind: 'thinking_start', msgId: 't', blockIdx: 0, _seq: 1 });
    m.apply(tokens(300, 2));
    m.apply({ kind: 'thinking_delta', msgId: 't', blockIdx: 0, text: 'because reasons', _seq: 3 });
    m.apply({ kind: 'thinking_end', msgId: 't', blockIdx: 0, _seq: 4 });
    expect(thinkingLabel(thinkingOf(m))).toBe('Thought · 15 chars');
    // The active key is cleared: a later count goes nowhere.
    expect(() => m.apply(tokens(99, 5))).not.toThrow();
    expect(thinkingLabel(thinkingOf(m))).toBe('Thought · 15 chars');
  });

  it('redacted: plain label without tokens, ~N with live or stamped tokens, and later counts are ignored', () => {
    const plain = new ConversationModel();
    plain.apply({ kind: 'thinking_start', msgId: 't', blockIdx: 0, _seq: 1 });
    plain.apply({ kind: 'thinking_redacted', msgId: 't', blockIdx: 0, _seq: 2 });
    plain.apply({ kind: 'thinking_end', msgId: 't', blockIdx: 0, _seq: 3 });
    expect(thinkingLabel(thinkingOf(plain))).toBe('Thinking (redacted)');

    const live = new ConversationModel();
    live.apply({ kind: 'thinking_start', msgId: 't', blockIdx: 0, _seq: 1 });
    for (const n of [50, 200, 300]) live.apply(tokens(n));
    live.apply({ kind: 'thinking_redacted', msgId: 't', blockIdx: 0, estimatedTokens: 300, _seq: 2 });
    live.apply(tokens(999));
    live.apply({ kind: 'thinking_end', msgId: 't', blockIdx: 0, _seq: 3 });

    const replay = new ConversationModel();
    replay.apply({ kind: 'thinking_start', msgId: 't', blockIdx: 0, _seq: 1 });
    replay.apply({ kind: 'thinking_redacted', msgId: 't', blockIdx: 0, estimatedTokens: 300, _seq: 2 });
    replay.apply({ kind: 'thinking_end', msgId: 't', blockIdx: 0, _seq: 3 });
    expect(thinkingLabel(thinkingOf(live))).toBe('Thinking (redacted, ~300 tokens)');
    expect(thinkingLabel(thinkingOf(replay))).toBe(thinkingLabel(thinkingOf(live)));

    const liveOnly = new ConversationModel();
    liveOnly.apply({ kind: 'thinking_start', msgId: 't', blockIdx: 0, _seq: 1 });
    liveOnly.apply(tokens(800, 2));
    liveOnly.apply({ kind: 'thinking_redacted', msgId: 't', blockIdx: 0, _seq: 3 });
    expect(thinkingLabel(thinkingOf(liveOnly))).toBe('Thinking (redacted, ~800 tokens)');
  });

  it('seq-less deltas all append, and per-token deltas equal one coalesced replay delta', () => {
    const live = new ConversationModel();
    live.apply({ kind: 'thinking_start', msgId: 'm', blockIdx: 0, _seq: 1 });
    const parts = ['Let ', 'me ', 'think ', 'about ', 'this'];
    parts.forEach((t, i) => live.apply({ kind: 'thinking_delta', msgId: 'm', blockIdx: 0, text: t, ...(i === 0 ? { _seq: 2 } : {}) }));
    const replay = new ConversationModel();
    replay.apply({ kind: 'thinking_start', msgId: 'm', blockIdx: 0, _seq: 1 });
    replay.apply({ kind: 'thinking_delta', msgId: 'm', blockIdx: 0, text: parts.join(''), _seq: 2 });
    expect(thinkingOf(live).buffer).toBe('Let me think about this');
    expect(thinkingOf(replay).buffer).toBe(thinkingOf(live).buffer);
  });
});

describe('sub-agent nesting', () => {
  it('a depth-2 child routes into the nested sub-conversation, not parked', () => {
    const m = new ConversationModel();
    m.apply({ kind: 'tool_use', msgId: null, blockIdx: 0, toolUseId: 'A', name: 'Agent', input: {}, parentToolUseId: null });
    m.apply({ kind: 'assistant_message', msgId: 'sub', parentToolUseId: 'A', message: { id: 'sub', content: [{ type: 'tool_use', id: 'B', name: 'Agent', input: {} }] } });
    m.apply({ kind: 'text_delta', msgId: 'deep', blockIdx: 0, text: 'deep', parentToolUseId: 'B' });
    m.apply({ kind: 'text_end', msgId: 'deep', blockIdx: 0, parentToolUseId: 'B' });
    expect(m.orphanChildEvents.size).toBe(0);
    const a = m.toolBlocks.get('A')!;
    const b = a.sub!.toolBlocks.get('B')!;
    expect((assistants(b.sub!)[0].children[0] as any).buffer).toBe('deep');
  });

  it('a truly headless child is parked, not rendered', () => {
    const m = new ConversationModel();
    m.apply({ kind: 'text_delta', msgId: 'z', blockIdx: 0, text: 'ghost', parentToolUseId: 'ZZZ' });
    expect(m.orphanChildEvents.has('ZZZ')).toBe(true);
    expect(m.items).toHaveLength(0);
  });

  it('a mistagged child of a non-Agent tool renders at the outer level', () => {
    const m = new ConversationModel();
    m.apply({ kind: 'tool_use', msgId: null, blockIdx: 0, toolUseId: 'bash1', name: 'Bash', input: { command: 'x' } });
    m.apply({ kind: 'user_echo', text: 'stray', parentToolUseId: 'bash1' });
    expect(m.toolBlocks.get('bash1')!.sub).toBeNull();
    expect(m.items.some((i) => i.type === 'user')).toBe(true);
  });

  it('the tool card stays collapsed on child events; a manual open or collapse survives later events; the sub-agent section is its own toggle', async () => {
    const m = new ConversationModel();
    m.apply({ kind: 'tool_use_start', msgId: 'm0', blockIdx: 0, toolUseId: 'A', name: 'Agent' });
    m.apply({ kind: 'tool_use', msgId: 'm0', blockIdx: 0, toolUseId: 'A', name: 'Agent', input: { description: 'search', prompt: 'go' } });
    m.apply({ kind: 'text_delta', msgId: 'c1', blockIdx: 0, text: 'first token', parentToolUseId: 'A' });
    const { root } = renderModel(m);
    await flush();
    const toolTrigger = () => root.querySelector('[data-tool-trigger]') as HTMLElement;
    const subTrigger = () => root.querySelector('[data-sub-trigger]') as HTMLElement;
    expect(toolTrigger().getAttribute('data-state')).toBe('closed');
    expect(subTrigger().getAttribute('data-state')).toBe('open');
    expect(root.textContent).toContain('first token');

    fireEvent.click(toolTrigger());
    m.apply({ kind: 'text_delta', msgId: 'c1', blockIdx: 0, text: ' two', parentToolUseId: 'A' });
    await flush();
    expect(toolTrigger().getAttribute('data-state')).toBe('open');

    fireEvent.click(subTrigger());
    m.apply({ kind: 'assistant_message', msgId: 'c2', parentToolUseId: 'A', message: { id: 'c2', content: [{ type: 'text', text: 'three' }] } });
    m.apply(toolResult({ toolUseId: 'A', content: 'done' }));
    await flush();
    expect(subTrigger().getAttribute('data-state')).toBe('closed');
    expect(toolTrigger().getAttribute('data-state')).toBe('open');
    expect((m.toolBlocks.get('A') as ToolNode).status).toBe('done');
  });
});

describe('replayed fragmented messages', () => {
  it('render two thinking blocks and two attached tool results, not one merged block', async () => {
    const S = await serverModules();
    const CWD = '/tmp/split-blocks-project';
    const SID = 'sess-split-blocks';
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-split-blocks-'));
    const prev = process.env.CLAUDE_PROJECTS_ROOT;
    process.env.CLAUDE_PROJECTS_ROOT = rootDir;
    try {
      const lines = [
        { type: 'user', uuid: 'u0', message: { role: 'user', content: 'do the work' } },
        { type: 'assistant', uuid: 'a0', message: { id: 'm_frag', role: 'assistant', content: [{ type: 'thinking', thinking: 'first thought' }] } },
        { type: 'assistant', uuid: 'a1', message: { id: 'm_frag', role: 'assistant', content: [{ type: 'thinking', thinking: 'second thought' }] } },
        { type: 'assistant', uuid: 'a2', message: { id: 'm_frag', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_a', name: 'Read', input: { file_path: '/a' } }] } },
        { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_a', content: 'aaa', is_error: false }] } },
        { type: 'assistant', uuid: 'a3', message: { id: 'm_frag', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_b', name: 'Read', input: { file_path: '/b' } }] } },
        { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_b', content: 'bbb', is_error: false }] } },
        { type: 'assistant', uuid: 'a4', message: { id: 'm_next', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      ];
      const file = path.join(rootDir, S.encodeCwd(CWD), `${SID}.jsonl`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const result = await S.loadPersistedTranscript({ place: S.localPlace(CWD), sessionId: SID });
      const events = result.lines.flatMap((l: any) => l.events);
      const m = new ConversationModel();
      m.applyEvents(events);
      const g = groupsOf(assistants(m)[0])[0];
      const thinks = g.children.filter((c): c is ThinkingNode => c.type === 'thinking');
      expect(thinks.map((t) => t.buffer)).toEqual(['first thought', 'second thought']);
      const tools = g.children.filter((c): c is ToolNode => c.type === 'tool');
      expect(tools.map((t) => (t.result?.content))).toEqual(['aaa', 'bbb']);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
      else process.env.CLAUDE_PROJECTS_ROOT = prev;
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
