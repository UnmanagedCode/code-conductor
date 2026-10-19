import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { mockFetch, type Call } from './test/fetchMock';
import { ndjsonStream } from './test/ndjson';

vi.mock('@/app/sessionActions', () => ({ resumeSession: vi.fn(async () => {}) }));
vi.mock('@/app/controller', () => ({ refreshProjects: vi.fn(async () => {}), refreshInstances: vi.fn(async () => {}) }));
vi.mock('@/app/models', () => ({ applyModels: vi.fn() }));
vi.mock('@/features/sidebar/restart', () => ({ performRestart: vi.fn(async () => {}) }));
vi.mock('@shared/capabilities', () => ({ loadCapabilities: vi.fn(), capabilities: vi.fn(() => null) }));

import { loadCapabilities } from '@shared/capabilities';
import { syncRoute, useRoute } from '@/state/route';
import { PluginsSection } from './PluginsSection';
import { pluginsStore } from './PluginsSection'; // step 2
import type { LibraryEntry, PluginRow } from './pluginLogic';
import { pluginsChangeStore, pluginsChangedSignal } from './pluginsSignal';
import { SettingsView } from './SettingsView';

type Stream = ReturnType<typeof ndjsonStream>;
type Skip = { dir: string; file: string | null; reason: string };
type Project = { name: string; worktrees: { worktreeName?: string }[] };
type Final = { type: 'result'; ok: true; result: Record<string, unknown> } | { type: 'result'; ok: false; error: string; tail?: string };
type Held = { response: Response; release: (json: unknown) => void };

const SHARE: LibraryEntry = { id: 'code-share', name: 'Code Share', description: 'Share code snippets.', repo: 'https://example.test/code-share', installed: false, installedAs: null, updateAvailable: false };
const INSTALLED: LibraryEntry = { ...SHARE, installed: true, installedAs: 'code-share', updateAvailable: true };
const UP_TO_DATE: LibraryEntry = { ...INSTALLED, updateAvailable: false };
// Uninstalled, beside Code Share: its Install must lock while another entry's action runs.
const OTHER: LibraryEntry = { id: 'other', name: 'Other', repo: 'https://example.test/other', installed: false, installedAs: null, updateAvailable: false };
// Installed and behind: its Update must lock while Code Share's runs.
const BEHIND: LibraryEntry = { id: 'behind', name: 'Behind', repo: 'https://example.test/behind', installed: true, installedAs: 'behind', updateAvailable: true };
const CURRENT: LibraryEntry = { id: 'current', name: 'Current', repo: 'https://example.test/current', installed: true, installedAs: 'current', updateAvailable: false };
// An enabled, stopped backend plugin (Start, the version select, Disable) and a disabled one (Enable): every installed-list control.
const PL: PluginRow = { id: 'pl', name: 'Pl', project: 'pl', state: 'stopped', enabled: true, hasBackend: true, localOnly: [] };
const OFF: PluginRow = { id: 'off', name: 'Off', project: 'off', state: 'stopped', enabled: false, hasBackend: true, localOnly: [] };
// Two plugins in the updated project and one elsewhere: an update names exactly the first two.
const SHARE_A: PluginRow = { id: 'share-a', name: 'Share A', project: 'code-share', state: 'ready', enabled: true, hasBackend: false, localOnly: [] };
const SHARE_B: PluginRow = { ...SHARE_A, id: 'share-b', name: 'Share B' };
const ELSEWHERE: PluginRow = { ...SHARE_A, id: 'elsewhere', name: 'Elsewhere', project: 'other' };
// A running, stale backend plugin whose project has one worktree: the version select's subject.
const KA: PluginRow = { id: 'ka', name: 'KA', project: 'kaproj', state: 'ready', stale: true, enabled: true, hasBackend: true, localOnly: [] };

let rows: PluginRow[];
let library: LibraryEntry[];
let skipped: Skip[];
let projects: Project[];
let calls: Call[];
let streams: Stream[];
let helds: Held[];
const PLUGINS0 = pluginsStore.get(); // step 2

/** A streamed install/update answer the test feeds; recorded in `streams` in POST order. */
function newStream(): Response {
  const s = ndjsonStream();
  streams.push(s);
  return s.response;
}

/** A JSON answer the test holds: its body arrives only on `release`. */
function heldJson(status = 200): Held {
  const enc = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let done = false;
  const response = new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }), { status, headers: { 'content-type': 'application/json' } });
  const held: Held = { response, release: (json) => { if (done) return; done = true; controller.enqueue(enc.encode(JSON.stringify(json))); controller.close(); } };
  helds.push(held);
  return held;
}

/** Routes the three section GETs, Archived, Code Share's install and update streams, plus a test's own routes. */
function serve(extra: Parameters<typeof mockFetch>[0] = {}) {
  streams = [];
  calls = mockFetch({
    'GET /api/plugins': () => ({ rows, notices: [] }),
    'GET /api/projects': () => projects,
    'GET /api/plugins/library': () => ({ entries: library, skipped }),
    'POST /api/plugins/library/code-share/install': newStream,
    'POST /api/plugins/library/code-share/update': newStream,
    'GET /api/archived': () => ({ groups: [] }),
    ...extra,
  });
}

async function streamAt(n: number): Promise<Stream> {
  await waitFor(() => expect(streams.length).toBeGreaterThan(n));
  return streams[n];
}
async function feed(s: Stream, text: string) {
  await act(async () => { s.push({ type: 'chunk', text }); });
}
async function finish(s: Stream, final: Final | null) {
  await act(async () => { if (final) s.push(final); s.end(); });
}
const ok = (result: Record<string, unknown>): Final => ({ type: 'result', ok: true, result });
const failed = (error: string, tail?: string): Final => ({ type: 'result', ok: false, error, ...(tail ? { tail } : {}) });

const entry = (id: string) => document.querySelector(`[data-entry="${id}"]`) as HTMLElement;
const entryButtons = (id: string) => within(entry(id)).queryAllByRole('button').map((b) => (b.textContent ?? '').trim());
const entryButton = (id: string, name: string) => within(entry(id)).getByRole('button', { name }) as HTMLButtonElement;
const installedAs = (id: string) => within(entry(id)).queryByText(/^installed as /)?.textContent ?? '';
const badges = (id: string) => Array.from(entry(id).querySelectorAll('[data-slot="badge"]')).map((b) => b.textContent);
const live = (id: string) => entry(id).querySelector('pre')?.textContent ?? '';
/** A card's own status line: the Status beside its list (a row's error line sits deeper). */
const ownStatus = (list: 'plugin-list' | 'library-list') =>
  (Array.from(screen.getByTestId(list).parentElement!.children).find((el) => el.getAttribute('role') === 'status') ?? null) as HTMLElement | null;
const pluginsLine = () => ownStatus('plugin-list')?.textContent ?? '';
const libLine = () => ownStatus('library-list')?.textContent ?? '';
/** A rendered Status's declared tone (`data-tone`), or 'absent' when it renders nothing. */
const toneOf = (el: HTMLElement | null) => el?.dataset.tone ?? 'absent';
const pluginsTone = () => toneOf(ownStatus('plugin-list'));
const libTone = () => toneOf(ownStatus('library-list'));
const tail = () => screen.queryByText('Install output', { selector: 'summary' })?.closest('details')?.querySelector('pre')?.textContent ?? '';
const gets = (url: '/api/plugins' | '/api/plugins/library') => calls.filter((c) => c.method === 'GET' && c.url === url).length;
const posts = (url: string) => calls.filter((c) => c.method === 'POST' && c.url === url);
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

const wrap = () => render(<TooltipProvider><PluginsSection /></TooltipProvider>);

function Host() {
  const route = useRoute();
  return route.view === 'settings' ? <SettingsView /> : <div data-testid="elsewhere" />;
}
function openAt(hash: string) {
  history.replaceState(null, '', `/${hash}`);
  syncRoute();
  return render(<TooltipProvider><Host /></TooltipProvider>);
}
const heading = (name: string) => screen.findByRole('heading', { level: 2, name });
const SECTION_HEADING = { plugins: 'Plugins', archived: 'Archived' } as const;
type Section = keyof typeof SECTION_HEADING;
async function switchTo(section: Section) {
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('link', { name: SECTION_HEADING[section] }));
  expect(location.hash).toBe(`#settings/${section}`);
  await heading(SECTION_HEADING[section]);
}
async function leaveAndReenter(section: Section) {
  act(() => { history.replaceState(null, '', '/#session=x'); syncRoute(); });
  expect(document.querySelector('[data-settings-view]')).toBeNull();
  act(() => { history.replaceState(null, '', `/#settings/${section}`); syncRoute(); });
  await heading(SECTION_HEADING[section]);
}

beforeEach(() => {
  rows = [];
  library = [SHARE];
  skipped = [];
  projects = [];
  helds = [];
  pluginsStore.set(PLUGINS0); // step 2
  vi.mocked(loadCapabilities).mockReset().mockResolvedValue({ remoteSystems: false, voice: false });
  serve();
});
afterEach(async () => {
  // A red run can stop mid-action: end what it left open so the action settles before the next test.
  await act(async () => {
    for (const s of streams) { try { s.end(); } catch { /* already ended */ } }
    for (const h of helds) h.release({});
    await new Promise((r) => setTimeout(r, 0));
  });
  vi.unstubAllGlobals();
});

