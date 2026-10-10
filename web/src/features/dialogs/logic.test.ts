import { afterEach, describe, expect, it, vi } from 'vitest';
import { messageFor, REFUSAL_OVERRIDES } from './adoptMessages';
import { computeSavings, defaultCut, type PruneAnalysis } from './pruneMath';
import { savingsNote, savingsRows, pickTier } from './SessionDialogs';
import { scanNote, groupConventions, deleteEffects, saveWorkspace } from './ProjectDialogs';
import { splitPath } from './PathInput';

const analysis = (over: Partial<PruneAnalysis> = {}): PruneAnalysis => ({
  turnCount: 3,
  encryptedThinking: 0,
  contextTokens: 10_000,
  calibration: { factor: 2, calibrated: true },
  turns: [
    { thinking: 100, toolInputTruncatable: 10, toolInputMinimal: 20, toolOutput: 1000, toolOutputImage: 400, exempt: 5 },
    { thinking: 100, toolInputTruncatable: 10, toolInputMinimal: 20, toolOutput: 0, toolOutputImage: 0, exempt: 0 },
    { thinking: 100, toolInputTruncatable: 10, toolInputMinimal: 20, toolOutput: 0, toolOutputImage: 0, exempt: 0 },
  ],
  ...over,
});

describe('prune savings', () => {
  it('scales every raw sum by the calibration factor', () => {
    const s = computeSavings(analysis(), { cut: 2, pruneThinking: true, minimal: false });
    expect(s.toolInputs).toBe(40);
    expect(s.exempt).toBe(10);
  });

  it('leaves the image part of tool outputs unscaled', () => {
    const s = computeSavings(analysis(), { cut: 1, pruneThinking: false, minimal: false });
    expect(s.toolOutputs).toBe((1000 - 400) * 2 + 400);
  });

  it('counts thinking in every turn, past the cut too, and in the total', () => {
    const s = computeSavings(analysis(), { cut: 1, pruneThinking: true, minimal: false });
    expect(s.thinking).toBe(600);
    expect(s.total).toBe(s.thinking + s.toolInputs + s.toolOutputs);
  });

  it('minimal mode uses the minimal input sizes', () => {
    expect(computeSavings(analysis(), { cut: 3, pruneThinking: false, minimal: true }).toolInputs).toBe(120);
  });

  it('starts the cut near 90%, at least 1, and short of the last turn', () => {
    expect(defaultCut(10)).toBe(9);
    expect(defaultCut(2)).toBe(1);
    expect(defaultCut(100)).toBe(90);
  });

  it('labels encrypted thinking as kept, sized, when there is no visible thinking saving', () => {
    const a = analysis({ encryptedThinking: 500 });
    const rows = savingsRows(a, computeSavings(a, { cut: 1, pruneThinking: false, minimal: false }));
    expect(rows[0][1]).toMatch(/stored encrypted \(~1\.0k in context, kept\)/);
  });

  it('shows the exempt row only when the pruned prefix holds exempt payload', () => {
    const a = analysis();
    expect(savingsRows(a, computeSavings(a, { cut: 1, pruneThinking: true, minimal: false })).some(([l]) => l.includes('exempt'))).toBe(true);
    expect(savingsRows(a, computeSavings(a, { cut: 0, pruneThinking: true, minimal: false })).some(([l]) => l.includes('exempt'))).toBe(false);
  });

  it('gives the percentage of the context chip reading, or none without one, and says when uncalibrated', () => {
    expect(savingsNote(analysis(), 5000)).toMatch(/^~50% of the current context/);
    const none = savingsNote(analysis({ contextTokens: 0, calibration: { factor: 1, calibrated: false } }), 5000);
    expect(none).not.toMatch(/%/);
    expect(none).toMatch(/Uncalibrated/);
  });

  it('renders millions with the M unit', () => {
    const a = analysis({ turns: [{ thinking: 0, toolInputTruncatable: 0, toolInputMinimal: 0, toolOutput: 2_000_000, toolOutputImage: 0, exempt: 0 }], turnCount: 1, calibration: { factor: 1, calibrated: true } });
    expect(savingsRows(a, computeSavings(a, { cut: 1, pruneThinking: false, minimal: false })).find(([l]) => l === 'Tool outputs')![1]).toBe('~2.0M tokens');
  });
});

describe('adopt refusal messages', () => {
  it('swaps a known tail for the dialog remedy instead of stacking one', () => {
    for (const o of REFUSAL_OVERRIDES) {
      const msg = messageFor({ code: o.code, reason: `Something went wrong${o.serverTail}` });
      expect(msg).toBe(`Something went wrong${o.remedy}`);
    }
  });

  it('renders a reason lacking the known tail verbatim', () => {
    expect(messageFor({ code: 'TRANSCRIPT_DIR_COLLISION', reason: 'plain reason' })).toBe('plain reason');
  });

  it('never shows a bare code', () => {
    expect(messageFor({ code: 'X' })).not.toMatch(/X/);
  });
});

