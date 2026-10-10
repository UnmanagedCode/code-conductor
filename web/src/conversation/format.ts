// Pure text for the conversation's lines: tool summaries, system annotations,
// turn-end and per-call usage, compaction labels. Ported from the old block
// renderers so the wording stays what users and tests know.
import { formatResetTime, formatResetWhen, RL_WINDOW_LABEL, fmtCost, formatTokens, formatPct } from '@/lib/core/usage.js';
import type { UiEvent } from '@/state/types';

/** Tools whose input is one shell command ({command, description?}). */
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'mcp__code-conductor__project_bash', 'mcp__code-conductor__system_bash']);
export const renderKindFor = (name: string) => (SHELL_TOOLS.has(name) ? 'Bash' : name);

function bashSubject(input: any) {
  const desc = typeof input.description === 'string' ? input.description.trim() : '';
  return desc || input.command;
}

export type DescribeCtx = {
  resolveTaskSubject?: (id: string | null) => string | null;
  resolveTaskDescription?: (id: string | null) => string | null;
};

/** One-line description of a tool call: its most useful argument. */
export function describeToolInput(name: string, input: any, ctx: DescribeCtx = {}): string {
  if (!input || typeof input !== 'object') return '';
  const trunc = (s: unknown, n = 120) => {
    if (typeof s !== 'string') return '';
    const oneLine = s.replace(/\s+/g, ' ').trim();
    return oneLine.length > n ? oneLine.slice(0, n) + '…' : oneLine;
  };
  const join = (subject: string | null, description: string | null, statusSuffix?: string | null) => {
    const subj = trunc(subject, 80);
    const desc = trunc(description, 100);
    let out = subj;
    if (desc && desc !== subj) out = subj ? `${subj} — ${desc}` : desc;
    if (statusSuffix) out = out ? `${out} · ${statusSuffix}` : statusSuffix;
    return trunc(out, 160);
  };
  if (name === 'mcp__code-conductor__project_bash') {
    const scope = input.worktree ? `${input.project}/${input.worktree}` : input.project;
    return trunc(`[${scope}] ${bashSubject(input)}`);
  }
  if (name === 'mcp__code-conductor__system_bash') {
    const scope = input.remoteId ? `${input.system}/${input.remoteId}` : input.system;
    return trunc(`[${scope}] ${bashSubject(input)}`);
  }
  if (name === 'mcp__code-conductor__project_read') {
    const scope = input.worktree ? `${input.project}/${input.worktree}` : input.project;
    let out = trunc(`[${scope}] ${input.relativePath}`);
    if (input.offset != null) out += `  [offset=${input.offset}, limit=${input.limit ?? '?'}]`;
    return out;
  }
  if (name === 'mcp__code-conductor__spawn_instance') {
    const parts: string[] = [];
    if (input.project != null) parts.push(`[${input.project}]`);
    if (input.model != null) parts.push(`model=${input.model}`);
    if (input.playbook != null) parts.push(`playbook=${input.playbook}`);
    if (input.stage != null) parts.push(`stage=${input.stage}`);
    if (typeof input.resume === 'string') parts.push(`resume=${input.resume.slice(0, 8)}`);
    return trunc(parts.join(' '));
  }
  if (name === 'mcp__code-conductor__send_prompt') {
    let out = `sessionId=${trunc(input.sessionId, 100)}`;
    if (input.stage != null) out += ` stage=${input.stage}`;
    if (typeof input.forward?.sessionId === 'string') out += ` forward=${input.forward.sessionId.slice(0, 8)}`;
    return out;
  }
  switch (renderKindFor(name)) {
    case 'Bash':
      return trunc(bashSubject(input));
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit': {
      const base = trunc(input.file_path ?? input.notebook_path);
      if (name === 'Read' && input.offset != null) return `${base}  [offset=${input.offset}, limit=${input.limit ?? '?'}]`;
      return base;
    }
    case 'Glob':
    case 'Grep':
      return trunc(input.pattern + (input.path ? `   in ${input.path}` : ''));
    case 'WebFetch': return trunc(input.url);
    case 'WebSearch':
    case 'ToolSearch': return trunc(input.query);
    case 'Agent':
      return trunc(input.subagent_type ? `[${input.subagent_type}] ${input.description ?? input.prompt ?? ''}` : input.description ?? input.prompt ?? '');
    case 'Skill': return trunc(input.skill ?? input.name);
    case 'TaskCreate': return join(input.subject, input.description);
    case 'TaskUpdate': {
      const id = input.taskId != null ? String(input.taskId) : null;
      const subject = (typeof input.subject === 'string' && input.subject) || ctx.resolveTaskSubject?.(id) || null;
      const description = (typeof input.description === 'string' && input.description) || ctx.resolveTaskDescription?.(id) || null;
      const status = typeof input.status === 'string' ? input.status : null;
      const idPrefix = id ? `#${id}` : null;
      const head = idPrefix && subject ? `${idPrefix} ${subject}` : subject ? subject : idPrefix ? idPrefix : '';
      return join(head, description, status ? `→ ${status}` : null);
    }
    case 'AskUserQuestion': return trunc(input.questions?.[0]?.question);
    case 'TodoWrite': {
      const n = Array.isArray(input.todos) ? input.todos.length : 0;
      return n ? `${n} todo${n === 1 ? '' : 's'}` : '';
    }
  }
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length > 0) return `${k}=${trunc(v, 100)}`;
  }
  return '';
}

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const OVERAGE_DISABLED_LABEL: Record<string, string> = { out_of_credits: 'out of credits' };

