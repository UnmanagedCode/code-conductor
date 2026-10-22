// A fresh load with split stored: the first expanded file renders side by side from storage alone.
import { vi } from 'vitest';

// Before any import: the stored mode the modules boot on.
vi.hoisted(() => { localStorage.setItem('code-conductor:diff-mode', 'split'); });

import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { routeFetch } from '@/test/routeFetch';
import { ReviewView } from './ReviewView';
import { viewStore } from './api';

const SUMMARY = '/api/projects/p/worktrees/w/diff';

afterEach(() => { viewStore.set({ review: null }); vi.unstubAllGlobals(); });

describe('a boot with split stored', () => {
  it('a reload with split stored opens the first expanded file side by side with Split view pressed', async () => {
    // Invariant: the read side of persistence — split shows from storage alone, with the toggle pressed.
    const calls = routeFetch({
      [`GET ${SUMMARY}?path=a.ts`]: () => ({ json: { file: { hunks: [{ header: '@@ -3,1 +8,1 @@', lines: [{ type: 'del', content: 'x' }, { type: 'add', content: 'y' }] }] } } }),
      [`GET ${SUMMARY}`]: () => ({ json: { files: [{ path: 'a.ts' }], totalFiles: 1 } }),
    });
    act(() => viewStore.set({ review: { title: 'c', url: SUMMARY } }));
    render(<TooltipProvider><ReviewView /></TooltipProvider>);
    await waitFor(() => expect(document.querySelector('[data-review-file="a.ts"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-review-file="a.ts"] button')!);
    await waitFor(() => expect(document.querySelector('[data-diff-mode="split"]')).not.toBeNull());
    expect(document.querySelectorAll('[data-split-row]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Split view' }).getAttribute('aria-pressed')).toBe('true');
    expect(calls.map((c) => c.url)).toEqual([SUMMARY, `${SUMMARY}?path=a.ts`]);
  });
});
