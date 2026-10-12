import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, within } from '@testing-library/react';
import { buildWakeStub, markPlainStub, WAKE_CALLBACK_MARKER } from '../../../public/wakeCallback.ts';
import { buildRenewSeed, RENEW_SUMMARY_SECTIONS, MECHANICAL_STATE_HEADER } from '../../../public/renewSeed.ts';
import { buildForwardFrame } from '../../../public/forwardFrame.ts';
import { ConversationModel, type UserNode } from './model';
import { flush, noActions, renderModel } from './renderModel';

let copied: string[] = [];
beforeEach(() => {
  copied = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t: string) => { copied.push(t); return Promise.resolve(); } } });
});
afterEach(() => vi.restoreAllMocks());

async function echo(text: string, extra: object = {}, actions = noActions) {
  const m = new ConversationModel();
  m.apply({ kind: 'user_echo', text, userIndex: 0, ...extra });
  const r = renderModel(m, actions);
  await flush();
  return { m, root: r.root, bubble: r.root.querySelector('[data-item="user"]') as HTMLElement };
}

const expand = async (fold: Element) => {
  fireEvent.click(fold.querySelector('[data-fold-trigger]')!);
  await flush();
};

describe('plain user bubbles', () => {
  it('GFM renders inside the bubble; single newlines stay line breaks in one paragraph', async () => {
    const src = ['```js', 'const x = 1;', '```', '', 'Some `inline code` and a list:', '', '- one', '- two', '', '[link](https://example.com)', '', '**bold**', '', '| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n');
    const { bubble } = await echo(src);
    const body = bubble.querySelector('[data-user-text] .md')!;
    expect(body.querySelector('pre > code')).toBeTruthy();
    expect(body.querySelectorAll('ul li')).toHaveLength(2);
    expect(body.querySelector('a[href="https://example.com"]')).toBeTruthy();
    expect(body.querySelector('strong')).toBeTruthy();
    expect(body.querySelector('table')).toBeTruthy();

    const lines = await echo('line one\nline two\nline three');
    const p = lines.bubble.querySelectorAll('[data-user-text] p');
    expect(p).toHaveLength(1);
    expect(p[0].textContent).toBe('line one\nline two\nline three');
  });

  it('HTML-looking text renders literally, never as elements', async () => {
    const { bubble } = await echo('<pasted_content id="1">\n<b>x</b><script>alert(1)</script>\n</pasted_content>');
    expect(bubble.querySelector('b')).toBeNull();
    expect(bubble.querySelector('script')).toBeNull();
    expect(bubble.textContent).toContain('<pasted_content id="1">');
  });

  it('the raw/md toggle switches views and copy always yields the raw source', async () => {
    const src = '**bold** and `code`';
    const { bubble } = await echo(src);
    const ui = within(bubble);
    fireEvent.click(ui.getByRole('button', { name: 'Show raw text' }));
    expect(bubble.querySelector('[data-view="raw"]')!.textContent).toBe(src);
    fireEvent.click(ui.getByRole('button', { name: 'Copy message' }));
    fireEvent.click(ui.getByRole('button', { name: 'Show rendered markdown' }));
    expect(bubble.querySelector('strong')).toBeTruthy();
    fireEvent.click(ui.getByRole('button', { name: 'Copy message' }));
    await flush();
    expect(copied).toEqual([src, src]);
  });

  it('a transcribed prompt strips the marker everywhere and shows the voice badge; a plain one has no badge', async () => {
    const t = await echo('<transcribed>\n**hi**');
    expect(t.bubble.textContent).not.toContain('<transcribed>');
    expect((t.m.items[0] as UserNode).transcribed).toBe(true);
    expect(t.bubble.querySelector('.lucide-mic')).toBeTruthy();
    fireEvent.click(within(t.bubble).getByRole('button', { name: 'Copy message' }));
    await flush();
    expect(copied).toEqual(['**hi**']);
    const p = await echo('hello');
    expect(p.bubble.querySelector('.lucide-mic')).toBeNull();
  });
});

