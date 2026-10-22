// The review view's Split view toggle and the side-by-side rendering it switches to.
// Width comes from a fake matchMedia: happy-dom's own evaluation misses the first narrowing change event.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { routeFetch } from '@/test/routeFetch';
import { ReviewView } from './ReviewView';
import { viewStore } from './api';
import { DIFF_MODE_STORAGE_KEY, diffModeStore, setDiffMode } from './diffMode';

const SUMMARY = '/api/projects/p/worktrees/w/diff';
const SUMMARY_2 = '/api/projects/p/worktrees/w2/diff';

let wide = true;
const lists = new Map<string, { media: string; matches: boolean; listeners: Set<(e: { matches: boolean }) => void> }>();
const answer = (q: string) => (q === '(min-width: 48rem)' ? wide : false);

beforeEach(() => {
  localStorage.clear();
  diffModeStore.set({ mode: 'unified' });
  wide = true;
  lists.clear();
  vi.stubGlobal('matchMedia', (query: string) => {
    let l = lists.get(query);
    if (!l) { l = { media: query, matches: answer(query), listeners: new Set() }; lists.set(query, l); }
    const list = l;
    return {
      media: query,
      get matches() { return list.matches; },
      onchange: null,
      addEventListener: (_t: string, fn: (e: { matches: boolean }) => void) => list.listeners.add(fn),
      removeEventListener: (_t: string, fn: (e: { matches: boolean }) => void) => list.listeners.delete(fn),
      addListener: (fn: (e: { matches: boolean }) => void) => list.listeners.add(fn),
      removeListener: (fn: (e: { matches: boolean }) => void) => list.listeners.delete(fn),
      dispatchEvent: () => true,
    };
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  viewStore.set({ review: null });
});

function setWide(v: boolean) {
  wide = v;
  act(() => {
    for (const l of lists.values()) {
      const next = answer(l.media);
      if (next === l.matches) continue;
      l.matches = next;
      for (const fn of [...l.listeners]) fn({ matches: next });
    }
  });
}

const ln = (type: string, content: string) => ({ type, content });
const HUNK_A = {
  header: '@@ -10,6 +20,6 @@',
  lines: [ln('ctx', 'a'), ln('del', 'b'), ln('del', 'c'), ln('del', 'd'), ln('add', 'B'), ln('ctx', 'e'), ln('add', 'F'), ln('add', 'G'), ln('ctx', 'h')],
};
const A_ROWS = [
  ['ctx', '10', 'a', 'ctx', '20', 'a'],
  ['del', '11', 'b', 'add', '21', 'B'],
  ['del', '12', 'c', 'empty', '', ''],
  ['del', '13', 'd', 'empty', '', ''],
  ['ctx', '14', 'e', 'ctx', '22', 'e'],
  ['empty', '', '', 'add', '23', 'F'],
  ['empty', '', '', 'add', '24', 'G'],
  ['ctx', '15', 'h', 'ctx', '25', 'h'],
];
const HUNK_B1 = { header: '@@ -1,1 +1,1 @@', lines: [ln('del', 'old-one'), ln('add', 'new-one')] };
const HUNK_B2 = { header: '@@ -40,1 +50,1 @@', lines: [ln('del', 'old-two'), ln('add', 'new-two')] };

const FILES = {
  files: [{ path: 'a.ts', adds: 3, dels: 3 }, { path: 'b.ts', adds: 2, dels: 2 }],
  totalFiles: 2,
};

function stub(summary = SUMMARY, extra: Record<string, unknown> = {}) {
  return routeFetch({
    [`GET ${summary}?path=a.ts`]: () => ({ json: { file: { hunks: [HUNK_A] } } }),
    [`GET ${summary}?path=b.ts`]: () => ({ json: { file: { hunks: [HUNK_B1, HUNK_B2] } } }),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, () => ({ json: v })])),
    [`GET ${summary}`]: () => ({ json: FILES }),
  });
}
const open = (url = SUMMARY) => act(() => viewStore.set({ review: { title: 'changes', url } }));
const mount = () => render(<TooltipProvider><ReviewView /></TooltipProvider>);
const card = (path: string) => document.querySelector(`[data-review-file="${path}"]`) as HTMLElement;
const expand = async (path: string) => {
  await waitFor(() => expect(card(path)).not.toBeNull());
  fireEvent.click(card(path).querySelector('button')!);
  await waitFor(() => expect(card(path).querySelector('[data-hunk-header]')).not.toBeNull());
};
const mode = (path = 'a.ts') => card(path).querySelector('[data-diff-mode]')?.getAttribute('data-diff-mode');
const toggle = () => screen.getByRole('button', { name: 'Split view' });
const rows = (path = 'a.ts') => [...card(path).querySelectorAll('[data-split-row]')].map((r) => {
  const side = (s: 'old' | 'new') => {
    const c = r.querySelector(`[data-split-cell="${s}"]`)!;
    return [c.getAttribute('data-cell-type'), r.querySelector(`[data-line-num="${s}"]`)!.textContent, c.textContent];
  };
  return [...side('old'), ...side('new')];
});

