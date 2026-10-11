import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { mockFetch, type Call } from './test/fetchMock';
import { ndjsonStream } from './test/ndjson';

vi.mock('@/app/sessionActions', () => ({ resumeSession: vi.fn(async () => {}) }));
vi.mock('@/app/controller', () => ({ refreshProjects: vi.fn(async () => {}), refreshInstances: vi.fn(async () => {}) }));
vi.mock('@/app/models', () => ({ applyModels: vi.fn() }));
vi.mock('@/features/sidebar/restart', () => ({ performRestart: vi.fn(async () => {}) }));
vi.mock('@/lib/core/capabilities.js', () => ({ loadCapabilities: vi.fn(), capabilities: vi.fn(() => null) }));

import { loadCapabilities } from '@/lib/core/capabilities.js';
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
function heldJson(): Held {
  const enc = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let done = false;
  const response = new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }), { headers: { 'content-type': 'application/json' } });
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
/** A rendered Status's tone, read from what it emits: the error tone's colour class plus its alert icon, the muted tone's colour class and no icon. */
const toneOf = (el: HTMLElement | null) => {
  if (!el) return 'absent';
  const icon = el.querySelector('svg.lucide-circle-alert') !== null;
  if (el.classList.contains('text-destructive') && icon) return 'error';
  if (el.classList.contains('text-muted-foreground') && !icon) return 'muted';
  return 'other';
};
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
    await waitFor(() => expect(libLine()).toBe('1 available'));
    fireEvent.click(entryButton('code-share', 'Install'));
    const s = await streamAt(0);
    library = [INSTALLED];
    await finish(s, ok({ id: 'code-share', name: 'code-share', postClone: { ran: true, ok: false, code: 1, tail: 'npm ERR! boom' } }));
    await waitFor(() => {
      expect(entryButtons('code-share')).toEqual(['Update']);
      expect(installedAs('code-share')).toBe('installed as code-share');
      expect(libLine()).toBe('Installed Code Share, but its post-install command failed');
      expect(libTone()).toBe('error');
      expect(tail()).toBe('npm ERR! boom');
    });
  });

  // A failed post-update command with no restart outcome warns about the command alone, with its output, and never claims the backend kept old code.
  it('an update whose post-update command failed still updates, and warns with the command output without claiming the backend kept old code', async () => {
    library = [INSTALLED];
    wrap();
    await waitFor(() => expect(libLine()).toBe('1 available'));
    fireEvent.click(entryButton('code-share', 'Update'));
    const s = await streamAt(0);
    library = [UP_TO_DATE];
    await finish(s, ok({ project: 'code-share', postPull: { ran: true, ok: false, code: 1, tail: 'npm ERR! boom again' }, restarted: null }));
    await waitFor(() => {
      expect(libLine()).toBe('Updated Code Share, but its post-update command failed');
      expect(libTone()).toBe('error');
      expect(tail()).toBe('npm ERR! boom again');
      expect(installedAs('code-share')).toBe('installed as code-share · up to date');
    });
  });

  // A failed backend restart after a passing hook warns with the restart error and shows no command output.
  it('an update whose backend restart failed still updates, and warns with the restart error', async () => {
    library = [INSTALLED];
    wrap();
    await waitFor(() => expect(libLine()).toBe('1 available'));
    fireEvent.click(entryButton('code-share', 'Update'));
    const s = await streamAt(0);
    library = [UP_TO_DATE];
    await finish(s, ok({ project: 'code-share', postPull: { ran: true, ok: true, code: 0, tail: 'fine' }, restarted: { ids: ['code-share'], ok: false, error: 'boom' } }));
    await waitFor(() => {
      expect(libLine()).toBe('Updated Code Share, but restarting its backend failed: boom');
      expect(libTone()).toBe('error');
      expect(installedAs('code-share')).toBe('installed as code-share · up to date');
    });
    expect(tail()).toBe('');
  });

  // When both the post-update command and the restart fail, the warning names the command, with its output, and not the restart.
  it('an update whose post-update command and restart both failed reports the command, not the restart', async () => {
    library = [INSTALLED];
    wrap();
    await waitFor(() => expect(libLine()).toBe('1 available'));
    fireEvent.click(entryButton('code-share', 'Update'));
    const s = await streamAt(0);
    library = [UP_TO_DATE];
    await finish(s, ok({ project: 'code-share', postPull: { ran: true, ok: false, code: 1, tail: 'npm ERR! boom' }, restarted: { ids: [], ok: false, error: 'restart boom' } }));
    await waitFor(() => {
      expect(libLine()).toBe('Updated Code Share, but its post-update command failed');
      expect(tail()).toBe('npm ERR! boom');
    });
    expect(libLine()).not.toContain('restart boom');
  });

  // A restart the server skipped (its wire value a string) says the backend still runs the old code, with the command output.
  it('an update whose restart was skipped after a failed post-update command says the backend still runs the old code, with the command output', async () => {
    library = [INSTALLED];
    wrap();
    await waitFor(() => expect(libLine()).toBe('1 available'));
    fireEvent.click(entryButton('code-share', 'Update'));
    const s = await streamAt(0);
    library = [UP_TO_DATE];
    await finish(s, ok({ project: 'code-share', postPull: { ran: true, ok: false, code: 1, tail: 'npm ERR! boom' }, restarted: { skipped: 'postPull-failed' } }));
    await waitFor(() => {
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
    await waitFor(() => expect(libLine()).toBe('Skipped 3 library drop-in(s): /a/broken.json (unexpected token), /b/broken.json (unexpected token), /mnt/gone (library dir unreadable: ENOENT)'));
    expect(libTone()).toBe('error');
  });

  // While an install streams, its progress shows in the entry and the line and every other plugin control is disabled; after it, the entry relabels installed, the change is announced with no ids, and the guard is free.
  it('Install shows progress and locks every other plugin control, then relabels the entry installed, announces the change and frees the guard', async () => {
    rows = [PL, OFF];
    library = [SHARE, OTHER];
    wrap();
    await waitFor(() => expect(libLine()).toBe('2 available'));
    const v0 = pluginsChangedSignal.version();
    fireEvent.click(entryButton('code-share', 'Install'));
    const s = await streamAt(0);
    await waitFor(() => expect(entryButton('code-share', 'Installing…').disabled).toBe(true));
    expect(libLine()).toBe('Installing Code Share…');
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
    expect(libLine()).toBe('2 available');
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
    await waitFor(() => expect(libLine()).toBe('1 available'));

    fireEvent.click(entryButton('code-share', 'Install'));
    await waitFor(() => expect(libLine()).toBe('Installing Code Share failed: library entry busy'));
    expect(libTone()).toBe('error');
    expect(tail()).toBe('lock held');
    expect(entryButton('code-share', 'Install').disabled).toBe(false);

    fireEvent.click(entryButton('code-share', 'Install'));
    const s = await streamAt(0);
    await feed(s, 'Cloning into code-share...\n');
    await finish(s, failed('clone failed', 'fatal: boom'));
    await waitFor(() => expect(libLine()).toBe('Installing Code Share failed: clone failed'));
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
    expect(libLine()).toBe('1 available');
    expect(posts('/api/plugins/library/code-share/install').length).toBe(3);
  });

  // An entry offers Install until installed, Update while behind its origin, and no button once up to date, with the installed badge and line only once installed.
  it('a library entry offers Install until installed, Update while behind its origin, and no button once up to date', async () => {
    library = [SHARE, BEHIND, CURRENT];
    wrap();
    await waitFor(() => expect(libLine()).toBe('3 available'));
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
    await waitFor(() => expect(libLine()).toBe('2 available'));
    const g = gets('/api/plugins/library');
    fireEvent.click(entryButton('code-share', 'Update'));
    const s = await streamAt(0);
    await waitFor(() => expect(entryButton('code-share', 'Updating…').disabled).toBe(true));
    expect(libLine()).toBe('Updating Code Share…');
    expect(libTone()).toBe('muted');
    expect(entryButton('behind', 'Update').disabled).toBe(true);
    await feed(s, 'Updating code-share...\n');
    await waitFor(() => expect(live('code-share')).toContain('Updating code-share...'));

    library = [UP_TO_DATE, BEHIND];
    await finish(s, ok({ id: 'code-share', name: 'code-share', project: 'code-share', postPull: null, restarted: null }));
    await waitFor(() => expect(installedAs('code-share')).toBe('installed as code-share · up to date'));
    expect(entryButtons('code-share')).toEqual([]);
    expect(libLine()).toBe('2 available');
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
    await waitFor(() => expect(libLine()).toBe('1 available'));
    const v0 = pluginsChangedSignal.version();
    const g = gets('/api/plugins/library');
    fireEvent.click(entryButton('code-share', 'Update'));
    const s = await streamAt(0);
    await feed(s, 'Updating code-share...\n');
    await finish(s, failed('git pull failed', 'fatal: diverged'));
    await waitFor(() => expect(libLine()).toBe('Updating Code Share failed: git pull failed'));
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
    await waitFor(() => expect(libLine()).toBe('Updating Code Share failed: stream ended unexpectedly'));
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
      expect(pluginsLine()).toBe('1 plugin');
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
    await waitFor(() => expect(libLine()).toBe('1 available'));

    fireEvent.click(entryButton('code-share', 'Update'));
    await finish(await streamAt(0), failed('git pull failed'));
    await waitFor(() => expect(libLine()).toBe('Updating Code Share failed: git pull failed'));
    fireEvent.click(button('Rescan'));
    expect(posts('/api/plugins/rescan').length).toBe(1);
    await waitFor(() => expect(pluginsLine()).toBe('1 plugin'));

    fireEvent.click(entryButton('code-share', 'Update'));
    library = [UP_TO_DATE];
    await finish(await streamAt(1), ok({ project: 'code-share', postPull: null, restarted: null }));
    await waitFor(() => expect(entryButtons('code-share')).toEqual([]));
    fireEvent.click(button('Rescan'));
    expect(posts('/api/plugins/rescan').length).toBe(2);
    await waitFor(() => expect(pluginsLine()).toBe('1 plugin'));
  });

  // An empty library says so on a muted line and renders no entry.
  it('an empty library says so and lists nothing', async () => {
    library = [];
    wrap();
    await waitFor(() => expect(libLine()).toBe('No library entries.'));
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
    expect(libLine()).toBe('Installing Code Share…');
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
    expect(libLine()).toBe('Installed Code Share, but its post-install command failed');
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
    await waitFor(() => expect(libLine()).toBe('Installing Code Share failed: clone failed'));

    await switchTo('archived');
    await switchTo('plugins');
    await waitFor(() => expect(gets('/api/plugins/library')).toBe(2));
    await waitFor(() => expect(entryButton('code-share', 'Install').disabled).toBe(false));
    expect(libLine()).toBe('Installing Code Share failed: clone failed');
    expect(libTone()).toBe('error');
    expect(tail()).toBe('fatal: boom');
    expect(live('code-share')).toContain('Cloning');

    await leaveAndReenter('plugins');
    await waitFor(() => expect(gets('/api/plugins/library')).toBe(3));
    await waitFor(() => expect(libLine()).toBe('1 available'));
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
    expect(libLine()).toBe('Installing Code Share…');
    expect(live('code-share')).toContain('Cloning into code-share');
    library = [INSTALLED];
    await finish(s, ok({ id: 'code-share', name: 'code-share', postClone: null }));
    await waitFor(() => expect(entryButtons('code-share')).toEqual(['Update']));
    expect(libLine()).toBe('1 available');
  });

  // A refused plugin action's message survives a section switch over the remount's count; reopening Settings replaces it with the plugin count.
  it("a refused plugin action's message survives a section switch, and reopening Settings replaces it with the plugin count", async () => {
    rows = [OFF];
    serve({ 'POST /api/plugins/off/enable': () => ({ status: 500, json: { error: 'enable boom' } }) });
    openAt('#settings/plugins');
    await waitFor(() => expect(entry('code-share')).not.toBeNull());
    fireEvent.click(button('Enable'));
    await waitFor(() => expect(pluginsLine()).toBe('Enabling off failed: enable boom'));
    expect(pluginsTone()).toBe('error');

    rows = [OFF, PL];
    await switchTo('archived');
    await switchTo('plugins');
    await waitFor(() => expect(gets('/api/plugins')).toBe(2));
    await screen.findByText('Pl');
    expect(pluginsLine()).toBe('Enabling off failed: enable boom');
    expect(pluginsTone()).toBe('error');

    await leaveAndReenter('plugins');
    await waitFor(() => expect(pluginsLine()).toBe('2 plugins'));
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
    await waitFor(() => expect(pluginsLine()).toBe('Rescanning…'));
    await switchTo('archived');
    await switchTo('plugins');
    await waitFor(() => expect(gets('/api/plugins')).toBe(2));
    const start = await screen.findByRole('button', { name: 'Start' });
    fireEvent.click(start);
    expect(posts('/api/plugins/pl/start').length).toBe(0);
    expect(pluginsLine()).toBe('Rescanning…');

    await act(async () => h.release({ ok: true }));
    await waitFor(() => expect(pluginsLine()).toBe('1 plugin'));
    fireEvent.click(button('Start'));
    expect(posts('/api/plugins/pl/start').length).toBe(1);
    await waitFor(() => expect(pluginsLine()).toBe('1 plugin'));
  });
});

