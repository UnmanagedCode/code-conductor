import * as React from 'react';
import { BarChart3Icon, FileTextIcon, LoaderCircleIcon, PencilIcon, RefreshCwIcon, ScissorsIcon, SparklesIcon, TriangleAlertIcon, CheckIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Markdown } from '@/components/Markdown';
import { useStore } from '@/state/createStore';
import { apiFetch } from '@shared/http';
import { fmtCost, formatDuration, formatTokens } from '@shared/usage';
import { refreshInstances } from '@/app/controller';
import { applySessionTitle } from '@/app/sessionActions';
import { isCallUsageShown, setCallUsageShown, uiStore } from '@/app/ui';
import { toast } from '@/ui/feedback';
import { cn } from '@/lib/utils';
import { focusContent } from '@/lib/modalFocus';
import { closeDialog, dialogStore } from './api';
import { CheckRow } from './SpawnDialog';
import { FormError } from './FormError';
import { computeSavings, defaultCut, type PruneAnalysis } from './pruneMath';
import { useOpenKey } from './useOpenKey';

// ── Summary ──────────────────────────────────────────────────────────────

export const SUMMARY_TIERS = ['title', 'short', 'medium', 'long'] as const;
type Tier = (typeof SUMMARY_TIERS)[number];
type TierData = { summary: string; isStale?: boolean };
type SummaryData = Partial<Record<Tier, TierData>>;

/** The tier to show after a load: the preferred one if cached, else medium, else the first cached. */
export function pickTier(data: SummaryData, prefer: Tier | null, current: Tier): Tier {
  const target = prefer ?? current;
  if (data[target]) return target;
  if (data.medium) return 'medium';
  return SUMMARY_TIERS.find((l) => data[l]) ?? 'medium';
}