describe('wake-callback bubbles', () => {
  const PAYLOAD = '{"sessionId":"abc12345","source":"live"}\n--- message 1/1 ---\n**bold** prose\n\n- item a';
  const STUB = buildWakeStub({ targetSessionId: 'abc12345', payloadText: PAYLOAD });

  it('folds the payload; the summary names the worker; the marker never shows; nothing is built until expanded', async () => {
    const { bubble } = await echo(STUB);
    expect(bubble.getAttribute('data-variant')).toBe('wake');
    const fold = bubble.querySelector('[data-fold="wake"]')!;
    expect(fold.getAttribute('data-state')).toBe('closed');
    expect(fold.querySelector('[data-fold-title]')!.textContent).toContain('abc12345');
    expect(bubble.textContent).not.toContain(WAKE_CALLBACK_MARKER);
    expect(fold.querySelector('.md')).toBeNull();
    expect(bubble.querySelector('[data-user-text]')).toBeNull();
    await expand(fold);
    expect(fold.querySelector('[data-wake-meta]')!.textContent).toBe('{"sessionId":"abc12345","source":"live"}');
    expect(fold.querySelector('.md strong')).toBeTruthy();
  });

  it('a jobs note shows its lines in the summary, kept as lines; the body is unchanged', async () => {
    const JOBS = 'Background jobs still running:\n- "npm test" — running 2m5s\nWorker `abc12345` is re-invoked when each job exits.';
    const withJobs = await echo(buildWakeStub({ targetSessionId: 'abc12345', payloadText: PAYLOAD, jobsNote: JOBS }));
    const title = withJobs.bubble.querySelector('[data-fold-title]')!;
    expect(title.textContent).toContain('\n- "npm test" — running 2m5s\n');
    const without = await echo(STUB);
    expect(without.bubble.querySelector('[data-fold-title]')!.textContent).not.toContain('Background jobs');
  });

  it('a body-less stub is one plain line with no fold and no controls', async () => {
    const { bubble } = await echo(markPlainStub('Worker `abc12345` finished its turn.'));
    expect(bubble.querySelector('[data-fold]')).toBeNull();
    const line = bubble.querySelector('[data-wake-plain]')!;
    expect(line.textContent).toMatch(/finished its turn/);
    expect(bubble.textContent).not.toContain(WAKE_CALLBACK_MARKER);
    expect(within(bubble).queryByRole('button', { name: 'Copy message' })).toBeNull();
  });

  it('raw view and copy of the expanded body yield the exact payload', async () => {
    const { bubble } = await echo(STUB);
    const fold = bubble.querySelector('[data-fold="wake"]')!;
    await expand(fold);
    fireEvent.click(within(fold as HTMLElement).getByRole('button', { name: 'Show raw text' }));
    expect(fold.querySelector('[data-view="raw"]')!.textContent).toBe(PAYLOAD);
    fireEvent.click(within(fold as HTMLElement).getByRole('button', { name: 'Copy text' }));
    await flush();
    expect(copied).toEqual([PAYLOAD]);
  });
});