describe('Split view', () => {
  it('a fresh profile shows unified hunks and an unpressed Split view toggle', async () => {
    // Invariant: with nothing stored the diff renders unified and the toggle reads unpressed.
    const calls = stub();
    open(); mount();
    await expand('a.ts');
    expect(mode()).toBe('unified');
    expect(card('a.ts').querySelectorAll('[data-diff-line]')).toHaveLength(HUNK_A.lines.length);
    expect(card('a.ts').querySelectorAll('[data-split-row]')).toHaveLength(0);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(calls.map((c) => c.url)).toEqual([SUMMARY, `${SUMMARY}?path=a.ts`]);
  });

  it('Split view renders the open file side by side and stores split; pressing again returns to unified and stores unified', async () => {
    // Invariant: the toggle switches the open file between layouts without refetching, and persists each choice.
    const calls = stub();
    open(); mount();
    await expand('a.ts');
    fireEvent.click(toggle());
    expect(mode()).toBe('split');
    expect(rows()).toEqual(A_ROWS);
    expect(localStorage.getItem(DIFF_MODE_STORAGE_KEY)).toBe('split');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle());
    expect(mode()).toBe('unified');
    expect(card('a.ts').querySelectorAll('[data-diff-line]')).toHaveLength(HUNK_A.lines.length);
    expect(localStorage.getItem(DIFF_MODE_STORAGE_KEY)).toBe('unified');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(calls.map((c) => c.url)).toEqual([SUMMARY, `${SUMMARY}?path=a.ts`]);
  });

  it('the chosen split carries to the next file expanded and to the next diff opened', async () => {
    // Invariant: the mode is view-wide, not per file or per diff; every hunk header shows once.
    const calls = stub(SUMMARY);
    open(); mount();
    await expand('a.ts');
    fireEvent.click(toggle());
    await expand('b.ts');
    expect(mode('b.ts')).toBe('split');
    expect([...card('b.ts').querySelectorAll('[data-hunk-header]')].map((h) => h.textContent)).toEqual([HUNK_B1.header, HUNK_B2.header]);
    expect(rows('b.ts')).toEqual([
      ['del', '1', 'old-one', 'add', '1', 'new-one'],
      ['del', '40', 'old-two', 'add', '50', 'new-two'],
    ]);
    const more = routeFetch({
      [`GET ${SUMMARY_2}?path=a.ts`]: () => ({ json: { file: { hunks: [HUNK_A] } } }),
      [`GET ${SUMMARY_2}`]: () => ({ json: FILES }),
    });
    open(SUMMARY_2);
    await expand('a.ts');
    expect(mode()).toBe('split');
    expect(calls.map((c) => c.url)).toEqual([SUMMARY, `${SUMMARY}?path=a.ts`, `${SUMMARY}?path=b.ts`]);
    expect(more.map((c) => c.url)).toEqual([SUMMARY_2, `${SUMMARY_2}?path=a.ts`]);
  });

  it('binary, oversized and truncated files show the same notes in split mode', async () => {
    // Invariant: the file-level notes do not depend on the layout.
    setDiffMode('split');
    const calls = routeFetch({
      [`GET ${SUMMARY}?path=big.ts`]: () => ({ json: { file: { hunks: [], oversized: true, adds: 70000, dels: 5 } } }),
      [`GET ${SUMMARY}?path=cut.ts`]: () => ({ json: { file: { hunks: [HUNK_B1], truncated: true, bytes: 987654 } } }),
      [`GET ${SUMMARY}`]: () => ({ json: { files: [{ path: 'img.png', binary: true }, { path: 'big.ts' }, { path: 'cut.ts' }], totalFiles: 3 } }),
    });
    open(); mount();
    await waitFor(() => expect(card('img.png')).not.toBeNull());
    fireEvent.click(card('img.png').querySelector('button')!);
    expect(card('img.png').textContent).toContain('Binary file');
    expect(card('img.png').querySelectorAll('[data-split-row]')).toHaveLength(0);
    fireEvent.click(card('big.ts').querySelector('button')!);
    await waitFor(() => expect(card('big.ts').textContent).toContain('Diff too large'));
    expect(card('big.ts').querySelectorAll('[data-split-row]')).toHaveLength(0);
    await expand('cut.ts');
    expect(card('cut.ts').textContent).toContain('Diff truncated');
    expect(card('cut.ts').textContent).toContain('987654');
    expect(rows('cut.ts')).toEqual([['del', '1', 'old-one', 'add', '1', 'new-one']]);
    expect(calls.map((c) => c.url)).toEqual([SUMMARY, `${SUMMARY}?path=big.ts`, `${SUMMARY}?path=cut.ts`]);
  });

  it('below md there is no toggle and a stored split renders unified; crossing back to md renders split again', async () => {
    // Invariant: narrow viewports never show split nor its toggle, yet the stored choice survives the crossing.
    setDiffMode('split');
    setWide(false);
    const calls = stub();
    open(); mount();
    await expand('a.ts');
    expect(screen.queryByRole('button', { name: 'Split view' })).toBeNull();
    expect(mode()).toBe('unified');
    setWide(true);
    expect(mode()).toBe('split');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem(DIFF_MODE_STORAGE_KEY)).toBe('split');
    expect(calls.map((c) => c.url)).toEqual([SUMMARY, `${SUMMARY}?path=a.ts`]);
  });

  it('a renamed file keeps its old → new title in split mode', async () => {
    // Invariant: the card title is outside the layout switch.
    setDiffMode('split');
    const calls = routeFetch({
      [`GET ${SUMMARY}?path=new.ts`]: () => ({ json: { file: { hunks: [HUNK_B1] } } }),
      [`GET ${SUMMARY}`]: () => ({ json: { files: [{ path: 'new.ts', oldPath: 'old.ts', status: 'renamed' }], totalFiles: 1 } }),
    });
    open(); mount();
    await expand('new.ts');
    expect(mode('new.ts')).toBe('split');
    expect(card('new.ts').querySelector('button')!.textContent).toContain('old.ts → new.ts');
    expect(calls.map((c) => c.url)).toEqual([SUMMARY, `${SUMMARY}?path=new.ts`]);
  });
});