export type SystemLine = { label: string; text: string; tone: 'muted' | 'warn' | 'error'; title?: string | null };

/** A kept system event as one annotated line. */
export function systemLine({ subtype, data }: UiEvent): SystemLine {
  const switchFailed = subtype === 'model_switch_failed' && !data?.cancelled;
  const warn = subtype === 'playbook_warn' || subtype === 'read_nudge' || switchFailed;
  const errorish = subtype === 'crashed' || subtype === 'spawn_error' || subtype === 'renew_error' || subtype === 'auto_stop_overage';
  const tone: SystemLine['tone'] = warn ? 'warn' : errorish ? 'error' : 'muted';
  const title = switchFailed ? data?.error || null : null;
  const text = (() => {
    switch (subtype) {
      case 'init': return `Session started · ${data?.model ?? '?'} · ${data?.session_id?.slice(0, 8) ?? '?'}`;
      case 'stderr': return data?.line ?? '';
      case 'exit': return `Process exited · code ${data?.code}${data?.signal ? ` · ${data.signal}` : ''}`;
      case 'spawn_error':
      case 'crashed': return data?.message ?? '';
      case 'history_load_error': return `Couldn't replay history: ${data?.message ?? ''}`;
      case 'renew_error': return `Renewal ${data?.stage ?? ''} failed: ${data?.message ?? ''}`;
      case 'permission_denied': return data?.message ?? data?.reason ?? '';
      case 'auto_stop_overage':
        if (data?.resume) {
          const at = formatResetTime(data.resetsAt)?.replace('resets ', '');
          return `Stopped: overage usage. Auto-resuming at ${at ?? 'reset'}.`;
        }
        return 'Stopped: the session entered overage usage and auto-stop is on.';
      case 'auto_resume': return `Window reset · delivered ${data?.count ?? 0} queued`;
      case 'auto_resume_skipped': return `Auto-resume skipped: ${data?.reason ?? ''}.`;
      case 'soft_interrupted': return data?.text ? `Turn interrupted: ${data.text}` : 'Turn interrupted';
      case 'drain_abort': return `Drained queued turn after interrupt (${data?.count ?? 1})`;
      case 'model_changed': return `Model changed: ${data?.from ?? '?'} → ${data?.to ?? '?'}${data?.restart ? ' (session restarted)' : ''}`;
      case 'model_switch_failed':
        if (data?.cancelled) return `Switch to ${data?.to ?? '?'} cancelled · session stopped`;
        return `Switch to ${data?.to ?? '?'} failed · still on ${data?.from ?? '?'}`;
      case 'playbook_warn': {
        const target = data?.sessionId ? ` on ${data.sessionId.slice(0, 8)}` : '';
        return `${data?.tool ?? '?'}${target} would have been refused · ${data?.code ?? '?'}: ${data?.reason ?? ''}`;
      }
      case 'read_nudge': return data?.text ?? '';
      case 'cache_miss':
        if (data?.prevPrefix != null) {
          const evicted = data.evicted ?? Math.max(0, (data.prevPrefix ?? 0) - (data.cacheRead ?? 0));
          return `~${evicted.toLocaleString()} tokens evicted from cache (${(data?.cacheRead ?? 0).toLocaleString()} served of ${(data.prevPrefix ?? 0).toLocaleString()})`;
        }
        return `${(data?.cacheCreation ?? 0).toLocaleString()} tokens written to cache, ${(data?.cacheRead ?? 0).toLocaleString()} served`;
      case 'rate_limit_event': {
        const info = data?.rate_limit_info ?? {};
        const window = (RL_WINDOW_LABEL as Record<string, string>)[info.rateLimitType] ?? info.rateLimitType ?? 'usage';
        const resetWhen = formatResetWhen(info.resetsAt);
        if (info.status === 'allowed_warning') {
          const util = typeof info.utilization === 'number' ? Math.round(info.utilization * 100) : null;
          return `Usage${util != null ? ` ${util}% of` : ''} ${window} limit${resetWhen ? ` · ${resetWhen}` : ''}`;
        }
        if (info.status === 'rejected') {
          let line = `${window} limit reached${resetWhen ? ` · ${resetWhen}` : ''}`;
          if (info.isUsingOverage) line += ' · on overage';
          else if (info.overageStatus === 'rejected') {
            line += ` · overage unavailable (${OVERAGE_DISABLED_LABEL[info.overageDisabledReason] ?? info.overageDisabledReason ?? 'unavailable'})`;
          }
          return line;
        }
        return `${info.status ?? 'rate limit'} · ${window}${resetWhen ? ` · ${resetWhen}` : ''}`;
      }
      case 'raw': return data?.line ?? '';
    }
    try { return JSON.stringify(data).slice(0, 200); } catch { return ''; }
  })();
  return { label: subtype, text, tone: subtype === 'rate_limit_event' && data?.rate_limit_info?.status === 'rejected' ? 'error' : tone, title };
}

