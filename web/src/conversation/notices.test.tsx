import { describe, expect, it } from 'vitest';
import { ConversationModel, type AssistantNode, type GroupNode } from './model';
import { feed, tool } from './testkit';
import { flush, renderModel } from './renderModel';

async function shown(events: any[]) {
  const m = new ConversationModel();
  feed(m, events);
  const r = renderModel(m);
  await flush();
  return { m, root: r.root };
}

const lines = (root: HTMLElement, subtype: string) => [...root.querySelectorAll(`[data-subtype="${subtype}"]`)];
const sys = (subtype: string, data: any) => ({ kind: 'system', subtype, data });

describe('cache-miss notice', () => {
  it('an eviction and a cold write each add one line carrying their own token count', async () => {
    // Invariant: every cache_miss event is its own notice, and the notice carries the event's token figure
    // (evicted count for a miss on a warm prefix, written count for a cold write), not a constant.
    const evicted = await shown([sys('cache_miss', { prevPrefix: 98_765, cacheRead: 12_345, evicted: 86_420 })]);
    const written = await shown([sys('cache_miss', { cacheCreation: 54_321, cacheRead: 777 })]);
    const e = lines(evicted.root, 'cache_miss');
    const w = lines(written.root, 'cache_miss');
    expect(e).toHaveLength(1);
    expect(w).toHaveLength(1);
    expect(e[0].textContent).toContain((86_420).toLocaleString());
    expect(w[0].textContent).toContain((54_321).toLocaleString());
    expect(e[0].textContent).not.toContain((54_321).toLocaleString());
    expect(w[0].textContent).not.toContain((86_420).toLocaleString());
  });

  it('two misses in one conversation give two lines, one apiece', async () => {
    // Invariant: the notice is per event; a later miss does not replace or merge with an earlier one.
    const { root } = await shown([
      sys('cache_miss', { cacheCreation: 11_111, cacheRead: 0 }),
      sys('cache_miss', { cacheCreation: 22_222, cacheRead: 0 }),
    ]);
    const l = lines(root, 'cache_miss');
    expect(l).toHaveLength(2);
    expect(l[0].textContent).toContain((11_111).toLocaleString());
    expect(l[1].textContent).toContain((22_222).toLocaleString());
  });
});

describe('auto-resume-skipped notice', () => {
  it('each dropped session logs its own line with its reason', async () => {
    // Invariant: one auto_resume_skipped event is one visible line carrying that event's reason; none is merged or lost.
    const { root } = await shown([
      sys('auto_resume_skipped', { reason: 'reason-alpha 3 queued dropped' }),
      sys('auto_resume_skipped', { reason: 'reason-beta 5 queued dropped' }),
    ]);
    const l = lines(root, 'auto_resume_skipped');
    expect(l).toHaveLength(2);
    expect(l[0].textContent).toContain('reason-alpha');
    expect(l[1].textContent).toContain('reason-beta');
  });

  it('a conversation with no such event shows none', async () => {
    // Invariant: control, the line comes from the event and is not always rendered.
    const { root } = await shown([sys('cache_miss', { cacheCreation: 5, cacheRead: 0 })]);
    expect(lines(root, 'auto_resume_skipped')).toHaveLength(0);
  });
});

describe('drained-turn notice', () => {
  it('one drain event is one line and two are two, each carrying its count', async () => {
    // Invariant: the line is per drain_abort event and shows that event's count.
    const one = await shown([sys('drain_abort', { count: 7 })]);
    const two = await shown([sys('drain_abort', { count: 7 }), sys('drain_abort', { count: 9 })]);
    const a = lines(one.root, 'drain_abort');
    const b = lines(two.root, 'drain_abort');
    expect(a).toHaveLength(1);
    expect(a[0].textContent).toContain('7');
    expect(b).toHaveLength(2);
    expect(b[1].textContent).toContain('9');
    expect(lines((await shown([])).root, 'drain_abort')).toHaveLength(0);
  });

  it('does not end the action group the surrounding tool calls share', async () => {
    // Invariant: a drained-turn line between two tool calls leaves them in one group (contrast: an interrupt notice splits them).
    const split = async (mid: any) => {
      const m = new ConversationModel();
      feed(m, [...tool('m1', 0, 't1', 'Read'), mid, ...tool('m2', 0, 't2', 'Grep')]);
      await flush();
      const groups = (m.items.filter((i) => i.type === 'assistant') as AssistantNode[])
        .flatMap((w) => w.children.filter((c): c is GroupNode => c.type === 'group'));
      return groups.length;
    };
    expect(await split(sys('drain_abort', { count: 1 }))).toBe(1);
    expect(await split(sys('soft_interrupted', {}))).toBe(2);
  });
});