describe('Plugins → hook warnings', () => {
  // A failed post-install command does not fail the install: the entry relabels installed while the library line warns, error-toned, with the command output.
  it('an install whose post-install command failed still installs, and warns with the command output', async () => {
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^1\b/));
    fireEvent.click(entryButton('code-share', 'Install'));
    const s = await streamAt(0);
    library = [INSTALLED];
    await finish(s, ok({ id: 'code-share', name: 'code-share', postClone: { ran: true, ok: false, code: 1, tail: 'npm ERR! boom' } }));
    await waitFor(() => {
      expect(entryButtons('code-share')).toEqual(['Update']);
      expect(installedAs('code-share')).toBe('installed as code-share');
      expect(libLine()).toMatch(/Code Share.*post-install/);
      expect(libTone()).toBe('error');
      expect(tail()).toBe('npm ERR! boom');
    });
  });

  // A post-install command that ran and passed is no warning: the entry relabels installed, the library line is the load's own muted count, and no output tail shows.
  it('an install whose post-install command ran and passed shows no warning and no command output', async () => {
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^1\b/));
    fireEvent.click(entryButton('code-share', 'Install'));
    const s = await streamAt(0);
    library = [INSTALLED];
    await finish(s, ok({ id: 'code-share', name: 'code-share', postClone: { ran: true, ok: true, code: 0, tail: 'added 12 packages' } }));
    await waitFor(() => expect(entryButtons('code-share')).toEqual(['Update']));
    expect(installedAs('code-share')).toBe('installed as code-share');
    expect(libLine()).toMatch(/^1\b/);
    expect(libTone()).toBe('muted');
    expect(tail()).toBe('');
  });

  // A failed post-update command with no restart outcome warns about the command alone, with its output, and never claims the backend kept old code.
  it('an update whose post-update command failed still updates, and warns with the command output without claiming the backend kept old code', async () => {
    library = [INSTALLED];
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^1\b/));
    fireEvent.click(entryButton('code-share', 'Update'));
    const s = await streamAt(0);
    library = [UP_TO_DATE];
    await finish(s, ok({ project: 'code-share', postPull: { ran: true, ok: false, code: 1, tail: 'npm ERR! boom again' }, restarted: null }));
    await waitFor(() => {
      expect(libLine()).toMatch(/Code Share.*post-update/);
      expect(libTone()).toBe('error');
      expect(tail()).toBe('npm ERR! boom again');
      expect(installedAs('code-share')).toBe('installed as code-share · up to date');
    });
    // Invariant: a failed command with no restart outcome never claims the backend kept old code. Positive control: the same line was just proven to be the non-empty post-update warning.
    expect(libLine()).not.toMatch(/old code/);
  });

  // A failed backend restart after a passing hook warns with the restart error and shows no command output.
  it('an update whose backend restart failed still updates, and warns with the restart error', async () => {
    library = [INSTALLED];
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^1\b/));
    fireEvent.click(entryButton('code-share', 'Update'));
    const s = await streamAt(0);
    library = [UP_TO_DATE];
    await finish(s, ok({ project: 'code-share', postPull: { ran: true, ok: true, code: 0, tail: 'fine' }, restarted: { ids: ['code-share'], ok: false, error: 'boom' } }));
    await waitFor(() => {
      expect(libLine()).toMatch(/Code Share.*restarting.*boom/);
      expect(libTone()).toBe('error');
      expect(installedAs('code-share')).toBe('installed as code-share · up to date');
    });
    expect(tail()).toBe('');
  });

  // When both the post-update command and the restart fail, the warning names the command, with its output, and not the restart.
  it('an update whose post-update command and restart both failed reports the command, not the restart', async () => {
    library = [INSTALLED];
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^1\b/));
    fireEvent.click(entryButton('code-share', 'Update'));
    const s = await streamAt(0);
    library = [UP_TO_DATE];
    await finish(s, ok({ project: 'code-share', postPull: { ran: true, ok: false, code: 1, tail: 'npm ERR! boom' }, restarted: { ids: [], ok: false, error: 'restart boom' } }));
    await waitFor(() => {
      expect(libLine()).toMatch(/Code Share.*post-update/);
      expect(tail()).toBe('npm ERR! boom');
    });
    // Invariant: the command failure is reported, not the restart's. Positive control: the same line was just proven to be the non-empty post-update warning.
    expect(libLine()).not.toContain('restart boom');
  });

  // A restart the server skipped (its wire value a string) says the backend still runs the old code, with the command output.
  it('an update whose restart was skipped after a failed post-update command says the backend still runs the old code, with the command output', async () => {
    library = [INSTALLED];
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^1\b/));
    fireEvent.click(entryButton('code-share', 'Update'));
    const s = await streamAt(0);
    library = [UP_TO_DATE];
    await finish(s, ok({ project: 'code-share', postPull: { ran: true, ok: false, code: 1, tail: 'npm ERR! boom' }, restarted: { skipped: 'postPull-failed' } }));
    await waitFor(() => {
      // The sentence is the contract here: it is the only text telling the user the backend still runs the old code.
      expect(libLine()).toBe('Updated Code Share, but its post-update command failed — its backend was left running the old code');
      expect(libTone()).toBe('error');
      expect(tail()).toBe('npm ERR! boom');
    });
  });
});

