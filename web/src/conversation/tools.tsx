import * as React from 'react';
import {
  BrainIcon, ChevronRightIcon, FileTextIcon, PencilLineIcon, TerminalIcon, SearchIcon, GlobeIcon,
  BotIcon, ListTodoIcon, FilePlusIcon, NotebookPenIcon, WrenchIcon, CircleCheckIcon, CircleAlertIcon,
  LoaderCircleIcon, HandIcon, CircleDashedIcon, SendIcon, SparklesIcon, PlugIcon, CornerDownRightIcon,
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/CopyButton';
import { formatToolName, toolNamePlain } from '@shared/toolName';
import { lineDiff, diffStats } from '@shared/diff';
import { formatTokens } from '@shared/usage';
import { cn } from '@/lib/utils';
import type { ConversationModel, GroupChild, GroupNode, ResultNode, ThinkingNode, ToolNode, CallUsageNode } from './model';
import { CALL_USAGE_TITLE, callUsageText, describeToolInput, formatElapsed, renderKindFor, splitResultContent, type DescribeCtx } from './format';
import { ImageZoom } from './ImageZoom';

export type RenderCtx = {
  model: ConversationModel;
  describeCtx: DescribeCtx;
  /** Renders a nested sub-agent conversation (avoids an import cycle with items.tsx). */
  renderSub: (sub: ConversationModel) => React.ReactNode;
};

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Bash: TerminalIcon,
  Read: FileTextIcon,
  Edit: PencilLineIcon,
  Write: FilePlusIcon,
  NotebookEdit: NotebookPenIcon,
  Glob: SearchIcon,
  Grep: SearchIcon,
  WebFetch: GlobeIcon,
  WebSearch: GlobeIcon,
  ToolSearch: SearchIcon,
  Agent: BotIcon,
  Skill: SparklesIcon,
  TaskCreate: ListTodoIcon,
  TaskUpdate: ListTodoIcon,
  TodoWrite: ListTodoIcon,
  'mcp__code-conductor__send_prompt': SendIcon,
};

function toolIcon(name: string) {
  const kind = renderKindFor(name);
  if (ICONS[kind]) return ICONS[kind];
  if (ICONS[name]) return ICONS[name];
  return name?.startsWith('mcp__') ? PlugIcon : WrenchIcon;
}

export function ToolName({ raw }: { raw: string }) {
  const { chip, kind, label } = formatToolName(raw);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 font-medium" title={chip ? raw : undefined} data-tool-name={raw}>
      {chip && (
        <span className={cn(
          'rounded px-1 py-px font-mono text-[10px] leading-4 font-medium',
          kind === 'cc' ? 'bg-primary/12 text-primary' : kind === 'plugin' ? 'bg-plan/12 text-plan' : 'bg-info/12 text-info',
        )}>{chip}</span>
      )}
      <span className="truncate">{label}</span>
    </span>
  );
}

/** Re-render every second while `active`. */
function useTicker(active: boolean) {
  const [, setN] = React.useState(0);
  React.useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
}

// ── Action group ─────────────────────────────────────────────────────────

const AG_MAX_PARTS = 4;

function groupLabel(c: GroupChild): string | null {
  if (c.type === 'tool') return toolNamePlain(c.name);
  if (c.type === 'thinking') return 'thinking';
  if (c.type === 'result') return 'tool_result';
  return null; // call-usage lines are not actions
}

function groupErrored(c: GroupChild) {
  if (c.type === 'result') return c.isError && !c.yielded;
  if (c.type === 'tool') return !!c.result && c.result.isError && !c.result.yielded;
  return false;
}

export function summarizeGroup(g: GroupNode) {
  const counts = new Map<string, number>();
  let n = 0;
  let errors = 0;
  let running = 0;
  for (const c of g.children) {
    const label = groupLabel(c);
    if (!label) continue;
    n += 1;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    if (groupErrored(c)) errors += 1;
    if (c.type === 'tool' && (c.status === 'running' || c.status === 'streaming')) running += 1;
  }
  const parts = [...counts].map(([label, k]) => ({ label, k }));
  return { n, parts: parts.slice(0, AG_MAX_PARTS), more: Math.max(0, parts.length - AG_MAX_PARTS), errors, running };
}

