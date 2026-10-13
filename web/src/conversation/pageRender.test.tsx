// Older history renders through the live pipeline: a lineage page becomes the
// same prompt, tool card and reply the live transcript shows; a sub-agent's head
// and children on one page nest; finalizing a page is safe to repeat; and the
// live rendering a page seam must reproduce keeps a turn_end's two runs apart.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, within } from '@testing-library/react';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: () => {} }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { conversation, lazyHistory } from '@/app/controller';
import { appStore } from '@/state/app';
import type { Instance, UiEvent } from '@/state/types';
import { ConversationView } from './ConversationView';
import { ConversationModel, type AssistantNode } from './model';
import { flush, renderModel } from './renderModel';
import { groupsOf, thinking, tool } from './testkit';

const inst = (id: string): Instance => ({ id, project: 'p', status: 'idle', sessionId: `s-${id}`, mode: 'default' });

/** A replayed turn: prompt, a Bash call and its result, then the reply. */
const ARCHIVED_TURN: UiEvent[] = [
  { kind: 'user_echo', text: 'old prompt', userIndex: 3, _seq: 10, parentToolUseId: null },
  { kind: 'tool_use_start', msgId: 'mOld', blockIdx: 0, toolUseId: 'tuOld', name: 'Bash', _seq: 11, parentToolUseId: null },
  { kind: 'tool_use', msgId: 'mOld', blockIdx: 0, toolUseId: 'tuOld', name: 'Bash', input: { command: 'ls' }, _seq: 12, parentToolUseId: null },
  { kind: 'tool_result', toolUseId: 'tuOld', content: 'file.txt', isError: false, _seq: 13, parentToolUseId: null },
  { kind: 'text_delta', msgId: 'mOld', blockIdx: 1, text: 'archived reply', _seq: 14, parentToolUseId: null },
  { kind: 'text_end', msgId: 'mOld', blockIdx: 1, _seq: 15, parentToolUseId: null },
];

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => {
    appStore.set({ instances: [], activeId: null });
    conversation.clear();
    lazyHistory.reset();
  });
});

describe('a lineage page', () => {
  it('renders through the live pipeline: the prompt, the tool card and the reply, and the empty-transcript placeholder gives way', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ events: ARCHIVED_TURN, hasMore: false, segment: null, nextBefore: null, pageSegment: null, currentSegmentId: null }),
    })));
    act(() => { appStore.set({ instances: [inst('i1')], activeId: 'i1' }); });
    const { container } = render(<TooltipProvider><ConversationView empty={<p data-empty-transcript />} /></TooltipProvider>);
    expect(container.querySelector('[data-empty-transcript]'), 'precondition: an empty transcript shows the placeholder').not.toBeNull();
    const scroll = container.querySelector('[data-conversation]') as HTMLElement;
    // happy-dom lays nothing out; auto-fill pages in only while the view is taller than its content.
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => 800 });
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => 0 });
    act(() => { lazyHistory.init({ tailStartSeq: 900 }); });
    await act(async () => {
      for (let i = 0; i < 50 && !scroll.querySelector('[data-item="assistant"]'); i++) await new Promise((r) => setTimeout(r, 5));
    });
    expect(container.querySelector('[data-empty-transcript]')).toBeNull();
    const bubble = scroll.querySelector('[data-item="user"] [data-user-text]') as HTMLElement;
    expect(bubble.textContent).toBe('old prompt');
    const reply = scroll.querySelector('[data-item="assistant"]') as HTMLElement;
    expect(reply.textContent).toContain('archived reply');
    // A historical page's trailing run arrives collapsed; open it to reach the card.
    fireEvent.click(within(reply).getByRole('button', { name: /action/ }));
    await flush();
    expect(reply.querySelectorAll('[data-tool-name="Bash"]').length, 'the tool card renders in the reply').toBe(1);
    expect(bubble.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING, 'the prompt comes first').toBeTruthy();
  });

  it("puts a sub-agent's children inside its Agent card's sub-agent section when head and children share the page, never at the outer level", async () => {
    const page = new ConversationModel().renderPage([
      { kind: 'user_echo', text: 'run task', userIndex: 0, _seq: 0, parentToolUseId: null },
      { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tu1', name: 'Agent', _seq: 1, parentToolUseId: null },
      { kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tu1', name: 'Agent', input: {}, _seq: 2, parentToolUseId: null },
      { kind: 'text_delta', msgId: 'msub', blockIdx: 0, text: 'sub-agent reply', _seq: 3, parentToolUseId: 'tu1' },
      { kind: 'text_end', msgId: 'msub', blockIdx: 0, _seq: 4, parentToolUseId: 'tu1' },
      { kind: 'tool_result', toolUseId: 'tu1', content: 'done', isError: false, _seq: 5, parentToolUseId: null },
    ], null, null);
    expect(page.orphanChildEvents.size, 'nothing parked').toBe(0);
    const { root } = renderModel(page);
    await flush();
    fireEvent.click(within(root).getByRole('button', { name: /action/ }));
    await flush();
    const subTrigger = root.querySelector('[data-sub-trigger]') as HTMLElement;
    expect(subTrigger.getAttribute('data-state'), 'the sub-agent section is open').toBe('open');
    const section = subTrigger.parentElement as HTMLElement;
    expect(section.textContent).toContain('sub-agent reply');
    expect((root.textContent ?? '').split('sub-agent reply').length - 1, 'rendered once, inside the section').toBe(1);
  });

  it('finalizing a page a second time changes nothing the first pass rendered', async () => {
    const m = new ConversationModel();
    for (const ev of [
      { kind: 'user_echo', text: 'cut prompt', userIndex: 0 },
      ...thinking('mg', 0, 'cut off mid').slice(0, 2),
      { kind: 'text_delta', msgId: 'mg', blockIdx: 1, text: 'partial reply' },
      ...tool('mg', 2, 'tu_done', 'Read'),
      { kind: 'tool_use_start', msgId: 'mg', blockIdx: 3, toolUseId: 'tu_cut', name: 'Bash' },
    ] as UiEvent[]) m.apply(ev);
    const { root } = renderModel(m);
    await flush();
    const dangling = root.innerHTML;
    act(() => { m.finalizeDanglingBlocks(); });
    await flush();
    const once = root.innerHTML;
    expect(once, 'fixture check: the first pass finalized the dangling blocks').not.toBe(dangling);
    const rev = m.rev;
    act(() => { m.finalizeDanglingBlocks(); });
    await flush();
    expect(root.innerHTML).toBe(once);
    expect(m.rev, 'and notified nothing').toBe(rev);
  });

  it('the live reference: in one pass, a turn_end between two tool runs renders them as two groups', () => {
    const m = new ConversationModel();
    for (const ev of [...tool('mA', 0, 'tuA', 'Bash'), { kind: 'turn_end', subtype: 'success', parentToolUseId: null }, ...tool('mB', 1, 'tuB', 'Read')] as UiEvent[]) m.apply(ev);
    const groups = (m.items.filter((i) => i.type === 'assistant') as AssistantNode[]).flatMap(groupsOf);
    expect(groups.map((g) => g.children.map((c) => (c.type === 'tool' ? c.name : c.type)))).toEqual([['Bash'], ['Read']]);
  });
});