describe('Plugins → library', () => {
  // Each skipped drop-in is named by dir/file (telling identical basenames apart) and a skipped directory by itself, on an error-toned line.
  it('a skipped library drop-in is named in the library status line by directory and file, and a skipped directory by itself', async () => {
    library = [];
    skipped = [
      { dir: '/a', file: 'broken.json', reason: 'unexpected token' },
      { dir: '/b', file: 'broken.json', reason: 'unexpected token' },
      { dir: '/mnt/gone', file: null, reason: 'library dir unreadable: ENOENT' },
    ];
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^Skipped 3\b/));
    for (const part of ['/a/broken.json', '/b/broken.json', '/mnt/gone', 'unexpected token', 'ENOENT']) expect(libLine()).toContain(part);
    expect(libTone()).toBe('error');
  });

  // While an install streams, its progress shows in the entry and the line and every other plugin control is disabled; after it, the entry relabels installed, the change is announced with no ids, and the guard is free.
  it('Install shows progress and locks every other plugin control, then relabels the entry installed, announces the change and frees the guard', async () => {
    rows = [PL, OFF];
    library = [SHARE, OTHER];
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^2\b/));
    const v0 = pluginsChangedSignal.version();
    fireEvent.click(entryButton('code-share', 'Install'));
    const s = await streamAt(0);
    await waitFor(() => expect(entryButton('code-share', 'Installing…').disabled).toBe(true));
    expect(libLine()).toMatch(/^Installing Code Share\b(?!.*failed)/);
    expect(libTone()).toBe('muted');
    expect(entryButton('other', 'Install').disabled).toBe(true);
    expect(button('Rescan').disabled).toBe(true);
    expect(button('Start').disabled).toBe(true);
    expect(button('Disable').disabled).toBe(true);
    expect(button('Enable').disabled).toBe(true);
    expect((screen.getByLabelText('Active version of Pl') as HTMLSelectElement).disabled).toBe(true);
    await feed(s, 'Cloning into code-share...\n');
    await waitFor(() => expect(live('code-share')).toContain('Cloning into code-share...'));

    library = [INSTALLED, OTHER];
    await finish(s, ok({ id: 'code-share', name: 'code-share', postClone: null }));
    await waitFor(() => expect(entryButtons('code-share')).toEqual(['Update']));
    expect(badges('code-share')).toEqual(['installed']);
    expect(installedAs('code-share')).toBe('installed as code-share');
    expect(libLine()).toMatch(/^2\b/);
    expect(libTone()).toBe('muted');
    expect(posts('/api/plugins/library/code-share/install').length).toBe(1);
    expect(entryButton('other', 'Install').disabled).toBe(false);
    expect(button('Rescan').disabled).toBe(false);
    expect(button('Start').disabled).toBe(false);
    expect(button('Disable').disabled).toBe(false);
    expect(button('Enable').disabled).toBe(false);
    expect((screen.getByLabelText('Active version of Pl') as HTMLSelectElement).disabled).toBe(false);
    expect(pluginsChangedSignal.version()).toBe(v0 + 1);
    expect(pluginsChangeStore.get().lastChange).toBeUndefined();

    fireEvent.click(entryButton('code-share', 'Update'));
    const s1 = await streamAt(1);
    library = [UP_TO_DATE, OTHER];
    await finish(s1, ok({ project: 'code-share', postPull: null, restarted: null }));
    await waitFor(() => expect(entryButtons('code-share')).toEqual([]));
  });

  // A plain-JSON refusal and a streamed failure both show the server's error and output and keep the entry installable with its live log; a retry clears the output and installs.
  it("a refused or failed install shows the server's error and output, keeps the entry installable with its live log, and a retry clears the output and installs", async () => {
    let attempt = 0;
    serve({ 'POST /api/plugins/library/code-share/install': () => (attempt++ === 0 ? { status: 409, json: { error: 'library entry busy', tail: 'lock held' } } : newStream()) });
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^1\b/));

    fireEvent.click(entryButton('code-share', 'Install'));
    await waitFor(() => expect(libLine()).toMatch(/Code Share.*library entry busy/));
    expect(libTone()).toBe('error');
    expect(tail()).toBe('lock held');
    expect(entryButton('code-share', 'Install').disabled).toBe(false);

    fireEvent.click(entryButton('code-share', 'Install'));
    const s = await streamAt(0);
    await feed(s, 'Cloning into code-share...\n');
    await finish(s, failed('clone failed', 'fatal: boom'));
    await waitFor(() => expect(libLine()).toMatch(/Code Share.*clone failed/));
    expect(libTone()).toBe('error');
    expect(tail()).toBe('fatal: boom');
    expect(entryButtons('code-share')).toEqual(['Install']);
    expect(entryButton('code-share', 'Install').disabled).toBe(false);
    expect(live('code-share')).toContain('Cloning into code-share');
    expect(installedAs('code-share')).toBe('');

    fireEvent.click(entryButton('code-share', 'Install'));
    const s1 = await streamAt(1);
    library = [INSTALLED];
    await finish(s1, ok({ id: 'code-share', name: 'code-share', postClone: null }));
    await waitFor(() => expect(entryButtons('code-share')).toEqual(['Update']));
    expect(tail()).toBe('');
    expect(libLine()).toMatch(/^1\b/);
    expect(posts('/api/plugins/library/code-share/install').length).toBe(3);
  });

  // An entry offers Install until installed, Update while behind its origin, and no button once up to date, with the installed badge and line only once installed.
  it('a library entry offers Install until installed, Update while behind its origin, and no button once up to date', async () => {
    library = [SHARE, BEHIND, CURRENT];
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^3\b/));
    expect(libTone()).toBe('muted');
    expect(entryButtons('code-share')).toEqual(['Install']);
    expect(installedAs('code-share')).toBe('');
    expect(badges('code-share')).toEqual([]);
    expect(entryButtons('behind')).toEqual(['Update']);
    expect(installedAs('behind')).toBe('installed as behind');
    expect(badges('behind')).toEqual(['installed']);
    expect(entryButtons('current')).toEqual([]);
    expect(installedAs('current')).toBe('installed as current · up to date');
  });

  // While an update streams its progress shows and the other entries lock; after it the list reloads once, the entry reads up to date, and the change names every plugin of the updated project and no other.
  it('Update shows progress and locks the other entries, then refreshes the list once and names every plugin of the updated project', async () => {
    rows = [SHARE_A, SHARE_B, ELSEWHERE];
    library = [INSTALLED, BEHIND];
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^2\b/));
    const g = gets('/api/plugins/library');
    fireEvent.click(entryButton('code-share', 'Update'));
    const s = await streamAt(0);
    await waitFor(() => expect(entryButton('code-share', 'Updating…').disabled).toBe(true));
    expect(libLine()).toMatch(/^Updating Code Share\b(?!.*failed)/);
    expect(libTone()).toBe('muted');
    expect(entryButton('behind', 'Update').disabled).toBe(true);
    await feed(s, 'Updating code-share...\n');
    await waitFor(() => expect(live('code-share')).toContain('Updating code-share...'));

    library = [UP_TO_DATE, BEHIND];
    await finish(s, ok({ id: 'code-share', name: 'code-share', project: 'code-share', postPull: null, restarted: null }));
    await waitFor(() => expect(installedAs('code-share')).toBe('installed as code-share · up to date'));
    expect(entryButtons('code-share')).toEqual([]);
    expect(libLine()).toMatch(/^2\b/);
    expect(libTone()).toBe('muted');
    expect(tail()).toBe('');
    expect(entryButton('behind', 'Update').disabled).toBe(false);
    await waitFor(() => expect(pluginsChangeStore.get().lastChange).toEqual({ action: 'update', ids: ['share-a', 'share-b'] }));
    expect(gets('/api/plugins/library')).toBe(g + 1);
  });

  // A failed update shows the error and pull output, keeps Update offered with its live log, and neither reloads nor announces; a stream ending without a result fails the same way.
  it('a failed update shows the error and pull output and keeps Update offered with its live log, reloading and announcing nothing; a stream that ends without a result fails too', async () => {
    library = [INSTALLED];
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^1\b/));
    const v0 = pluginsChangedSignal.version();
    const g = gets('/api/plugins/library');
    fireEvent.click(entryButton('code-share', 'Update'));
    const s = await streamAt(0);
    await feed(s, 'Updating code-share...\n');
    await finish(s, failed('git pull failed', 'fatal: diverged'));
    await waitFor(() => expect(libLine()).toMatch(/Code Share.*git pull failed/));
    expect(libTone()).toBe('error');
    expect(tail()).toBe('fatal: diverged');
    expect(entryButton('code-share', 'Update').disabled).toBe(false);
    expect(live('code-share')).toContain('Updating code-share');
    expect(gets('/api/plugins/library')).toBe(g);
    expect(pluginsChangedSignal.version()).toBe(v0);

    fireEvent.click(entryButton('code-share', 'Update'));
    const s1 = await streamAt(1);
    await feed(s1, 'x\n');
    await finish(s1, null);
    await waitFor(() => expect(libLine()).toMatch(/Code Share.*stream ended unexpectedly/));
    expect(tail()).toBe('');
  });

  // The version select offers main and each named worktree, reads main for a vanished worktree, posts the chosen checkout, and reports {action:'version', ids}.
  it("a version switch posts the chosen checkout, reports {action:'version', ids}, and an active worktree that no longer exists reads main", async () => {
    rows = [{ ...KA, activeVersion: { type: 'worktree', name: 'gone' } }];
    projects = [{ name: 'kaproj', worktrees: [{ worktreeName: 'wt' }, {}] }];
    serve({ 'POST /api/plugins/ka/version': () => ({ ok: true }) });
    wrap();
    const sel = (await screen.findByLabelText('Active version of KA')) as HTMLSelectElement;
    await waitFor(() => expect(Array.from(sel.options).map((o) => o.value)).toEqual(['main', 'worktree:wt']));
    expect(sel.value).toBe('main');

    rows = [{ ...KA, activeVersion: { type: 'worktree', name: 'wt' } }];
    fireEvent.change(sel, { target: { value: 'worktree:wt' } });
    await waitFor(() => {
      expect(pluginsChangeStore.get().lastChange).toEqual({ action: 'version', ids: ['ka'] });
      expect(sel.value).toBe('worktree:wt');
      expect(pluginsLine()).toMatch(/^1\b/);
    });

    rows = [{ ...KA, activeVersion: { type: 'main' } }];
    fireEvent.change(sel, { target: { value: 'main' } });
    await waitFor(() => expect(posts('/api/plugins/ka/version').length).toBe(2));
    expect(posts('/api/plugins/ka/version').map((c) => c.body)).toEqual([{ type: 'worktree', name: 'wt' }, { type: 'main' }]);
    await waitFor(() => expect(sel.value).toBe('main'));
  });

  // A single Update, failed or succeeded, releases the action guard: a plugin action right after it still runs.
  it('a plugin action still runs after a single Update ends, whether the update failed or succeeded', async () => {
    rows = [PL];
    library = [INSTALLED];
    serve({ 'POST /api/plugins/rescan': () => ({ ok: true }) });
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^1\b/));

    fireEvent.click(entryButton('code-share', 'Update'));
    await finish(await streamAt(0), failed('git pull failed'));
    await waitFor(() => expect(libLine()).toMatch(/Code Share.*git pull failed/));
    fireEvent.click(button('Rescan'));
    expect(posts('/api/plugins/rescan').length).toBe(1);
    await waitFor(() => expect(pluginsLine()).toMatch(/^1\b/));

    fireEvent.click(entryButton('code-share', 'Update'));
    library = [UP_TO_DATE];
    await finish(await streamAt(1), ok({ project: 'code-share', postPull: null, restarted: null }));
    await waitFor(() => expect(entryButtons('code-share')).toEqual([]));
    fireEvent.click(button('Rescan'));
    expect(posts('/api/plugins/rescan').length).toBe(2);
    await waitFor(() => expect(pluginsLine()).toMatch(/^1\b/));
  });

  // An empty library says so on a muted line and renders no entry.
  it('an empty library says so and lists nothing', async () => {
    library = [];
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/no library entries/i));
    expect(libTone()).toBe('muted');
    expect(screen.getByTestId('library-list').children.length).toBe(0);
  });
});

