import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { fmtCost } from '@shared/usage';
import { routeFetch } from '@/test/routeFetch';
import { CostsView, fmtNum, type CostsSummary, type DayRow, type ModelRow } from './CostsView';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const model = (o: Partial<ModelRow>): ModelRow => ({
  model: 'm', cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, tokens_known: true, tokens_estimated: false,
  turns: 1, sessions: 1, cache_misses: 0, duration_api_ms: 0, duration_ms: 0, ...o,
});
const day = (o: Partial<DayRow>): DayRow => ({
  date: '2026-10-01', cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, tokens_known: true, tokens_estimated: false, ...o,
});

const D1 = day({ date: '2026-10-01', cost_usd: 1.5, input_tokens: 1000, output_tokens: 200, cache_creation_tokens: 30, cache_read_tokens: 4000 });
const D2 = day({ date: '2026-10-02', cost_usd: 0.5, input_tokens: 500, output_tokens: 100, cache_creation_tokens: 70, cache_read_tokens: 900, tokens_estimated: true });
const D3 = day({ date: '2026-10-03', tokens_known: false });
const FIXTURE: CostsSummary = {
  total_usd: 2, row_count: 7,
  by_project: [{ project: 'p', cost_usd: 2, turns: 7, sessions: 2, cache_misses: 0, duration_api_ms: 1000, duration_ms: 2000 }],
  by_model: [
    model({ model: 'claude-opus-4-8', cost_usd: 2, input_tokens: 1000, output_tokens: 200 }),
    model({ model: 'glm-5.2:cloud', input_tokens: 500, output_tokens: 100, cache_read_tokens: 900 }),
  ],
  daily_trend: [D1, D2, D3],
};

async function mount() {
  const calls = routeFetch({ 'GET /api/costs/summary': () => ({ json: FIXTURE }) });
  render(<TooltipProvider><CostsView /></TooltipProvider>);
  await screen.findByRole('tab', { name: 'Tokens' });
  return calls;
}
const tab = (name: string) => screen.getByRole('tab', { name });
const tileLabels = () => [...document.querySelectorAll('[data-costs-total] > *')].map((t) => t.children[0].textContent);
const tileValue = (label: string) => {
  const tile = [...document.querySelectorAll('[data-costs-total] > *')].find((t) => t.children[0].textContent === label)!;
  return tile.children[1].textContent;
};
const tileSub = (label: string) => [...document.querySelectorAll('[data-costs-total] > *')].find((t) => t.children[0].textContent === label)!.children[2]?.textContent;
const modelTable = () => [...document.querySelectorAll('table')].find((t) => t.textContent?.includes('claude-opus-4-8') && t.querySelector('thead'))!.textContent;
const columnOf = (date: string) => [...document.querySelectorAll('svg g[aria-label]')].find((g) => g.getAttribute('aria-label')!.startsWith(date))!;
const srRow = (date: string) => [...document.querySelectorAll('table.sr-only tr')].find((r) => r.children[0].textContent === date)!;

