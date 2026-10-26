// The transcript's markdown (assistant text with read-aloud off and on, and a user bubble) applies the view-link policy.
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { voiceStore } from '@/features/voice/store';
import { routeStore, syncRoute } from '@/state/route';
import { clickLink } from '@/test/linkClick';
import { ConversationModel } from './model';
import { flush, renderModel } from './renderModel';
import { text } from './testkit';

const SRC = '[▶ Open review](#plugin/code-review/?review=r-9) and [docs](https://example.com)';

beforeEach(() => {
  history.replaceState(null, '', '/#session=sess-1');
  syncRoute();
});
afterEach(() => {
  cleanup();
  act(() => { voiceStore.set({ ttsAvailable: false }); });
});

async function show(m: ConversationModel) {
  const { root } = renderModel(m);
  await flush();
  return root;
}

function expectPolicy(root: HTMLElement) {
  const view = root.querySelector('a[href^="#plugin/"]') as HTMLAnchorElement;
  expect(view, 'the view link').not.toBeNull();
  expect(view.hasAttribute('target')).toBe(false);
  const ext = root.querySelector('a[href="https://example.com"]')!;
  expect(ext.getAttribute('target')).toBe('_blank');
  expect(clickLink(view)).toBe(true);
  expect(routeStore.get().route).toMatchObject({ view: 'plugin', pluginId: 'code-review', pluginPath: '?review=r-9' });
}

describe('view links in the transcript', () => {
  // Pins: assistant text keeps the policy on both render paths (plain, and the read-aloud slot render).
  it.each([{ tts: false }, { tts: true }])('assistant text with read-aloud $tts', async ({ tts }) => {
    act(() => { voiceStore.set({ ttsAvailable: tts }); });
    const m = new ConversationModel();
    m.applyEvents(text('m1', 0, SRC));
    expectPolicy(await show(m));
  });

  // Pins: a user bubble's markdown applies the same policy.
  it('a user message', async () => {
    const m = new ConversationModel();
    m.applyEvents([{ kind: 'user_echo', text: SRC, userIndex: 0 }]);
    expectPolicy(await show(m));
  });
});
