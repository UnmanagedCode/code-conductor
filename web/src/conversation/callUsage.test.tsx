import { describe, expect, it } from 'vitest';
import { ConversationModel, type AssistantNode, type GroupNode } from './model';
import { feed, groupText, text, thinking, tool } from './testkit';
import { isCallUsageShown, setCallUsageShown, uiStore } from '@/app/ui';

const usage = (msgId: string) => ({ kind: 'call_usage', msgId, promptTokens: 40_000, growthTokens: 1_000, outputTokens: 200 });

describe('per-call usage lines', () => {
  it('after a thinking + parallel-tool call the line joins the open group, and the tally ignores it', () => {
    const m = new ConversationModel();
    feed(m, [...thinking('m1', 0), ...tool('m1', 1, 't1', 'Read'), ...tool('m1', 2, 't2', 'Grep'), usage('m1')]);
    const g = (m.items[0] as AssistantNode).children[0] as GroupNode;
    expect(g.children.map((c) => c.type)).toEqual(['thinking', 'tool', 'tool', 'call_usage']);
    expect(groupText(g)).toBe('3 actions · thinking, Read, Grep');
  });

  it('after a call ending in text the line goes in the body after the text, opening no group; the next call\'s tools join one run', () => {
    const m = new ConversationModel();
    feed(m, [...text('m1', 0, 'answer'), usage('m1'), ...tool('m2', 0, 't1', 'Bash'), usage('m2'), ...tool('m3', 0, 't2', 'Read')]);
    const w = m.items[0] as AssistantNode;
    expect(w.children.map((c) => c.type)).toEqual(['text', 'call_usage', 'group']);
    expect((w.children[2] as GroupNode).children.map((c) => c.type)).toEqual(['tool', 'call_usage', 'tool']);
  });

  it('a line for an unknown call creates nothing', () => {
    const m = new ConversationModel();
    m.apply(usage('nowhere'));
    expect(m.items).toHaveLength(0);
  });

  it('the setting is per session, defaults off, and a session with no id is never shown', () => {
    uiStore.set({ callUsageShown: {} });
    expect(isCallUsageShown('A')).toBe(false);
    setCallUsageShown('A', true);
    expect(isCallUsageShown('A')).toBe(true);
    expect(isCallUsageShown('B')).toBe(false);
    setCallUsageShown(null, true);
    expect(isCallUsageShown(null)).toBe(false);
    setCallUsageShown('A', false);
    expect(isCallUsageShown('A')).toBe(false);
  });
});

describe('replayed context readings', () => {
  it('a replayed message_start leaves the conversation unchanged and the transcript empty', () => {
    const m = new ConversationModel();
    m.apply({ kind: 'message_start', msgId: 'm1', usage: { input_tokens: 10 }, _seq: 1 });
    expect(m.items).toHaveLength(0);
  });
});
