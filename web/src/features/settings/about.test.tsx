import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { mockFetch } from './test/fetchMock';
import { ndjsonStream } from './test/ndjson';

vi.mock('@/app/sessionActions', () => ({ resumeSession: vi.fn(async () => {}) }));
vi.mock('@/app/controller', () => ({ refreshProjects: vi.fn(async () => {}), refreshInstances: vi.fn(async () => {}) }));
vi.mock('@/app/models', () => ({ applyModels: vi.fn() }));
vi.mock('@/features/sidebar/restart', () => ({ performRestart: vi.fn(async () => ({ ok: true })) }));

import { performRestart } from '@/features/sidebar/restart';
import { AboutSection, selfUpdateStore } from './AboutSection';
import { PluginsSection, pluginsStore } from './PluginsSection';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { LibraryEntry } from './pluginLogic';

const INITIAL = selfUpdateStore.get();
const PLUGINS0 = pluginsStore.get();

// What About's mount load fetches for its Update plugins button.
let library: LibraryEntry[] = [];
const PLUGIN_ROUTES = {
  'GET /api/plugins': () => ({ rows: [], notices: [] }),
  'GET /api/projects': () => [],
  'GET /api/plugins/library': () => ({ entries: library, skipped: [] }),
};
const entry = (id: string, over: Partial<LibraryEntry> = {}): LibraryEntry => ({ id, name: id, repo: `https://example.test/${id}`, installed: true, updateAvailable: true, ...over });

const available = { version: '1.0', canCheck: true, updateAvailable: true, behind: 3, upstream: 'origin/main' };

const versionCard = () => screen.getByText('Version', { selector: '[data-slot="card-title"]' }).closest('[data-slot="card"]') as HTMLElement;
const line = () => within(versionCard()).queryByRole('status')?.textContent ?? '';
const log = () => versionCard().querySelector('pre')?.textContent ?? '';
const buttons = () => within(versionCard()).queryAllByRole('button') as HTMLButtonElement[];

