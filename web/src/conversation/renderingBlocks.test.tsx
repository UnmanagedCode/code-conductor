/// <reference types="node" />
import { beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, within } from '@testing-library/react';
import { ConversationModel } from './model';
import { serverModules, type ServerParser } from './testkit';
import { flush, renderModel } from './renderModel';

let S: Awaited<ReturnType<typeof serverModules>>;
beforeAll(async () => { S = await serverModules(); });

const se = (event: any) => ({ type: 'stream_event', event });
const startMsg = (id: string) => se({ type: 'message_start', message: { id, role: 'assistant' } });

/** Feed raw CLI frames through the server's parser into a model, rendering after each step when asked. */
function pump(m: ConversationModel, p: ServerParser, frames: any[]) {
  for (const f of frames) for (const ev of p.handleObject(f)) m.apply(ev);
}

describe('nested sub-agent rows', () => {
  it('a tool call made by a sub-agent renders with the same name hook and server chip title as an outer one', async () => {
    // Invariant: a row nested under an Agent block goes through the same tool-name renderer: it carries the raw name hook and the raw-name title that marks a chip.
    const RAW = 'mcp__code-conductor__code-kanban__move_card';
    const m = new ConversationModel();
    m.apply({ kind: 'tool_use_start', msgId: 'o1', blockIdx: 0, toolUseId: 'A', name: 'Agent' });
    m.apply({ kind: 'tool_use', msgId: 'o1', blockIdx: 0, toolUseId: 'A', name: 'Agent', input: { description: 'd', prompt: 'p' } });
    m.apply({ kind: 'assistant_message', msgId: 'c1', parentToolUseId: 'A', message: { id: 'c1', content: [{ type: 'tool_use', id: 'kb1', name: RAW, input: { cardId: 'c1' } }, { type: 'tool_use', id: 'rd1', name: 'Read', input: { file_path: '/x' } }] } });
    const { root } = renderModel(m);
    await flush();
    const sub = root.querySelector('[data-sub-trigger]')!;
    expect(sub.getAttribute('data-state')).toBe('open');
    const nested = [...root.querySelectorAll('[data-tool-name]')].filter((n) => n.getAttribute('data-tool-name') !== 'Agent');
    expect(nested.map((n) => n.getAttribute('data-tool-name')).sort()).toEqual([RAW, 'Read'].sort());
    expect(root.querySelector(`[data-tool-name="${RAW}"]`)!.getAttribute('title')).toBe(RAW);
    // control: a plain built-in nested row carries no chip title
    expect(root.querySelector('[data-tool-name="Read"]')!.hasAttribute('title')).toBe(false);
  });
});

describe('redacted thinking', () => {
  const redactedOf = (root: HTMLElement) => root.querySelectorAll('[data-thinking="redacted"]');

  async function run(frames: any[]) {
    const m = new ConversationModel();
    const p = new S.Parser();
    pump(m, p, frames);
    const r = renderModel(m);
    await flush();
    // The thinking block sits in the turn's action group; open it.
    const group = within(r.root).getByRole('button', { name: /action/i });
    if (group.getAttribute('data-state') === 'closed') fireEvent.click(group);
    await flush();
    return r.root;
  }
  const textBlock = (idx: number, body: string) => [
    se({ type: 'content_block_start', index: idx, content_block: { type: 'text' } }),
    se({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: body } }),
    se({ type: 'content_block_stop', index: idx }),
  ];

  it('a signature-only thinking block is one static line: no expand control, no char count', async () => {
    // Invariant: redacted thinking is a single non-expandable line (marker present, no collapsible trigger).
    const root = await run([
      startMsg('r1'),
      se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_q9' } }),
      se({ type: 'content_block_stop', index: 0 }),
      ...textBlock(1, 'visible answer'),
      se({ type: 'message_stop' }),
    ]);
    expect(redactedOf(root)).toHaveLength(1);
    expect(root.querySelector('[data-thinking="summary"]')).toBeNull();
    expect(root.querySelector('[data-thinking="redacted"] button, [data-thinking="redacted"] summary')).toBeNull();
    expect(root.textContent).toContain('visible answer');
  });

  it('a stream of empty thinking deltas ends redacted, not as an empty expandable thought', async () => {
    // Invariant: the parser drops empty thinking deltas so the block takes the redacted path (not an empty expandable thought).
    const empty = (_n: number) => se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } });
    const root = await run([
      startMsg('r2'),
      se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      empty(1), empty(2), empty(3),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_z' } }),
      se({ type: 'content_block_stop', index: 0 }),
      ...textBlock(1, 'ok'),
      se({ type: 'message_stop' }),
    ]);
    expect(redactedOf(root)).toHaveLength(1);
    expect(root.querySelector('[data-thinking="summary"]')).toBeNull();
  });

  it('control: a thinking block with real text is expandable, not redacted', async () => {
    // Invariant: the redacted marker is content-driven; real thinking text keeps its expand control.
    const root = await run([
      startMsg('r3'),
      se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'first half, ' } }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'second half' } }),
      se({ type: 'content_block_stop', index: 0 }),
      ...textBlock(1, 'ok'),
      se({ type: 'message_stop' }),
    ]);
    expect(redactedOf(root)).toHaveLength(0);
    const trigger = root.querySelector('[data-thinking="summary"]') as HTMLElement;
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger);
    await flush();
    expect(root.textContent).toContain('first half, second half');
  });
});

describe('assistant text finalised on text_end', () => {
  it('stays plain while streaming, then renders markdown with an autolinked URL and trailing punctuation outside the link', async () => {
    // Invariant: raw deltas show verbatim until text_end; the finalised block is markdown: emphasis becomes an element and a bare URL becomes a link to it.
    const m = new ConversationModel();
    const p = new S.Parser();
    pump(m, p, [
      startMsg('t1'),
      se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'See **bold** and ' } }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'https://example.org/page here.' } }),
    ]);
    const { root } = renderModel(m);
    await flush();
    expect(root.querySelector('a')).toBeNull();
    expect(root.querySelector('strong')).toBeNull();
    expect(root.textContent).toContain('See **bold** and https://example.org/page here.');

    pump(m, p, [se({ type: 'content_block_stop', index: 0 })]);
    await flush();
    const a = within(root).getByRole('link');
    expect(a.getAttribute('href')).toBe('https://example.org/page');
    expect(root.querySelector('strong')!.textContent).toBe('bold');
    expect(root.textContent).toMatch(/here\.$/);
    expect(a.textContent).not.toMatch(/\.$/);
  });
});
