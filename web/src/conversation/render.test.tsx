/// <reference types="node" />
import { beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fireEvent, within } from '@testing-library/react';
import { ConversationModel } from './model';
import { feed, readJsonl, serverModules, text, tool, toolResult } from './testkit';
import { flush, renderModel } from './renderModel';
import type { UiEventOf } from '@shared/uiEvent';

let S: Awaited<ReturnType<typeof serverModules>>;
beforeAll(async () => { S = await serverModules(); });

async function shown(events: any[]) {
  const m = new ConversationModel();
  feed(m, events);
  const r = renderModel(m);
  await flush();
  return { m, root: r.root };
}

/** Open the (only) action group and every tool card in it. */
function expandAll(root: HTMLElement) {
  const ag = within(root).getByRole('button', { name: /actions?/ });
  if (ag.getAttribute('data-state') === 'closed') fireEvent.click(ag);
  for (const t of root.querySelectorAll('[data-tool-trigger]')) if (t.getAttribute('data-state') === 'closed') fireEvent.click(t);
}

describe('tool cards', () => {
  it('a Bash call shows the command in its body and the description in its summary', async () => {
    const { root } = await shown(tool('m1', 0, 't1', 'Bash', { result: null, input: { command: 'ls -la', description: 'List files' } }));
    expandAll(root);
    const trigger = root.querySelector('[data-tool-trigger]')!;
    expect(trigger.textContent).toContain('List files');
    expect(trigger.textContent).not.toContain('ls -la');
    expect([...root.querySelectorAll('pre')].map((p) => p.textContent)).toContain('ls -la');
  });

  it('PowerShell and project_bash render the same command box as Bash', async () => {
    for (const name of ['PowerShell', 'mcp__code-conductor__project_bash']) {
      const { root } = await shown(tool('m1', 0, 't1', name, { result: null, input: { project: 'demo', command: 'rg foo', description: 'Search for foo' } }));
      expandAll(root);
      expect([...root.querySelectorAll('pre')].map((p) => p.textContent)).toContain('rg foo');
      expect(root.querySelector('[aria-label="Copy command"]')).toBeTruthy();
    }
  });

  it('an Edit renders a diff with add/remove counts; a Write a numbered preview', async () => {
    const { root } = await shown([
      ...tool('m1', 0, 't1', 'Edit', { result: null, input: { file_path: 'a.js', old_string: 'x\ny', new_string: 'x\nz' } }),
      ...tool('m1', 1, 't2', 'Write', { result: null, input: { file_path: 'b.js', content: 'hello\nworld\n' } }),
    ]);
    expandAll(root);
    expect(root.textContent).toContain('+1 −1');
    expect(root.textContent).toContain('2 lines');
  });

  it('an unknown tool, or a shell call with a non-string command, falls back to a collapsed JSON dump', async () => {
    for (const [name, input] of [['SomeFutureTool', { foo: 1 }], ['PowerShell', { command: 42 }]] as const) {
      const { root } = await shown(tool('m1', 0, 't1', name, { result: null, input }));
      expandAll(root);
      const details = root.querySelector('details') as HTMLDetailsElement;
      expect(details.textContent).toContain('Arguments');
      expect(details.open).toBe(false);
      expect(details.querySelector('pre')!.textContent).toMatch(/"(foo|command)"/);
    }
  });

  it('an MCP tool shows its server chip and label with the raw name on hover; a built-in has neither', async () => {
    const { root } = await shown([
      ...tool('m1', 0, 't1', 'mcp__code-conductor__code-share__publish', { result: null, input: {} }),
      ...tool('m1', 1, 't2', 'PowerShell', { result: null, input: { command: 'x' } }),
    ]);
    expandAll(root);
    const [plugin, builtin] = root.querySelectorAll('[data-tool-trigger]');
    const name = plugin.querySelector('[data-tool-name]')!;
    expect(name.getAttribute('title')).toBe('mcp__code-conductor__code-share__publish');
    expect(name.textContent).toBe('sharePublish');
    expect(builtin.querySelector('[data-tool-name]')!.hasAttribute('title')).toBe(false);
  });

  it('a foreground Agent result with subagent totals shows the usage badge (singular for one use); none without totals', async () => {
    const withTotals = await shown([...tool('m1', 0, 'a1', 'Agent', { result: null }), toolResult({ toolUseId: 'a1', content: 'done', agentTokens: 42_000, agentToolUses: 1 })]);
    expandAll(withTotals.root);
    expect(withTotals.root.textContent).toContain('subagent 42k ctx · 1 tool use');
    const unknownCount = await shown([...tool('m1', 0, 'a1', 'Agent', { result: null }), toolResult({ toolUseId: 'a1', content: 'done', agentTokens: 42_000 })]);
    expect(unknownCount.root.textContent).toContain('subagent 42k ctx');
    expect(unknownCount.root.textContent).not.toContain('tool use');
    const none = await shown(tool('m1', 0, 'a1', 'Agent'));
    expect(none.root.textContent).not.toContain('subagent');
  });

  it('results: images render lazily as images, small text opens, long text truncates with a show-full control', async () => {
    const { root } = await shown([
      ...tool('m1', 0, 't1', 'Read', { result: null, input: { file_path: 'x.png' } }),
      toolResult({ toolUseId: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }),
      ...tool('m1', 1, 't2', 'Bash', { result: 'y'.repeat(5000) }),
    ]);
    expandAll(root);
    const img = root.querySelector('img[src="data:image/png;base64,AAAA"]')!;
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(root.textContent).toContain('Result · 1 image');
    const showFull = within(root).getByRole('button', { name: 'Show full output' });
    fireEvent.click(showFull);
    expect([...root.querySelectorAll('pre')].some((p) => p.textContent === 'y'.repeat(5000))).toBe(true);
  });
});