describe('Plugins → state across remounts', () => {
  // An install still streaming keeps its progress line across a section switch.
  it("an install's progress line survives a section switch while it streams", async () => {
    openAt('#settings/plugins');
    await waitFor(() => expect(entry('code-share')).not.toBeNull());
    fireEvent.click(entryButton('code-share', 'Install'));
    const s = await streamAt(0);
    await switchTo('archived');
    await switchTo('plugins');
    await waitFor(() => expect(gets('/api/plugins/library')).toBe(2));
    await waitFor(() => expect(entryButton('code-share', 'Installing…').disabled).toBe(true));
    expect(libLine()).toMatch(/^Installing Code Share\b(?!.*failed)/);
    expect(libTone()).toBe('muted');
    library = [INSTALLED];
    await finish(s, ok({ id: 'code-share', name: 'code-share', postClone: null }));
    await waitFor(() => expect(entryButtons('code-share')).toEqual(['Update']));
  });

  // An install that ends after a section switch lands in the section shown: the entry relabels and its warning and output show.
  it('an install that ends after a section switch lands in the section shown: the entry relabels installed and its warning and output show', async () => {
    openAt('#settings/plugins');
    await waitFor(() => expect(entry('code-share')).not.toBeNull());
    fireEvent.click(entryButton('code-share', 'Install'));
    const s = await streamAt(0);
    await switchTo('archived');
    await switchTo('plugins');
    await waitFor(() => expect(gets('/api/plugins/library')).toBe(2));
    await waitFor(() => expect(entryButton('code-share', 'Installing…').disabled).toBe(true));
    library = [INSTALLED];
    await finish(s, ok({ id: 'code-share', name: 'code-share', postClone: { ran: true, ok: false, code: 1, tail: 'npm ERR! boom' } }));
    await waitFor(() => expect(entryButtons('code-share')).toEqual(['Update']));
    expect(libLine()).toMatch(/Code Share.*post-install/);
    expect(libTone()).toBe('error');
    expect(tail()).toBe('npm ERR! boom');
  });

  // A refused install's message, output and live log survive a section switch; reopening Settings replaces the message with the count and drops the log, keeping the output.
  it("a refused install's message, output and live log survive a section switch; reopening Settings replaces the message and drops the log but keeps the output", async () => {
    openAt('#settings/plugins');
    await waitFor(() => expect(entry('code-share')).not.toBeNull());
    fireEvent.click(entryButton('code-share', 'Install'));
    const s = await streamAt(0);
    await feed(s, 'Cloning into code-share...\n');
    await finish(s, failed('clone failed', 'fatal: boom'));
    await waitFor(() => expect(libLine()).toMatch(/Code Share.*clone failed/));

    await switchTo('archived');
    await switchTo('plugins');
    await waitFor(() => expect(gets('/api/plugins/library')).toBe(2));
    await waitFor(() => expect(entryButton('code-share', 'Install').disabled).toBe(false));
    expect(libLine()).toMatch(/Code Share.*clone failed/);
    expect(libTone()).toBe('error');
    expect(tail()).toBe('fatal: boom');
    expect(live('code-share')).toContain('Cloning');

    await leaveAndReenter('plugins');
    await waitFor(() => expect(gets('/api/plugins/library')).toBe(3));
    await waitFor(() => expect(libLine()).toMatch(/^1\b/));
    expect(libTone()).toBe('muted');
    expect(tail()).toBe('fatal: boom');
    expect(live('code-share')).toBe('');
  });

  // Reopening Settings while an install streams keeps its progress line and live log (new behaviour, matching About's running update).
  it('an install still streaming when Settings is reopened keeps its progress line and live log', async () => {
    openAt('#settings/plugins');
    await waitFor(() => expect(entry('code-share')).not.toBeNull());
    fireEvent.click(entryButton('code-share', 'Install'));
    const s = await streamAt(0);
    await feed(s, 'Cloning into code-share...\n');
    await leaveAndReenter('plugins');
    await waitFor(() => expect(gets('/api/plugins/library')).toBe(2));
    await waitFor(() => expect(entryButton('code-share', 'Installing…').disabled).toBe(true));
    expect(libLine()).toMatch(/^Installing Code Share\b(?!.*failed)/);
    expect(live('code-share')).toContain('Cloning into code-share');
    library = [INSTALLED];
    await finish(s, ok({ id: 'code-share', name: 'code-share', postClone: null }));
    await waitFor(() => expect(entryButtons('code-share')).toEqual(['Update']));
    expect(libLine()).toMatch(/^1\b/);
  });

  // A refused plugin action's message survives a section switch over the remount's count; reopening Settings replaces it with the plugin count.
  it("a refused plugin action's message survives a section switch, and reopening Settings replaces it with the plugin count", async () => {
    rows = [OFF];
    serve({ 'POST /api/plugins/off/enable': () => ({ status: 500, json: { error: 'enable boom' } }) });
    openAt('#settings/plugins');
    await waitFor(() => expect(entry('code-share')).not.toBeNull());
    fireEvent.click(button('Enable'));
    await waitFor(() => expect(pluginsLine()).toMatch(/off.*enable boom/));
    expect(pluginsTone()).toBe('error');

    rows = [OFF, PL];
    await switchTo('archived');
    await switchTo('plugins');
    await waitFor(() => expect(gets('/api/plugins')).toBe(2));
    await screen.findByText('Pl');
    expect(pluginsLine()).toMatch(/off.*enable boom/);
    expect(pluginsTone()).toBe('error');

    await leaveAndReenter('plugins');
    await waitFor(() => expect(pluginsLine()).toMatch(/^2\b/));
    expect(pluginsTone()).toBe('muted');
  });

  // A plugin action still in flight after a section switch keeps the one-action guard: a second action starts nothing until the first ends.
  it('a plugin action still in flight after a section switch blocks a second one until it ends', async () => {
    rows = [PL];
    const h = heldJson();
    serve({ 'POST /api/plugins/rescan': () => h.response, 'POST /api/plugins/pl/start': () => ({ ok: true }) });
    openAt('#settings/plugins');
    await waitFor(() => expect(entry('code-share')).not.toBeNull());
    fireEvent.click(button('Rescan'));
    await waitFor(() => expect(pluginsLine()).toMatch(/^Rescanning/));
    await switchTo('archived');
    await switchTo('plugins');
    await waitFor(() => expect(gets('/api/plugins')).toBe(2));
    const start = (await screen.findByRole('button', { name: 'Start' })) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(button('Rescanning…').disabled).toBe(true);
    fireEvent.click(start);
    expect(posts('/api/plugins/pl/start').length).toBe(0);
    expect(pluginsLine()).toMatch(/^Rescanning/);

    await act(async () => h.release({ ok: true }));
    await waitFor(() => expect(pluginsLine()).toMatch(/^1\b/));
    await waitFor(() => expect(button('Start').disabled).toBe(false));
    fireEvent.click(button('Start'));
    expect(posts('/api/plugins/pl/start').length).toBe(1);
    await waitFor(() => expect(pluginsLine()).toMatch(/^1\b/));
  });
});

describe('Plugins → reloads', () => {
  // Every reload after an action replaces a refusal on either status line and drops the live logs; the library output stays until the next install or update starts.
  it('a reload after any action replaces a refusal on either status line and drops the live logs, but keeps the library output', async () => {
    rows = [OFF];
    library = [SHARE];
    serve({ 'POST /api/plugins/off/enable': () => ({ status: 500, json: { error: 'enable boom' } }), 'POST /api/plugins/rescan': () => ({ ok: true }) });
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^1\b/));
    const g = gets('/api/plugins/library');

    fireEvent.click(button('Enable'));
    await waitFor(() => expect(pluginsLine()).toMatch(/off.*enable boom/));

    fireEvent.click(entryButton('code-share', 'Install'));
    const s = await streamAt(0);
    await feed(s, 'Cloning into code-share...\n');
    library = [INSTALLED];
    await finish(s, ok({ id: 'code-share', name: 'code-share', postClone: null }));
    await waitFor(() => {
      expect(entryButtons('code-share')).toEqual(['Update']);
      expect(gets('/api/plugins/library')).toBe(g + 1);
    });
    expect(pluginsLine()).toMatch(/^1\b/);
    expect(pluginsTone()).toBe('muted');
    expect(live('code-share')).toBe('');

    fireEvent.click(entryButton('code-share', 'Update'));
    const s1 = await streamAt(1);
    await feed(s1, 'Updating code-share...\n');
    await finish(s1, failed('git pull failed', 'fatal: diverged'));
    await waitFor(() => expect(libLine()).toMatch(/Code Share.*git pull failed/));
    expect(live('code-share')).toContain('Updating code-share');

    fireEvent.click(button('Rescan'));
    await waitFor(() => expect(posts('/api/plugins/rescan').length).toBe(1));
    await waitFor(() => expect(gets('/api/plugins/library')).toBe(g + 2));
    await waitFor(() => expect(libLine()).toMatch(/^1\b/));
    expect(libTone()).toBe('muted');
    expect(tail()).toBe('fatal: diverged');
    expect(live('code-share')).toBe('');
  });

  // A reload that fails after an action leaves its own message on the plugin list's line and no action's progress note on either line.
  it("a reload that fails after an action says so on the plugin list's line and leaves no progress note on either line", async () => {
    rows = [PL];
    library = [SHARE];
    let libraryDown = false;
    serve({
      'GET /api/plugins/library': () => (libraryDown ? { status: 500, json: { error: 'library unavailable' } } : { entries: library, skipped }),
      'POST /api/plugins/rescan': () => ({ ok: true }),
    });
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^1\b/));
    const g = gets('/api/plugins/library');

    libraryDown = true;
    fireEvent.click(button('Rescan'));
    await waitFor(() => expect(pluginsLine()).toMatch(/library unavailable/));
    expect(pluginsTone()).toBe('error');

    fireEvent.click(entryButton('code-share', 'Install'));
    await finish(await streamAt(0), ok({ id: 'code-share', name: 'code-share', postClone: null }));
    await waitFor(() => {
      expect(gets('/api/plugins/library')).toBe(g + 2);
      expect(entryButtons('code-share')).toEqual(['Install']);
    });
    expect(libLine()).toMatch(/^1\b/);
    expect(libTone()).toBe('muted');
    expect(pluginsLine()).toMatch(/library unavailable/);
  });
});

// Settings part 3c (card 2026-0654)
// Behind after its update: Behind's server state once an update landed.
const CAUGHT_UP: LibraryEntry = { ...BEHIND, updateAvailable: false };
// Flagged behind but not installed: it shows Install, so Update all neither counts nor updates it.
const STRAY: LibraryEntry = { id: 'stray', name: 'Stray', repo: 'https://example.test/stray', installed: false, installedAs: null, updateAvailable: true };
// The plugin of Behind's project: an update of Behind names it.
const BEHIND_A: PluginRow = { ...SHARE_A, id: 'behind-a', name: 'Behind A', project: 'behind' };
// The local-only note's subjects: a plugin here, one on a system declaring both capabilities,
// a conventions-only one on a system, and a disabled one on a system that still carries a code.
const HERE: PluginRow = { ...PL, id: 'here', name: 'Here', project: 'here', system: 'local' };
const BOTH: PluginRow = { ...PL, id: 'both', name: 'Both', project: 'both', system: 'prod-box', localOnly: ['PLUGIN_BACKEND_LOCAL_ONLY', 'PLUGIN_DIR_LOCAL_ONLY'] };
const CONV: PluginRow = { id: 'conv', name: 'Conv', project: 'conv', state: 'stopped', enabled: true, hasBackend: false, system: 'prod-box', localOnly: [] };
const OFF_THERE: PluginRow = { ...OFF, id: 'off-there', name: 'Off There', project: 'off-there', system: 'prod-box', localOnly: ['PLUGIN_BACKEND_LOCAL_ONLY'] };

