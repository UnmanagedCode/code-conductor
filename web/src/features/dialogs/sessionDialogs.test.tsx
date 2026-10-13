import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/app/controller', () => ({
  refreshProjects: vi.fn(async () => {}),
  refreshInstances: vi.fn(async () => {}),
  selectInstance: vi.fn(),
  send: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  performProjectDelete: vi.fn(async () => {}),
  applySessionTitle: vi.fn(async () => 't'),
}));
vi.mock('@shared/capabilities', () => ({
  loadCapabilities: vi.fn(async () => ({ remoteSystems: true, voice: true, fuseUnion: true })),
  capabilities: () => null,
}));
vi.mock('@/ui/feedback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui/feedback')>()),
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { DialogsHost } from './DialogsHost';
import { closeDialog, dialogStore, openPruneDialog, openRenameDialog, openStatsDialog, openSummaryDialog } from './api';
import { routeFetch, type RoutedCall } from '@/test/routeFetch';
import { applySessionTitle } from '@/app/sessionActions';
import { refreshInstances } from '@/app/controller';
import { toast } from '@/ui/feedback';
import type { PruneAnalysis, PruneTurn } from './pruneMath';

afterEach(() => {
  for (const k of Object.keys(dialogStore.get()) as (keyof ReturnType<typeof dialogStore.get>)[]) closeDialog(k);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const writes = (calls: RoutedCall[]) => calls.filter((c) => c.method !== 'GET');

describe('session summary', () => {
  const SUMMARY = {
    title: { summary: 'Demo: ship the parity port', isStale: false },
    short: { summary: 'Short gist.', isStale: false },
    medium: { summary: '## Recap\n\nShipped **three** dialogs.\n\n| a | b |\n|---|---|\n| 1 | 2 |', isStale: true },
  };
  const tier = (t: string) => document.querySelector<HTMLButtonElement>(`[data-len="${t}"]`)!;
  const content = () => document.querySelector('[data-summary-content]')!;

  it('opens on Medium with its cached summary rendered as markdown, offering all four tiers, and no cost', async () => {
    // Invariant: the dialog offers each of the four tiers once, opens on the cached Medium tier alone pressed (not the first cached tier), renders it through the markdown pipeline, and shows no cost before a generation.
    const data = SUMMARY;
    routeFetch({ 'GET /api/sessions/s1/summary': () => ({ json: { ok: true, sessionId: 's1', data } }) });
    render(<DialogsHost />);
    act(() => openSummaryDialog('s1'));
    await screen.findByText('Recap');
    const lens = [...document.querySelectorAll('[data-len]')].map((b) => b.getAttribute('data-len'));
    expect([...lens].sort()).toEqual(['long', 'medium', 'short', 'title']);
    const pressed = [...document.querySelectorAll('[data-len]')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-len'));
    expect(pressed).toEqual(['medium']);
    expect(content().querySelector('h2')?.textContent).toBe('Recap');
    expect(content().querySelector('strong')?.textContent).toBe('three');
    expect(content().querySelector('table')).not.toBeNull();
    expect(document.querySelector('[data-cost]')).toBeNull();
  });

  it('the stale warning shows on a stale tier and goes on a fresh one', async () => {
    // Invariant: the stale warning follows the selected tier's isStale flag, both ways.
    const data = SUMMARY;
    routeFetch({ 'GET /api/sessions/s1/summary': () => ({ json: { ok: true, sessionId: 's1', data } }) });
    render(<DialogsHost />);
    act(() => openSummaryDialog('s1'));
    await screen.findByText('Recap');
    expect(document.querySelector('[data-stale]')?.textContent).toBe('The session has grown since this summary');
    fireEvent.click(tier('short'));
    expect(document.querySelector('[data-stale]')).toBeNull();
    fireEvent.click(tier('medium'));
    expect(document.querySelector('[data-stale]')?.textContent).toBe('The session has grown since this summary');
  });

  it('with nothing cached it offers Generate summary and posts nothing until asked', async () => {
    // Invariant: opening the dialog never generates; only the Generate click posts, with the selected tier.
    const data = {};
    const calls = routeFetch({ 'GET /api/sessions/s1/summary': () => ({ json: { ok: true, sessionId: 's1', data } }) });
    render(<DialogsHost />);
    act(() => openSummaryDialog('s1'));
    await screen.findByText(/No medium summary yet/);
    await act(async () => {});
    expect(content().textContent).toBe("No medium summary yet. Generate one; it runs a short model pass on this session's transcript.");
    const generate = screen.getByRole('button', { name: 'Generate summary' });
    expect(writes(calls)).toEqual([]);
    fireEvent.click(generate);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: 'POST', url: '/api/sessions/s1/summary', body: { length: 'medium' } });
  });

  it('Regenerate posts the selected tier and shows the returned cost, which a tier switch, a reopen or a null cost clears', async () => {
    // Invariant: the cost shows after a generation that returned a cost, and is cleared by a tier click, a reopen, and a null cost.
    const data = SUMMARY;
    let cost: number | null = 0.0123;
    const calls = routeFetch({
      'GET /api/sessions/s1/summary': () => ({ json: { ok: true, sessionId: 's1', data } }),
      'POST /api/sessions/s1/summary': () => ({ json: { ok: true, data: { ...SUMMARY, short: { summary: 'Fresh gist.', isStale: false } }, costUsd: cost } }),
    });
    render(<DialogsHost />);
    act(() => openSummaryDialog('s1'));
    await screen.findByText('Recap');
    fireEvent.click(tier('short'));
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await waitFor(() => expect(document.querySelector('[data-cost]')?.textContent).toBe('Cost: $0.0123'));
    expect(writes(calls).map((c) => [c.method, c.body])).toEqual([['POST', { length: 'short' }]]);
    expect(content().textContent).toContain('Fresh gist.');

    fireEvent.click(tier('medium'));
    expect(document.querySelector('[data-cost]')).toBeNull();

    fireEvent.click(tier('short'));
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await waitFor(() => expect(document.querySelector('[data-cost]')?.textContent).toBe('Cost: $0.0123'));
    act(() => closeDialog('summary'));
    act(() => openSummaryDialog('s1'));
    await screen.findByText('Recap');
    expect(document.querySelector('[data-cost]')).toBeNull();

    cost = null;
    fireEvent.click(tier('short'));
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(3));
    await screen.findByRole('button', { name: 'Regenerate' });
    expect(document.querySelector('[data-cost]')).toBeNull();
  });

  it('a Regenerate answer whose cost is not a number shows no cost line', async () => {
    // Invariant: the cost line shows only for a numeric costUsd; a truthy non-number such as the string '0.5' shows none.
    const data = SUMMARY;
    let n = 0;
    let cost: unknown = 0.0123;
    const calls = routeFetch({
      'GET /api/sessions/s1/summary': () => ({ json: { ok: true, sessionId: 's1', data } }),
      'POST /api/sessions/s1/summary': () => {
        n++;
        return { json: { ok: true, data: { ...SUMMARY, short: { summary: `Gist ${n}.`, isStale: false } }, costUsd: cost } };
      },
    });
    render(<DialogsHost />);
    act(() => openSummaryDialog('s1'));
    await screen.findByText('Recap');
    fireEvent.click(tier('short'));
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await screen.findByText('Gist 1.');
    expect(document.querySelector('[data-cost]')?.textContent).toBe('Cost: $0.0123');

    cost = '0.5';
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await screen.findByText('Gist 2.');
    await screen.findByRole('button', { name: 'Regenerate' });
    expect(writes(calls)).toHaveLength(2);
    expect(document.querySelector('[data-cost]')).toBeNull();
  });

  it('Use as session title shows only on a cached Title tier and applies that title', async () => {
    // Invariant: Use as session title renders only when the Title tier is selected and cached, and applies the Title tier's text.
    let data: Record<string, unknown> = SUMMARY;
    routeFetch({ 'GET /api/sessions/s1/summary': () => ({ json: { ok: true, sessionId: 's1', data } }) });
    render(<DialogsHost />);
    act(() => openSummaryDialog('s1'));
    await screen.findByText('Recap');
    expect(screen.queryByRole('button', { name: /Use as session title/ })).toBeNull();
    fireEvent.click(tier('title'));
    fireEvent.click(screen.getByRole('button', { name: /Use as session title/ }));
    await waitFor(() => expect(applySessionTitle).toHaveBeenCalledWith('s1', 'Demo: ship the parity port'));
    const applied = await screen.findByRole('button', { name: /Applied/ });
    expect(applied.textContent?.trim()).toBe('Applied');
    expect((applied as HTMLButtonElement).disabled).toBe(true);

    act(() => closeDialog('summary'));
    data = { medium: SUMMARY.medium };
    act(() => openSummaryDialog('s1'));
    await screen.findByText('Recap');
    fireEvent.click(tier('title'));
    expect(screen.queryByRole('button', { name: /Use as session title/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Generate summary' })).toBeTruthy();
  });
});

describe('session rename', () => {
  const input = () => screen.getByRole('textbox', { name: 'Session title' }) as HTMLInputElement;
  const open = () => {
    routeFetch({});
    render(<DialogsHost />);
    act(() => openRenameDialog('s1', 'Old title'));
  };

  it('saving sends the trimmed title and closes', async () => {
    // Invariant: the field is prefilled with the current title, and Save sends the trimmed new title, then closes.
    open();
    expect(input().value).toBe('Old title');
    fireEvent.change(input(), { target: { value: '  New title  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(applySessionTitle).toHaveBeenCalledWith('s1', 'New title'));
    await waitFor(() => expect(dialogStore.get().rename).toBeNull());
  });

  it('a title over 100 characters is cut to 100 before it is sent, and the field caps typing at 100', async () => {
    // Invariant: the rename dialog itself cuts the title to 100 characters before sending, and the field's maxlength is 100.
    open();
    expect(input().maxLength).toBe(100);
    fireEvent.change(input(), { target: { value: 'x'.repeat(120) } });
    fireEvent.submit(input().closest('form') as HTMLFormElement);
    await waitFor(() => expect(applySessionTitle).toHaveBeenCalledWith('s1', 'x'.repeat(100)));
  });

  it('an empty title is sent as empty, which clears the title', async () => {
    // Invariant: a blank title is sent as the empty string, not treated as a no-op or refused.
    open();
    fireEvent.change(input(), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(applySessionTitle).toHaveBeenCalledWith('s1', ''));
    await waitFor(() => expect(dialogStore.get().rename).toBeNull());
  });

  it('an unchanged title closes without a request', async () => {
    // Invariant: a title equal to the current one once trimmed closes the dialog without sending anything.
    open();
    fireEvent.change(input(), { target: { value: '  Old title ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(dialogStore.get().rename).toBeNull());
    expect(applySessionTitle).not.toHaveBeenCalled();
  });

  it('a refused rename shows the reason and keeps the dialog open', async () => {
    // Invariant: a failed rename shows the server's reason and leaves the dialog open.
    vi.mocked(applySessionTitle).mockRejectedValueOnce(new Error('session not found'));
    open();
    fireEvent.change(input(), { target: { value: 'New title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Rename failed: session not found');
    expect(dialogStore.get().rename).not.toBeNull();
  });
});

describe('prune context', () => {
  const turn = (o: Partial<PruneTurn> = {}): PruneTurn => ({ thinking: 30, toolInputTruncatable: 10, toolInputMinimal: 20, toolOutput: 100, toolOutputImage: 0, exempt: 0, ...o });
  const analysis = (n: number, over: Partial<PruneAnalysis> = {}): PruneAnalysis => ({
    turnCount: n, turns: Array.from({ length: n }, () => turn()), encryptedThinking: 0,
    contextTokens: 50_000, calibration: { factor: 1, calibrated: true }, ...over,
  });
  let current: PruneAnalysis;
  const route = () => routeFetch({
    'GET /api/instances/i1/prune/analysis': () => ({ json: current }),
    'POST /api/instances/i1/prune': () => ({ json: { ok: true } }),
  });
  const range = () => document.getElementById('pd-cut') as HTMLInputElement;
  const loaded = () => waitFor(() => expect(range()).not.toBeNull());
  const thinking = () => screen.getByRole('checkbox', { name: 'Prune all thinking blocks' });
  const minimal = () => screen.getByRole('checkbox', { name: 'Minimal tool inputs' });
  const pruneBtn = () => screen.getByRole('button', { name: /^Prune$/ }) as HTMLButtonElement;
  const thinkingCells = () => [...document.querySelector('[data-savings] tr')!.querySelectorAll('td')].map((td) => td.textContent);

  it('the slider runs from 0 to the turn count and starts at about 90%, short of the newest turn', async () => {
    // Invariant: the cut slider spans 0..turnCount and starts at defaultCut (18 of 20), not at turnCount-1 or turnCount.
    current = analysis(20);
    route();
    render(<DialogsHost />);
    act(() => openPruneDialog('i1'));
    await loaded();
    expect(range().min).toBe('0');
    expect(range().max).toBe('20');
    expect(range().value).toBe('18');
    expect(document.querySelector('[data-cut-label]')?.textContent).toBe('18 of 20');
  });

  it('thinking starts ticked and minimal inputs unticked, and Prune sends the cut, the thinking choice and the input mode', async () => {
    // Invariant: the POST carries exactly the slider's cut, the thinking box and the minimal box as inputMode, then refreshes, toasts and closes.
    current = analysis(20);
    const calls = route();
    render(<DialogsHost />);
    act(() => openPruneDialog('i1'));
    await loaded();
    expect(thinking().getAttribute('aria-checked')).toBe('true');
    expect(minimal().getAttribute('aria-checked')).toBe('false');
    fireEvent.click(pruneBtn());
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0].body).toEqual({ cutTurnIndex: 18, pruneThinking: true, inputMode: 'truncate' });
    await waitFor(() => expect(dialogStore.get().prune).toBeNull());
    expect(refreshInstances).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Context pruned', 'The original session is archived and stays resumable.');

    act(() => openPruneDialog('i1'));
    await loaded();
    fireEvent.change(range(), { target: { value: '20' } });
    expect(document.querySelector('[data-cut-label]')?.textContent).toBe('20 of 20');
    fireEvent.click(thinking());
    fireEvent.click(minimal());
    fireEvent.click(pruneBtn());
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)[1].body).toEqual({ cutTurnIndex: 20, pruneThinking: false, inputMode: 'minimal' });
  });

  it('a visible thinking saving reads as tokens even when encrypted thinking is present', async () => {
    // Invariant: the Thinking row shows the visible-thinking saving in tokens whenever it is non-zero; the encrypted note appears only when that saving is zero.
    current = analysis(20, { encryptedThinking: 500 });
    route();
    render(<DialogsHost />);
    act(() => openPruneDialog('i1'));
    await loaded();
    let cells = thinkingCells();
    expect(cells).toHaveLength(2);
    expect(cells[0]).toContain('Thinking');
    expect(cells[1]).toMatch(/\b600\b.*tokens/);
    expect(cells[1]).not.toMatch(/encrypted/);
    fireEvent.click(thinking());
    cells = thinkingCells();
    expect(cells[0]).toContain('Thinking');
    expect(cells[1]).toMatch(/encrypted/);
    expect(cells[1]).toMatch(/\b500\b/);
    expect(cells[1]).not.toMatch(/\b600\b/);
  });

  it('Prune is disabled while the selection saves nothing, and enabled again once it saves something', async () => {
    // Invariant: with an analysis loaded, a selection whose estimated total saving is zero (the totals row's figure reads 0, where the opening selection's does not) disables Prune and sends nothing; a non-zero saving enables it.
    current = analysis(20);
    const calls = route();
    render(<DialogsHost />);
    act(() => openPruneDialog('i1'));
    await loaded();
    const totals = () => [...[...document.querySelectorAll('[data-savings] tr')].at(-1)!.querySelectorAll('td')].map((td) => td.textContent ?? '');
    const figure = () => totals()[1].replace(/\D/g, '');
    expect(pruneBtn().disabled).toBe(false);
    expect(totals()[0]).toMatch(/total/i);
    expect(figure()).not.toBe('0');
    fireEvent.change(range(), { target: { value: '0' } });
    fireEvent.click(thinking());
    expect(document.querySelector('[data-cut-label]')?.textContent).toMatch(/\b0\b.*\b20\b/);
    expect(thinking().getAttribute('aria-checked')).toBe('false');
    expect(totals()[0]).toMatch(/total/i);
    expect(figure()).toBe('0');
    expect(pruneBtn().disabled).toBe(true);
    fireEvent.click(pruneBtn());
    await act(async () => {});
    expect(writes(calls)).toEqual([]);

    fireEvent.click(thinking());
    expect(pruneBtn().disabled).toBe(false);
    fireEvent.click(pruneBtn());
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0].body).toEqual({ cutTurnIndex: 0, pruneThinking: true, inputMode: 'truncate' });
  });

  it('a session with no completed turns says so and cannot be pruned, while a one-turn session can', async () => {
    // Invariant: turnCount 0 is refused with an alert saying there are no completed turns, no slider and a disabled Prune; turnCount 1 is offered with no alert.
    current = analysis(0);
    route();
    render(<DialogsHost />);
    act(() => openPruneDialog('i1'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/no completed turns/i);
    expect(range()).toBeNull();
    expect(pruneBtn().disabled).toBe(true);

    act(() => closeDialog('prune'));
    current = analysis(1);
    act(() => openPruneDialog('i1'));
    await loaded();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(range().max).toBe('1');
    expect(pruneBtn().disabled).toBe(false);
  });
});

describe('session statistics', () => {
  const own = { cost_usd: 1.2345, duration_api_ms: 65_000, duration_ms: 125_000 };
  const rolled = { cost_usd: 9 };
  const open = async (workerSessions: number) => {
    const stats = { own, rolled, workerSessions };
    routeFetch({ 'GET /api/costs/session/s1': () => ({ json: stats }) });
    render(<DialogsHost />);
    act(() => openStatsDialog('s1'));
    await waitFor(() => expect(document.querySelector('[data-stats-table]')).not.toBeNull());
  };
  const heads = () => [...document.querySelectorAll('[data-stats-table] thead th')].map((th) => th.textContent);
  const rows = () => [...document.querySelectorAll('[data-stats-table] tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
  const description = () => screen.getByText(/^Spend and time for this session/).textContent;

  it('with no workers it shows This session alone and the no-workers note', async () => {
    // Invariant: with zero workers only the label column and This session render, each metric row carries the session's own figure, the rolled-up figures stay hidden, the no-workers note shows, and the description does not mention workers.
    await open(0);
    expect(heads()).toHaveLength(2);
    expect(heads()[1]).toContain('This session');
    const r = rows();
    expect(r.map((row) => row.length)).toEqual([2, 2, 2]);
    expect(r[0][0]).toMatch(/cost/i);
    expect(r[0][1]).toContain('1.2345');
    expect(r[1][1]).toMatch(/1m\s*5s/);
    expect(r[2][1]).toMatch(/2m\s*5s/);
    expect(r.flat().some((t) => /\b9\b/.test(t ?? ''))).toBe(false);
    expect(screen.getByText(/no worker sessions/i)).toBeTruthy();
    expect(description()).not.toMatch(/worker/i);
  });

  it('with one worker it adds the Incl. 1 worker column beside This session and drops the note', async () => {
    // Invariant: with workers a third column renders, its header counting one worker in the singular, the Cost row carrying the session's own and the rolled-up figure under their headers; the no-workers note is gone and the description mentions the workers.
    await open(1);
    expect(heads()).toHaveLength(3);
    expect(heads()[1]).toContain('This session');
    expect(heads()[2]).toMatch(/\b1 worker\b/);
    expect(rows()[0]).toHaveLength(3);
    expect(rows()[0][1]).toContain('1.2345');
    expect(rows()[0][2]).toMatch(/\b9\b/);
    expect(screen.queryByText(/no worker sessions/i)).toBeNull();
    expect(description()).toMatch(/worker/i);
  });
});