export const ActionGroup = React.memo(function ActionGroup({ node, ctx }: { node: GroupNode; rev: number; ctx: RenderCtx }) {
  const s = summarizeGroup(node);
  return (
    <Collapsible
      open={node.open}
      onOpenChange={(o) => ctx.model.setGroupOpen(node, o)}
      className="overflow-hidden rounded-xl border bg-card/60"
    >
      <CollapsibleTrigger data-group-trigger className="group/ag flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50">
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/ag:rotate-90" />
        <span className="shrink-0 font-medium whitespace-nowrap">{s.n} action{s.n === 1 ? '' : 's'}</span>
        <span className="hidden min-w-0 flex-1 flex-wrap gap-1 sm:flex">
          {s.parts.map(({ label, k }) => (
            <Badge key={label} variant="secondary" className="max-w-48 font-normal">
              <span className="truncate">{label}</span>{k > 1 && <span className="opacity-70">×{k}</span>}
            </Badge>
          ))}
          {s.more > 0 && <Badge variant="outline" className="font-normal">+{s.more} more</Badge>}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs">
          {s.errors > 0 && <span className="flex items-center gap-1 text-destructive"><CircleAlertIcon className="size-3.5" />{s.errors} error{s.errors === 1 ? '' : 's'}</span>}
          {s.running > 0 ? <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" /> : s.errors === 0 && <CircleCheckIcon className="size-4 text-success" />}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="divide-y border-t">
          {node.children.map((c) => <GroupChildView key={c.id} node={c} rev={c.rev} ctx={ctx} />)}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}, (a, b) => a.node === b.node && a.rev === b.rev);

export const GroupChildView = React.memo(function GroupChildView({ node, ctx }: { node: GroupChild; rev: number; ctx: RenderCtx }) {
  switch (node.type) {
    case 'tool': return <ToolBlock node={node} ctx={ctx} />;
    case 'thinking': return <div className="px-3 py-2"><ThinkingBlock node={node} model={ctx.model} /></div>;
    case 'result': return <div className="px-3 py-2"><ResultBlock node={node} model={ctx.model} /></div>;
    case 'call_usage': return <CallUsageLine node={node} />;
  }
}, (a, b) => a.node === b.node && a.rev === b.rev);

export function CallUsageLine({ node }: { node: CallUsageNode }) {
  return (
    <div className="px-3 py-1 font-mono text-[11px] text-muted-foreground tabular-nums" title={CALL_USAGE_TITLE} data-call-usage-line>
      {callUsageText(node.ev)}
    </div>
  );
}

// ── Thinking ─────────────────────────────────────────────────────────────

/** The thinking block's one-line label: live token count, char count once settled, or redacted. */
export function thinkingLabel(node: ThinkingNode): string {
  if (node.redacted) return `Thinking (redacted${node.tokens > 0 ? `, ~${node.tokens.toLocaleString()} tokens` : ''})`;
  if (node.finalized) return `Thought · ${node.buffer.length.toLocaleString()} chars`;
  return node.tokens > 0 ? `Thinking… ${node.tokens.toLocaleString()} tokens` : 'Thinking…';
}

export function ThinkingBlock({ node, model }: { node: ThinkingNode; model: ConversationModel }) {
  if (node.redacted) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-thinking="redacted">
        <BrainIcon className="size-3.5" />
        {thinkingLabel(node)}
      </div>
    );
  }
  return (
    <Collapsible open={node.reader.open} onOpenChange={(o) => model.setReader(node, { open: o })}>
      <CollapsibleTrigger className="group/think flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground" data-thinking="summary">
        <BrainIcon className={cn('size-3.5', !node.finalized && 'animate-pulse text-plan')} />
        {thinkingLabel(node)}
        <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/think:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 border-l-2 border-plan/40 pl-3 text-sm whitespace-pre-wrap text-muted-foreground">
        {node.buffer}
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── Tool block ───────────────────────────────────────────────────────────

const STATUS_ICON: Record<string, React.ReactNode> = {
  streaming: <CircleDashedIcon className="size-3.5 animate-pulse text-muted-foreground" />,
  running: <LoaderCircleIcon className="size-3.5 animate-spin text-info" />,
  done: <CircleCheckIcon className="size-3.5 text-success" />,
  errored: <CircleAlertIcon className="size-3.5 text-destructive" />,
  'handed to user': <HandIcon className="size-3.5 text-warning" />,
  incomplete: <CircleDashedIcon className="size-3.5 text-muted-foreground" />,
};

function ToolBlock({ node, ctx }: { node: ToolNode; ctx: RenderCtx }) {
  useTicker(node.status === 'running' && !!node.startedAt);
  const Icon = toolIcon(node.name);
  const desc = node.input ? describeToolInput(node.name, node.input, ctx.describeCtx) : '';
  const time = node.status === 'running' && node.startedAt
    ? formatElapsed(Date.now() - node.startedAt)
    : node.elapsedMs ? formatElapsed(node.elapsedMs) : null;
  const args = renderArgs(node, ctx.model);
  return (
    <Collapsible open={node.reader.open} onOpenChange={(o) => ctx.model.setReader(node, { open: o })} className="px-3 py-2">
      <CollapsibleTrigger data-tool-trigger className="group/tool flex w-full min-w-0 flex-wrap items-center gap-2 text-left text-sm sm:flex-nowrap">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <ToolName raw={node.name} />
        {desc && <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" data-tool-desc>{desc}</span>}
        {!desc && <span className="flex-1" />}
        {node.agentUsage && (
          <span className="order-last basis-full pl-5.5 text-[11px] text-muted-foreground sm:order-none sm:basis-auto sm:shrink-0 sm:pl-0" data-agent-usage title="The subagent's own context when it finished (its last call's prompt + output). A separate context window, not part of this session's figures.">
            subagent {formatTokens(node.agentUsage.tokens)} ctx{node.agentUsage.toolUses != null && ` · ${node.agentUsage.toolUses} tool use${node.agentUsage.toolUses === 1 ? '' : 's'}`}
          </span>
        )}
        {time && <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{time}</span>}
        <span className="shrink-0" title={node.status}>{STATUS_ICON[node.status]}</span>
        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/tool:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-2">
        {args}
        {node.result && <ResultBlock node={node.result} model={ctx.model} />}
      </CollapsibleContent>
      {node.sub && (
        <Collapsible open={node.reader.subOpen} onOpenChange={(o) => ctx.model.setReader(node, { subOpen: o })} className="mt-2 rounded-lg border border-dashed bg-background/60">
          <CollapsibleTrigger data-sub-trigger className="group/sub flex w-full items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            <CornerDownRightIcon className="size-3.5" /> Sub-agent
            <ChevronRightIcon className="ml-auto size-3 transition-transform group-data-[state=open]/sub:rotate-90" />
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 border-t px-3 py-3">{ctx.renderSub(node.sub)}</CollapsibleContent>
        </Collapsible>
      )}
    </Collapsible>
  );
}

function CommandBox({ text }: { text: string }) {
  return (
    <div className="group/cmd relative rounded-lg bg-muted/70">
      <CopyButton getText={() => text} label="Copy command" className="absolute top-1 right-1 opacity-0 group-hover/cmd:opacity-100 [@media(hover:none)]:opacity-100" />
      <pre className="overflow-x-auto py-2 pr-10 pl-3 font-mono text-xs leading-5 whitespace-pre-wrap">{text}</pre>
    </div>
  );
}

type DiffLine = { type: 'add' | 'del' | 'ctx'; text: string; marker?: string };

export function DiffTable({ head, stats, lines }: { head: string; stats: string; lines: DiffLine[] }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/50 px-3 py-1.5 text-xs">
        <span className="truncate font-mono">{head}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{stats}</span>
      </div>
      <div className="max-h-96 overflow-auto py-1 font-mono text-xs leading-5">
        {lines.map((l, i) => (
          <div key={i} className={cn('flex min-w-max', l.type === 'add' && 'bg-success/12', l.type === 'del' && 'bg-destructive/10')}>
            <span className={cn('w-10 shrink-0 pr-2 text-right text-muted-foreground/70 select-none', l.type === 'add' && 'text-success', l.type === 'del' && 'text-destructive')}>
              {l.marker ?? (l.type === 'add' ? '+' : l.type === 'del' ? '−' : '')}
            </span>
            <span className="pr-3 whitespace-pre">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const opType = (op: string): DiffLine['type'] => (op === '+' ? 'add' : op === '-' ? 'del' : 'ctx');

function renderArgs(node: ToolNode, model: ConversationModel): React.ReactNode {
  const input = node.input;
  if (input) {
    const kind = renderKindFor(node.name);
    if (kind === 'Bash' && typeof input.command === 'string') return <CommandBox text={input.command} />;
    if (node.name === 'mcp__code-conductor__send_prompt' && typeof input.text === 'string') return <CommandBox text={input.text} />;
    if (kind === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      const ops = lineDiff(input.old_string, input.new_string);
      const { adds, dels } = diffStats(ops);
      return <DiffTable head={input.file_path ?? ''} stats={`+${adds} −${dels}`} lines={ops.map((o) => ({ type: opType(o.op), text: o.text }))} />;
    }
    if (kind === 'Write' && typeof input.content === 'string') {
      const lines = input.content.split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      return <DiffTable head={input.file_path ?? ''} stats={`${lines.length} line${lines.length === 1 ? '' : 's'}`} lines={lines.map((text: string, i: number) => ({ type: 'ctx' as const, text, marker: String(i + 1) }))} />;
    }
    if (kind === 'NotebookEdit' && typeof input.new_source === 'string') {
      const ops = lineDiff(input.old_source ?? '', input.new_source);
      const { adds, dels } = diffStats(ops);
      const label = `${input.notebook_path ?? ''}${input.cell_id ? ` · cell ${input.cell_id}` : ''}${input.edit_mode ? ` · ${input.edit_mode}` : ''}`;
      return <DiffTable head={label} stats={`+${adds} −${dels}`} lines={ops.map((o) => ({ type: opType(o.op), text: o.text }))} />;
    }
    let json = '';
    try { json = JSON.stringify(input, null, 2); } catch { json = node.partialJson; }
    return <ArgsJson text={json} node={node} model={model} />;
  }
  if (node.partialJson) return <ArgsJson text={node.partialJson} node={node} model={model} />;
  return null;
}

function ArgsJson({ text, node, model }: { text: string; node: ToolNode; model: ConversationModel }) {
  return (
    <details
      open={node.reader.argsOpen}
      onToggle={(e) => { if (e.currentTarget.open !== node.reader.argsOpen) model.setReader(node, { argsOpen: e.currentTarget.open }); }}
      className="group/args"
      data-tool-args
    >
      <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">Arguments</summary>
      <pre className="mt-1 max-h-80 overflow-auto rounded-lg bg-muted/60 px-3 py-2 font-mono text-xs leading-5">{text}</pre>
    </details>
  );
}

// ── Tool result ──────────────────────────────────────────────────────────

const RESULT_TRUNC = 4000;

export function ResultBlock({ node, model }: { node: ResultNode; model: ConversationModel }) {
  const { text, images } = React.useMemo(() => splitResultContent(node.content), [node.content]);
  const failed = node.isError && !node.yielded;
  const truncated = text.length > RESULT_TRUNC && !node.reader.full;
  const label = node.yielded ? 'Handed to user'
    : failed ? 'Error'
    : images.length ? `Result · ${images.length} image${images.length === 1 ? '' : 's'}` : 'Result';
  return (
    <details
      open={node.reader.open}
      onToggle={(e) => { if (e.currentTarget.open !== node.reader.open) model.setReader(node, { open: e.currentTarget.open }); }}
      className="group/res"
      data-tool-result
    >
      <summary className={cn(
        'flex cursor-pointer items-center gap-1.5 text-xs select-none',
        failed ? 'text-destructive' : node.yielded ? 'text-warning' : 'text-muted-foreground hover:text-foreground',
      )}>
        <ChevronRightIcon className="size-3 transition-transform group-open/res:rotate-90" />
        {label}
      </summary>
      {text && (
        <div className={cn('mt-1 overflow-hidden rounded-lg', failed ? 'bg-destructive/8 ring-1 ring-destructive/20' : 'bg-muted/60')}>
          <pre className="max-h-96 overflow-auto px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap">
            {truncated ? `${text.slice(0, RESULT_TRUNC)}\n…` : text}
          </pre>
          {truncated && (
            <div className="border-t px-2 py-1">
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => model.setReader(node, { full: true })}>Show full output</Button>
            </div>
          )}
        </div>
      )}
      {images.map((src, i) => <ImageZoom key={i} src={src} alt="Tool result image" className="mt-2 max-h-80 rounded-lg border" />)}
    </details>
  );
}
