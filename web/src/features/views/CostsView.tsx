import * as React from 'react';
import { ChevronRightIcon, CoinsIcon, RotateCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { projectLabel } from '@shared/conductors';
import { apiFetch } from '@shared/http';
import { formatDuration, fmtCost } from '@shared/usage';
import { cn } from '@/lib/utils';
import { ViewMessage, ViewShell } from './ViewShell';

export type ModelRow = {
  model: string; cost_usd: number; input_tokens: number; output_tokens: number; cache_creation_tokens: number; cache_read_tokens: number;
  tokens_known?: boolean; turns: number; sessions: number; cache_misses: number; duration_api_ms: number; duration_ms: number;
};
export type ProjectRow = {
  project: string; cost_usd: number; turns: number; sessions: number; cache_misses: number; duration_api_ms: number; duration_ms: number; by_model?: ModelRow[];
};
export type CostsSummary = {
  total_usd: number; row_count: number; by_project: ProjectRow[]; by_model: ModelRow[]; daily_trend: { date: string; cost_usd: number }[];
};

export function fmtNum(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

/** A substitution backend reports no summable per-turn tokens: show — rather than a made-up 0. */
export const tokenCell = (m: ModelRow, key: keyof ModelRow) => (m.tokens_known ? fmtNum(m[key] as number) : '—');

const MODEL_HEADERS = ['Model', 'Cost', 'Input', 'Output', 'Cache create', 'Cache read', 'Turns', 'Sessions', 'Cache misses', 'LLM time', 'Walltime'];

export function modelCells(m: ModelRow): string[] {
  return [
    m.model, fmtCost(m.cost_usd), tokenCell(m, 'input_tokens'), tokenCell(m, 'output_tokens'), tokenCell(m, 'cache_creation_tokens'),
    tokenCell(m, 'cache_read_tokens'), String(m.turns), String(m.sessions), String(m.cache_misses), formatDuration(m.duration_api_ms), formatDuration(m.duration_ms),
  ];
}

function Table({ headers, rows, className }: { headers: string[]; rows: string[][]; className?: string }) {
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full min-w-max text-sm tabular-nums">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            {headers.map((h, i) => <th key={h} className={cn('px-3 py-2 font-medium', i > 0 && 'text-right')}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b last:border-b-0">
              {r.map((c, j) => <td key={j} className={cn('px-3 py-2', j === 0 ? 'font-medium' : 'text-right')}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ title, children, description }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** Rounded "nice" axis ticks from 0 to just above max. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

const shortDate = (d: string) => {
  const t = new Date(`${d}T00:00:00`);
  return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const tickMoney = (v: number) => (v === 0 ? '$0' : v < 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(v < 10 ? 1 : 0)}`);

/** Daily spend: one series, one hue, bars on a baseline, hover for the exact figure. */
export function DailyChart({ days }: { days: { date: string; cost_usd: number }[] }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(640);
  const [hover, setHover] = React.useState<number | null>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 200;
  const pad = { l: 44, r: 8, t: 12, b: 24 };
  const max = Math.max(...days.map((d) => d.cost_usd), 0);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const plotW = width - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const slot = plotW / Math.max(days.length, 1);
  const barW = Math.max(2, Math.min(28, slot - 2));
  const y = (v: number) => pad.t + plotH - (v / top) * plotH;
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor(plotW / 56))));
  const r = Math.min(4, barW / 2);
  const hv = hover != null ? days[hover] : null;
  return (
    <div ref={ref} className="relative w-full" onMouseLeave={() => setHover(null)}>
      <svg width={width} height={H} role="img" aria-label={`Daily spend over ${days.length} days, peak ${fmtCost(max)}`} className="block">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} strokeDasharray={t === 0 ? undefined : '2 4'} />
            <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted-foreground)" className="tabular-nums">{tickMoney(t)}</text>
          </g>
        ))}
        {days.map((d, i) => {
          const cx = pad.l + slot * i + slot / 2;
          const h = d.cost_usd > 0 ? Math.max(2, plotH * (d.cost_usd / top)) : 0;
          const x = cx - barW / 2;
          const yy = pad.t + plotH - h;
          const rr = Math.min(r, h);
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${d.date}: ${fmtCost(d.cost_usd)}`}>
              <rect x={pad.l + slot * i} y={pad.t} width={slot} height={plotH} fill="transparent" />
              {h > 0 && (
                <path
                  d={`M${x},${yy + h} V${yy + rr} Q${x},${yy} ${x + rr},${yy} H${x + barW - rr} Q${x + barW},${yy} ${x + barW},${yy + rr} V${yy + h} Z`}
                  fill="var(--primary)"
                  opacity={hover == null || hover === i ? 1 : 0.45}
                />
              )}
              {i % labelEvery === 0 && (
                <text x={cx} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--muted-foreground)">{shortDate(d.date)}</text>
              )}
            </g>
          );
        })}
      </svg>
      {hv && hover != null && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md"
          style={{ left: Math.min(width - 60, Math.max(60, pad.l + slot * hover + slot / 2)), top: y(hv.cost_usd) - 6 }}
        >
          <div className="text-muted-foreground">{shortDate(hv.date)}</div>
          <div className="font-semibold tabular-nums">{fmtCost(hv.cost_usd)}</div>
        </div>
      )}
      <table className="sr-only">
        <caption>Daily spend</caption>
        <tbody>{days.map((d) => <tr key={d.date}><td>{d.date}</td><td>{fmtCost(d.cost_usd)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function ProjectsTable({ rows }: { rows: ProjectRow[] }) {
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const toggle = (p: string) => setOpen((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const heads = ['Project', 'Cost', 'Turns', 'Sessions', 'Cache misses', 'LLM time', 'Walltime'];
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-max text-sm tabular-nums">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              {heads.map((h, i) => <th key={h} className={cn('px-3 py-2 font-medium', i > 0 && 'text-right')}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const isOpen = open.has(p.project);
              return (
                <React.Fragment key={p.project}>
                  <tr className="cursor-pointer border-b hover:bg-muted/40" onClick={() => toggle(p.project)} aria-expanded={isOpen} data-cost-project={p.project}>
                    <td className="px-3 py-2 font-medium">
                      <span className="flex items-center gap-1.5">
                        <ChevronRightIcon className={cn('size-3.5 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
                        {projectLabel(p.project)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">{fmtCost(p.cost_usd)}</td>
                    <td className="px-3 py-2 text-right">{p.turns}</td>
                    <td className="px-3 py-2 text-right">{p.sessions}</td>
                    <td className="px-3 py-2 text-right">{p.cache_misses}</td>
                    <td className="px-3 py-2 text-right">{formatDuration(p.duration_api_ms)}</td>
                    <td className="px-3 py-2 text-right">{formatDuration(p.duration_ms)}</td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b bg-muted/30">
                      <td colSpan={heads.length} className="p-2">
                        <Table headers={MODEL_HEADERS} rows={(p.by_model ?? []).map(modelCells)} className="rounded-lg border bg-card" />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CostsBody({ data }: { data: CostsSummary }) {
  if (data.row_count === 0) {
    return <ViewMessage>No cost data recorded yet. Cost tracking begins with the next turn.</ViewMessage>;
  }
  const llm = data.by_project.reduce((a, p) => a + (p.duration_api_ms ?? 0), 0);
  const sessions = data.by_project.reduce((a, p) => a + (p.sessions ?? 0), 0);
  const peak = data.daily_trend.reduce((a, d) => (d.cost_usd > a.cost_usd ? d : a), data.daily_trend[0] ?? { date: '', cost_usd: 0 });
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4" data-costs-total>
        <Stat label="Total spend" value={fmtCost(data.total_usd)} sub={`across ${data.row_count} turn${data.row_count === 1 ? '' : 's'}`} />
        <Stat label="Sessions" value={String(sessions)} sub={`${data.by_project.length} project${data.by_project.length === 1 ? '' : 's'}`} />
        <Stat label="LLM time" value={formatDuration(llm)} />
        <Stat label="Busiest day" value={peak?.date ? fmtCost(peak.cost_usd) : '—'} sub={peak?.date ? shortDate(peak.date) : undefined} />
      </div>
      {data.daily_trend.length > 0 && (
        <Section title="Daily spend">
          <div className="rounded-xl border bg-card p-3"><DailyChart days={data.daily_trend} /></div>
        </Section>
      )}
      <Section title="By project" description="Tap a project for its per-model breakdown.">
        <ProjectsTable rows={data.by_project} />
      </Section>
      <Section title="By model">
        <Table headers={MODEL_HEADERS} rows={data.by_model.map(modelCells)} className="rounded-xl border bg-card" />
      </Section>
    </div>
  );
}

/** Spend by project, model and day, from the server's per-turn cost log. */
export function CostsView() {
  const [state, setState] = React.useState<{ phase: 'loading' | 'loaded' | 'error'; data?: CostsSummary; error?: string }>({ phase: 'loading' });
  const load = React.useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      setState({ phase: 'loaded', data: await apiFetch<CostsSummary>('/api/costs/summary') });
    } catch (e: any) {
      setState({ phase: 'error', error: e.message });
    }
  }, []);
  React.useEffect(() => { void load(); }, [load]);
  return (
    <ViewShell
      title="Costs"
      subtitle="Spend by project, model and day"
      icon={<CoinsIcon className="size-4" />}
      actions={<Button size="sm" variant="ghost" onClick={() => void load()} aria-label="Refresh"><RotateCwIcon /></Button>}
      data-view="costs"
    >
      {state.phase === 'loading' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>
          <Skeleton className="h-56 rounded-xl" />
        </div>
      ) : state.phase === 'error' ? <ViewMessage tone="error">Failed to load: {state.error}</ViewMessage>
        : <CostsBody data={state.data!} />}
    </ViewShell>
  );
}