describe('costs Cost | Tokens switch', () => {
  it('switches the top section between Cost and Tokens; the tables do not change', async () => {
    await mount();
    expect(tileLabels()).toEqual(['Total spend', 'Sessions', 'LLM time', 'Busiest day']);
    expect(screen.getByRole('heading', { name: 'Daily spend' })).toBeTruthy();
    const before = modelTable();
    fireEvent.mouseDown(tab('Tokens'));
    expect(tileLabels()).toEqual(['Total tokens', 'Input', 'Output', 'Cache input']);
    expect(screen.getByRole('heading', { name: 'Daily tokens' })).toBeTruthy();
    expect(modelTable()).toBe(before);
    fireEvent.mouseDown(tab('Cost'));
    expect(tileLabels()).toEqual(['Total spend', 'Sessions', 'LLM time', 'Busiest day']);
  });

  it('a Refresh keeps the chosen metric', async () => {
    const calls = await mount();
    fireEvent.mouseDown(tab('Tokens'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/costs/summary')).toHaveLength(2));
    await screen.findByRole('tab', { name: 'Tokens' });
    expect(tab('Tokens').getAttribute('aria-selected')).toBe('true');
    expect(calls.filter((c) => c.url === '/api/costs/summary')).toHaveLength(2);
  });

  it('Tokens tiles sum every known day across models; cache input is read + create', async () => {
    await mount();
    fireEvent.mouseDown(tab('Tokens'));
    expect(tileValue('Input')).toContain(fmtNum(1500));
    expect(tileValue('Input')).toMatch(/estimated/);
    expect(tileValue('Output')).toBe(fmtNum(300));
    expect(tileValue('Cache input')).toContain(fmtNum(5000));
    expect(tileValue('Total tokens')).toBe(fmtNum(6800));
    expect(tileSub('Cache input')).toBe(`${fmtNum(4900)} read · ${fmtNum(100)} create`);
    expect(tileValue('Cache input')).toMatch(/estimated/);
    expect(tileValue('Output')).not.toMatch(/estimated/);
    expect(tileValue('Total tokens')).not.toMatch(/estimated/);
  });

  it('stacks output, input, cache input bottom→top with heights in value ratio', async () => {
    await mount();
    fireEvent.mouseDown(tab('Tokens'));
    for (const [d, vals] of [[D1, [200, 1000, 4030]], [D2, [100, 500, 970]]] as const) {
      const segs = [...columnOf(d.date).querySelectorAll('[data-series]')];
      expect(segs.map((s) => s.getAttribute('data-series'))).toEqual(['Output', 'Input', 'Cache input']);
      expect(segs.map((s) => Number(s.getAttribute('data-value')))).toEqual(vals);
      const h = segs.map((s) => Number(s.getAttribute('data-height')));
      for (let i = 1; i < 3; i++) expect(Math.abs(h[i] / h[0] - vals[i] / vals[0])).toBeLessThan(1e-6);
    }
    expect(document.querySelector('[data-chart-legend]')!.textContent).toBe('Cache inputInputOutput');
  });

  it('a day without token data renders no bar and reads —, not 0', async () => {
    await mount();
    fireEvent.mouseDown(tab('Tokens'));
    const col = columnOf(D3.date);
    expect(col.querySelector('[data-series]')).toBeNull();
    expect(col.getAttribute('aria-label')).toContain('no token data');
    expect([...srRow(D3.date).children].slice(1).map((c) => c.textContent)).toEqual(['—', '—', '—']);
  });

  it('estimated days mark only their input and cache-input cells', async () => {
    await mount();
    fireEvent.mouseDown(tab('Tokens'));
    // sr-only cells run top→bottom: Cache input, Input, Output
    const est = [...srRow(D2.date).children].slice(1).map((c) => /estimated/.test(c.textContent!));
    expect(est).toEqual([true, true, false]);
    expect([...srRow(D1.date).children].slice(1).some((c) => /estimated/.test(c.textContent!))).toBe(false);
  });

  it('Cost mode chart keeps its contract', async () => {
    await mount();
    expect(screen.getByRole('img', { name: `Daily spend over 3 days, peak ${fmtCost(1.5)}` })).toBeTruthy();
    const bars = [...document.querySelectorAll('[data-series="Spend"]')];
    expect(bars).toHaveLength(2);
    for (const b of bars) expect(b.getAttribute('fill')).toBe('var(--primary)');
    expect(document.querySelector('[data-chart-legend]')).toBeNull();
    expect(document.querySelector('table.sr-only caption')!.textContent).toBe('Daily spend');
  });

  it('fmtNum adds a B tier', () => {
    expect(fmtNum(1_500_000_000)).toBe('1.5B');
    expect(fmtNum(1_500_000)).toBe('1.5M');
  });
});