/** Update all, whatever its label: `Update all`, `Update all (N)` or `Updating i/n…`. */
const updateAllButton = () => screen.getByTitle('Update every installed library plugin that is behind its origin, one at a time') as HTMLButtonElement;
const plugin = (id: string) => document.querySelector(`[data-plugin="${id}"]`) as HTMLElement;
const pluginButtons = (id: string) => within(plugin(id)).queryAllByRole('button').map((b) => (b.textContent ?? '').trim());
const localOnlyNote = (id: string) => plugin(id).querySelector('[data-local-only]') as HTMLElement | null;
/** The index of the first recorded POST to `url`; -1 if none. */
const postIndex = (url: string) => calls.findIndex((c) => c.method === 'POST' && c.url === url);
/** The indexes of the library GETs recorded after call `from`. */
const libraryGetsAfter = (from: number) => calls.flatMap((c, i) => (i > from && c.method === 'GET' && c.url === '/api/plugins/library' ? [i] : []));

describe('Plugins → Update all', () => {
  // Update all counts exactly the entries showing a per-entry Update: an up-to-date entry and an uninstalled one flagged behind leave it offered disabled and unnumbered.
  it('Update all is offered disabled when no installed library entry is behind its origin', async () => {
    library = [CURRENT, OTHER, STRAY];
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^3\b/));
    expect(entryButtons('stray')).toEqual(['Install']);
    expect(entryButtons('current')).toEqual([]);
    expect(updateAllButton().textContent).toMatch(/^Update all\D*$/);
    expect(updateAllButton().disabled).toBe(true);
  });

  // Update all updates each entry behind its origin in list order, one at a time, with its progress in the header and the status line and every entry locked; then it reloads the list exactly once, drops the live logs, summarises muted and announces one change naming every plugin of the updated projects.
  it('Update all updates each entry behind its origin one at a time, then reloads the list once and announces one change', async () => {
    rows = [SHARE_A, BEHIND_A, ELSEWHERE];
    library = [INSTALLED, CURRENT, STRAY, BEHIND];
    serve({ 'POST /api/plugins/library/behind/update': newStream });
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^4\b/));
    expect(updateAllButton().textContent).toMatch(/\(2\)/);
    expect(updateAllButton().disabled).toBe(false);
    const v0 = pluginsChangedSignal.version();
    const g = gets('/api/plugins/library');

    fireEvent.click(updateAllButton());
    const s0 = await streamAt(0);
    await waitFor(() => expect(updateAllButton().textContent).toMatch(/1\/2/));
    expect(updateAllButton().disabled).toBe(true);
    expect(libLine()).toMatch(/Updating Code Share.*1\/2/);
    expect(libTone()).toBe('muted');
    expect(entryButton('code-share', 'Updating…').disabled).toBe(true);
    expect(entryButton('behind', 'Update').disabled).toBe(true);
    expect(posts('/api/plugins/library/behind/update').length).toBe(0);
    await feed(s0, 'Updating code-share...\n');
    await waitFor(() => expect(live('code-share')).toContain('Updating code-share...'));

    await finish(s0, ok({ id: 'code-share', name: 'code-share', project: 'code-share', postPull: null, restarted: null }));
    const s1 = await streamAt(1);
    await waitFor(() => expect(updateAllButton().textContent).toMatch(/2\/2/));
    expect(libLine()).toMatch(/Updating Behind.*2\/2/);
    expect(entryButton('behind', 'Updating…').disabled).toBe(true);
    expect(entryButton('code-share', 'Update').disabled).toBe(true);
    expect(gets('/api/plugins/library')).toBe(g);

    library = [UP_TO_DATE, CURRENT, STRAY, CAUGHT_UP];
    await finish(s1, ok({ id: 'behind', name: 'behind', project: 'behind', postPull: null, restarted: null }));
    await waitFor(() => expect(libLine()).toMatch(/Updated 2 of 2/));
    expect(libTone()).toBe('muted');
    expect(tail()).toBe('');
    expect(installedAs('code-share')).toBe('installed as code-share · up to date');
    expect(installedAs('behind')).toBe('installed as behind · up to date');
    expect(live('code-share')).toBe('');
    expect(updateAllButton().textContent).toMatch(/^Update all\D*$/);
    expect(updateAllButton().disabled).toBe(true);
    const reloads = libraryGetsAfter(postIndex('/api/plugins/library/code-share/update'));
    expect(reloads.length).toBe(1);
    expect(reloads[0]).toBeGreaterThan(postIndex('/api/plugins/library/behind/update'));
    expect(posts('/api/plugins/library/stray/update').length).toBe(0);
    expect(posts('/api/plugins/library/current/update').length).toBe(0);
    expect(pluginsChangedSignal.version()).toBe(v0 + 1);
    expect(pluginsChangeStore.get().lastChange).toEqual({ action: 'update', ids: ['share-a', 'behind-a'] });
  });

  // A failed update does not stop the run: the summary counts only the updates that landed and names the failure beside the other entry's warning, each output under its entry's name; the failed entry stays offered; only the updated project's plugins are announced. A run with nothing landing announces nothing, says "plugin" for one, and clears the previous output at its start.
  it('Update all continues past a failed update and names it in the summary beside a warning, with each output', async () => {
    rows = [SHARE_A, BEHIND_A, ELSEWHERE];
    library = [INSTALLED, BEHIND];
    serve({ 'POST /api/plugins/library/behind/update': newStream });
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^2\b/));
    const v0 = pluginsChangedSignal.version();

    fireEvent.click(updateAllButton());
    await finish(await streamAt(0), failed('git pull failed', 'fatal: diverged'));
    const s1 = await streamAt(1);
    library = [INSTALLED, CAUGHT_UP];
    await finish(s1, ok({ id: 'behind', name: 'behind', project: 'behind', postPull: { ran: true, ok: false, code: 1, tail: 'npm ERR! behind' }, restarted: null }));
    await waitFor(() => expect(libLine()).toMatch(/Updated 1 of 2/));
    // Invariant: the failure is named with its cause beside the other entry's warning, and each output sits under its own entry's name.
    for (const part of ['Code Share', 'git pull failed', 'Behind', 'post-update']) expect(libLine()).toContain(part);
    expect(libTone()).toBe('error');
    expect(tail()).toMatch(/Code Share[\s\S]*fatal: diverged[\s\S]*Behind[\s\S]*npm ERR! behind/);
    expect(updateAllButton().textContent).toMatch(/\(1\)/);
    expect(updateAllButton().disabled).toBe(false);
    expect(entryButton('code-share', 'Update').disabled).toBe(false);
    expect(installedAs('behind')).toBe('installed as behind · up to date');
    expect(pluginsChangedSignal.version()).toBe(v0 + 1);
    expect(pluginsChangeStore.get().lastChange).toEqual({ action: 'update', ids: ['behind-a'] });

    fireEvent.click(updateAllButton());
    const s2 = await streamAt(2);
    await waitFor(() => expect(updateAllButton().textContent).toMatch(/1\/1/));
    expect(tail()).toBe('');
    await finish(s2, failed('git pull failed'));
    await waitFor(() => expect(libLine()).toMatch(/Updated 0 of 1.*Code Share.*git pull failed/));
    expect(libTone()).toBe('error');
    expect(tail()).toBe('');
    expect(pluginsChangedSignal.version()).toBe(v0 + 1);
    expect(updateAllButton().textContent).toMatch(/\(1\)/);
  });

  // A soft warning is not a failure: both updates count, the summary lists each warning in the single-update wording, only a warning with output adds to the output, and every updated plugin is announced.
  it('Update all reports a post-update warning per plugin without counting it as a failure', async () => {
    rows = [SHARE_A, BEHIND_A, ELSEWHERE];
    library = [INSTALLED, BEHIND];
    serve({ 'POST /api/plugins/library/behind/update': newStream });
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^2\b/));
    const v0 = pluginsChangedSignal.version();

    fireEvent.click(updateAllButton());
    await finish(await streamAt(0), ok({ id: 'code-share', name: 'code-share', project: 'code-share', postPull: { ran: true, ok: false, code: 1, tail: 'npm ERR! share' }, restarted: null }));
    const s1 = await streamAt(1);
    library = [UP_TO_DATE, CAUGHT_UP];
    await finish(s1, ok({ id: 'behind', name: 'behind', project: 'behind', postPull: { ran: true, ok: true, code: 0, tail: 'added 3 packages' }, restarted: { ids: ['behind-a'], ok: false, error: 'boom' } }));
    await waitFor(() => expect(libLine()).toMatch(/Updated 2 of 2/));
    // Invariant: both updates count (no failure is named), each warning names its plugin and cause, and only the warning that has output adds to the output.
    expect(libLine()).toMatch(/Code Share.*post-update/);
    expect(libLine()).toMatch(/Behind.*restarting.*boom/);
    expect(libLine()).not.toMatch(/failed: git|fatal/);
    expect(libTone()).toBe('error');
    expect(tail()).toContain('npm ERR! share');
    // Positive control: the output is non-empty (the line above), so the absence below is not an empty read.
    expect(tail()).not.toContain('added 3 packages');
    expect(updateAllButton().textContent).toMatch(/^Update all\D*$/);
    expect(pluginsChangedSignal.version()).toBe(v0 + 1);
    expect(pluginsChangeStore.get().lastChange).toEqual({ action: 'update', ids: ['share-a', 'behind-a'] });
  });

  // While Update all runs every other plugin control is disabled, Rescan and the installed list's included; once it ends they are enabled again.
  it('other plugin actions are locked while Update all runs, and free once it ends', async () => {
    rows = [PL, OFF];
    library = [INSTALLED, BEHIND, OTHER];
    serve({ 'POST /api/plugins/library/behind/update': newStream });
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^3\b/));
    fireEvent.click(updateAllButton());
    const s0 = await streamAt(0);
    await waitFor(() => expect(updateAllButton().textContent).toMatch(/1\/2/));
    expect(button('Rescan').disabled).toBe(true);
    expect(button('Start').disabled).toBe(true);
    expect(button('Disable').disabled).toBe(true);
    expect(button('Enable').disabled).toBe(true);
    expect((screen.getByLabelText('Active version of Pl') as HTMLSelectElement).disabled).toBe(true);
    expect(entryButton('other', 'Install').disabled).toBe(true);
    expect(entryButton('behind', 'Update').disabled).toBe(true);

    await finish(s0, ok({ project: 'code-share', postPull: null, restarted: null }));
    const s1 = await streamAt(1);
    library = [UP_TO_DATE, CAUGHT_UP, OTHER];
    await finish(s1, ok({ project: 'behind', postPull: null, restarted: null }));
    await waitFor(() => expect(libLine()).toMatch(/Updated 2 of 2/));
    expect(button('Rescan').disabled).toBe(false);
    expect(button('Start').disabled).toBe(false);
    expect(button('Disable').disabled).toBe(false);
    expect(button('Enable').disabled).toBe(false);
    expect((screen.getByLabelText('Active version of Pl') as HTMLSelectElement).disabled).toBe(false);
    expect(entryButton('other', 'Install').disabled).toBe(false);
  });

  // A section switch or a reopened Settings mid-run reloads the lists but re-arms neither Update all nor any entry; the progress line and the live log stay, and the run lands in the section shown.
  it('a reload during Update all keeps it and every entry locked, with its progress line and live log', async () => {
    library = [INSTALLED, BEHIND];
    serve({ 'POST /api/plugins/library/behind/update': newStream });
    openAt('#settings/plugins');
    await waitFor(() => expect(entry('code-share')).not.toBeNull());
    fireEvent.click(updateAllButton());
    const s0 = await streamAt(0);
    await feed(s0, 'Updating code-share...\n');

    await switchTo('archived');
    await switchTo('plugins');
    await waitFor(() => expect(gets('/api/plugins/library')).toBe(2));
    await waitFor(() => expect(entryButton('code-share', 'Updating…').disabled).toBe(true));
    expect(updateAllButton().textContent).toMatch(/1\/2/);
    expect(updateAllButton().disabled).toBe(true);
    expect(entryButton('behind', 'Update').disabled).toBe(true);
    expect(libLine()).toMatch(/Updating Code Share.*1\/2/);
    expect(live('code-share')).toContain('Updating code-share...');

    await leaveAndReenter('plugins');
    await waitFor(() => expect(gets('/api/plugins/library')).toBe(3));
    await waitFor(() => expect(entryButton('code-share', 'Updating…').disabled).toBe(true));
    expect(updateAllButton().textContent).toMatch(/1\/2/);
    expect(updateAllButton().disabled).toBe(true);
    expect(entryButton('behind', 'Update').disabled).toBe(true);
    expect(libLine()).toMatch(/Updating Code Share.*1\/2/);
    expect(live('code-share')).toContain('Updating code-share...');

    await finish(s0, ok({ project: 'code-share', postPull: null, restarted: null }));
    const s1 = await streamAt(1);
    library = [UP_TO_DATE, CAUGHT_UP];
    await finish(s1, ok({ project: 'behind', postPull: null, restarted: null }));
    await waitFor(() => expect(libLine()).toMatch(/Updated 2 of 2/));
    expect(updateAllButton().textContent).toMatch(/^Update all\D*$/);
  });

  // Update all starts nothing while another action holds the guard: during a single Update it is disabled; during a plugin action it is disabled, and its click starts no update; once the action ends it runs.
  it('Update all starts no update while another plugin action is in flight', async () => {
    rows = [PL];
    library = [INSTALLED, BEHIND];
    const h = heldJson();
    serve({ 'POST /api/plugins/library/behind/update': newStream, 'POST /api/plugins/rescan': () => h.response });
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^2\b/));

    fireEvent.click(entryButton('code-share', 'Update'));
    const s0 = await streamAt(0);
    await waitFor(() => expect(entryButton('code-share', 'Updating…').disabled).toBe(true));
    expect(updateAllButton().textContent).toMatch(/\(2\)/);
    expect(updateAllButton().disabled).toBe(true);
    library = [UP_TO_DATE, BEHIND];
    await finish(s0, ok({ project: 'code-share', postPull: null, restarted: null }));
    await waitFor(() => expect(updateAllButton().textContent).toMatch(/\(1\)/));
    expect(posts('/api/plugins/library/behind/update').length).toBe(0);

    fireEvent.click(button('Rescan'));
    await waitFor(() => expect(pluginsLine()).toMatch(/^Rescanning/));
    expect(updateAllButton().disabled).toBe(true);
    fireEvent.click(updateAllButton());
    await act(async () => {});
    expect(posts('/api/plugins/library/behind/update').length).toBe(0);
    expect(updateAllButton().textContent).toMatch(/\(1\)/);
    expect(libLine()).toMatch(/^2\b/);

    await act(async () => h.release({ ok: true }));
    await waitFor(() => expect(pluginsLine()).toMatch(/^1\b/));
    fireEvent.click(updateAllButton());
    const s1 = await streamAt(1);
    library = [UP_TO_DATE, CAUGHT_UP];
    await finish(s1, ok({ project: 'behind', postPull: null, restarted: null }));
    await waitFor(() => expect(libLine()).toMatch(/Updated 1 of 1/));
  });

  // A closing reload that fails leaves the pre-run list: Update all re-arms for both entries, the plugin list's line says why, and the change still names the updated projects' plugins from the rows already loaded.
  it('Update all re-arms its button when the reload after the run fails', async () => {
    rows = [SHARE_A, BEHIND_A, ELSEWHERE];
    library = [INSTALLED, BEHIND];
    let libraryDown = false;
    serve({
      'GET /api/plugins/library': () => (libraryDown ? { status: 500, json: { error: 'library unavailable' } } : { entries: library, skipped }),
      'POST /api/plugins/library/behind/update': newStream,
    });
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^2\b/));
    libraryDown = true;
    fireEvent.click(updateAllButton());
    await finish(await streamAt(0), ok({ project: 'code-share', postPull: null, restarted: null }));
    await finish(await streamAt(1), ok({ project: 'behind', postPull: null, restarted: null }));
    await waitFor(() => expect(pluginsLine()).toMatch(/library unavailable/));
    expect(pluginsTone()).toBe('error');
    await waitFor(() => expect(libLine()).toMatch(/Updated 2 of 2/));
    expect(updateAllButton().textContent).toMatch(/\(2\)/);
    expect(updateAllButton().disabled).toBe(false);
    expect(entryButton('code-share', 'Update').disabled).toBe(false);
    expect(entryButton('behind', 'Update').disabled).toBe(false);
    expect(pluginsChangeStore.get().lastChange).toEqual({ action: 'update', ids: ['share-a', 'behind-a'] });
  });

  // A reload that finds the library empty disarms an armed Update all.
  it('Update all disarms when a reload finds the library empty', async () => {
    rows = [PL];
    library = [INSTALLED, BEHIND];
    serve({ 'POST /api/plugins/rescan': () => ({ ok: true }) });
    wrap();
    await waitFor(() => expect(updateAllButton().textContent).toMatch(/\(2\)/));
    expect(updateAllButton().disabled).toBe(false);
    library = [];
    fireEvent.click(button('Rescan'));
    await waitFor(() => expect(libLine()).toMatch(/no library entries/i));
    expect(updateAllButton().textContent).toMatch(/^Update all\D*$/);
    expect(updateAllButton().disabled).toBe(true);
  });

  // Update all holds the guard across its closing reload: with no entry running any more, every entry, Install and plugin action stays locked until that reload lands.
  it('Update all keeps every plugin control locked through its closing reload', async () => {
    rows = [PL];
    library = [INSTALLED, BEHIND, OTHER];
    const h = heldJson();
    let holdNext = false;
    serve({
      'GET /api/plugins/library': () => {
        if (!holdNext) return { entries: library, skipped };
        holdNext = false;
        return h.response;
      },
      'POST /api/plugins/library/behind/update': newStream,
    });
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^3\b/));
    const g = gets('/api/plugins/library');
    fireEvent.click(updateAllButton());
    await finish(await streamAt(0), ok({ project: 'code-share', postPull: null, restarted: null }));
    const s1 = await streamAt(1);
    holdNext = true;
    library = [UP_TO_DATE, CAUGHT_UP, OTHER];
    await finish(s1, ok({ project: 'behind', postPull: null, restarted: null }));
    await waitFor(() => expect(gets('/api/plugins/library')).toBe(g + 1));
    // Positive control: the run has cleared its running entry, so only Update all's own hold can lock anything now.
    await waitFor(() => expect(entryButtons('behind')).toEqual(['Update']));
    expect(updateAllButton().textContent).toMatch(/2\/2/);
    expect(updateAllButton().disabled).toBe(true);
    expect(entryButton('code-share', 'Update').disabled).toBe(true);
    expect(entryButton('behind', 'Update').disabled).toBe(true);
    expect(entryButton('other', 'Install').disabled).toBe(true);
    expect(button('Rescan').disabled).toBe(true);
    expect(button('Start').disabled).toBe(true);

    await act(async () => h.release({ entries: library, skipped: [] }));
    await waitFor(() => expect(libLine()).toMatch(/Updated 2 of 2/));
    expect(entryButton('other', 'Install').disabled).toBe(false);
    expect(button('Rescan').disabled).toBe(false);
    expect(button('Start').disabled).toBe(false);
  });

  // Update all updates what is behind when clicked, not what was last painted: an entry that caught up since is skipped, and with none left the click starts nothing, reloads nothing and leaves the guard free.
  it('Update all reads its targets when clicked: a caught-up entry is skipped, and with none left it starts nothing and takes no guard', async () => {
    rows = [PL];
    library = [INSTALLED, BEHIND];
    serve({ 'POST /api/plugins/library/behind/update': newStream, 'POST /api/plugins/rescan': () => ({ ok: true }) });
    wrap();
    await waitFor(() => expect(updateAllButton().textContent).toMatch(/\(2\)/));
    const btn = updateAllButton();
    // A reload lands after the paint, Behind caught up; React re-renders only when this act ends.
    act(() => {
      pluginsStore.set({ library: [INSTALLED, CAUGHT_UP] });
      // Positive control: the click lands on the paint that still offers both.
      expect(btn.textContent).toMatch(/\(2\)/);
      expect(btn.disabled).toBe(false);
      fireEvent.click(btn);
    });
    const s0 = await streamAt(0);
    await waitFor(() => expect(updateAllButton().textContent).toMatch(/1\/1/));
    library = [UP_TO_DATE, CAUGHT_UP];
    await finish(s0, ok({ project: 'code-share', postPull: null, restarted: null }));
    await waitFor(() => expect(libLine()).toMatch(/Updated 1 of 1/));
    expect(posts('/api/plugins/library/behind/update').length).toBe(0);

    library = [INSTALLED, BEHIND];
    fireEvent.click(button('Rescan'));
    await waitFor(() => {
      expect(pluginsLine()).toMatch(/^1\b/);
      expect(updateAllButton().textContent).toMatch(/\(2\)/);
    });
    const g = gets('/api/plugins/library');
    const btn2 = updateAllButton();
    act(() => {
      pluginsStore.set({ library: [UP_TO_DATE, CAUGHT_UP] });
      // Positive control, as above.
      expect(btn2.textContent).toMatch(/\(2\)/);
      expect(btn2.disabled).toBe(false);
      fireEvent.click(btn2);
    });
    await act(async () => {});
    // Sanity only: no extra update POST (1 either way; `gets` and `libLine` are what discriminate).
    expect(posts('/api/plugins/library/code-share/update').length).toBe(1);
    expect(gets('/api/plugins/library')).toBe(g);
    expect(libLine()).toMatch(/^2\b/);
    expect(updateAllButton().textContent).toMatch(/^Update all\D*$/);
    fireEvent.click(button('Rescan'));
    expect(posts('/api/plugins/rescan').length).toBe(2);
    await waitFor(() => expect(pluginsLine()).toMatch(/^1\b/));
  });
});