/** A background task's folded line: name · status · exit code (an Agent task has none). */
export function taskNotificationHeadline(data: any): string {
  const exit = data?.exitCode != null ? ` · exit ${data.exitCode}` : '';
  return `${data?.name ?? data?.task_id ?? '?'} · ${data?.status ?? '?'}${exit}`;
}

function growthPrefix(growth: number | null | undefined) {
  return growth == null ? '' : `${growth < 0 ? '-' : '+'}${formatTokens(Math.abs(growth))} → `;
}

/** One API call's figures, from a live `call_usage` event. */
export function callUsageText({ promptTokens, growthTokens, outputTokens, thinkingTokens }: UiEvent): string {
  const parts: string[] = [];
  if (promptTokens != null) parts.push(`${growthPrefix(growthTokens)}ctx ${formatTokens(promptTokens)}`);
  parts.push(`out ${formatTokens(outputTokens)}${thinkingTokens ? ` (${formatTokens(thinkingTokens)} thinking)` : ''}`);
  return parts.join(' · ');
}

export const CALL_USAGE_TITLE = "Prompt size of this API call (exact). Growth = this call's prompt minus the previous call's: that call's output plus everything appended since (tool results, user message, injected context, hook output), not per-tool attribution.";

export type TurnEndParts = { ok: boolean; stopReason: string | null; duration: string | null; cost: string | null; context: string | null; tokens: string | null };

export function turnEndParts({ durationMs, cost, costDelta, usage, isError, stopReason, contextTokens, contextWindowTokens, contextGrowthTokens }: UiEvent): TurnEndParts {
  const displayCost = costDelta ?? cost;
  let context: string | null = null;
  if (contextTokens != null && Number.isFinite(contextTokens)) {
    const ctx = `${growthPrefix(contextGrowthTokens)}ctx ${formatTokens(contextTokens)}`;
    context = contextWindowTokens != null && Number.isFinite(contextWindowTokens) && contextWindowTokens > 0
      ? `${ctx} / ${formatTokens(contextWindowTokens)} (${formatPct(contextTokens / contextWindowTokens)})`
      : ctx;
  }
  return {
    ok: !isError,
    stopReason: stopReason ?? null,
    duration: durationMs != null ? formatDurationShort(durationMs) : null,
    cost: displayCost != null ? fmtCost(displayCost) : null,
    context,
    tokens: usage ? `in ${formatTokens(usage.input_tokens)} · out ${formatTokens(usage.output_tokens)}` : null,
  };
}

function formatDurationShort(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return formatElapsed(ms);
}

export function compactionLabel({ state, trigger = null, preTokens = null, postTokens = null, error = null }: {
  state: string; trigger?: string | null; preTokens?: number | null; postTokens?: number | null; error?: string | null;
}) {
  const fmt = (n: number) => n.toLocaleString();
  if (state === 'running') return 'Compacting context…';
  if (state === 'failed') return error ? `Compaction failed: ${error}` : 'Compaction did not complete';
  const parts = ['Context compacted'];
  if (trigger) parts.push(trigger);
  if (preTokens != null && postTokens != null) parts.push(`${fmt(preTokens)} → ${fmt(postTokens)} tokens`);
  else if (preTokens != null) parts.push(`${fmt(preTokens)} tokens`);
  return parts.join(' · ');
}

/** Split tool_result content into text, safe image sources and tool references. */
export function splitResultContent(content: unknown): { text: string; images: string[] } {
  const textParts: string[] = [];
  const images: string[] = [];
  const refs: string[] = [];
  if (typeof content === 'string') textParts.push(content);
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'image' && b.source && typeof b.source === 'object') {
        const src = imageSrcFromSource(b.source);
        if (src) images.push(src);
      } else if (b.type === 'tool_reference' && typeof b.tool_name === 'string') refs.push(b.tool_name);
      else if (typeof b.text === 'string' && b.text) textParts.push(b.text);
    }
    if (refs.length) textParts.push(`Loaded ${refs.length} tool schema${refs.length === 1 ? '' : 's'}: ${refs.join(', ')}`);
  } else if (content != null) {
    textParts.push(JSON.stringify(content));
  }
  return { text: textParts.join('\n'), images };
}

// base64 → data: URL (never SVG, which can carry script); url → http(s)/file only.
function imageSrcFromSource(source: any): string | null {
  if (source.type === 'base64' && typeof source.data === 'string') {
    const media = typeof source.media_type === 'string' && /^image\/[\w.+-]+$/i.test(source.media_type) ? source.media_type : 'image/png';
    if (/svg/i.test(media)) return null;
    return `data:${media};base64,${source.data}`;
  }
  if (source.type === 'url' && typeof source.url === 'string' && /^(https?:|file:)\/\//i.test(source.url)) return source.url;
  return null;
}