describe('annotations', () => {
  it('noise is dropped and kept system events render inline in chronological order', async () => {
    const { root } = await shown([
      { kind: 'system', subtype: 'status', data: { status: 'requesting' } },
      { kind: 'system', subtype: 'rate_limit_event', data: { rate_limit_info: { status: 'allowed' } } },
      { kind: 'system', subtype: 'stderr', data: { line: 'first' } },
      ...text('m1', 0, 'between'),
      { kind: 'system', subtype: 'stderr', data: { line: 'second' } },
    ]);
    const kids = [...root.children];
    expect(kids.map((n) => n.getAttribute('data-subtype') ?? n.getAttribute('data-item'))).toEqual(['stderr', 'assistant', 'stderr']);
  });

  it('a read nudge and a playbook warning render warning-styled; a stderr line does not', async () => {
    const { root } = await shown([
      { kind: 'system', subtype: 'read_nudge', data: { text: 'nudge text' } },
      { kind: 'system', subtype: 'playbook_warn', data: { tool: 'send_prompt', code: 'X', reason: 'r' } },
      { kind: 'system', subtype: 'stderr', data: { line: 'noise' } },
    ]);
    expect([...root.querySelectorAll('[data-tone="warn"]')].map((n) => n.getAttribute('data-subtype'))).toEqual(['read_nudge', 'playbook_warn']);
    expect(root.querySelector('[data-subtype="read_nudge"]')!.textContent).toContain('nudge text');
  });

  it('a nudge between a tool_use and its result does not close the group, and the result attaches', async () => {
    const m = new ConversationModel();
    feed(m, [
      { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tu8', name: 'mcp__code-conductor__project_read' },
      { kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tu8', name: 'mcp__code-conductor__project_read', input: {} },
      { kind: 'system', subtype: 'read_nudge', data: { text: 'n' } },
      toolResult({ toolUseId: 'tu8', content: 'file bytes RESULT-MARK' }),
    ]);
    const group = (m.items[0] as any).children[0];
    expect(group.open).toBe(true);
    expect(m.toolBlocks.get('tu8')!.result!.content).toContain('RESULT-MARK');
  });
});

describe('background task notifications (real fixtures)', () => {
  const C1 = 'toolu_018MKm8vtqnn6GpMTLzD3Ncu';
  const C7 = 'toolu_012VgSmvzUktTsW7SkbfpLHq';
  const EXPECTED = ['bg ok · completed · exit 0', 'bg fail · failed · exit 3', 'bg agent · completed', 'ls / 2>&1 | head -3 · completed · exit 0'];
  const liveEvents = () => {
    const parser = new S.Parser();
    return readJsonl('task-notification.stdout.jsonl').flatMap((f) => parser.handleObject(f));
  };
  const headlines = (root: HTMLElement) => [...root.querySelectorAll('[data-subtype="task_notification"] [data-headline]')].map((n) => n.textContent);

  it('the live stream renders one folded line per background task; a foreground task renders nothing', async () => {
    const evs = liveEvents();
    const { root } = await shown(evs);
    expect(headlines(root)).toEqual(EXPECTED);
    const failed = [...root.querySelectorAll('[data-subtype="task_notification"]')].find((n) => n.textContent!.includes('bg fail'))!;
    expect(failed.getAttribute('data-tone')).toBe('warn');
    const ok = root.querySelector('[data-subtype="task_notification"]') as HTMLDetailsElement;
    expect(ok.open).toBe(false);
    const tn = evs.find((e): e is UiEventOf<'system'> => e.kind === 'system' && e.subtype === 'task_notification' && e.toolUseId === C1)!;
    expect(ok.querySelector('[data-fold-body]')!.textContent).toContain(tn.data!.summary);
    expect(ok.querySelector('[data-headline]')!.textContent).not.toContain(tn.data!.output_file);
    const fg = evs.find((e) => e.kind === 'system' && e.subtype === 'task_notification' && e.toolUseId === C7)!;
    expect((await shown([fg])).root.querySelector('[data-subtype]')).toBeNull();
  });

  it('a reload renders the same lines in the same order', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-tn-'));
    const prev = process.env.CLAUDE_PROJECTS_ROOT;
    process.env.CLAUDE_PROJECTS_ROOT = home;
    try {
      const cwd = '/workspace/project';
      const sid = '20594e65-2dd2-4118-83e5-7dd5d36ab56f';
      const file = path.join(home, S.encodeCwd(cwd), `${sid}.jsonl`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, readJsonl('task-notification.transcript.jsonl').map((l) => JSON.stringify(l)).join('\n') + '\n');
      const result = await S.loadPersistedTranscript({ place: S.localPlace(cwd), sessionId: sid, seqHint: 0 });
      const { root } = await shown(result.lines.flatMap((l: any) => l.events));
      expect(headlines(root)).toEqual(EXPECTED);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
      else process.env.CLAUDE_PROJECTS_ROOT = prev;
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
