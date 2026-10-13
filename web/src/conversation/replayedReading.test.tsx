// The context reading a replay re-sends: a resume or rewind ends its history replay
// with a message_start that reuses the newest replayed message's id and carries only
// its usage, live and without a sequence number. It moves the header's context
// reading and changes nothing in the transcript, and the empty-transcript
// placeholder gives way only to real content.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: () => {} }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { bus } from '@shared/ws';
import { conversation, lazyHistory, startController, stopController } from '@/app/controller';
import { getUsageTracker } from '@/app/trackers';
import { appStore } from '@/state/app';
import type { Instance } from '@/state/types';
import type { UiEvent } from '@shared/uiEvent';
import { ConversationView } from './ConversationView';
import { flush } from './renderModel';

const inst = (id: string): Instance => ({ id, project: 'p', status: 'idle', sessionId: `s-${id}`, mode: 'default' });
/** The replay's closing reading, as the server sends it after a resume or rewind. */
const REPLAYED_START: UiEvent = {
  kind: 'message_start', msgId: 'm_new', replayed: true, parentToolUseId: null,
  usage: { input_tokens: 2, cache_read_input_tokens: 46_396, cache_creation_input_tokens: 0, output_tokens: 500 },
};

async function frame(type: string, detail: object) {
  act(() => { bus.dispatchEvent(new CustomEvent(type, { detail })); });
  await flush();
}
const live = (ev: UiEvent) => frame('event', { id: 'i1', ev });
const reading = () => getUsageTracker('i1').currentContextSize();

beforeEach(() => {
  // The snapshot's history probe: an empty last page.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ events: [], hasMore: false, segment: null, nextBefore: null }) })));
  act(() => { appStore.set({ instances: [inst('i1')], activeId: 'i1' }); });
  startController();
});

afterEach(() => {
  stopController();
  vi.unstubAllGlobals();
  act(() => {
    appStore.set({ instances: [], activeId: null });
    conversation.clear();
    lazyHistory.reset();
  });
});

describe('a replayed message_start', () => {
  it('moves the context reading and leaves the transcript exactly as it was, though it reuses the replayed message id', async () => {
    const { container } = render(<TooltipProvider><ConversationView /></TooltipProvider>);
    const root = container.querySelector('[data-conversation]') as HTMLElement;
    await frame('snapshot', { id: 'i1', events: [
      { kind: 'user_echo', text: 'go', userIndex: 0, _seq: 1 },
      { kind: 'text_delta', msgId: 'm_new', blockIdx: 0, text: 'an answer', _seq: 2 },
      { kind: 'text_end', msgId: 'm_new', blockIdx: 0, _seq: 3 },
    ] });
    const html = root.innerHTML;
    const rev = conversation.rev;
    const items = [...conversation.items];
    expect(reading(), 'precondition: no reading yet').toBeNull();

    await live(REPLAYED_START);
    expect(reading(), 'positive control: the frame reached the client').toBe(46_398);
    expect(conversation.rev).toBe(rev);
    expect(conversation.items).toEqual(items);
    expect(root.innerHTML).toBe(html);
    expect(root.querySelectorAll('[data-item="assistant"]')).toHaveLength(1);

    await live({ kind: 'text_delta', msgId: 'm_new', blockIdx: 1, text: 'more' });
    expect(conversation.rev, 'sensitivity: content on the same message id does change it').not.toBe(rev);
    expect(root.innerHTML, 'sensitivity: and its render').not.toBe(html);
  });

  it('leaves the empty-transcript placeholder in place; real content clears it', async () => {
    const { container } = render(<TooltipProvider><ConversationView empty={<p data-empty-transcript />} /></TooltipProvider>);
    await frame('snapshot', { id: 'i1', events: [] });
    // The snapshot's history probe settles (an empty last page) before the placeholder shows.
    await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5)); });
    expect(reading(), 'precondition: no reading yet').toBeNull();
    expect(container.querySelector('[data-empty-transcript]'), 'precondition: an empty transcript shows it').not.toBeNull();
    await live(REPLAYED_START);
    expect(reading(), 'positive control: the frame reached the client').toBe(46_398);
    expect(container.querySelector('[data-empty-transcript]')).not.toBeNull();
    await live({ kind: 'user_echo', text: 'go', userIndex: 0 });
    expect(container.querySelector('[data-empty-transcript]')).toBeNull();
  });
});