function SummaryBody({ sessionId }: { sessionId: string }) {
  const [data, setData] = React.useState<SummaryData | null>(null);
  const [tier, setTier] = React.useState<Tier>('medium');
  const [loading, setLoading] = React.useState(true);
  const [generating, setGenerating] = React.useState(false);
  const [error, setError] = React.useState('');
  const [cost, setCost] = React.useState<number | null>(null);
  const [applied, setApplied] = React.useState<'idle' | 'busy' | 'done'>('idle');

  React.useEffect(() => {
    let live = true;
    (async () => {
      try {
        const body = await apiFetch<any>(`/api/sessions/${encodeURIComponent(sessionId)}/summary`);
        if (!live) return;
        setData(body?.data ?? {});
        setTier((cur) => pickTier(body?.data ?? {}, null, cur));
      } catch (e: any) {
        if (live) setError(`Failed to load: ${e.message}`);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [sessionId]);

  async function generate() {
    setGenerating(true);
    setError('');
    setCost(null);
    try {
      const body = await apiFetch<any>(`/api/sessions/${encodeURIComponent(sessionId)}/summary`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ length: tier }),
      });
      setCost(typeof body?.costUsd === 'number' ? body.costUsd : null);
      setData(body?.data ?? {});
      setTier((cur) => pickTier(body?.data ?? {}, cur, cur));
      setApplied('idle');
    } catch (e: any) {
      setError(`Generation failed: ${e.message}`);
    } finally {
      setGenerating(false);
    }
  }

  async function useAsTitle() {
    const title = data?.title?.summary;
    if (!title) return;
    setApplied('busy');
    setError('');
    try {
      await applySessionTitle(sessionId, title);
      setApplied('done');
    } catch (e: any) {
      setError(`Failed to set the title: ${e.message}`);
      setApplied('idle');
    }
  }

  const current = data?.[tier] ?? null;
  return (
    <div className="grid min-h-0 gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><FileTextIcon className="size-5 text-primary" /> Session summary</DialogTitle>
        <DialogDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {current?.isStale && <span className="flex items-center gap-1 text-warning" data-stale><TriangleAlertIcon className="size-3.5" />The session has grown since this summary</span>}
          {cost != null && <span data-cost>Cost: {fmtCost(cost)}</span>}
        </DialogDescription>
      </DialogHeader>
      <div className="inline-flex w-fit rounded-lg bg-muted p-0.5 text-sm" role="group" aria-label="Summary length">
        {SUMMARY_TIERS.map((t) => (
          <button
            key={t}
            type="button"
            data-len={t}
            aria-pressed={t === tier}
            disabled={generating}
            onClick={() => { setCost(null); setError(''); setTier(t); }}
            className={cn('rounded-md px-3 py-1 capitalize transition-colors', t === tier ? 'bg-background font-medium shadow-xs dark:bg-input/40' : 'text-muted-foreground hover:text-foreground')}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="max-h-[50dvh] min-h-24 overflow-y-auto rounded-xl border bg-muted/20 p-4" data-summary-content>
        {loading ? (
          <div className="grid gap-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /></div>
        ) : current ? (
          <Markdown text={current.summary} />
        ) : (
          <p className="text-sm text-muted-foreground">No {tier} summary yet. Generate one; it runs a short model pass on this session's transcript.</p>
        )}
      </div>
      <FormError>{error}</FormError>
      <DialogFooter>
        {tier === 'title' && current && (
          <Button variant="outline" onClick={() => void useAsTitle()} disabled={applied !== 'idle'}>
            {applied === 'done' ? <><CheckIcon /> Applied</> : <><PencilIcon /> Use as session title</>}
          </Button>
        )}
        <Button onClick={() => void generate()} disabled={loading || generating}>
          {generating ? <LoaderCircleIcon className="animate-spin" /> : current ? <RefreshCwIcon /> : <SparklesIcon />}
          {generating ? 'Generating…' : current ? 'Regenerate' : 'Generate summary'}
        </Button>
      </DialogFooter>
    </div>
  );
}

export function SummaryDialog() {
  const slot = useStore(dialogStore, (s) => s.summary);
  const key = useOpenKey(slot);
  return (
    <Dialog open={!!slot} onOpenChange={(o) => { if (!o) closeDialog('summary'); }}>
      {slot && <DialogContent className="sm:max-w-2xl" data-dialog="summary" onOpenAutoFocus={focusContent}><SummaryBody key={key} sessionId={slot.sessionId} /></DialogContent>}
    </Dialog>
  );
}

// ── Statistics ───────────────────────────────────────────────────────────

type CostRow = { cost_usd?: number; duration_ms?: number; duration_api_ms?: number; turns?: number };
type Stats = { own: CostRow; rolled: CostRow; workerSessions?: number };

export const STAT_METRICS: [string, (m: CostRow) => string][] = [
  ['Cost', (m) => fmtCost(m.cost_usd)],
  ['LLM time', (m) => formatDuration(m.duration_api_ms)],
  ['Turn walltime', (m) => formatDuration(m.duration_ms)],
];

function StatsBody({ sessionId }: { sessionId: string }) {
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [error, setError] = React.useState('');
  useStore(uiStore, (s) => s.callUsageShown);
  const callUsage = isCallUsageShown(sessionId);

  React.useEffect(() => {
    let live = true;
    (async () => {
      try {
        const body = await apiFetch<any>(`/api/costs/session/${encodeURIComponent(sessionId)}`);
        if (live) setStats(body ?? {});
      } catch (e: any) {
        if (live) setError(`Failed to load: ${e.message}`);
      }
    })();
    return () => { live = false; };
  }, [sessionId]);

  const workers = stats?.workerSessions ?? 0;
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><BarChart3Icon className="size-5 text-primary" /> Session statistics</DialogTitle>
        <DialogDescription>Spend and time for this session{workers > 0 ? ', and rolled up across the workers it spawned' : ''}.</DialogDescription>
      </DialogHeader>
      {stats ? (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm" data-stats-table>
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium" />
                <th className="px-3 py-2 text-right font-medium">This session</th>
                {workers > 0 && <th className="px-3 py-2 text-right font-medium">Incl. {workers} worker{workers === 1 ? '' : 's'}</th>}
              </tr>
            </thead>
            <tbody>
              {STAT_METRICS.map(([label, fmt]) => (
                <tr key={label} className="border-t">
                  <td className="px-3 py-2 text-muted-foreground">{label}</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{fmt(stats.own ?? {})}</td>
                  {workers > 0 && <td className="px-3 py-2 text-right font-medium tabular-nums">{fmt(stats.rolled ?? {})}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !error ? (
        <div className="grid gap-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
      ) : null}
      {stats && workers === 0 && <p className="text-xs text-muted-foreground">No worker sessions were spawned from this session.</p>}
      <FormError>{error}</FormError>
      <CheckRow
        id="stats-call-usage"
        checked={callUsage}
        onChange={(v) => setCallUsageShown(sessionId, v)}
        label="Show mid-turn statistics"
        hint="Adds each API call's prompt size and output to the transcript."
      />
      <DialogFooter><Button variant="outline" onClick={() => closeDialog('stats')}>Close</Button></DialogFooter>
    </div>
  );
}

export function StatsDialog() {
  const slot = useStore(dialogStore, (s) => s.stats);
  const key = useOpenKey(slot);
  return (
    <Dialog open={!!slot} onOpenChange={(o) => { if (!o) closeDialog('stats'); }}>
      {slot && <DialogContent className="sm:max-w-lg" data-dialog="stats" onOpenAutoFocus={focusContent}><StatsBody key={key} sessionId={slot.sessionId} /></DialogContent>}
    </Dialog>
  );
}

// ── Prune ────────────────────────────────────────────────────────────────

/** The savings table's rows, as label/value pairs. */
export function savingsRows(analysis: PruneAnalysis | null, s: ReturnType<typeof computeSavings>): [string, string][] {
  const tokens = (n: number) => `~${formatTokens(n)} tokens`;
  const encrypted = analysis ? Math.round(analysis.encryptedThinking * analysis.calibration.factor) : 0;
  return [
    ['Thinking', s.thinking === 0 && encrypted > 0 ? `n/a, stored encrypted (~${formatTokens(encrypted)} in context, kept)` : tokens(s.thinking)],
    ['Tool inputs', tokens(s.toolInputs)],
    ['Tool outputs', tokens(s.toolOutputs)],
    ...(s.exempt > 0 ? [['Kept: orchestration calls (exempt)', tokens(s.exempt)] as [string, string]] : []),
    ['Estimated total saved', tokens(s.total)],
  ];
}

/** The note under the table: share of the ctx chip's reading, calibration, sub-agent exclusion. */
export function savingsNote(analysis: PruneAnalysis, total: number) {
  const ctx = analysis.contextTokens;
  return (ctx > 0
    ? `~${Math.round((total / ctx) * 100)}% of the current context (${formatTokens(ctx)} tokens, the context chip's reading). `
    : "No current context reading yet. It returns after the session's next turn. ")
    + (analysis.calibration.calibrated ? "Calibrated against this session's real token usage. " : 'Uncalibrated estimate: not enough usage history yet. ')
    + "Sub-agent transcripts are excluded; they are not in this session's context.";
}

function PruneBody({ instanceId }: { instanceId: string }) {
  const [analysis, setAnalysis] = React.useState<PruneAnalysis | null>(null);
  const [cut, setCut] = React.useState(0);
  const [pruneThinking, setPruneThinking] = React.useState(true);
  const [minimal, setMinimal] = React.useState(false);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    (async () => {
      try {
        const a: PruneAnalysis = await apiFetch(`/api/instances/${encodeURIComponent(instanceId)}/prune/analysis`);
        if (!live) return;
        if (a.turnCount < 1) { setError('Nothing to prune yet. This session has no completed turns.'); return; }
        setAnalysis(a);
        setCut(defaultCut(a.turnCount));
      } catch (e: any) {
        if (live) setError(`Could not analyse this session: ${e.message}`);
      }
    })();
    return () => { live = false; };
  }, [instanceId]);

  const s = computeSavings(analysis, { cut, pruneThinking, minimal });

  async function apply() {
    if (!analysis || busy) return;
    setBusy(true);
    setError('');
    try {
      await apiFetch(`/api/instances/${encodeURIComponent(instanceId)}/prune`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cutTurnIndex: cut, pruneThinking, inputMode: minimal ? 'minimal' : 'truncate' }),
      });
      await refreshInstances();
      toast.success('Context pruned', 'The original session is archived and stays resumable.');
      closeDialog('prune');
    } catch (e: any) {
      setError(`Prune failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><ScissorsIcon className="size-5 text-primary" /> Prune context</DialogTitle>
        <DialogDescription>
          Rewrites a copy of this session with old tool payloads replaced by size stubs. Questions and orchestration calls are kept intact. No model pass and no token cost; the original session is archived and stays resumable.
        </DialogDescription>
      </DialogHeader>
      {analysis ? (
        <>
          <div className="grid gap-2">
            <div className="flex items-baseline justify-between text-sm">
              <Label htmlFor="pd-cut">Prune the oldest turns</Label>
              <span className="font-medium tabular-nums" data-cut-label>{cut} of {analysis.turnCount}</span>
            </div>
            <input
              id="pd-cut"
              type="range"
              min={0}
              max={analysis.turnCount}
              step={1}
              value={cut}
              onChange={(e) => setCut(Number(e.target.value))}
              className="w-full accent-[var(--primary)]"
            />
          </div>
          <CheckRow id="pd-thinking" checked={pruneThinking} onChange={setPruneThinking} label="Prune all thinking blocks" hint="Every turn, not just the pruned ones." />
          <CheckRow id="pd-minimal" checked={minimal} onChange={setMinimal} label="Minimal tool inputs" hint="Squeezes any value over 80 characters to a size marker. The default keeps the first 500 characters, so short inputs don't shrink at all." />
          <div className="overflow-hidden rounded-xl border">
            <table className="w-full text-sm" data-savings>
              <tbody>
                {savingsRows(analysis, s).map(([label, value], i, all) => (
                  <tr key={label} className={cn('border-t first:border-t-0', i === all.length - 1 && 'bg-muted/40 font-medium')}>
                    <td className="px-3 py-2 text-muted-foreground">{label}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground" data-savings-note>{savingsNote(analysis, s.total)}</p>
        </>
      ) : !error ? (
        <div className="grid gap-2"><p className="text-sm text-muted-foreground">Analysing the session…</p><Skeleton className="h-24 w-full" /></div>
      ) : null}
      <FormError>{error}</FormError>
      <DialogFooter>
        <Button variant="ghost" onClick={() => closeDialog('prune')}>Cancel</Button>
        <Button onClick={() => void apply()} disabled={busy || !analysis || s.total <= 0}>
          {busy ? <LoaderCircleIcon className="animate-spin" /> : <ScissorsIcon />}{busy ? 'Pruning…' : 'Prune'}
        </Button>
      </DialogFooter>
    </div>
  );
}

export function PruneDialog() {
  const slot = useStore(dialogStore, (s) => s.prune);
  const key = useOpenKey(slot);
  return (
    <Dialog open={!!slot} onOpenChange={(o) => { if (!o) closeDialog('prune'); }}>
      {slot && <DialogContent className="sm:max-w-lg" data-dialog="prune" onOpenAutoFocus={focusContent}><PruneBody key={key} instanceId={slot.instanceId} /></DialogContent>}
    </Dialog>
  );
}

// ── Rename ───────────────────────────────────────────────────────────────

function RenameBody({ sessionId, current }: { sessionId: string; current: string }) {
  const [title, setTitle] = React.useState(current);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function save() {
    const next = title.trim().slice(0, 100);
    if (next === current.trim()) { closeDialog('rename'); return; }
    setBusy(true);
    setError('');
    try {
      await applySessionTitle(sessionId, next);
      closeDialog('rename');
    } catch (e: any) {
      setError(`Rename failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <DialogHeader>
        <DialogTitle>Rename session</DialogTitle>
        <DialogDescription>Leave it empty to go back to the project name.</DialogDescription>
      </DialogHeader>
      <Input id="rename-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} autoFocus onFocus={(e) => e.currentTarget.select()} placeholder="Session title" aria-label="Session title" />
      <FormError>{error}</FormError>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => closeDialog('rename')}>Cancel</Button>
        <Button type="submit" disabled={busy}>{busy && <LoaderCircleIcon className="animate-spin" />}Save</Button>
      </DialogFooter>
    </form>
  );
}

export function RenameDialog() {
  const slot = useStore(dialogStore, (s) => s.rename);
  const key = useOpenKey(slot);
  return (
    <Dialog open={!!slot} onOpenChange={(o) => { if (!o) closeDialog('rename'); }}>
      {slot && <DialogContent className="sm:max-w-md" data-dialog="rename"><RenameBody key={key} sessionId={slot.sessionId} current={slot.current} /></DialogContent>}
    </Dialog>
  );
}