describe('renew-seed bubbles', () => {
  const S = RENEW_SUMMARY_SECTIONS;
  const STATE = `${MECHANICAL_STATE_HEADER}\nWorkers you own (their next turn wakes you):\n  (none)`;
  const SEED = buildRenewSeed({
    summary: `## ${S.roster}\nworker abc12345 is on task 1\n\n## ${S.completed}\nlanded the migration\n\n## ${S.userContext}\nprefers terse replies`,
    followUp: 'MARK-D: keep going on the migration',
    stateBlock: STATE,
  });

  it('renders a collapsed renew bubble, not a plain body, built on first expand', async () => {
    const { bubble } = await echo(SEED);
    expect(bubble.getAttribute('data-variant')).toBe('renew');
    const fold = bubble.querySelector('[data-fold="renew"]')!;
    expect(fold.getAttribute('data-state')).toBe('closed');
    expect(fold.textContent).toMatch(/Context renewed/);
    expect(bubble.querySelector('[data-user-text]')).toBeNull();
    expect(fold.querySelector('section')).toBeNull();
  });

  it('expanding shows one labelled section per heading, then the follow-up and the literal mechanical state', async () => {
    const { bubble } = await echo(SEED);
    const fold = bubble.querySelector('[data-fold="renew"]')!;
    await expand(fold);
    const labels = [...fold.querySelectorAll('section > div:first-child')].map((n) => n.textContent);
    expect(labels).toEqual([S.roster, S.completed, S.userContext, "Conductor's follow-up directive", 'Mechanical state (server-generated)']);
    const state = [...fold.querySelectorAll('section')].at(-1)!.querySelector('pre')!;
    expect(state.textContent).toContain('Workers you own');
    expect(state.querySelector('strong, li')).toBeNull();
  });

  it('a summary without template headings is one Handoff summary section', async () => {
    const { bubble } = await echo(buildRenewSeed({ summary: 'just some free-form prose with no headings at all.' }));
    const fold = bubble.querySelector('[data-fold="renew"]')!;
    await expand(fold);
    expect([...fold.querySelectorAll('section > div:first-child')].map((n) => n.textContent)).toEqual(['Handoff summary']);
  });

  it('raw view and copy yield the exact seed', async () => {
    const { bubble } = await echo(SEED);
    const fold = bubble.querySelector('[data-fold="renew"]')! as HTMLElement;
    await expand(fold);
    fireEvent.click(within(fold).getByRole('button', { name: 'Show raw text' }));
    expect(fold.querySelector('[data-view="raw"]')!.textContent).toBe(SEED);
    fireEvent.click(within(fold).getByRole('button', { name: 'Copy text' }));
    await flush();
    expect(copied).toEqual([SEED]);
  });

  it('ordinary prompts, forward frames embedding a seed and wake stubs are not renew seeds', async () => {
    expect((await echo('hello')).bubble.getAttribute('data-variant')).toBe('plain');
    const fwd = buildForwardFrame({ messages: [buildRenewSeed({ summary: 'embedded' })], instruction: 'please review this' });
    expect((await echo(fwd)).bubble.getAttribute('data-variant')).toBe('forward');
    expect((await echo(buildWakeStub({ targetSessionId: 'abc12345', payloadText: 'line1\nline2' }))).bubble.getAttribute('data-variant')).toBe('wake');
  });
});

