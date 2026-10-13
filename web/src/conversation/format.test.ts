import { describe, expect, it } from 'vitest';
import { callUsageText, describeToolInput, splitResultContent, systemLine, taskNotificationHeadline, turnEndParts } from './format';
import { shouldRenderSystem } from './model';
import type { UiEvent, UiEventOf } from '@shared/uiEvent';

describe('describeToolInput', () => {
  it('Bash prefers its description, falls back to the command; PowerShell summarises identically', () => {
    for (const name of ['Bash', 'PowerShell']) {
      expect(describeToolInput(name, { command: 'ls -la' })).toBe('ls -la');
      expect(describeToolInput(name, { command: 'ls -la', description: 'List files' })).toBe('List files');
      expect(describeToolInput(name, { command: 'ls -la', description: '   ' })).toBe('ls -la');
      expect(describeToolInput(name, {})).toBe('');
    }
    expect(describeToolInput('Bash', null)).toBe('');
  });

  it('project_bash / system_bash keep their scope prefix', () => {
    const p = 'mcp__code-conductor__project_bash';
    const s = 'mcp__code-conductor__system_bash';
    expect(describeToolInput(p, { project: 'demo', command: 'rg foo', description: 'Search for foo' })).toBe('[demo] Search for foo');
    expect(describeToolInput(p, { project: 'demo', worktree: 'wt-1', command: 'rg foo', description: 'Search for foo' })).toBe('[demo/wt-1] Search for foo');
    expect(describeToolInput(p, { project: 'demo', command: 'rg foo', description: '   ' })).toBe('[demo] rg foo');
    expect(describeToolInput(s, { system: 'refbox', command: 'git --version', description: 'Check the git version' })).toBe('[refbox] Check the git version');
    expect(describeToolInput(s, { system: 'refbox', remoteId: 'c1', command: 'x', description: 'Check' })).toBe('[refbox/c1] Check');
    expect(describeToolInput(s, { system: 'refbox', command: 'uname -a' })).toBe('[refbox] uname -a');
  });

  it('file tools show the path; Read shows pagination', () => {
    for (const n of ['Edit', 'Write', 'Read']) expect(describeToolInput(n, { file_path: '/x/y.js' })).toBe('/x/y.js');
    const r = describeToolInput('Read', { file_path: '/a', offset: 100, limit: 50 });
    expect(r).toMatch(/\/a/);
    expect(r).toMatch(/offset=100/);
    expect(r).toMatch(/limit=50/);
  });

  it('search, web, Agent and ToolSearch summaries', () => {
    expect(describeToolInput('Glob', { pattern: '**/*.ts', path: 'src' })).toMatch(/\*\*\/\*\.ts.*src/);
    expect(describeToolInput('Grep', { pattern: 'foo', path: 'tests' })).toMatch(/foo.*tests/);
    expect(describeToolInput('WebFetch', { url: 'https://example.com' })).toBe('https://example.com');
    expect(describeToolInput('WebSearch', { query: 'claude code' })).toBe('claude code');
    expect(describeToolInput('Agent', { subagent_type: 'Explore', description: 'find files' })).toBe('[Explore] find files');
    expect(describeToolInput('ToolSearch', { query: 'select:WebFetch', max_results: 3 })).toBe('select:WebFetch');
  });

  it('collapses whitespace and truncates long commands and descriptions', () => {
    const long = 'a'.repeat(300);
    for (const n of ['Bash', 'PowerShell']) {
      const s = describeToolInput(n, { command: `echo\n\n   ${long}` });
      expect(s.length).toBeLessThanOrEqual(121);
      expect(s.endsWith('…')).toBe(true);
    }
    const d = describeToolInput('Bash', { command: 'echo short', description: `explain\n\n   ${'b'.repeat(300)}` });
    expect(d.length).toBeLessThanOrEqual(121);
    expect(d.startsWith('explain b')).toBe(true);
    expect(d.includes('short')).toBe(false);
  });

  it('an unknown tool shows its first string field', () => {
    expect(describeToolInput('CustomThing', { mode: 'auto', count: 5 })).toBe('mode=auto');
  });

  it('task tools resolve subject and description, preferring their own', () => {
    expect(describeToolInput('TaskCreate', { subject: 'Refactor X', description: 'Pull out the hook plumbing' })).toMatch(/Refactor X.*hook plumbing/);
    const ctx = { resolveTaskSubject: (id: string | null) => (id === '4' ? 'Refactor X' : null), resolveTaskDescription: (id: string | null) => (id === '4' ? 'Pull out the hook plumbing' : null) };
    const s = describeToolInput('TaskUpdate', { taskId: '4', status: 'completed' }, ctx);
    for (const part of [/#4/, /Refactor X/, /hook plumbing/, /→ completed/]) expect(s).toMatch(part);
    const bare = describeToolInput('TaskUpdate', { taskId: '7', status: 'in_progress' });
    expect(bare).toMatch(/#7/);
    expect(bare).toMatch(/→ in_progress/);
    const own = describeToolInput('TaskUpdate', { taskId: '4', subject: 'New name', status: 'completed' }, { resolveTaskSubject: () => 'Old name' });
    expect(own).toMatch(/New name/);
    expect(own.includes('Old name')).toBe(false);
  });

  it('spawn_instance and send_prompt summaries', () => {
    const sp = 'mcp__code-conductor__spawn_instance';
    expect(describeToolInput(sp, { project: 'cc', model: 'sonnet', playbook: 'feature-loop', stage: 'implement' })).toBe('[cc] model=sonnet playbook=feature-loop stage=implement');
    expect(describeToolInput(sp, { project: 'cc', model: 'sonnet' })).toBe('[cc] model=sonnet');
    expect(describeToolInput(sp, { resume: '78ac46d0-1234-5678-9abc-def012345678' })).toBe('resume=78ac46d0');
    expect(describeToolInput(sp, { model: 'sonnet' })).toBe('model=sonnet');
    const pr = 'mcp__code-conductor__send_prompt';
    expect(describeToolInput(pr, { sessionId: 'abc123', text: 'go ahead', stage: 'review' })).toBe('sessionId=abc123 stage=review');
    expect(describeToolInput(pr, { sessionId: 'abc123', text: 'go ahead' })).toBe('sessionId=abc123');
    expect(describeToolInput(pr, { sessionId: 'abc123', text: 'x', forward: { sessionId: '12345678-aaaa' } })).toBe('sessionId=abc123 forward=12345678');
  });
});

describe('tool results', () => {
  it('base64 images become data URLs; svg is refused; http(s)/file URLs pass; text joins', () => {
    const r = splitResultContent([
      { type: 'text', text: 'Here is the screenshot:' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      { type: 'image', source: { type: 'base64', data: 'BBBB' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'CCCC' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
      { type: 'image', source: { type: 'url', url: 'file:///home/foo.png' } },
      { type: 'image', source: { type: 'url', url: 'javascript:alert(1)' } },
    ]);
    expect(r.images).toEqual(['data:image/jpeg;base64,AAAA', 'data:image/png;base64,BBBB', 'https://example.com/a.png', 'file:///home/foo.png']);
    expect(r.text).toBe('Here is the screenshot:');
  });

  it('plain strings stay text; tool_reference blocks (ToolSearch) are named', () => {
    expect(splitResultContent('total 22\nfile1\n')).toEqual({ text: 'total 22\nfile1\n', images: [] });
    const r = splitResultContent([{ type: 'tool_reference', tool_name: 'WebFetch' }, { type: 'tool_reference', tool_name: 'WebSearch' }]);
    expect(r.text).toBe('Loaded 2 tool schemas: WebFetch, WebSearch');
  });
});

describe('turn footer and per-call usage', () => {
  const BARE: UiEventOf<'turn_end'> = {
    kind: 'turn_end', subtype: 'success', stopReason: null, durationMs: null, durationApiMs: null, durationApiMsDelta: null,
    cost: null, costDelta: null, usage: null, isError: false,
  };
  const BASE: UiEventOf<'turn_end'> = { ...BARE, durationMs: 1200, cost: 9, costDelta: 0.0123, usage: { input_tokens: 10, output_tokens: 252 }, stopReason: 'end_turn' };

  it('shows the turn cost (costDelta, never the session total) at 4dp, nothing when unknown', () => {
    expect(turnEndParts({ ...BASE, costDelta: 1 }).cost).toBe('$1.0000');
    expect(turnEndParts(BARE).cost).toBeNull();
  });

  it('the ctx segment: with a window, alone without one, and absent without a reading', () => {
    expect(turnEndParts({ ...BASE, contextTokens: 35_000, contextWindowTokens: 200_000 }).context).toBe('ctx 35k / 200k (18%)');
    expect(turnEndParts({ ...BASE, contextTokens: 35_000, contextWindowTokens: null }).context).toBe('ctx 35k');
    expect(turnEndParts({ ...BASE, contextTokens: null, contextWindowTokens: 200_000 }).context).toBeNull();
    expect(turnEndParts({ ...BASE, contextTokens: null, contextGrowthTokens: 3_200 }).context).toBeNull();
  });

  it("the turn's growth prefixes the ctx segment, sign kept, like the per-call line", () => {
    expect(turnEndParts({ ...BASE, contextTokens: 35_000, contextWindowTokens: 200_000, contextGrowthTokens: 3_200 }).context).toBe('+3.2k → ctx 35k / 200k (18%)');
    expect(turnEndParts({ ...BASE, contextTokens: 35_000, contextWindowTokens: null, contextGrowthTokens: 3_200 }).context).toBe('+3.2k → ctx 35k');
    expect(turnEndParts({ ...BASE, contextTokens: 35_000, contextWindowTokens: 200_000, contextGrowthTokens: -1_500 }).context).toBe('-1.5k → ctx 35k / 200k (18%)');
    for (const g of [3_200, -1_500, 0]) {
      const turn = turnEndParts({ ...BARE, contextTokens: 35_000, contextGrowthTokens: g }).context!;
      const call = callUsageText({ kind: 'call_usage', msgId: 'm1', promptTokens: 35_000, growthTokens: g, outputTokens: 10, thinkingTokens: null });
      expect(turn.slice(0, turn.indexOf('ctx'))).toBe(call.slice(0, call.indexOf('ctx')));
    }
  });

  it('marks a failed turn and keeps the stop reason', () => {
    expect(turnEndParts({ ...BASE, isError: true })).toMatchObject({ ok: false, stopReason: 'end_turn' });
    expect(turnEndParts(BASE).tokens).toBe('in 10 · out 252');
  });

  it('a call line shows growth, context and output with its thinking portion', () => {
    expect(callUsageText({ kind: 'call_usage', msgId: 'm1', promptTokens: 40_000, growthTokens: 3_200, outputTokens: 1_500, thinkingTokens: 900 })).toBe('+3.2k → ctx 40k · out 1.5k (900 thinking)');
    expect(callUsageText({ kind: 'call_usage', msgId: 'm1', promptTokens: 40_000, growthTokens: null, outputTokens: 12, thinkingTokens: null })).toBe('ctx 40k · out 12');
  });

  it('a call line drops its growth with no baseline, its thinking clause when thinking is 0 or unknown, and its context segment when the prompt is unknown; negative growth keeps its sign', () => {
    const call: UiEvent = { kind: 'call_usage', msgId: 'm1', outputTokens: 460, thinkingTokens: 73, promptTokens: 84_000, growthTokens: 3_200 };
    expect(callUsageText(call), 'fixture check: the full line').toBe('+3.2k → ctx 84k · out 460 (73 thinking)');
    expect(callUsageText({ ...call, growthTokens: null }), 'no baseline').toBe('ctx 84k · out 460 (73 thinking)');
    expect(callUsageText({ ...call, thinkingTokens: 0 }), 'thinking 0').toBe('+3.2k → ctx 84k · out 460');
    expect(callUsageText({ ...call, thinkingTokens: null }), 'thinking unknown').toBe('+3.2k → ctx 84k · out 460');
    expect(callUsageText({ ...call, promptTokens: null, growthTokens: null, thinkingTokens: 0 }), 'prompt unknown').toBe('out 460');
    expect(callUsageText({ ...call, growthTokens: -1_500 }), 'negative growth').toBe('-1.5k → ctx 84k · out 460 (73 thinking)');
  });
});

describe('system lines', () => {
  it('per-turn noise is dropped; kept subtypes render', () => {
    expect(shouldRenderSystem({ kind: 'system', subtype: 'status', data: { status: 'requesting' } })).toBe(false);
    expect(shouldRenderSystem({ kind: 'system', subtype: 'rate_limit_event', data: { rate_limit_info: { status: 'allowed' } } })).toBe(false);
    expect(shouldRenderSystem({ kind: 'system', subtype: 'rate_limit_event', data: { rate_limit_info: { status: 'allowed_warning' } } })).toBe(true);
    for (const s of ['read_nudge', 'playbook_warn', 'model_switch_failed', 'model_changed', 'init', 'stderr']) {
      expect(shouldRenderSystem({ kind: 'system', subtype: s, data: {} })).toBe(true);
    }
    expect(shouldRenderSystem({ kind: 'system', subtype: 'task_notification', data: { notified: true } })).toBe(true);
    expect(shouldRenderSystem({ kind: 'system', subtype: 'task_notification', data: {} })).toBe(false);
  });

  it('rate limit lines are parsed one-liners with overage detail', () => {
    const warn = systemLine({ kind: 'system', subtype: 'rate_limit_event', data: { rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9 } } });
    expect(warn.text).toMatch(/^Usage 90% of 5-hour limit/);
    expect(warn.text.includes('{')).toBe(false);
    const rejected = systemLine({ kind: 'system', subtype: 'rate_limit_event', data: { rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', overageStatus: 'rejected', overageDisabledReason: 'out_of_credits' } } });
    expect(rejected.text).toMatch(/^7-day limit reached/);
    expect(rejected.text).toMatch(/overage unavailable \(out of credits\)/);
    expect(rejected.tone).toBe('error');
    const onOverage = systemLine({ kind: 'system', subtype: 'rate_limit_event', data: { rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', isUsingOverage: true } } });
    expect(onOverage.text).toMatch(/on overage/);
  });

  it('model switch lines: restart suffix, identity unchanged, failure with cause tooltip, cancel neutral', () => {
    expect(systemLine({ kind: 'system', subtype: 'model_changed', data: { from: 'alpha:cloud', to: 'beta:cloud', restart: true } })).toMatchObject({
      text: 'Model changed: alpha:cloud → beta:cloud (session restarted)', tone: 'muted',
    });
    expect(systemLine({ kind: 'system', subtype: 'model_changed', data: { from: 'claude-haiku-4-5', to: 'claude-opus-4-8' } }).text).toBe('Model changed: claude-haiku-4-5 → claude-opus-4-8');
    expect(systemLine({ kind: 'system', subtype: 'model_switch_failed', data: { from: 'alpha:cloud', to: 'beta:cloud', error: "Error: model 'beta:cloud' not found" } })).toMatchObject({
      text: 'Switch to beta:cloud failed · still on alpha:cloud', tone: 'warn', title: "Error: model 'beta:cloud' not found",
    });
    expect(systemLine({ kind: 'system', subtype: 'model_switch_failed', data: { from: 'alpha:cloud', to: 'beta:cloud', cancelled: true } })).toMatchObject({
      text: 'Switch to beta:cloud cancelled · session stopped', tone: 'muted', title: null,
    });
  });

  it('a cross-backend divider names both backends on every outcome (mirrors model-switch-bubble "a cross-backend divider names both backends on every outcome")', () => {
    const backends = { from: 'claude-haiku-4-5', to: 'alpha:cloud', fromBackend: 'claude', toBackend: 'ollama' };
    expect(systemLine({ kind: 'system', subtype: 'model_changed', data: { ...backends, restart: true } }).text)
      .toBe('Model changed: claude-haiku-4-5 on claude → alpha:cloud on ollama (session restarted)');
    expect(systemLine({ kind: 'system', subtype: 'model_switch_failed', data: { ...backends, error: 'boom' } }).text)
      .toBe('Switch to alpha:cloud on ollama failed · still on claude-haiku-4-5 on claude');
    expect(systemLine({ kind: 'system', subtype: 'model_switch_failed', data: { ...backends, cancelled: true } }).text)
      .toBe('Switch to alpha:cloud on ollama cancelled · session stopped');
    // One side alone is not a crossing: the text stays as it was.
    expect(systemLine({ kind: 'system', subtype: 'model_changed', data: { from: 'a', to: 'b', toBackend: 'ollama' } }).text)
      .toBe('Model changed: a → b');
  });

  it('a playbook warning names tool, target (8 chars), code and reason once, as prose', () => {
    const l = systemLine({ kind: 'system', subtype: 'playbook_warn', data: { tool: 'send_prompt', code: 'TRANSITION_ILLEGAL', reason: 'plan cannot reach implement directly', sessionId: 'abc12345-dead-beef' } });
    expect(l.tone).toBe('warn');
    for (const part of ['would have been refused', 'TRANSITION_ILLEGAL', 'plan cannot reach implement directly', 'send_prompt', 'abc12345']) expect(l.text).toContain(part);
    expect(l.text).not.toContain('abc12345-dead-beef');
    expect(l.text).not.toContain('{');
    const untargeted = systemLine({ kind: 'system', subtype: 'playbook_warn', data: { tool: 'spawn_instance', code: 'PLAYBOOK_UNKNOWN', reason: 'no playbook named' } });
    expect(untargeted.text).not.toContain('undefined');
    expect(untargeted.text).not.toMatch(/ on /);
  });

  it('a read nudge carries the verbatim text as a warning; an ordinary line is not a warning', () => {
    expect(systemLine({ kind: 'system', subtype: 'read_nudge', data: { text: 'You have read 8 files' } })).toMatchObject({ text: 'You have read 8 files', tone: 'warn' });
    expect(systemLine({ kind: 'system', subtype: 'stderr', data: { line: 'noise' } }).tone).toBe('muted');
  });

  it('a task notification headline names the task, status and exit code (none for an Agent task)', () => {
    expect(taskNotificationHeadline({ name: 'bg ok', status: 'completed', exitCode: 0 })).toBe('bg ok · completed · exit 0');
    expect(taskNotificationHeadline({ name: 'bg agent', status: 'completed' })).toBe('bg agent · completed');
  });

  it('auto-stop and soft interrupt wording', () => {
    expect(systemLine({ kind: 'system', subtype: 'soft_interrupted', data: { text: 'user interrupt' } }).text).toBe('Turn interrupted: user interrupt');
    expect(systemLine({ kind: 'system', subtype: 'auto_stop_overage', data: { resume: false } }).text).toMatch(/auto-stop is on/);
    expect(systemLine({ kind: 'system', subtype: 'auto_stop_overage', data: { resume: true, resetsAt: 2_000_000_000 } }).text).toMatch(/Auto-resuming at/);
  });
});