const rowBtn = (id: string, name: string) => within(plugin(id)).getByRole('button', { name }) as HTMLButtonElement;
const kaSelect = () => screen.getByLabelText('Active version of KA') as HTMLSelectElement;

describe('Plugins → action in flight', () => {
  // The clicked control alone is relabelled; every plugin control is disabled until the request and the reload after it land.
  it('a row action shows its pending label on the clicked button only, disables every plugin control, and clears once the action and its reload land', async () => {
    rows = [KA, PL, OFF];
    library = [INSTALLED, OTHER];
    projects = [{ name: 'kaproj', worktrees: [{ worktreeName: 'wt' }] }];
    const h = heldJson();
    const reload = heldJson();
    let pluginGets = 0;
    serve({
      'POST /api/plugins/ka/restart': () => h.response,
      'GET /api/plugins': () => (++pluginGets === 2 ? reload.response : { rows, notices: [] }),
      'POST /api/plugins/pl/start': () => ({ ok: true }),
    });
    wrap();
    await waitFor(() => expect(libLine()).toMatch(/^2\b/));

    fireEvent.click(rowBtn('ka', 'Restart'));
    await waitFor(() => expect(rowBtn('ka', 'Restarting…').disabled).toBe(true));
    expect(rowBtn('ka', 'Stop').disabled).toBe(true);
    expect(kaSelect().disabled).toBe(true);
    expect(rowBtn('ka', 'Disable').disabled).toBe(true);
    expect(pluginButtons('pl')).toEqual(['Start', 'Disable']);
    expect(rowBtn('pl', 'Start').disabled).toBe(true);
    expect(rowBtn('pl', 'Disable').disabled).toBe(true);
    expect(rowBtn('off', 'Enable').disabled).toBe(true);
    expect(button('Rescan').disabled).toBe(true);
    expect(entryButton('code-share', 'Update').disabled).toBe(true);
    expect(entryButton('other', 'Install').disabled).toBe(true);
    expect(updateAllButton().disabled).toBe(true);
    expect(pluginsLine()).toMatch(/^Restarting ka/);

    fireEvent.click(rowBtn('ka', 'Restarting…'));
    fireEvent.click(rowBtn('pl', 'Start'));
    expect(posts('/api/plugins/ka/restart').length).toBe(1);
    expect(posts('/api/plugins/pl/start').length).toBe(0);

    await act(async () => h.release({}));
    await waitFor(() => expect(gets('/api/plugins')).toBe(2));
    expect(rowBtn('ka', 'Restarting…').disabled).toBe(true);
    expect(rowBtn('pl', 'Start').disabled).toBe(true);

    await act(async () => reload.release({ rows, notices: [] }));
    await waitFor(() => expect(rowBtn('ka', 'Restart').disabled).toBe(false));
    expect(rowBtn('ka', 'Stop').disabled).toBe(false);
    expect(kaSelect().disabled).toBe(false);
    expect(rowBtn('ka', 'Disable').disabled).toBe(false);
    expect(rowBtn('pl', 'Start').disabled).toBe(false);
    expect(rowBtn('off', 'Enable').disabled).toBe(false);
    expect(button('Rescan').disabled).toBe(false);
    expect(entryButton('code-share', 'Update').disabled).toBe(false);
    expect(entryButton('other', 'Install').disabled).toBe(false);
    expect(updateAllButton().disabled).toBe(false);
    await waitFor(() => expect(pluginsLine()).toMatch(/^3\b/));
    expect(pluginsTone()).toBe('muted');

    fireEvent.click(rowBtn('pl', 'Start'));
    expect(posts('/api/plugins/pl/start').length).toBe(1);
    await waitFor(() => expect(pluginsLine()).toMatch(/^3\b/));
  });

  // One subtest per control, so no row can hide behind another.
  it.each([
    { rows: [OFF], scope: 'off', click: 'Enable', pending: 'Enabling…', url: '/api/plugins/off/enable' },
    { rows: [PL], scope: 'pl', click: 'Start', pending: 'Starting…', url: '/api/plugins/pl/start' },
    { rows: [KA], scope: 'ka', click: 'Stop', pending: 'Stopping…', url: '/api/plugins/ka/stop' },
    { rows: [KA], scope: 'ka', click: 'Restart', pending: 'Restarting…', url: '/api/plugins/ka/restart' },
    { rows: [PL], scope: 'pl', click: 'Disable', pending: 'Disabling…', url: '/api/plugins/pl/disable' },
  ])('$click shows $pending on itself while its request is held', async ({ rows: r, scope, click, pending, url }) => {
    rows = r;
    const h = heldJson();
    serve({ [`POST ${url}`]: () => h.response });
    wrap();
    await waitFor(() => expect(pluginsLine()).toMatch(/^1\b/));
    fireEvent.click(rowBtn(scope, click));
    await waitFor(() => expect(rowBtn(scope, pending).disabled).toBe(true));
    expect(within(plugin(scope)).queryByRole('button', { name: click })).toBeNull();

    await act(async () => h.release({}));
    if (click === 'Enable' || click === 'Disable') {
      await waitFor(() => expect(within(plugin(scope)).queryByRole('button', { name: pending })).toBeNull());
      expect(posts(url).length).toBe(1);
    } else {
      await waitFor(() => expect(rowBtn(scope, click).disabled).toBe(false));
    }
  });

  // The pending label follows the plugin id, not the action: a second row offering the same action keeps its idle name.
  it('an action held on one row leaves another row offering the same action disabled but not relabelled', async () => {
    const PL2: PluginRow = { ...PL, id: 'pl2', name: 'Pl2', project: 'pl2' };
    rows = [PL, PL2];
    projects = [{ name: 'pl', worktrees: [{ worktreeName: 'wt' }] }, { name: 'pl2', worktrees: [{ worktreeName: 'wt' }] }];
    const h = heldJson();
    const v = heldJson();
    serve({ 'POST /api/plugins/pl/start': () => h.response, 'POST /api/plugins/pl2/version': () => v.response });
    wrap();
    await waitFor(() => expect(pluginsLine()).toMatch(/^2\b/));

    fireEvent.click(rowBtn('pl', 'Start'));
    await waitFor(() => expect(rowBtn('pl', 'Starting…').disabled).toBe(true));
    expect(pluginButtons('pl2')).toEqual(['Start', 'Disable']);
    expect(rowBtn('pl2', 'Start').disabled).toBe(true);
    await act(async () => h.release({ ok: true }));
    await waitFor(() => expect(rowBtn('pl', 'Start').disabled).toBe(false));

    const sel = within(plugin('pl2')).getByLabelText('Active version of Pl2') as HTMLSelectElement;
    await waitFor(() => expect(Array.from(sel.options).map((o) => o.value)).toEqual(['main', 'worktree:wt']));
    fireEvent.change(sel, { target: { value: 'worktree:wt' } });
    await waitFor(() => expect(plugin('pl2').textContent).toContain('Switching…'));
    expect(plugin('pl').textContent).not.toContain('Switching…');
    await act(async () => v.release({ ok: true }));
    await waitFor(() => expect(plugin('pl2').textContent).not.toContain('Switching…'));
  });

  it('Rescan shows Rescanning… on itself and disables every row\'s controls until it settles', async () => {
    rows = [PL];
    const h = heldJson();
    serve({ 'POST /api/plugins/rescan': () => h.response });
    wrap();
    await waitFor(() => expect(pluginButtons('pl')).toEqual(['Start', 'Disable']));
    fireEvent.click(button('Rescan'));
    await waitFor(() => expect(button('Rescanning…').disabled).toBe(true));
    expect(pluginButtons('pl')).toEqual(['Start', 'Disable']);
    expect(rowBtn('pl', 'Start').disabled).toBe(true);
    expect(rowBtn('pl', 'Disable').disabled).toBe(true);

    await act(async () => h.release({ ok: true }));
    await waitFor(() => expect(button('Rescan').disabled).toBe(false));
    expect(rowBtn('pl', 'Start').disabled).toBe(false);
  });

  it('a version switch shows Switching… beside the select and disables it until it settles', async () => {
    rows = [{ ...KA, activeVersion: { type: 'main' } }];
    projects = [{ name: 'kaproj', worktrees: [{ worktreeName: 'wt' }] }];
    const h = heldJson();
    serve({ 'POST /api/plugins/ka/version': () => h.response });
    wrap();
    const sel = (await screen.findByLabelText('Active version of KA')) as HTMLSelectElement;
    await waitFor(() => expect(Array.from(sel.options).map((o) => o.value)).toEqual(['main', 'worktree:wt']));
    expect(plugin('ka').textContent).not.toContain('Switching…');

    fireEvent.change(sel, { target: { value: 'worktree:wt' } });
    await waitFor(() => expect(plugin('ka').textContent).toContain('Switching…'));
    expect(sel.disabled).toBe(true);
    expect(rowBtn('ka', 'Stop').disabled).toBe(true);

    rows = [{ ...KA, activeVersion: { type: 'worktree', name: 'wt' } }];
    await act(async () => h.release({ ok: true }));
    await waitFor(() => expect(plugin('ka').textContent).not.toContain('Switching…'));
    expect(sel.disabled).toBe(false);
  });

  it("a failed action surfaces the server's error on the status line and clears pending, re-enabling every control", async () => {
    rows = [KA, PL];
    const h = heldJson(502);
    serve({ 'POST /api/plugins/ka/restart': () => h.response, 'POST /api/plugins/pl/start': () => ({ ok: true }) });
    wrap();
    await waitFor(() => expect(pluginsLine()).toMatch(/^2\b/));
    fireEvent.click(rowBtn('ka', 'Restart'));
    await waitFor(() => expect(rowBtn('ka', 'Restarting…').disabled).toBe(true));

    await act(async () => h.release({ error: "plugin 'ka' failed to start", tail: 'boom' }));
    await waitFor(() => expect(pluginsLine()).toMatch(/Restarting ka failed: plugin 'ka' failed to start/));
    expect(pluginsTone()).toBe('error');
    expect(rowBtn('ka', 'Restart').disabled).toBe(false);
    expect(rowBtn('ka', 'Stop').disabled).toBe(false);
    expect(rowBtn('pl', 'Start').disabled).toBe(false);

    fireEvent.click(rowBtn('pl', 'Start'));
    expect(posts('/api/plugins/pl/start').length).toBe(1);
    await waitFor(() => expect(pluginsLine()).toMatch(/^2\b/));
  });
});

