import { describe, expect, it } from 'vitest';
import { ConversationModel } from './model';
import { feed, shape, text, tool } from './testkit';
import { flush, renderModel } from './renderModel';
import { systemLine } from './format';

const R = 1792285200;
const rl = (over: Record<string, unknown> = {}): any => ({
  kind: 'system',
  subtype: 'rate_limit_event',
  data: { rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.68, resetsAt: R, ...over } },
});

async function shown(events: any[]) {
  const m = new ConversationModel();
  feed(m, events);
  const r = renderModel(m);
  await flush();
  return { m, root: r.root };
}

const lines = (root: HTMLElement) => [...root.querySelectorAll('[data-subtype="rate_limit_event"]')];

describe('usage divider de-duplication', () => {
  it('two adjacent identical usage lines render once', async () => {
    // Invariant: a usage line that renders the same as the one directly above it is not shown again.
    const { root } = await shown([rl(), rl()]);
    const l = lines(root);
    expect(l).toHaveLength(1);
    expect(l[0].textContent).toContain('68%');
  });

  it("a tool loop's per-call usage reports render once under its group", async () => {
    // Invariant: the notices a tool loop piles up under one assistant envelope collapse to one pill.
    const { m, root } = await shown([
      ...tool('m1', 0, 't1', 'Bash'), rl(),
      ...tool('m2', 0, 't2', 'Bash'), rl(),
      ...tool('m3', 0, 't3', 'Bash'), rl(),
    ]);
    expect(shape(m)).toEqual(['assistant', 'system', 'system', 'system']);
    expect(lines(root)).toHaveLength(1);
  });

  it('identical usage lines separated by other content both render', async () => {
    // Invariant: only directly adjacent repeats collapse; an item between them keeps both.
    const { m, root } = await shown([rl(), ...text('m1', 0, 'between'), rl()]);
    expect(shape(m)).toEqual(['system', 'assistant', 'system']);
    expect(lines(root)).toHaveLength(2);
  });

  it.each([
    ['utilization', { utilization: 0.71 }],
    ['reset time', { resetsAt: R + 3600 }],
    ['window', { rateLimitType: 'five_hour' }],
  ])('adjacent usage lines differing in %s both render', async (_name, over) => {
    // Invariant: any difference in the rendered line keeps the two separate.
    const { root } = await shown([rl(), rl(over)]);
    const l = lines(root);
    expect(l).toHaveLength(2);
    expect(l[0].textContent).not.toBe(l[1].textContent);
  });

  describe('only usage lines take part', () => {
    const pillText = () => systemLine(rl()).text;
    const stderr = () => ({ kind: 'system', subtype: 'stderr', data: { line: pillText() } });
    const count = (root: HTMLElement, subtype: string) => root.querySelectorAll(`[data-subtype="${subtype}"]`).length;

    it('a non-usage line above an identical-looking pill does not hide the pill', async () => {
      // Invariant: the predecessor must itself be a usage line to suppress the pill.
      const { root } = await shown([stderr(), rl()]);
      expect(count(root, 'rate_limit_event')).toBe(1);
    });

    it('a non-usage line below an identical-looking pill is not hidden', async () => {
      // Invariant: the line being hidden must itself be a usage line; the pill above does not suppress it.
      const { root } = await shown([rl(), stderr()]);
      expect(count(root, 'rate_limit_event')).toBe(1);
      expect(count(root, 'stderr')).toBe(1);
    });
  });

  it('the first pill of a run stays mounted when an identical repeat arrives', async () => {
    // Invariant: the kept pill is the first of the run (same element, no remount), not the latest.
    const m = new ConversationModel();
    feed(m, [rl()]);
    const { root } = renderModel(m);
    await flush();
    const first = lines(root)[0];
    expect(first).toBeDefined();
    feed(m, [rl()]);
    await flush();
    expect(lines(root)).toHaveLength(1);
    expect(lines(root)[0]).toBe(first);
  });
});
