import { describe, expect, it } from 'vitest';
import { RateLimitTracker, RL_BUCKET_KEYS, UsageTracker, rlChipSegment } from '@/lib/core/usage.js';

const M1 = 'claude-haiku-4-5';
const M2 = 'claude-opus-4-8';
const OLD_USAGE = { input_tokens: 10_000, cache_read_input_tokens: 180_000 };
const NEW_USAGE = { input_tokens: 20_000, cache_read_input_tokens: 400_000 };
const DELTA_USAGE = { input_tokens: 60_000 };
const rl = (fields: object) => ({ kind: 'system', subtype: 'rate_limit_event', data: { rate_limit_info: fields } });

describe('context reading (UsageTracker)', () => {
  it('model_changed drops the reading but keeps cumulative totals and adopts the new model', () => {
    const t = new UsageTracker();
    t.apply({ kind: 'message_start', model: M1, usage: OLD_USAGE });
    t.apply({ kind: 'turn_end', usage: { input_tokens: 5, output_tokens: 7 }, costDelta: 0.5, durationMs: 1000 });
    expect(t.currentContextSize()).toBe(190_000);
    const cum = { ...t.cum! };
    t.apply({ kind: 'system', subtype: 'model_changed', data: { from: M1, to: M2 } });
    expect(t.currentContextSize()).toBeNull();
    expect(t.effectiveModel()).toBe(M2);
    expect(t.cum).toEqual(cum);
  });

  it('the next usage-bearing frame of either kind restores the reading', () => {
    for (const next of [{ kind: 'message_start', model: M2, usage: NEW_USAGE }, { kind: 'context_usage', usage: NEW_USAGE }]) {
      const t = new UsageTracker();
      t.apply({ kind: 'message_start', model: M1, usage: OLD_USAGE });
      t.apply({ kind: 'system', subtype: 'model_changed', data: { from: M1, to: M2 } });
      t.apply(next);
      expect(t.currentContextSize()).toBe(420_000);
    }
  });

  it('a model_changed without `to` still drops the reading and keeps the model', () => {
    const t = new UsageTracker();
    t.apply({ kind: 'message_start', model: M1, usage: OLD_USAGE });
    t.apply({ kind: 'system', subtype: 'model_changed', data: {} });
    expect(t.currentContextSize()).toBeNull();
    expect(t.effectiveModel()).toBe(M1);
  });

  it('a replayed restart divider keeps the seeded reading; a live one drops it', () => {
    const t = new UsageTracker();
    t.seedContext(NEW_USAGE);
    t.apply({ kind: 'system', subtype: 'model_changed', data: { from: M1, to: M2, restart: true }, replayed: true });
    expect(t.currentContextSize()).toBe(420_000);
    expect(t.model).toBe(M2);
    t.apply({ kind: 'system', subtype: 'model_changed', data: { from: M1, to: M2, restart: true } });
    expect(t.currentContextSize()).toBeNull();
  });

  it('context_usage latches the reading without counting a turn; turn_end never clobbers it; a null block leaves it', () => {
    const t = new UsageTracker();
    t.apply({ kind: 'context_usage', usage: DELTA_USAGE });
    expect(t.currentContextSize()).toBe(60_000);
    expect(t.cum!.turns).toBe(0);
    t.apply({ kind: 'turn_end', usage: { input_tokens: 9_000_000, cache_read_input_tokens: 7_000_000 } });
    expect(t.currentContextSize()).toBe(60_000);
    expect(t.cum!.turns).toBe(1);
    t.apply({ kind: 'context_usage', usage: null });
    expect(t.currentContextSize()).toBe(60_000);
  });
});

describe('rate limits', () => {
  it('events from any session merge into one account-wide tracker; later values win', () => {
    const t = new RateLimitTracker();
    t.apply(rl({ rateLimitType: 'five_hour', utilization: 0.45, resetsAt: 1000 }));
    t.apply(rl({ rateLimitType: 'five_hour', utilization: 0.6, resetsAt: 1100 }));
    expect(t.info).toMatchObject({ rateLimitType: 'five_hour', utilization: 0.6, resetsAt: 1100 });
  });

  it('a sparse or null-bearing message never clobbers good fields; overage survives a re-fetch', () => {
    const t = new RateLimitTracker();
    t.apply(rl({ rateLimitType: 'five_hour', utilization: 0.45, resetsAt: 9999, isUsingOverage: false }));
    t.apply(rl({ isUsingOverage: true }));
    t.apply(rl({ utilization: null, resetsAt: 10_000 }));
    expect(t.info).toEqual({ rateLimitType: 'five_hour', utilization: 0.45, resetsAt: 10_000, isUsingOverage: true });
    t.apply(rl({ rateLimitType: 'five_hour', utilization: 0.96 }));
    expect(t.info!.isUsingOverage).toBe(true);
  });

  it('ignores unrelated events', () => {
    const t = new RateLimitTracker();
    for (const ev of [{ kind: 'turn_end', usage: {} }, { kind: 'message_start', usage: {} }, { kind: 'system', subtype: 'init', data: {} }]) t.apply(ev);
    expect(t.info).toBeNull();
  });

  it('the chip segment: utilization as a percentage, overage flagged, placeholders when unknown', () => {
    expect(rlChipSegment({ rateLimitType: 'five_hour', utilization: 0.9 }, null)).toEqual({ text: 'rl 5h 90%', frac: 0.9, isOverage: false });
    expect(rlChipSegment({ rateLimitType: 'five_hour' }, null)).toMatchObject({ text: 'rl 5h --', frac: null });
    expect(rlChipSegment({ rateLimitType: 'five_hour', utilization: 0.5, isUsingOverage: true }, null).isOverage).toBe(true);
    expect(rlChipSegment(null, { five_hour: { utilization: 67 } })).toMatchObject({ text: 'rl 5h 67%', frac: 0.67 });
    expect(rlChipSegment(null, { seven_day: { utilization: 90 } }).text).toBe('rl 7d 90%');
    expect(rlChipSegment(null, { seven_day_sonnet: { utilization: 10 } }).text).toBe('rl 7d Sonnet 10%');
    expect(rlChipSegment(null, { five_hour: null })).toEqual({ text: 'rl --', frac: null, isOverage: false });
    expect(rlChipSegment(null, null)).toEqual({ text: 'rl --', frac: null, isOverage: false });
    expect(RL_BUCKET_KEYS[0]).toBe('five_hour');
  });
});
