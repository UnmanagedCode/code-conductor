import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ReviewView } from './ReviewView';
import { viewStore } from './api';

const SUMMARY_URL = '/api/projects/proj-q/worktrees/wt-q/diff';

afterEach(() => {
  vi.unstubAllGlobals();
  viewStore.set({ review: null });
});

const mount = () => render(<TooltipProvider><ReviewView /></TooltipProvider>);
const cards = () => [...document.querySelectorAll('[data-review-file]')].map((n) => n.getAttribute('data-review-file'));

describe('review summary', () => {
  it('renders a card for every file from the one summary request, with no per-file fetch', async () => {
    // Invariant: the summary alone lists every file; hunks are never fetched until a card is expanded.
    const files = ['src/a.ts', 'src/b.ts', 'docs/c.md', 'img/d.png', 'z.txt'].map((path) => ({ path, adds: 4, dels: 1, binary: path.endsWith('.png') }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ files, totalAdds: 20, totalDels: 5, totalFiles: 5 })));
    vi.stubGlobal('fetch', fetchMock);
    act(() => viewStore.set({ review: { title: 'wt-q changes', url: SUMMARY_URL } }));
    mount();
    await waitFor(() => expect(cards()).toHaveLength(5));
    expect(cards()).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts', 'docs/c.md', 'img/d.png', 'z.txt']));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe(SUMMARY_URL);
  });

  it('a summary with no files renders no cards (control)', async () => {
    // Invariant: the card count follows the summary's files, not a constant.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ files: [], totalFiles: 0 }))));
    act(() => viewStore.set({ review: { title: 'empty', url: SUMMARY_URL } }));
    mount();
    await waitFor(() => expect(document.querySelector('[data-view="review"]')).not.toBeNull());
    await waitFor(() => expect(document.querySelector('[data-slot="skeleton"]')).toBeNull());
    expect(cards()).toEqual([]);
  });
});

describe('over-cap file diff', () => {
  // The expanded card for big.ts.
  async function expandWith(file: Record<string, unknown>) {
    const summary = { files: [{ path: 'big.ts', adds: 3, dels: 0 }], totalFiles: 1 };
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes('path=') ? { file } : summary)));
    vi.stubGlobal('fetch', fetchMock);
    act(() => viewStore.set({ review: { title: 'big', url: SUMMARY_URL } }));
    mount();
    await waitFor(() => expect(cards()).toEqual(['big.ts']));
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    await waitFor(() => expect(document.querySelector('[data-hunk-header]')).not.toBeNull());
    const body = document.querySelector('[data-review-file="big.ts"]')!;
    return { body, fetchMock };
  }
  const hunks = [{ header: '@@ -1,3 +1,3 @@', lines: [{ type: 'add', content: 'kept line' }] }];

  it('keeps its hunks and reports the byte size when truncated, and neither note nor size when not', async () => {
    // Invariant: truncated detail keeps its hunks and adds a note carrying the byte size; a complete diff has no note.
    const truncated = await expandWith({ hunks, truncated: true, bytes: 987654 });
    expect(truncated.body.querySelectorAll('[data-diff-line]')).toHaveLength(1);
    expect(truncated.body.textContent).toContain('987654');
    document.body.innerHTML = '';
    viewStore.set({ review: null });
    const complete = await expandWith({ hunks, truncated: false, bytes: 987654 });
    expect(complete.body.querySelectorAll('[data-diff-line]')).toHaveLength(1);
    expect(complete.body.textContent).not.toContain('987654');
  });
});
