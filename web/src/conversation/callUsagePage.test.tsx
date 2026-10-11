import { describe, expect, it } from 'vitest';
import { ConversationModel } from './model';
import { text, tool } from './testkit';
import { flush, renderModel } from './renderModel';
import { CALL_USAGE_TITLE } from './format';

async function pageRendered(events: any[]) {
  const live = new ConversationModel();
  const page = live.renderPage(events, 'seg1', 'seg1');
  live.prependPage(page, null);
  const r = renderModel(live);
  await flush();
  return r.root;
}

const usageLines = (root: HTMLElement) => root.querySelectorAll(`[title="${CALL_USAGE_TITLE.replace(/"/g, '\\"')}"]`);

describe('call usage on a lazily loaded page', () => {
  it('a page without call_usage events renders no usage line; one with them renders one per call', async () => {
    // Invariant: the usage line is content-driven: absent when the page carries no call_usage, present (and one per call) when it does.
    const base = [{ kind: 'user_echo', text: 'go', userIndex: 0 }, ...tool('m1', 0, 'tu1', 'Read'), ...text('m1', 1, 'done'), ...text('m2', 0, 'again')];
    const bare = await pageRendered(base);
    expect(bare.textContent).toContain('done');
    expect(usageLines(bare)).toHaveLength(0);
    const withUsage = await pageRendered([
      ...base,
      { kind: 'call_usage', msgId: 'm1', promptTokens: 61_000, growthTokens: 2_000, outputTokens: 310 },
      { kind: 'call_usage', msgId: 'm2', promptTokens: 63_000, growthTokens: 1_500, outputTokens: 120 },
    ]);
    expect(usageLines(withUsage)).toHaveLength(2);
  });
});