describe('Plugins → reloads', () => {
  // Every reload after an action replaces a refusal on either status line and drops the live logs; the library output stays until the next install or update starts.
  it('a reload after any action replaces a refusal on either status line and drops the live logs, but keeps the library output', async () => {
    rows = [OFF];
    library = [SHARE];
    serve({ 'POST /api/plugins/off/enable': () => ({ status: 500, json: { error: 'enable boom' } }), 'POST /api/plugins/rescan': () => ({ ok: true }) });
    wrap();
    await waitFor(() => expect(libLine()).toBe('1 available'));
    const g = gets('/api/plugins/library');

    fireEvent.click(button('Enable'));
    await waitFor(() => expect(pluginsLine()).toBe('Enabling off failed: enable boom'));

    fireEvent.click(entryButton('code-share', 'Install'));
    const s = await streamAt(0);
    await feed(s, 'Cloning into code-share...\n');
    library = [INSTALLED];
    await finish(s, ok({ id: 'code-share', name: 'code-share', postClone: null }));
    await waitFor(() => {
      expect(entryButtons('code-share')).toEqual(['Update']);
      expect(gets('/api/plugins/library')).toBe(g + 1);
    });
    expect(pluginsLine()).toBe('1 plugin');
    expect(pluginsTone()).toBe('muted');
    expect(live('code-share')).toBe('');

    fireEvent.click(entryButton('code-share', 'Update'));
    const s1 = await streamAt(1);
    await feed(s1, 'Updating code-share...\n');
    await finish(s1, failed('git pull failed', 'fatal: diverged'));
    await waitFor(() => expect(libLine()).toBe('Updating Code Share failed: git pull failed'));
    expect(live('code-share')).toContain('Updating code-share');

    fireEvent.click(button('Rescan'));
    await waitFor(() => expect(posts('/api/plugins/rescan').length).toBe(1));
    await waitFor(() => expect(gets('/api/plugins/library')).toBe(g + 2));
    await waitFor(() => expect(libLine()).toBe('1 available'));
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
    await waitFor(() => expect(libLine()).toBe('1 available'));
    const g = gets('/api/plugins/library');

    libraryDown = true;
    fireEvent.click(button('Rescan'));
    await waitFor(() => expect(pluginsLine()).toBe('Failed to load plugins: library unavailable'));
    expect(pluginsTone()).toBe('error');

    fireEvent.click(entryButton('code-share', 'Install'));
    await finish(await streamAt(0), ok({ id: 'code-share', name: 'code-share', postClone: null }));
    await waitFor(() => {
      expect(gets('/api/plugins/library')).toBe(g + 2);
      expect(entryButtons('code-share')).toEqual(['Install']);
    });
    expect(libLine()).toBe('1 available');
    expect(libTone()).toBe('muted');
    expect(pluginsLine()).toBe('Failed to load plugins: library unavailable');
  });
});
