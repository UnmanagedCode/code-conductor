import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CommitsView } from './CommitsView';
import { viewStore } from './api';
import type { Commit, CommitsPayload } from './commitsModel';

const sha = (c: string) => c.repeat(40);
const commit = (c: string, ahead: boolean): Commit => ({ sha: sha(c), shortSha: c.repeat(7), subject: `subject ${c}`, parents: [], ahead });

function payload(over: Partial<CommitsPayload> = {}): CommitsPayload {
  const letters = 'abcdefg'.split('');
  return {
    branch: 'topic/zeta', truncated: false, limit: 100, hasUncommitted: false, aheadCount: 3, aheadOf: 'trunk',
    commits: letters.map((c, i) => commit(c, i < 3)), ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  viewStore.set({ commits: null });
});

async function mount(params: { project: string; worktree: string | null }, data: CommitsPayload) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(data))));
  act(() => viewStore.set({ commits: params }));
  render(<TooltipProvider><CommitsView /></TooltipProvider>);
  await waitFor(() => expect(document.querySelector('[data-commit-list]')).not.toBeNull());
  const view = document.querySelector('[data-view="commits"]')!;
  const heading = screen.getByRole('heading', { level: 1 }).textContent ?? '';
  const stats = view.querySelector('header')!.textContent ?? '';
  return { heading, stats };
}

describe('commits header', () => {
  it('titles the worktree with its branch, not the parent project, and states count and ahead', async () => {
    // Invariant: a worktree view heads with the worktree name and branch; stats carry the commit count and the ahead count against its base.
    const { heading, stats } = await mount({ project: 'parent-proj', worktree: 'wt-feature' }, payload());
    expect(heading).toContain('wt-feature');
    expect(heading).toContain('topic/zeta');
    expect(heading).not.toContain('parent-proj');
    expect(stats).toContain('7');
    expect(stats).toContain('3');
    expect(stats).toContain('trunk');
  });

  it('titles the project when there is no worktree, and omits ahead stats when nothing is ahead (control)', async () => {
    // Invariant: the heading follows the viewed target; the ahead state follows the payload's aheadCount.
    const { heading, stats } = await mount({ project: 'parent-proj', worktree: null }, payload({
      aheadCount: 0, branch: 'main-line', commits: 'abcde'.split('').map((c) => commit(c, false)),
    }));
    expect(heading).toContain('parent-proj');
    expect(heading).toContain('main-line');
    expect(stats).toContain('5');
    expect(stats).not.toContain('trunk');
  });
});