describe('dialog text helpers', () => {
  it('the scan note pluralises, names the free-text route when empty, and reports truncation and unreadable dirs', () => {
    expect(scanNote({ root: '/r', maxDepth: 3, candidates: [] })).toMatch(/No unregistered directories found under \/r\. Type a path/);
    expect(scanNote({ root: '/r', maxDepth: 3, candidates: [{ path: '/r/a', relPath: 'a' }] })).toMatch(/^1 unregistered directory under \/r, 3 levels deep/);
    const n = scanNote({ root: '/r', maxDepth: 2, truncated: true, unreadable: 2, candidates: [{ path: 'a', relPath: 'a' }, { path: 'b', relPath: 'b' }] });
    expect(n).toMatch(/2 unregistered directories/);
    expect(n).toMatch(/truncated/);
    expect(n).toMatch(/2 directories could not be read/);
  });

  it('groups project conventions: core first, then one group per plugin, sorted', () => {
    const g = groupConventions([
      { slug: 'zeta/a', name: 'A', description: '' },
      { slug: 'design', name: 'D', description: '' },
      { slug: 'alpha/b', name: 'B', description: '' },
      { slug: 'x', name: 'X', description: '', plugin: 'beta' },
    ]);
    expect(g.map((x) => x.label)).toEqual(['Project conventions', 'alpha', 'beta', 'zeta']);
  });

  it('a project on a system keeps its worktree directories; a local one removes them', () => {
    const base = { name: 'p', path: '/p', remoteId: null, worktrees: [{ worktreeName: 'w' }] } as any;
    expect(deleteEffects({ ...base, system: 'box' }, 1)[1]).toMatch(/Unregister 1 worktree .*left in place/);
    expect(deleteEffects({ ...base, system: 'local' }, 2)[0]).toBe('Kill 2 running sessions');
    expect(deleteEffects({ ...base, system: 'local' }, 2)[1]).toMatch(/^Remove 1 worktree/);
  });

  it('the summary tier falls back to medium, then to the first cached tier', () => {
    expect(pickTier({ long: { summary: 'x' } }, 'title', 'medium')).toBe('long');
    expect(pickTier({ medium: { summary: 'x' }, title: { summary: 't' } }, 'short', 'short')).toBe('medium');
    expect(pickTier({ title: { summary: 't' } }, 'title', 'medium')).toBe('title');
  });

  it('splitPath splits an absolute path into its directory and the typed prefix', () => {
    expect(splitPath('/a/b/c')).toEqual({ dir: '/a/b', dirSlash: '/a/b/', prefix: 'c' });
    expect(splitPath('/x')).toEqual({ dir: '/', dirSlash: '/', prefix: 'x' });
    expect(splitPath('rel/x')).toBeNull();
  });

  // The root and a trailing slash name a directory with an empty prefix; only an absolute POSIX path splits at all.
  it('splitPath keeps the root and a trailing slash as directories, and refuses an empty, relative or Windows path', () => {
    expect(splitPath('/')).toEqual({ dir: '/', dirSlash: '/', prefix: '' });
    expect(splitPath('/a')).toEqual({ dir: '/', dirSlash: '/', prefix: 'a' });
    expect(splitPath('/a/')).toEqual({ dir: '/a', dirSlash: '/a/', prefix: '' });
    expect(splitPath('/a/b/pre')).toEqual({ dir: '/a/b', dirSlash: '/a/b/', prefix: 'pre' });
    expect(splitPath('')).toBeNull();
    expect(splitPath('rel/dir')).toBeNull();
    expect(splitPath('C:\\Users\\x')).toBeNull();
  });
});

describe('saving a workspace', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch() {
    const calls: [string, string, unknown][] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([init?.method ?? 'GET', url, init?.body ? JSON.parse(init.body as string) : null]);
      return new Response('{}', { status: 200 });
    }));
    return calls;
  }

  it('a new workspace with nothing ticked is created empty', async () => {
    const calls = stubFetch();
    await saveWorkspace({ original: null, name: 'W', originalMembers: new Set(), ticked: new Set() });
    expect(calls).toEqual([['POST', '/api/workspaces', { name: 'W' }]]);
  });

  it('renames first, then adds and removes only the members that changed', async () => {
    const calls = stubFetch();
    await saveWorkspace({ original: 'Old', name: 'New', originalMembers: new Set(['a', 'b']), ticked: new Set(['b', 'c']) });
    expect(calls[0]).toEqual(['PUT', '/api/workspaces/Old', { name: 'New' }]);
    expect(calls.slice(1).sort()).toEqual([
      ['PUT', '/api/projects/a/workspace', { workspace: null }],
      ['PUT', '/api/projects/c/workspace', { workspace: 'New' }],
    ]);
  });
});
