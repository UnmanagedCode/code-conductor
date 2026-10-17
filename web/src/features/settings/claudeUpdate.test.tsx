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
import { claudeUpdateStore } from './ClaudeUpdateCard';

const INITIAL_SELF = selfUpdateStore.get();
const INITIAL_CLAUDE = claudeUpdateStore.get();

const CLAUDE_URL = '/api/settings/claude-update';
// cc itself is up to date, so its Version card offers no button of its own.
const SELF_UP_TO_DATE = { 'GET /api/settings/self-update': () => ({ version: '1.0', canCheck: true }) };
const CLAUDE_FOUND = { [`GET ${CLAUDE_URL}`]: () => ({ found: true, command: 'claude', version: '2.0.0' }) };

const claudeCard = () => screen.getByText('Claude Code', { selector: '[data-slot="card-title"]' }).closest('[data-slot="card"]') as HTMLElement;
const status = () => within(claudeCard()).queryByRole('status');
const line = () => status()?.textContent ?? '';
const log = () => claudeCard().querySelector('pre')?.textContent ?? '';
const buttons = () => (within(claudeCard()).queryAllByRole('button') as HTMLButtonElement[]).map((b) => [b.textContent?.trim(), b.disabled]);

beforeEach(() => {
  selfUpdateStore.set(INITIAL_SELF);
  claudeUpdateStore.set(INITIAL_CLAUDE);
  vi.mocked(performRestart).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('About → Claude Code', () => {
  // Invariant: the card's line is the probed CLI version, and Update is offered enabled.
  it('shows the CLI version and offers Update', async () => {
    mockFetch({ ...SELF_UP_TO_DATE, ...CLAUDE_FOUND });
    render(<AboutSection />);
    await waitFor(() => expect(line()).toContain('v2.0.0'));
    expect(buttons()).toEqual([['Update', false]]);
  });

  // Invariant: a CLI that cannot run is named with the probe's reason as an error, and the remedy stays offered.
  it('a CLI that cannot run says why, and Update is still offered', async () => {
    mockFetch({ ...SELF_UP_TO_DATE, [`GET ${CLAUDE_URL}`]: () => ({ found: false, command: 'claude', error: 'enoent', message: 'spawn claude ENOENT' }) });
    render(<AboutSection />);
    await waitFor(() => expect(line()).toContain('spawn claude ENOENT'));
    expect(status()?.dataset.tone).toBe('error');
    expect(buttons()).toEqual([['Update', false]]);
  });

  // Invariant: one POST, chunks appended in arrival order, the button locked while it runs, and the result's version reported with no cc restart.
  it('Update POSTs, streams the log as it arrives, locks while running, and reports the new version with no restart', async () => {
    const stream = ndjsonStream();
    const calls = mockFetch({ ...SELF_UP_TO_DATE, ...CLAUDE_FOUND, [`POST ${CLAUDE_URL}`]: () => stream.response });
    render(<AboutSection />);
    await waitFor(() => expect(line()).toContain('v2.0.0'));
    fireEvent.click(within(claudeCard()).getByRole('button', { name: 'Update' }));
    act(() => stream.push({ type: 'chunk', phase: 'update', text: 'Current version: 2.0.0\n' }));
    await waitFor(() => expect(log()).toBe('Current version: 2.0.0\n'));
    act(() => stream.push({ type: 'chunk', phase: 'update', text: 'Checking for updates...\n' }));
    await waitFor(() => expect(log()).toBe('Current version: 2.0.0\nChecking for updates...\n'));
    expect(line()).toBe('Updating Claude Code…');
    expect(buttons()).toEqual([['Updating…', true]]);
    act(() => { stream.push({ type: 'result', ok: true, result: { ok: true, version: '2.1.0' } }); stream.end(); });
    await waitFor(() => expect(line()).toContain('v2.1.0'));
    expect(line()).toContain('new sessions');
    expect(status()?.dataset.tone).toBe('ok');
    expect(buttons()).toEqual([['Update', false]]);
    expect(calls.filter((c) => c.method === 'POST' && c.url === CLAUDE_URL)).toHaveLength(1);
    expect(performRestart).not.toHaveBeenCalled();
  });

  // Invariant: a streamed failure result names its error as an error line, replaces the log with its tail, and re-arms Update.
  it('a failed run says why, shows its tail and offers Update again', async () => {
    const stream = ndjsonStream();
    mockFetch({ ...SELF_UP_TO_DATE, ...CLAUDE_FOUND, [`POST ${CLAUDE_URL}`]: () => stream.response });
    render(<AboutSection />);
    fireEvent.click(await within(claudeCard()).findByRole('button', { name: 'Update' }));
    act(() => {
      stream.push({ type: 'chunk', phase: 'update', text: 'Current version: 2.0.0\n' });
      stream.push({ type: 'result', ok: false, error: 'claude update exited with code 1', tail: 'Error: failed to install update' });
      stream.end();
    });
    await waitFor(() => expect(line()).toContain('exited with code 1'));
    expect(status()?.dataset.tone).toBe('error');
    expect(log()).toBe('Error: failed to install update');
    expect(buttons()).toEqual([['Update', false]]);
  });

  // Invariant: a plain-JSON refusal before streaming surfaces its reason and leaves Update enabled.
  it('a refusal before streaming says why and offers Update again', async () => {
    mockFetch({
      ...SELF_UP_TO_DATE, ...CLAUDE_FOUND,
      [`POST ${CLAUDE_URL}`]: () => ({ status: 409, json: { error: 'a restart or update is already in progress (update)', code: 'MAINTENANCE_IN_PROGRESS' } }),
    });
    render(<AboutSection />);
    fireEvent.click(await within(claudeCard()).findByRole('button', { name: 'Update' }));
    await waitFor(() => expect(line()).toContain('already in progress'));
    expect(buttons()).toEqual([['Update', false]]);
  });

  // Invariant: the running update outlives the card — a remount shows it, re-checks nothing, offers no second Update, and still lands the outcome.
  it('leaving About mid-run and coming back shows the running update, no second check or Update, and still the outcome', async () => {
    const stream = ndjsonStream();
    const calls = mockFetch({ ...SELF_UP_TO_DATE, ...CLAUDE_FOUND, [`POST ${CLAUDE_URL}`]: () => stream.response });
    const first = render(<AboutSection />);
    await waitFor(() => expect(line()).toContain('v2.0.0'));
    fireEvent.click(within(claudeCard()).getByRole('button', { name: 'Update' }));
    act(() => stream.push({ type: 'chunk', phase: 'update', text: 'Checking for updates...\n' }));
    await waitFor(() => expect(log()).toContain('Checking for updates'));
    first.unmount();

    render(<AboutSection />);
    await act(async () => {});
    expect(line()).toBe('Updating Claude Code…');
    expect(log()).toContain('Checking for updates');
    expect(buttons()).toEqual([['Updating…', true]]);
    expect(calls.filter((c) => c.method === 'GET' && c.url === CLAUDE_URL)).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'POST' && c.url === CLAUDE_URL)).toHaveLength(1);

    act(() => { stream.push({ type: 'result', ok: true, result: { ok: true, version: '2.1.0' } }); stream.end(); });
    await waitFor(() => expect(line()).toContain('v2.1.0'));
    expect(buttons()).toEqual([['Update', false]]);
  });
});