describe('forward-frame bubbles', () => {
  const MESSAGES = ['first message with **x**', '--- plan · saved to /tmp/plans/demo.md ---\n# Plan: demo\n\n- step one', '--- questions ---\n1. Q one'];
  const INSTRUCTION = 'Please review and respond.';
  const FRAME = buildForwardFrame({ messages: MESSAGES, instruction: INSTRUCTION });

  it('folds the payload with a message count and keeps the instruction outside as ordinary text', async () => {
    const { bubble } = await echo(FRAME);
    expect(bubble.getAttribute('data-variant')).toBe('forward');
    const fold = bubble.querySelector('[data-fold="forward"]')!;
    expect(fold.getAttribute('data-state')).toBe('closed');
    expect(fold.textContent).toMatch(/Forwarded worker output · 3 messages/);
    expect(bubble.querySelector('[data-user-text]')!.textContent).toBe(INSTRUCTION);
    expect(fold.querySelector('section')).toBeNull();
    const one = await echo(buildForwardFrame({ messages: ['only'], instruction: 'go' }));
    expect(one.bubble.textContent).toMatch(/· 1 message(?!s)/);
  });

  it('expanding renders one labelled markdown section per message (singular label for one)', async () => {
    const { bubble } = await echo(FRAME);
    const fold = bubble.querySelector('[data-fold="forward"]')!;
    await expand(fold);
    expect([...fold.querySelectorAll('section > div:first-child')].map((n) => n.textContent)).toEqual(['Message 1/3', 'Message 2/3', 'Message 3/3']);
    expect(fold.querySelector('section strong')!.textContent).toBe('x');
    const one = await echo(buildForwardFrame({ messages: ['only'], instruction: 'go' }));
    const f1 = one.bubble.querySelector('[data-fold="forward"]')!;
    await expand(f1);
    expect([...f1.querySelectorAll('section > div:first-child')].map((n) => n.textContent)).toEqual(['Forwarded output']);
  });

  it('an unclosed code fence in one message does not swallow the next', async () => {
    const { bubble } = await echo(buildForwardFrame({ messages: ['```js\nconst a = 1;', 'second message'], instruction: 'go' }));
    const fold = bubble.querySelector('[data-fold="forward"]')!;
    await expand(fold);
    expect(fold.querySelectorAll('section')).toHaveLength(2);
    expect(fold.querySelectorAll('section')[1].textContent).toContain('second message');
  });

  it('each copy yields what its view shows: the payload in the fold, the instruction on the bubble', async () => {
    const { bubble } = await echo(FRAME);
    const fold = bubble.querySelector('[data-fold="forward"]')! as HTMLElement;
    await expand(fold);
    fireEvent.click(within(fold).getByRole('button', { name: 'Copy text' }));
    fireEvent.click(within(bubble).getByRole('button', { name: 'Copy message' }));
    await flush();
    expect(copied[1]).toBe(INSTRUCTION);
    expect(copied[0]).toContain('first message with **x**');
    expect(copied[0]).not.toContain(INSTRUCTION);
  });

  it('an empty instruction adds no user-text block; a skill-load echo opening with the frame header is a skill bubble only', async () => {
    const empty = await echo(buildForwardFrame({ messages: ['out'], instruction: '' }));
    expect(empty.bubble.querySelector('[data-user-text]')).toBeNull();
    const skill = await echo(FRAME, { skillLoad: { skill: 'demo' } });
    expect(skill.bubble.querySelector('[data-fold="skill"]')).toBeTruthy();
    expect(skill.bubble.querySelector('[data-fold="forward"]')).toBeNull();
  });
});

describe('skill-load bubbles', () => {
  const SKILL_TEXT = '# Keybindings\n\nUse **this** skill when…';

  it('a skillLoad-tagged echo is a collapsed skill bubble; an untagged synthetic message stays plain', async () => {
    const { bubble } = await echo(SKILL_TEXT, { skillLoad: { skill: 'keybindings-help' } });
    const fold = bubble.querySelector('[data-fold="skill"]')!;
    expect(fold.textContent).toContain('Loading skill: keybindings-help');
    expect(fold.getAttribute('data-state')).toBe('closed');
    expect(fold.querySelector('.md')).toBeNull();
    expect(bubble.querySelector('[data-user-text]')).toBeNull();
    const plain = await echo(SKILL_TEXT, { isSynthetic: true });
    expect(plain.bubble.querySelector('[data-fold]')).toBeNull();
    expect(plain.bubble.querySelector('[data-user-text]')).toBeTruthy();
  });

  it('expands to markdown (no meta line); raw is the exact source and copy returns it', async () => {
    const { bubble } = await echo(SKILL_TEXT, { skillLoad: { skill: 'k' } });
    const fold = bubble.querySelector('[data-fold="skill"]')! as HTMLElement;
    await expand(fold);
    expect(fold.querySelector('.md h1')!.textContent).toBe('Keybindings');
    expect(fold.querySelector('[data-wake-meta]')).toBeNull();
    fireEvent.click(within(fold).getByRole('button', { name: 'Show raw text' }));
    expect(fold.querySelector('[data-view="raw"]')!.textContent).toBe(SKILL_TEXT);
    fireEvent.click(within(fold).getByRole('button', { name: 'Copy text' }));
    await flush();
    expect(copied).toEqual([SKILL_TEXT]);
  });
});
