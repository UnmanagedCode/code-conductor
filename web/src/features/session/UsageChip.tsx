import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useStore, useSignal } from '@/state/createStore';
import type { Instance } from '@/state/types';
import {
  formatTokens, formatPct, formatDuration, formatResetTime, rlChipSegment, RL_BUCKET_KEYS, RL_WINDOW_LABEL, fmtCost,
} from '@shared/usage';
import { CLAUDE_BACKEND } from '@shared/models';
import { getUsageTracker, rateLimits, trackerSignal } from '@/app/trackers';
import { accountUsageStore } from '@/app/accountUsage';
import { cn } from '@/lib/utils';

const toneFor = (frac: number | null) =>
  frac == null ? 'text-muted-foreground' : frac < 0.5 ? 'text-success' : frac < 0.8 ? 'text-warning' : 'text-destructive';

function Ring({ frac }: { frac: number | null }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  const f = frac == null ? 0 : Math.min(1, Math.max(0, frac));
  return (
    <svg viewBox="0 0 18 18" className={cn('size-4 -rotate-90', toneFor(frac))} aria-hidden>
      <circle cx={9} cy={9} r={r} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth={2.5} />
      {frac != null && <circle cx={9} cy={9} r={r} fill="none" stroke="currentColor" strokeWidth={2.5} strokeDasharray={c} strokeDashoffset={c * (1 - f)} strokeLinecap="round" />}
    </svg>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-0.5 text-sm">
      <span className="text-muted-foreground">{k}</span>
      <span className={cn('font-medium tabular-nums', tone)}>{v}</span>
    </div>
  );
}

/** Context fill + account rate limit, with the session-totals / usage-limits popover. */
export function UsageChip({ inst }: { inst: Instance }) {
  useSignal(trackerSignal);
  const { usage: account, stale } = useStore(accountUsageStore, (s) => s);
  const usage = getUsageTracker(inst.id);
  const win = inst.contextWindowTokens ?? null;
  const frac: number | null = usage.currentFillPct(win);
  const used: number | null = usage.currentContextSize();
  const rl = rlChipSegment(rateLimits.info, account);
  const c = usage.cum;
  const modelLabel = usage.effectiveModel(inst.modelSwitch?.from ?? inst.model) ?? '(account default)';

  const title = [
    used == null ? 'Context usage appears after the first turn.'
      : frac != null ? `Context: ${used.toLocaleString()}/${(win ?? 0).toLocaleString()} tokens`
      : `Context: ${used.toLocaleString()} tokens used (capacity unknown)`,
    rl.frac != null ? `Rate limit: ${Math.round(rl.frac * 100)}% used` : null,
    rl.isOverage ? 'Overage active' : null,
  ].filter(Boolean).join(' · ');

  const buckets: { label: string; util: number | null; reset: string | null }[] = [];
  if (account) {
    for (const key of RL_BUCKET_KEYS) {
      const b = account[key];
      if (!b) continue;
      buckets.push({
        label: RL_WINDOW_LABEL[key] ?? key,
        util: typeof b.utilization === 'number' ? b.utilization / 100 : null,
        reset: b.resets_at ? formatResetTime(new Date(b.resets_at).getTime() / 1000) : null,
      });
    }
    const fable = account.limits?.find((l: any) => l.scope?.model?.display_name === 'Fable');
    if (fable) {
      buckets.push({
        label: '7-day Fable',
        util: typeof fable.percent === 'number' ? fable.percent / 100 : null,
        reset: fable.resets_at ? formatResetTime(new Date(fable.resets_at).getTime() / 1000) : null,
      });
    }
  }
  const ex = account?.extra_usage;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={title}
          className="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs text-muted-foreground tabular-nums transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Usage details"
          data-usage-chip
        >
          <Ring frac={frac} />
          <span>{used == null || frac == null ? 'ctx —' : formatPct(frac)}</span>
          <span className="text-muted-foreground/50">·</span>
          <span className={toneFor(rl.frac)}>{rl.text.replace(/^rl /, '')}</span>
          {rl.isOverage && <span className="rounded bg-destructive px-1 text-[10px] font-semibold text-white">OVERAGE</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-80">
        <div className="space-y-4">
          <section>
            <div className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Context</div>
            <div className="flex items-center gap-3">
              <Ring frac={frac} />
              <div className="text-sm">
                {used == null ? <span className="text-muted-foreground">Appears after the first turn</span>
                  : <><span className="font-medium tabular-nums">{formatTokens(used)}</span>{win ? <span className="text-muted-foreground"> / {formatTokens(win)} ({formatPct(frac)})</span> : <span className="text-muted-foreground"> used (capacity unknown)</span>}</>}
              </div>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {Number.isFinite(win) && !inst.modelSwitch ? `${modelLabel} · ${formatTokens(win)} context` : modelLabel}
            </div>
          </section>
          <section>
            <div className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Session totals</div>
            {c.turns === 0 ? <div className="text-sm text-muted-foreground">No turns have completed yet.</div> : (() => {
              const totalIn = c.inputTokens + c.cacheRead + c.cacheCreation;
              const hit = totalIn > 0 ? c.cacheRead / totalIn : 0;
              return (
                <>
                  <Row k="Turns" v={String(c.turns)} />
                  <Row k="Duration" v={formatDuration(c.durationMs)} />
                  <Row k="Cost" v={inst.backend && inst.backend !== CLAUDE_BACKEND ? '—' : fmtCost(c.cost)} />
                  <Row k="Input (uncached)" v={formatTokens(c.inputTokens)} />
                  <Row k="Output" v={formatTokens(c.outputTokens)} />
                  <Row k="Cache reads" v={`${formatTokens(c.cacheRead)} (${formatPct(hit)} hit)`} />
                  <Row k="Cache creation" v={formatTokens(c.cacheCreation)} />
                </>
              );
            })()}
          </section>
          <section>
            <div className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Usage limits{account && stale && ' (stale)'}</div>
            {!account ? <div className="text-sm text-muted-foreground">Usage data unavailable.</div> : (
              <div className="space-y-2">
                {buckets.map((b) => (
                  <div key={b.label}>
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="text-muted-foreground">{b.label}</span>
                      <span className={cn('font-medium tabular-nums', toneFor(b.util))}>{b.util != null ? `${Math.round(b.util * 100)}%` : '—'}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className={cn('h-full rounded-full', b.util == null ? '' : b.util < 0.5 ? 'bg-success' : b.util < 0.8 ? 'bg-warning' : 'bg-destructive')} style={{ width: `${Math.min(100, (b.util ?? 0) * 100)}%` }} />
                    </div>
                    {b.reset && <div className="mt-0.5 text-[11px] text-muted-foreground">{b.reset}</div>}
                  </div>
                ))}
                {ex?.is_enabled && (
                  <Row k="Extra credits" v={`${typeof ex.used_credits === 'number' ? (ex.used_credits / 100).toFixed(2) : '?'} / ${typeof ex.monthly_limit === 'number' ? (ex.monthly_limit / 100).toFixed(2) : '?'} ${ex.currency ?? ''}`.trim()} />
                )}
              </div>
            )}
          </section>
        </div>
      </PopoverContent>
    </Popover>
  );
}