describe('Plugins → local-only', () => {
  // A plugin on the machine cc runs on keeps its backend controls and carries no local-only note.
  it('a plugin on this machine offers Start and carries no local-only note', async () => {
    rows = [HERE];
    wrap();
    await waitFor(() => expect(pluginButtons('here')).toEqual(['Start', 'Disable']));
    expect(within(plugin('here')).getByLabelText('Active version of Here')).toBeTruthy();
    expect(localOnlyNote('here')).toBeNull();
  });

  // A plugin on a system declaring both local-only capabilities names the system and both codes on one note, and offers neither Start nor a version; a local sibling keeps both and has no note.
  it('a plugin on a system that declares both local-only capabilities names both codes on its note and hides Start', async () => {
    rows = [HERE, BOTH];
    wrap();
    await waitFor(() => expect(localOnlyNote('both')).not.toBeNull());
    // Invariant: the note names the system and both capability codes, and carries an explanatory title.
    for (const part of ['prod-box', 'PLUGIN_BACKEND_LOCAL_ONLY', 'PLUGIN_DIR_LOCAL_ONLY']) expect(localOnlyNote('both')!.textContent).toContain(part);
    expect(localOnlyNote('both')!.getAttribute('title')).toBeTruthy();
    expect(pluginButtons('both')).toEqual(['Disable']);
    expect(within(plugin('both')).queryByLabelText('Active version of Both')).toBeNull();
    expect(pluginButtons('here')).toEqual(['Start', 'Disable']);
    expect(localOnlyNote('here')).toBeNull();
  });

  // A plugin on a system that declares no local-only capability is not marked and keeps Disable; a disabled plugin there carries no note even with a code.
  it('a conventions-only plugin on a system is not marked local-only and keeps Disable, and a disabled plugin there carries no note', async () => {
    rows = [CONV, OFF_THERE];
    wrap();
    await waitFor(() => expect(pluginButtons('conv')).toEqual(['Disable']));
    expect(localOnlyNote('conv')).toBeNull();
    expect(pluginButtons('off-there')).toEqual(['Enable']);
    expect(localOnlyNote('off-there')).toBeNull();
  });
});

