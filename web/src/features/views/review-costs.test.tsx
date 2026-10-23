import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FileCard, fileDiffUrl, reviewStats } from './ReviewView';
import { CONDUCTOR_LABEL } from '@shared/conductors';
import { CostsBody, modelCells, niceTicks, type CostsSummary, type ModelRow } from './CostsView';

afterEach(() => vi.unstubAllGlobals());

const SUMMARY_URL = '/api/projects/p/worktrees/w/diff';

describe('review', () => {
  it('adds the file path to the summary URL for one file\'s hunks', () => {
    expect(fileDiffUrl(SUMMARY_URL, 'src/a b.ts')).toBe('/api/projects/p/worktrees/w/diff?path=src%2Fa+b.ts');
    expect(fileDiffUrl('/api/x/diff?context=3', 'f')).toBe('/api/x/diff?context=3&path=f');
  });

  it('summarises totals', () => {
    expect(reviewStats({ totalAdds: 3, totalDels: 1, totalFiles: 2 })).toBe('+3 · −1 · 2 files');
  });

  it('fetches nothing until expanded, then exactly one request for that file, and renders its hunks', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ file: { hunks: [{ header: '@@ -1 +1 @@', lines: [{ type: 'del', content: 'old' }, { type: 'add', content: 'new' }] }] } })));
    vi.stubGlobal('fetch', fetchMock);
    render(<FileCard file={{ path: 'a.ts', status: 'modified', adds: 1, dels: 1 }} summaryUrl={SUMMARY_URL} />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    await screen.findByText('@@ -1 +1 @@');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([...document.querySelectorAll('[data-diff-line]')].map((n) => n.getAttribute('data-diff-line'))).toEqual(['del', 'add']);
    fireEvent.click(screen.getByRole('button', { expanded: true }));
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a failed per-file fetch shows an error with a working retry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ file: { hunks: [{ header: '@@ h @@', lines: [] }] } })));
    vi.stubGlobal('fetch', fetchMock);
    render(<FileCard file={{ path: 'a.ts' }} summaryUrl={SUMMARY_URL} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    await screen.findByText(/Failed to load diff: boom/);
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await screen.findByText('@@ h @@');
  });

  it('an oversized file shows a note and no lines; a binary file needs no fetch', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ file: { hunks: [], oversized: true, adds: 9000, dels: 2 } })));
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = render(<FileCard file={{ path: 'big' }} summaryUrl={SUMMARY_URL} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    await screen.findByText(/Diff too large/);
    expect(document.querySelector('[data-diff-line]')).toBeNull();
    unmount();
    fetchMock.mockClear();
    render(<FileCard file={{ path: 'img.png', binary: true }} summaryUrl={SUMMARY_URL} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    await screen.findByText(/Binary file/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const model = (over: Partial<ModelRow>): ModelRow => ({
  model: 'm', cost_usd: 0.5, input_tokens: 1200, output_tokens: 300, cache_creation_tokens: 0, cache_read_tokens: 5000,
  tokens_known: true, turns: 2, sessions: 1, cache_misses: 0, duration_api_ms: 1000, duration_ms: 2000, ...over,
});

describe('costs', () => {
  it('renders — for token cells of a group with no usage-bearing turn, numbers otherwise', () => {
    expect(modelCells(model({ tokens_known: false })).slice(2, 6)).toEqual(['—', '—', '—', '—']);
    expect(modelCells(model({})).slice(2, 6)).toEqual(['1.2k', '300', '0', '5.0k']);
  });

  it('names a group\'s input and cache-read cells estimated when its cache split is, and no other cell', () => {
    const data: CostsSummary = {
      total_usd: 0, row_count: 2, by_project: [],
      by_model: [model({ model: 'est', cost_usd: 0, tokens_estimated: true }), model({ model: 'real', cost_usd: 0 })],
      daily_trend: [],
    };
    render(<TooltipProvider><CostsBody data={data} metric="cost" onMetricChange={() => {}} /></TooltipProvider>);
    const row = (name: string) => screen.getAllByRole('row').find((r) => r.querySelector('td')?.textContent === name)!;
    const estCells = within(row('est')).getAllByRole('cell');
    const named = within(row('est')).getAllByRole('cell', { name: /estimated/ });
    expect(named.map((c) => estCells.indexOf(c))).toEqual([2, 5]);
    expect(named.map((c) => c.textContent)).toEqual([expect.stringContaining('1.2k'), expect.stringContaining('5.0k')]);
    expect(within(row('real')).queryAllByRole('cell', { name: /estimated/ })).toEqual([]);
  });

  it('renders every money figure as $N.NNNN', () => {
    const data: CostsSummary = {
      total_usd: 1.23456, row_count: 3,
      by_project: [{ project: 'p', cost_usd: 1.2, turns: 3, sessions: 1, cache_misses: 0, duration_api_ms: 10, duration_ms: 20, by_model: [model({})] }],
      by_model: [model({})],
      daily_trend: [{ date: '2026-10-01', cost_usd: 1.23456, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, tokens_known: false, tokens_estimated: false }],
    };
    render(<TooltipProvider><CostsBody data={data} metric="cost" onMetricChange={() => {}} /></TooltipProvider>);
    const cells = [...document.querySelectorAll('td, [data-costs-total] div')].map((n) => n.textContent ?? '').filter((t) => t.startsWith('$'));
    expect(cells.length).toBeGreaterThan(2);
    for (const c of cells) expect(c).toMatch(/^\$\d+\.\d{4}$/);
    expect(screen.getAllByText('$1.2346').length).toBeGreaterThan(0);
    fireEvent.click(document.querySelector('[data-cost-project="p"]')!);
    expect(screen.getAllByText('1.2k').length).toBeGreaterThan(0);
  });

  it('labels the conductor project row Conductor while its data attribute keeps the raw name', () => {
    // Invariant: the visible row text is CONDUCTOR_LABEL; data-cost-project stays `.conduct` (an identifier, not a label).
    const data: CostsSummary = {
      total_usd: 1, row_count: 1,
      by_project: [{ project: '.conduct', cost_usd: 1, turns: 1, sessions: 1, cache_misses: 0, duration_api_ms: 10, duration_ms: 20, by_model: [model({})] }],
      by_model: [model({})], daily_trend: [],
    };
    render(<TooltipProvider><CostsBody data={data} metric="cost" onMetricChange={() => {}} /></TooltipProvider>);
    const row = document.querySelector('[data-cost-project=".conduct"]') as HTMLElement;
    expect(row.textContent).toContain(CONDUCTOR_LABEL);
    expect(row.textContent).not.toContain('.conduct');
  });

  it('says so when nothing has been recorded', () => {
    render(<CostsBody data={{ total_usd: 0, row_count: 0, by_project: [], by_model: [], daily_trend: [] }} metric="cost" onMetricChange={() => {}} />);
    expect(screen.getByText(/No cost data recorded yet/)).toBeTruthy();
  });

  it('picks round axis ticks covering the maximum', () => {
    expect(niceTicks(0.37)).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
    expect(niceTicks(4.2)).toEqual([0, 2, 4, 6]);
    expect(niceTicks(0)).toEqual([0]);
  });
});

void waitFor;
