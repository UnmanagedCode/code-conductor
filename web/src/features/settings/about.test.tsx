import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { mockFetch } from './test/fetchMock';
import { ndjsonStream } from './test/ndjson';

vi.mock('@/app/sessionActions', () => ({ resumeSession: vi.fn(async () => {}) }));
vi.mock('@/app/controller', () => ({ refreshProjects: vi.fn(async () => {}), refreshInstances: vi.fn(async () => {}) }));
vi.mock('@/app/models', () => ({ applyModels: vi.fn() }));
vi.mock('@/features/sidebar/restart', () => ({ performRestart: vi.fn(async () => {}) }));

import { performRestart } from '@/features/sidebar/restart';
import { AboutSection, selfUpdateStore } from './AboutSection';

const INITIAL = selfUpdateStore.get();

const available = { version: '1.0', canCheck: true, updateAvailable: true, behind: 3, upstream: 'origin/main' };

const versionCard = () => screen.getByText('Version', { selector: '[data-slot="card-title"]' }).closest('[data-slot="card"]') as HTMLElement;
const line = () => within(versionCard()).queryByRole('status')?.textContent ?? '';
const log = () => versionCard().querySelector('pre')?.textContent ?? '';
const buttons = () => within(versionCard()).queryAllByRole('button') as HTMLButtonElement[];

beforeEach(() => {
  selfUpdateStore.set(INITIAL);
  vi.mocked(performRestart).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('About', () => {
  // The notice names the copyright holder, links the licence text and the source, and states the network-use obligation.
  it('shows the legal notice: copyright, the AGPL-3.0 link, the source link and the §13 note', () => {
    mockFetch({ 'GET /api/settings/self-update': () => available });
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
      mockFetch({ 'GET /api/settings/self-update': () => status });
      const view = render(<AboutSection />);
      await waitFor(() => expect(line()).toContain(facts[0]));
      for (const fact of facts) expect(line()).toContain(fact);
      expect(buttons().map((b) => b.textContent?.trim())).toEqual(offered ? ['Update'] : []);
      view.unmount();
      selfUpdateStore.set(INITIAL);
    }
    mockFetch({ 'GET /api/settings/self-update': () => ({ status: 500, json: { error: 'down' } }) });
    render(<AboutSection />);
    await waitFor(() => expect(line()).toContain('down'));
    expect(buttons()).toEqual([]);
  });

  // Chunks reach the log before the result lands, the button locks while it runs, and a clean result restarts with resume.
  it('Update streams the log as it arrives, then hands off to restart with resume', async () => {
    const stream = ndjsonStream();
    mockFetch({ 'GET /api/settings/self-update': () => available, 'POST /api/settings/self-update': () => stream.response });
    render(<AboutSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
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

  // A pulled tree whose npm install failed is never booted: no restart, the npm tail replaces the log, and the button re-arms as Retry.
  it('an npm failure after the pull stops before the restart, shows its tail and offers Retry', async () => {
    const stream = ndjsonStream();
    let posts = 0;
    const calls = mockFetch({
      'GET /api/settings/self-update': () => available,
      'POST /api/settings/self-update': () => (++posts === 1 ? stream.response : ndjsonStream().response),
    });
    render(<AboutSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    act(() => { stream.push({ type: 'chunk', text: 'pulled\n' }); stream.push({ type: 'result', ok: true, result: { npm: { ok: false, tail: 'npm ERR! x' } } }); stream.end(); });
    await waitFor(() => expect(line()).toMatch('npm install failed'));
    expect(log()).toBe('npm ERR! x');
    expect(buttons().map((b) => [b.textContent?.trim(), b.disabled])).toEqual([['Retry', false]]);
    expect(performRestart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
  });

  // Reopening About after a finished or failed update starts a fresh check with clean state: no stale Retry, no stale log.
  it('reopening About after an npm failure checks again and offers Update with an empty log', async () => {
    const stream = ndjsonStream();
    const calls = mockFetch({ 'GET /api/settings/self-update': () => available, 'POST /api/settings/self-update': () => stream.response });
    const first = render(<AboutSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
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
      'GET /api/settings/self-update': () => available,
      'POST /api/settings/self-update': () => ({ status: 409, json: { error: 'dirty tree', tail: 'M file' } }),
    });
    render(<AboutSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    await waitFor(() => expect(line()).toContain('dirty tree'));
    expect(log()).toBe('M file');
    expect(buttons().map((b) => [b.textContent?.trim(), b.disabled])).toEqual([['Update', false]]);
    expect(performRestart).not.toHaveBeenCalled();
  });

  // The running update outlives the section: a remount shows it, issues no second check, offers no second Update, and still receives the outcome.
  it('leaving About during an update and coming back shows the running update, offers no second Update, and still shows its outcome', async () => {
    const stream = ndjsonStream();
    const calls = mockFetch({ 'GET /api/settings/self-update': () => available, 'POST /api/settings/self-update': () => stream.response });
    const first = render(<AboutSection />);
    await waitFor(() => expect(line()).toMatch(/v1\.0.*3 commits/));
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
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