describe('Plugins → auto-start', () => {
  const autoStartSwitch = (id: string) => within(plugin(id)).queryByRole('switch') as HTMLButtonElement | null;
  /** Answers an auto-start save the way the server does: the flag lands on the row the reload reads. */
  const saveAutoStart = (id: string) => (call: Call) => {
    rows = rows.map((r) => (r.id === id ? { ...r, autoStart: call.body.autoStart } : r));
    return rows.find((r) => r.id === id);
  };

  // The switch posts the toggled value and then shows the server's value, not its own.
  it('the switch posts {autoStart} for its plugin, shows Saving… while held, and reads the reloaded row', async () => {
    rows = [{ ...PL, autoStart: false }];
    const h = heldJson();
    const save = saveAutoStart('pl');
    serve({ 'POST /api/plugins/pl/autostart': (call) => { save(call); return h.response; } });
    wrap();
    await waitFor(() => expect(autoStartSwitch('pl')).not.toBeNull());
    const sw = screen.getByRole('switch', { name: 'Auto-start Pl' });
    expect(sw.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(sw);
    await waitFor(() => expect(plugin('pl').textContent).toContain('Saving…'));
    expect(posts('/api/plugins/pl/autostart').map((c) => c.body)).toEqual([{ autoStart: true }]);
    await act(async () => h.release(rows[0]));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Auto-start Pl' }).getAttribute('aria-checked')).toBe('true'));
    expect(plugin('pl').textContent).not.toContain('Saving…');

    serve({ 'POST /api/plugins/pl/autostart': saveAutoStart('pl') });
    fireEvent.click(screen.getByRole('switch', { name: 'Auto-start Pl' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Auto-start Pl' }).getAttribute('aria-checked')).toBe('false'));
    expect(posts('/api/plugins/pl/autostart').map((c) => c.body)).toEqual([{ autoStart: false }]);
  });

  // Auto-start applies only to a plugin cc could start: enabled, with a backend, on this machine.
  it('only an enabled local plugin with a backend offers the switch', async () => {
    const NO_BACKEND: PluginRow = { ...PL, id: 'nb', name: 'Nb', project: 'nb', hasBackend: false };
    rows = [PL, OFF, NO_BACKEND, BOTH];
    wrap();
    await waitFor(() => expect(pluginsLine()).toMatch(/^4\b/));
    expect(autoStartSwitch('pl')).not.toBeNull();
    expect(autoStartSwitch('off')).toBeNull();
    expect(autoStartSwitch('nb')).toBeNull();
    expect(autoStartSwitch('both')).toBeNull();
  });

  // A refused save reports the server's error and leaves the switch at the server's value.
  it("a refused save shows the server's error on the status line and the switch stays off", async () => {
    rows = [{ ...PL, autoStart: false }];
    serve({ 'POST /api/plugins/pl/autostart': () => ({ status: 409, json: { error: "plugin 'pl' is not enabled" } }) });
    wrap();
    await waitFor(() => expect(autoStartSwitch('pl')).not.toBeNull());
    fireEvent.click(autoStartSwitch('pl')!);
    await waitFor(() => expect(pluginsLine()).toMatch(/Turning auto-start on for pl failed: plugin 'pl' is not enabled/));
    expect(pluginsTone()).toBe('error');
    expect(autoStartSwitch('pl')!.getAttribute('aria-checked')).toBe('false');
  });

  // The switch joins the one-action-at-a-time guard: another row's action in flight disables it.
  it('the switch is disabled while another plugin action is in flight, and re-enabled once it lands', async () => {
    const PL2: PluginRow = { ...PL, id: 'pl2', name: 'Pl2', project: 'pl2' };
    rows = [PL, PL2];
    const h = heldJson();
    serve({ 'POST /api/plugins/pl/start': () => h.response });
    wrap();
    await waitFor(() => expect(autoStartSwitch('pl2')).not.toBeNull());
    expect(autoStartSwitch('pl2')!.disabled).toBe(false);

    fireEvent.click(rowBtn('pl', 'Start'));
    await waitFor(() => expect(autoStartSwitch('pl2')!.disabled).toBe(true));
    fireEvent.click(autoStartSwitch('pl2')!);
    expect(posts('/api/plugins/pl2/autostart').length).toBe(0);

    await act(async () => h.release({ ok: true }));
    await waitFor(() => expect(autoStartSwitch('pl2')!.disabled).toBe(false));
  });
});