beforeEach(() => {
  selfUpdateStore.set(INITIAL);
  pluginsStore.set(PLUGINS0);
  library = [];
  vi.mocked(performRestart).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('About', () => {
  // The notice names the copyright holder, links the licence text and the source, and states the network-use obligation.
  it('shows the legal notice: copyright, the AGPL-3.0 link, the source link and the §13 note', () => {
    mockFetch({ ...PLUGIN_ROUTES, 'GET /api/settings/self-update': () => available });
    render(<AboutSection />);
    const notice = within(screen.getByTestId('legal-notice'));
    expect(notice.getByText(/Copyright © 2026 UnmanagedCode/)).toBeTruthy();
    expect(notice.getByRole('link', { name: 'GNU Affero General Public License v3.0 (AGPL-3.0)' }).getAttribute('href')).toBe('https://www.gnu.org/licenses/agpl-3.0.html');
    expect(notice.getByRole('link', { name: 'github.com/UnmanagedCode/code-conductor' }).getAttribute('href')).toBe('https://github.com/UnmanagedCode/code-conductor');
    expect(notice.getByText(/§13/)).toBeTruthy();
  });

  // Each self-update status maps to its own wording, and Update is offered for an available fast-forward alone; a failed check says why.
  it('the version line names each update state, and only an available fast-forward offers Update', async () => {
    const cases: [object, string[], boolean][] = [
      [{ version: '1.0', canCheck: true }, ['v1.0', 'up to date'], false],
      [{ version: '1.0', canCheck: true, diverged: true, ahead: 1, behind: 2, upstream: 'origin/main' }, ["1 ahead", '2 behind', 'origin/main'], false],
      [{ version: '1.0', canCheck: false }, ['v1.0', 'upstream'], false],
      [available, ['v1.0', '3 commits', 'origin/main'], true],
    ];
    // Invariant: each update state's line carries its own facts (version, counts, upstream), and Update is offered only for an available fast-forward.
    for (const [status, facts, offered] of cases) {
      mockFetch({ ...PLUGIN_ROUTES, 'GET /api/settings/self-update': () => status });
      const view = render(<AboutSection />);
      await waitFor(() => expect(line()).toContain(facts[0]));
      for (const fact of facts) expect(line()).toContain(fact);
      expect(buttons().map((b) => b.textContent?.trim())).toEqual(offered ? ['Update'] : []);
      view.unmount();
      selfUpdateStore.set(INITIAL);
    }
    mockFetch({ ...PLUGIN_ROUTES, 'GET /api/settings/self-update': () => ({ status: 500, json: { error: 'down' } }) });
    render(<AboutSection />);
    await waitFor(() => expect(line()).toContain('down'));
    expect(buttons()).toEqual([]);
  });

  // Chunks reach the log before the result lands, the button locks while it runs, and a clean result restarts with resume.
  it('Update streams the log as it arrives, then hands off to restart with resume', async () => {
    const stream = ndjsonStream();
    mockFetch({ ...PLUGIN_ROUTES, 'GET /api/settings/self-update': () => available, 'POST /api/settings/self-update': () => stream.response });
    render(<AboutSection />);
    fireEvent.click(await within(versionCard()).findByRole('button', { name: 'Update' }));
    act(() => stream.push({ type: 'chunk', text: 'Pulling 3 commits\n' }));
    await waitFor(() => expect(log()).toBe('Pulling 3 commits\n'));
    act(() => stream.push({ type: 'chunk', text: 'and one more\n' }));
    // Each chunk is appended to the log, never replacing it.
    await waitFor(() => expect(log()).toBe('Pulling 3 commits\nand one more\n'));
    expect(line()).toBe('Updating conductor…');
    expect(buttons().map((b) => [b.textContent?.trim(), b.disabled])).toEqual([['Updating…', true]]);
    expect(performRestart).not.toHaveBeenCalled();
    act(() => { stream.push({ type: 'result', ok: true, result: {} }); stream.end(); });
    await waitFor(() => expect(line()).toMatch(/Restarting/));
    expect(performRestart).toHaveBeenCalledTimes(1);
    expect(performRestart).toHaveBeenCalledWith({ resume: true });
    // After a successful update nothing re-arms Update while the restart is in flight.
    expect(buttons().map((b) => [b.textContent?.trim(), b.disabled])).toEqual([['Updating…', true]]);
  });

  // A pulled update whose restart is refused leaves the old version running: the line says so and to fix it, the refusal's tail lands in the log, and no Update is offered again.
  it('a restart refused after the pull says cc still runs the previous version, with the tail in the log', async () => {
    vi.mocked(performRestart).mockResolvedValueOnce({ ok: false, error: 'vite build failed (exit 1)', tail: 'error: Unexpected token' });
    const stream = ndjsonStream();
    mockFetch({ ...PLUGIN_ROUTES, 'GET /api/settings/self-update': () => available, 'POST /api/settings/self-update': () => stream.response });
    render(<AboutSection />);
    fireEvent.click(await within(versionCard()).findByRole('button', { name: 'Update' }));
    act(() => { stream.push({ type: 'chunk', text: 'pulled\n' }); stream.push({ type: 'result', ok: true, result: {} }); stream.end(); });
    await waitFor(() => expect(line()).toBe('Updated, but the restart was refused: vite build failed (exit 1). cc is still running the previous version; fix it and restart.'));
    expect(within(versionCard()).getByRole('status').dataset.tone).toBe('error');
    expect(log()).toBe('error: Unexpected token');
    expect(performRestart).toHaveBeenCalledWith({ resume: true });
    expect(buttons()).toEqual([]);
  });

  // A pulled tree whose npm install failed is never booted: no restart, the npm tail replaces the log, and the button re-arms as Retry.
  it('an npm failure after the pull stops before the restart, shows its tail and offers Retry', async () => {
    const stream = ndjsonStream();
    let posts = 0;
    const calls = mockFetch({
      ...PLUGIN_ROUTES,
      'GET /api/settings/self-update': () => available,
      'POST /api/settings/self-update': () => (++posts === 1 ? stream.response : ndjsonStream().response),
    });
    render(<AboutSection />);
    fireEvent.click(await within(versionCard()).findByRole('button', { name: 'Update' }));
    act(() => { stream.push({ type: 'chunk', text: 'pulled\n' }); stream.push({ type: 'result', ok: true, result: { npm: { ok: false, tail: 'npm ERR! x' } } }); stream.end(); });
    await waitFor(() => expect(line()).toMatch('npm install failed'));
    expect(log()).toBe('npm ERR! x');
    expect(buttons().map((b) => [b.textContent?.trim(), b.disabled])).toEqual([['Retry', false]]);
    expect(performRestart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
  });

  // A refusal that never ran npm (a linked node_modules) names its own reason, not an npm failure; its tail stays in the log and Retry is offered.
  it('a DEPS_LINKED refusal after the pull shows its own message, never "npm install failed"', async () => {
    // Invariant: when npm.ran is false the line carries the refusal's message (npm.error) and the log its tail, and nothing restarts.
    const refusal = 'node_modules does not satisfy package.json (node_modules/vite missing) and is a link to /shared/node_modules, which cc does not install into — run npm install there.';
    const stream = ndjsonStream();
    mockFetch({ ...PLUGIN_ROUTES, 'GET /api/settings/self-update': () => available, 'POST /api/settings/self-update': () => stream.response });
    render(<AboutSection />);
    fireEvent.click(await within(versionCard()).findByRole('button', { name: 'Update' }));
    act(() => { stream.push({ type: 'result', ok: true, result: { npm: { ran: false, ok: false, code: 1, error: refusal, tail: refusal } } }); stream.end(); });
    await waitFor(() => expect(line()).toBe(`The update was pulled but its dependencies were not installed: ${refusal}`));
    expect(line()).not.toContain('npm install failed');
    expect(log()).toBe(refusal);
    expect(buttons().map((b) => [b.textContent?.trim(), b.disabled])).toEqual([['Retry', false]]);
    expect(performRestart).not.toHaveBeenCalled();
  });

  // Reopening About after a finished or failed update starts a fresh check with clean state: no stale Retry, no stale log.
  it('reopening About after an npm failure checks again and offers Update with an empty log', async () => {
    const stream = ndjsonStream();
    const calls = mockFetch({ ...PLUGIN_ROUTES, 'GET /api/settings/self-update': () => available, 'POST /api/settings/self-update': () => stream.response });
    const first = render(<AboutSection />);
    fireEvent.click(await within(versionCard()).findByRole('button', { name: 'Update' }));
    act(() => { stream.push({ type: 'result', ok: true, result: { npm: { ok: false, tail: 'npm ERR! x' } } }); stream.end(); });
    await waitFor(() => expect(buttons().map((b) => b.textContent?.trim())).toEqual(['Retry']));
    expect(log()).toBe('npm ERR! x');
    first.unmount();

    render(<AboutSection />);
    await waitFor(() => expect(line()).toMatch(/v1\.0.*3 commits/));
    expect(calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/settings/self-update'))).toHaveLength(2);
    expect(buttons().map((b) => [b.textContent?.trim(), b.disabled])).toEqual([['Update', false]]);
    expect(log()).toBe('');
  });

  // An early (plain JSON) refusal surfaces its reason and tail, and Update is offered again rather than left locked.
  it('a refused or failed update says why, shows its tail and offers Update again', async () => {
    mockFetch({
      ...PLUGIN_ROUTES,
      'GET /api/settings/self-update': () => available,
      'POST /api/settings/self-update': () => ({ status: 409, json: { error: 'dirty tree', tail: 'M file' } }),
    });
    render(<AboutSection />);
    fireEvent.click(await within(versionCard()).findByRole('button', { name: 'Update' }));
    await waitFor(() => expect(line()).toContain('dirty tree'));
    expect(log()).toBe('M file');
    expect(buttons().map((b) => [b.textContent?.trim(), b.disabled])).toEqual([['Update', false]]);
    expect(performRestart).not.toHaveBeenCalled();
  });

  // The running update outlives the section: a remount shows it, issues no second check, offers no second Update, and still receives the outcome.
  it('leaving About during an update and coming back shows the running update, offers no second Update, and still shows its outcome', async () => {
    const stream = ndjsonStream();
    const calls = mockFetch({ ...PLUGIN_ROUTES, 'GET /api/settings/self-update': () => available, 'POST /api/settings/self-update': () => stream.response });
    const first = render(<AboutSection />);
    await waitFor(() => expect(line()).toMatch(/v1\.0.*3 commits/));
    fireEvent.click(within(versionCard()).getByRole('button', { name: 'Update' }));
    act(() => stream.push({ type: 'chunk', text: 'Pulling…' }));
    await waitFor(() => expect(log()).toContain('Pulling…'));
    first.unmount();

    render(<AboutSection />);
    await act(async () => {});
    expect(line()).toBe('Updating conductor…');
    expect(log()).toContain('Pulling…');
    expect(buttons().map((b) => [b.textContent?.trim(), b.disabled])).toEqual([['Updating…', true]]);
    expect(calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/settings/self-update'))).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);

    act(() => { stream.push({ type: 'result', ok: true, result: {} }); stream.end(); });
    await waitFor(() => expect(line()).toMatch(/Restarting/));
    expect(performRestart).toHaveBeenCalledTimes(1);
    expect(buttons().map((b) => [b.textContent?.trim(), b.disabled])).toEqual([['Updating…', true]]);
  });
});

describe('About: Update plugins', () => {
  const UPDATE = (id: string) => `POST /api/plugins/library/${id}/update`;
  const pluginButtons = () => buttons().map((b) => [b.textContent?.trim(), b.disabled]);
  const behind = () => [entry('a'), entry('b')];
  const upToDate = () => library.map((e) => ({ ...e, updateAvailable: false }));
  const OK = { type: 'result', ok: true, result: { project: 'x' } };
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const startRun = async (streams: Record<string, ReturnType<typeof ndjsonStream>>) => {
    const calls = mockFetch({
      ...PLUGIN_ROUTES,
      'GET /api/settings/self-update': () => ({ version: '1.0', canCheck: true }),
      ...Object.fromEntries(Object.entries(streams).map(([id, st]) => [UPDATE(id), () => st.response])),
    });
    library = behind();
    const view = render(<AboutSection />);
    fireEvent.click(await within(versionCard()).findByRole('button', { name: 'Update plugins (2)' }));
    return { calls, view };
  };
  const posts = (calls: { method: string; url: string }[]) => calls.filter((c) => c.method === 'POST').map((c) => c.url);

  // Invariant: the button counts only installed entries that are behind, and sits in the Version card alone.
  it('shows Update plugins (N) for installed+behind entries only, in the Version card', async () => {
    library = [entry('a'), entry('b'), entry('c', { updateAvailable: false }), entry('d', { installed: false })];
    mockFetch({ ...PLUGIN_ROUTES, 'GET /api/settings/self-update': () => ({ version: '1.0', canCheck: true }), 'GET /api/settings/claude-update': () => ({ found: true, command: 'claude', version: '2.0.0' }) });
    render(<AboutSection />);
    await waitFor(() => expect(pluginButtons()).toEqual([['Update plugins (2)', false]]));
    expect(screen.getAllByRole('button', { name: /Update plugins/ })).toHaveLength(1);
  });

  // Invariant: with nothing behind there is no button, and the plugin button appears independently of cc's own Update.
  it('is absent when nothing is behind and independent of cc\'s Update', async () => {
    library = [entry('c', { updateAvailable: false }), entry('d', { installed: false })];
    mockFetch({ ...PLUGIN_ROUTES, 'GET /api/settings/self-update': () => available });
    const first = render(<AboutSection />);
    await waitFor(() => expect(pluginButtons()).toEqual([['Update', false]]));
    await settle();
    expect(pluginButtons()).toEqual([['Update', false]]);
    first.unmount();
    selfUpdateStore.set(INITIAL);
    pluginsStore.set(PLUGINS0);
    library = [entry('a')];
    render(<AboutSection />);
    await waitFor(() => expect(pluginButtons()).toEqual([['Update', false], ['Update plugins (1)', false]]));
  });

  // Invariant: a click updates each behind entry in order with the Plugins page's request, shows i/n progress while locked, and the button leaves once the closing reload finds nothing behind.
  it('runs the updates in order, shows Updating i/n…, then disappears after the reload', async () => {
    const s1 = ndjsonStream(); const s2 = ndjsonStream();
    const { calls } = await startRun({ a: s1, b: s2 });
    await waitFor(() => expect(pluginButtons()).toEqual([['Updating 1/2…', true]]));
    expect(posts(calls)).toEqual(['/api/plugins/library/a/update']);
    act(() => { s1.push(OK); s1.end(); });
    await waitFor(() => expect(pluginButtons()).toEqual([['Updating 2/2…', true]]));
    expect(posts(calls)).toEqual(['/api/plugins/library/a/update', '/api/plugins/library/b/update']);
    library = upToDate();
    act(() => { s2.push(OK); s2.end(); });
    await waitFor(() => expect(pluginButtons()).toEqual([]));
  });

  // Invariant: a failed update leaves the button armed with the remaining count.
  it('a failed update re-arms the button with the entries still behind', async () => {
    const s1 = ndjsonStream(); const s2 = ndjsonStream();
    await startRun({ a: s1, b: s2 });
    act(() => { s1.push(OK); s1.end(); });
    await waitFor(() => expect(pluginButtons()).toEqual([['Updating 2/2…', true]]));
    library = [entry('b')];
    act(() => { s2.push({ type: 'result', ok: false, error: 'boom' }); s2.end(); });
    await waitFor(() => expect(pluginButtons()).toEqual([['Update plugins (1)', false]]));
  });

  // Invariant: a remount mid-run shows the running progress, locked, and starts no second run.
  it('a remount mid-run shows the progress, disabled, with no extra request', async () => {
    const s1 = ndjsonStream(); const s2 = ndjsonStream();
    const { calls, view } = await startRun({ a: s1, b: s2 });
    await waitFor(() => expect(pluginButtons()).toEqual([['Updating 1/2…', true]]));
    view.unmount();
    render(<AboutSection />);
    await settle();
    expect(pluginButtons()).toEqual([['Updating 1/2…', true]]);
    expect(posts(calls)).toEqual(['/api/plugins/library/a/update']);
    library = upToDate();
    act(() => { s1.push(OK); s1.end(); });
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    act(() => { s2.push(OK); s2.end(); });
    await waitFor(() => expect(pluginButtons()).toEqual([]));
  });

  // Invariant: while another plugin action (a row's Update) holds the guard, the button shows the count but is disabled.
  it('is disabled while another plugin action holds the guard', async () => {
    const held = ndjsonStream();
    library = [entry('a')];
    mockFetch({
      ...PLUGIN_ROUTES,
      'GET /api/settings/self-update': () => ({ version: '1.0', canCheck: true }),
      [UPDATE('a')]: () => held.response,
    });
    const plugins = render(<TooltipProvider><PluginsSection /></TooltipProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    plugins.unmount();
    render(<AboutSection />);
    await waitFor(() => expect(pluginButtons()).toEqual([['Update plugins (1)', true]]));
    act(() => { held.push(OK); held.end(); });
    library = upToDate();
    await waitFor(() => expect(pluginsStore.get().busy).toBe(false));
  });

  // Invariant: a run started from About is the Plugins page's run, so its Library button shows the same progress.
  it('shares the run state with the Plugins page', async () => {
    const s1 = ndjsonStream(); const s2 = ndjsonStream();
    const { view } = await startRun({ a: s1, b: s2 });
    await waitFor(() => expect(pluginButtons()).toEqual([['Updating 1/2…', true]]));
    view.unmount();
    render(<TooltipProvider><PluginsSection /></TooltipProvider>);
    const libraryButton = await screen.findByTitle(/Update every installed library plugin/);
    expect(libraryButton.textContent).toBe('Updating 1/2…');
    expect((libraryButton as HTMLButtonElement).disabled).toBe(true);
    library = upToDate();
    act(() => { s1.push(OK); s1.end(); });
    act(() => { s2.push(OK); s2.end(); });
    await waitFor(() => expect(pluginsStore.get().busy).toBe(false));
  });

  // Invariant: a run in progress keeps its button and Updating i/n… label even when the list shows nothing behind any more.
  it('shows the running progress, disabled, when a reload already finds nothing behind', async () => {
    const s1 = ndjsonStream(); const s2 = ndjsonStream();
    const { view } = await startRun({ a: s1, b: s2 });
    await waitFor(() => expect(pluginButtons()).toEqual([['Updating 1/2…', true]]));
    library = upToDate();
    view.unmount();
    render(<AboutSection />);
    await waitFor(() => expect(pluginsStore.get().library?.some((e) => e.updateAvailable)).toBe(false));
    expect(pluginButtons()).toEqual([['Updating 1/2…', true]]);
    act(() => { s1.push(OK); s1.end(); });
    await waitFor(() => expect(pluginButtons()).toEqual([['Updating 2/2…', true]]));
    act(() => { s2.push(OK); s2.end(); });
    await waitFor(() => expect(pluginButtons()).toEqual([]));
  });

  // Invariant: opening About leaves a running plugin action's status line and live output on the Plugins page.
  it('opening About keeps a running row Update\'s status line and live output', async () => {
    const held = ndjsonStream();
    library = [entry('a')];
    mockFetch({
      ...PLUGIN_ROUTES,
      'GET /api/settings/self-update': () => ({ version: '1.0', canCheck: true }),
      [UPDATE('a')]: () => held.response,
    });
    render(<TooltipProvider><PluginsSection /></TooltipProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    act(() => held.push({ type: 'chunk', text: 'pulling a\n' }));
    await screen.findByText(/pulling a/);
    expect(screen.getByText('Updating a…')).toBeTruthy();
    render(<AboutSection />);
    await waitFor(() => expect(pluginButtons()).toEqual([['Update plugins (1)', true]]));
    await settle();
    expect(screen.getByText('Updating a…')).toBeTruthy();
    expect(screen.getByText(/pulling a/)).toBeTruthy();
    act(() => { held.push(OK); held.end(); });
    library = upToDate();
    await waitFor(() => expect(pluginsStore.get().busy).toBe(false));
  });
});
