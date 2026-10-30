import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { mockFetch } from './test/fetchMock';
import { routeFetch, held, type RouteAnswer } from '@/test/routeFetch';

vi.mock('@/app/sessionActions', () => ({ resumeSession: vi.fn(async () => {}) }));
vi.mock('@/app/controller', () => ({ refreshProjects: vi.fn(async () => {}), refreshInstances: vi.fn(async () => {}) }));
vi.mock('@/app/models', () => ({ applyModels: vi.fn() }));
vi.mock('@/features/sidebar/restart', () => ({ performRestart: vi.fn(async () => {}) }));

import { resumeSession } from '@/app/sessionActions';
import { refreshInstances, refreshProjects } from '@/app/controller';
import { applyModels } from '@/app/models';
import { modelsSettingsStore, loadModelsSettings } from './models/store';
import type { ModelsPayload } from './models/logic';
import { OverageCard, discardOverageDraft } from './AccountSection';
import { ClaudeLogin } from './ClaudeLogin';
import { BackendsSection, backendsDraftStore } from './BackendsSection';
import { SystemsSection, systemsDraftStore } from './SystemsSection';
import { ModelsSection, EffortPicker, modelsDraftStore } from './models/ModelsSection';
import { ArchivedSection } from './ArchivedSection';
import { PluginsSection } from './PluginsSection';
import { pluginsChangeStore, pluginsChangedSignal } from './pluginsSignal';
import { on } from '@/app/events';
import { ConfirmHost, toast } from '@/ui/feedback';
import { buildWakeStub } from '@shared/wakeCallback';
import { readJsonl } from '@/conversation/testkit';
import { SERVER_UNREACHABLE_MESSAGE } from '@shared/http';

const DRAFTS = [modelsDraftStore.get(), backendsDraftStore.get(), systemsDraftStore.get()] as const;

const wrap = (ui: React.ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>);

const models = (over: object = {}) => ({
  backends: [
    { id: 'claude', label: 'Claude', template: '', env: [], managed: true },
    { id: 'ollama', label: 'Ollama', template: 'ollama launch claude --model {model} --yes --', env: [], managed: true },
    { id: 'mine', label: 'Mine', template: 'mine run {model}', env: [{ key: 'A', value: '1' }] },
  ],
  claudeFamilies: [{ family: 'sonnet', label: 'Sonnet', default: 'claude-sonnet-5-5', versions: [{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }] }],
  tiers: [{ tier: 'fast', label: 'Fast' }, { tier: 'powerful', label: 'Powerful' }],
  tierBackend: { fast: { backend: 'claude', model: 'claude-sonnet-5-5' }, powerful: { backend: 'claude', model: 'claude-sonnet-5-5' } },
  tierEffort: { fast: 'low' },
  efforts: ['low', 'medium', 'high', 'max'],
  defaultEffort: 'medium',
  enabledTiers: { fast: true, powerful: true },
  defaultSpawnTier: 'powerful',
  roles: [{ role: 'conductor', label: 'Conductor', builtin: true }],
  roleBackend: { conductor: { kind: 'tier', tier: 'powerful' } },
  roleEffort: { conductor: { effort: 'inherit', inheritsTo: 'high' } },
  customModels: [{ label: 'Mine 1', model: 'm1', backend: 'mine', contextWindow: 200000 }],
  ollamaCloudModels: [],
  onOverage: 'stop',
  overageThreshold: { enabled: true, value: 70 },
  conductorCompactWindow: { enabled: false, value: 200 },
  ...over,
});

beforeEach(() => {
  modelsSettingsStore.set({ data: null, error: null, status: null });
  modelsDraftStore.set(DRAFTS[0]);
  backendsDraftStore.set(DRAFTS[1]);
  systemsDraftStore.set(DRAFTS[2]);
  discardOverageDraft();
  vi.mocked(applyModels).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('Account → overage protection', () => {
  it('populates from the models payload, stages edits until Apply, then commits both fields', async () => {
    const calls = mockFetch({ 'POST /api/settings/models/prefs': (c) => models({ onOverage: c.body.onOverage, overageThreshold: c.body.overageThreshold }) });
    modelsSettingsStore.set({ data: models() as any });
    wrap(<OverageCard />);
    expect(screen.getByRole('button', { name: 'Stop', pressed: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Stop & resume' }));
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByText('Overage settings applied');
    expect(calls[0].body).toEqual({ onOverage: 'stop-resume', overageThreshold: { enabled: true, value: 70 } });
  });

  it('a failed Apply keeps the edit staged and shows the error', async () => {
    mockFetch({ 'POST /api/settings/models/prefs': () => ({ status: 400, json: { error: 'bad threshold' } }) });
    modelsSettingsStore.set({ data: models() as any });
    wrap(<OverageCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByText('Update failed: bad threshold');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Off', pressed: true })).toBeTruthy();
  });

  it('a prefs save elsewhere does not clobber a staged, unapplied edit', () => {
    modelsSettingsStore.set({ data: models() as any });
    wrap(<OverageCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    act(() => modelsSettingsStore.set({ data: models({ onOverage: 'stop-resume' }) as any }));
    expect(screen.getByRole('button', { name: 'Off', pressed: true })).toBeTruthy();
  });

  // Apply commits the staged values, then the controls show what the server answered (not what was typed) and nothing stays staged.
  it('Apply re-syncs the controls to the values the server returns and clears the staged state', async () => {
    const calls = mockFetch({ 'POST /api/settings/models/prefs': (c) => models({ onOverage: c.body.onOverage, overageThreshold: { enabled: true, value: 99 } }) });
    modelsSettingsStore.set({ data: models({ onOverage: 'none', overageThreshold: { enabled: false, value: 85 } }) as any });
    wrap(<OverageCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop & resume' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Also stop at a usage threshold' }));
    fireEvent.change(screen.getByLabelText('Stop at'), { target: { value: '95' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByText('Overage settings applied');
    expect(calls[0].body).toEqual({ onOverage: 'stop-resume', overageThreshold: { enabled: true, value: 95 } });
    expect((screen.getByLabelText('Stop at') as HTMLInputElement).value).toBe('99');
    expect(screen.getByText('99%')).toBeTruthy();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true);
  });
});

describe('Account → Claude login', () => {
  const signedIn = { loggedIn: true, authMethod: 'claude.ai', email: 'me@example.com', orgName: null, subscriptionType: 'pro', configDirectory: '/home/x/.claude' };

  it('signed in: identity and plan, a Re-log in button, and no flow panel for an idle flow', async () => {
    mockFetch({ 'GET /api/claude-auth/status': () => signedIn, 'GET /api/claude-auth/login': () => ({ state: 'idle' }) });
    wrap(<ClaudeLogin />);
    await screen.findByText('Signed in');
    expect(screen.getByText(/me@example.com · Pro plan · Claude subscription/)).toBeTruthy();
    expect(screen.queryByText(/null/)).toBeNull();
    expect(screen.getByTestId('ca-login').textContent).toMatch('Re-log in');
    expect(screen.queryByTestId('ca-flow')).toBeNull();
  });

  it('a status failure shows the error, never "Not signed in"', async () => {
    mockFetch({ 'GET /api/claude-auth/status': () => ({ status: 502, json: { error: 'cli broke' } }), 'GET /api/claude-auth/login': () => ({ state: 'idle' }) });
    wrap(<ClaudeLogin />);
    await screen.findByText('Could not read the Claude login state: cli broke');
    expect(screen.queryByText('Not signed in')).toBeNull();
  });

  it('Log in shows the URL and code field; Submit posts the trimmed code; success fires onLoginSuccess once', async () => {
    let state: any = { state: 'idle' };
    const calls = mockFetch({
      'GET /api/claude-auth/status': () => ({ loggedIn: false }),
      'GET /api/claude-auth/login': () => state,
      'POST /api/claude-auth/login': () => (state = { state: 'awaiting_code', url: 'https://claude.ai/oauth?x' }),
      'POST /api/claude-auth/login/code': () => (state = { state: 'verifying', url: 'https://claude.ai/oauth?x' }),
    });
    const onLoginSuccess = vi.fn();
    wrap(<ClaudeLogin onLoginSuccess={onLoginSuccess} pollMs={10} />);
    await screen.findByText('Not signed in');
    fireEvent.click(screen.getByTestId('ca-login'));
    const link = await screen.findByTestId('ca-url');
    expect(link.getAttribute('href')).toBe('https://claude.ai/oauth?x');
    expect(link.getAttribute('target')).toBe('_blank');
    fireEvent.change(screen.getByLabelText('Sign-in code'), { target: { value: '  abc123 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/login/code'))?.body).toEqual({ code: 'abc123' }));
    await waitFor(() => expect((screen.getByLabelText('Sign-in code') as HTMLInputElement).disabled).toBe(true));
    state = { state: 'succeeded' };
    await screen.findByText('Signed in.');
    await new Promise((r) => setTimeout(r, 50));
    expect(onLoginSuccess).toHaveBeenCalledTimes(1);
  });

  it('a flow already ended before the panel opened stays hidden and does not fire onLoginSuccess', async () => {
    mockFetch({ 'GET /api/claude-auth/status': () => signedIn, 'GET /api/claude-auth/login': () => ({ state: 'succeeded' }) });
    const onLoginSuccess = vi.fn();
    wrap(<ClaudeLogin onLoginSuccess={onLoginSuccess} />);
    await screen.findByText('Signed in');
    expect(screen.queryByTestId('ca-flow')).toBeNull();
    expect(onLoginSuccess).not.toHaveBeenCalled();
  });

  const URL_ = 'https://claude.com/cai/oauth/authorize?code=true&state=S';
  const signedOut = { loggedIn: false, authMethod: 'none' };
  const awaitingCode = { state: 'awaiting_code', url: URL_ };
  const verifying = { state: 'verifying', url: URL_ };
  afterEach(() => vi.useRealTimers());
  const fakeTimers = () => vi.useFakeTimers({ shouldAdvanceTime: true });
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  /** A login server: GET answers `server.snap` (or a route's override); each action sets the next snapshot. */
  function loginServer(start: object, routes: Record<string, (body: any) => RouteAnswer | Promise<RouteAnswer>> = {}) {
    const server = { snap: start as any };
    const calls = routeFetch({
      'GET /api/claude-auth/status': () => ({ json: signedOut }),
      'POST /api/claude-auth/login/code': () => ({ json: (server.snap = verifying) }),
      'POST /api/claude-auth/login/cancel': () => ({ json: (server.snap = { state: 'cancelled' }) }),
      'GET /api/claude-auth/login': () => ({ json: server.snap }),
      ...routes,
    });
    const polls = () => calls.filter((c) => c.method === 'GET' && c.url === '/api/claude-auth/login').length;
    const statusReads = () => calls.filter((c) => c.url === '/api/claude-auth/status').length;
    const codeBodies = () => calls.filter((c) => c.url === '/api/claude-auth/login/code').map((c) => c.body);
    return { server, calls, polls, statusReads, codeBodies };
  }
  const flowMsg = () => within(screen.getByTestId('ca-flow')).queryByRole('status')?.textContent ?? '';
  const codeField = () => screen.getByLabelText('Sign-in code') as HTMLInputElement;
  const loginBtn = () => screen.getByTestId('ca-login') as HTMLButtonElement;

  // A signed-out CLI reads "Not signed in" and offers a first login, not a re-login.
  it('signed out: "Not signed in" and a Log in button', async () => {
    loginServer({ state: 'idle' });
    wrap(<ClaudeLogin pollMs={10} />);
    await screen.findByText('Not signed in');
    expect(loginBtn().textContent?.trim()).toBe('Log in');
  });

  // Starting the flow and reaching awaiting_code exposes the sign-in link (new tab, no opener), a copyable URL and the code field, and locks Log in while it runs.
  it('Log in posts the start; the polled awaiting_code shows a new-tab link, a copyable URL field and an enabled code field, with Log in disabled and Cancel offered', async () => {
    fakeTimers();
    const { server, calls } = loginServer({ state: 'idle' }, {
      'POST /api/claude-auth/login': () => { server.snap = awaitingCode; return { json: { state: 'starting' } }; },
    });
    wrap(<ClaudeLogin pollMs={10} />);
    await screen.findByText('Not signed in');
    fireEvent.click(loginBtn());
    await advance(10);
    const link = await screen.findByTestId('ca-url');
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/claude-auth/login')).toHaveLength(1);
    expect(link.getAttribute('href')).toBe(URL_);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toMatch('noopener');
    expect((screen.getByLabelText('Sign-in URL') as HTMLInputElement).value).toBe(URL_);
    expect(screen.getByRole('button', { name: 'Copy sign-in URL' })).toBeTruthy();
    expect(codeField().disabled).toBe(false);
    expect(loginBtn().disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  // The code is sent trimmed; a rejected code comes back as awaiting_code with an error, which is shown while the field re-enables with the typed text intact.
  it('Submit posts the trimmed code; an awaiting_code answer carrying an error shows it and keeps the typed code', async () => {
    fakeTimers();
    const { server, codeBodies } = loginServer(awaitingCode);
    wrap(<ClaudeLogin pollMs={10} />);
    await screen.findByLabelText('Sign-in code');
    fireEvent.change(codeField(), { target: { value: '  abc#S  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(codeBodies()).toEqual([{ code: 'abc#S' }]));
    server.snap = { ...awaitingCode, error: 'Invalid code, try again' };
    await advance(10);
    await waitFor(() => expect(flowMsg()).toBe('Invalid code, try again'));
    expect(codeField().disabled).toBe(false);
    expect(codeField().value).toBe('  abc#S  ');
  });

  // verifying locks the code entry; a watched success re-reads the status exactly once, re-enables Log in and stops the poll.
  it('verifying disables the code field and Submit; succeeded re-reads the status once, says Signed in., and stops polling', async () => {
    fakeTimers();
    const { server, polls, statusReads } = loginServer(verifying);
    wrap(<ClaudeLogin pollMs={10} />);
    await screen.findByLabelText('Sign-in code');
    expect(codeField().disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Submit' })).toHaveProperty('disabled', true);
    expect(flowMsg()).toBe('Verifying…');
    const before = statusReads();
    server.snap = { state: 'succeeded' };
    await advance(10);
    await waitFor(() => expect(flowMsg()).toBe('Signed in.'));
    expect(screen.getByTestId('ca-flow')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(loginBtn().disabled).toBe(false);
    await waitFor(() => expect(statusReads()).toBe(before + 1));
    const n = polls();
    await advance(100);
    expect(polls()).toBe(n);
    expect(statusReads()).toBe(before + 1);
  });

  // A failed flow shows the CLI's own error, frees Log in, and is not polled further.
  it('failed shows the CLI error, re-enables Log in, and stops polling', async () => {
    fakeTimers();
    const { server, polls } = loginServer(verifying);
    wrap(<ClaudeLogin pollMs={10} />);
    await screen.findByText('Verifying…');
    server.snap = { state: 'failed', error: 'Login failed: HTTP 400' };
    await advance(10);
    await waitFor(() => expect(flowMsg()).toBe('Login failed: HTTP 400'));
    expect(loginBtn().disabled).toBe(false);
    const n = polls();
    await advance(100);
    expect(polls()).toBe(n);
  });

  // Cancel is one POST; the cancelled flow hides code entry and frees Log in.
  it('Cancel posts the cancel, shows Login cancelled., hides the code field and re-enables Log in', async () => {
    fakeTimers();
    const { calls } = loginServer(awaitingCode);
    wrap(<ClaudeLogin pollMs={10} />);
    await screen.findByLabelText('Sign-in code');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(flowMsg()).toBe('Login cancelled.'));
    expect(calls.filter((c) => c.url === '/api/claude-auth/login/cancel')).toHaveLength(1);
    expect(screen.queryByLabelText('Sign-in code')).toBeNull();
    expect(loginBtn().disabled).toBe(false);
  });

  // A flow the server already runs (another tab, a reopen) is shown on open and polled without any click.
  it('a flow already active when the panel opens is shown and polled', async () => {
    fakeTimers();
    const { polls } = loginServer(awaitingCode);
    wrap(<ClaudeLogin pollMs={10} />);
    await screen.findByTestId('ca-flow');
    expect((screen.getByLabelText('Sign-in URL') as HTMLInputElement).value).toBe(URL_);
    const n = polls();
    await advance(50);
    expect(polls()).toBeGreaterThan(n);
  });

  // A refused start opens the flow panel with the server's reason instead of failing silently.
  it("a refused start shows the server's error in the flow panel", async () => {
    fakeTimers();
    loginServer({ state: 'idle' }, {
      'POST /api/claude-auth/login': () => ({ status: 409, json: { error: 'a Claude login is already in progress' } }),
    });
    wrap(<ClaudeLogin pollMs={10} />);
    await screen.findByText('Not signed in');
    fireEvent.click(loginBtn());
    await waitFor(() => expect(flowMsg()).toBe('a Claude login is already in progress'));
  });

  // A new login starts with an empty code field, so a code typed into a cancelled flow is never submitted.
  it('a code typed before a Cancel is cleared when the next login starts', async () => {
    fakeTimers();
    const { server, codeBodies } = loginServer(awaitingCode, {
      'POST /api/claude-auth/login': () => { server.snap = awaitingCode; return { json: { state: 'starting' } }; },
    });
    wrap(<ClaudeLogin pollMs={10} />);
    await screen.findByLabelText('Sign-in code');
    fireEvent.change(codeField(), { target: { value: 'stale#S' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(flowMsg()).toBe('Login cancelled.'));
    fireEvent.click(loginBtn());
    await advance(10);
    await screen.findByLabelText('Sign-in code');
    expect(codeField().value).toBe('');
    fireEvent.change(codeField(), { target: { value: 'fresh#S' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(codeBodies()).toEqual([{ code: 'fresh#S' }]));
  });

  // Cancel supersedes a poll in flight: its late answer neither re-opens code entry nor restarts the poll.
  it('a poll still in flight when Cancel lands is dropped: the code field stays hidden and polling stays stopped', async () => {
    fakeTimers();
    const late = held<RouteAnswer>();
    let gets = 0;
    const { polls } = loginServer(awaitingCode, {
      'GET /api/claude-auth/login': () => (++gets === 2 ? late.answer : { json: awaitingCode }),
    });
    wrap(<ClaudeLogin pollMs={10} />);
    await screen.findByLabelText('Sign-in code');
    await advance(10);
    await waitFor(() => expect(polls()).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(flowMsg()).toBe('Login cancelled.'));
    await act(async () => late.release({ json: awaitingCode }));
    expect(screen.queryByLabelText('Sign-in code')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(flowMsg()).toBe('Login cancelled.');
    const n = polls();
    await advance(100);
    expect(polls()).toBe(n);
  });

  // A closed panel's in-flight poll is dead: it repaints nothing in the reopened panel, which shows the server's newer state and polls nothing.
  it('a poll in flight when the panel closes is dropped, and the reopened panel keeps the newer state', async () => {
    fakeTimers();
    const late = held<RouteAnswer>();
    let gets = 0;
    const { server, polls } = loginServer(verifying, {
      'GET /api/claude-auth/login': () => (++gets === 2 ? late.answer : { json: server.snap }),
    });
    const a = wrap(<ClaudeLogin pollMs={10} />);
    await screen.findByText('Verifying…');
    await advance(10);
    await waitFor(() => expect(polls()).toBe(2));
    a.unmount();
    server.snap = { state: 'failed', error: 'Login failed: HTTP 400' };
    wrap(<ClaudeLogin pollMs={10} />);
    await screen.findByText('Not signed in');
    await waitFor(() => expect(polls()).toBe(3));
    await act(async () => {});
    expect(loginBtn().disabled).toBe(false);
    expect(screen.queryByTestId('ca-flow')).toBeNull();
    await act(async () => late.release({ json: verifying }));
    expect(loginBtn().disabled).toBe(false);
    expect(screen.queryByTestId('ca-flow')).toBeNull();
    const n = polls();
    await advance(100);
    expect(polls()).toBe(n);
  });

  // When another tab's flow refuses the start, that flow is adopted: shown, cancellable, polled, and the refusal stays the message.
  it("a start refused because another tab's flow is running shows that flow, cancellable and polled, with the refusal", async () => {
    fakeTimers();
    const refusal = 'a Claude login is already in progress';
    let gets = 0;
    const { polls } = loginServer({ state: 'idle' }, {
      'GET /api/claude-auth/login': () => ({ json: ++gets === 1 ? { state: 'idle' } : awaitingCode }),
      'POST /api/claude-auth/login': () => ({ status: 409, json: { error: refusal } }),
    });
    wrap(<ClaudeLogin pollMs={10} />);
    await screen.findByText('Not signed in');
    fireEvent.click(loginBtn());
    await screen.findByLabelText('Sign-in URL');
    expect(screen.getByTestId('ca-flow')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect((screen.getByLabelText('Sign-in URL') as HTMLInputElement).value).toBe(URL_);
    expect(flowMsg()).toBe(refusal);
    const n = polls();
    await advance(50);
    expect(polls()).toBeGreaterThan(n);
    expect(flowMsg()).toBe(refusal);
  });

  // The refusal outranks the adopted flow's own "Verifying…" wording.
  it("a start refused while another tab's flow is verifying keeps the refusal on screen", async () => {
    fakeTimers();
    const refusal = 'a Claude login is already in progress';
    let gets = 0;
    loginServer({ state: 'idle' }, {
      'GET /api/claude-auth/login': () => ({ json: ++gets === 1 ? { state: 'idle' } : verifying }),
      'POST /api/claude-auth/login': () => ({ status: 409, json: { error: refusal } }),
    });
    wrap(<ClaudeLogin pollMs={10} />);
    await screen.findByText('Not signed in');
    fireEvent.click(loginBtn());
    await screen.findByRole('button', { name: 'Cancel' });
    expect(flowMsg()).toBe(refusal);
    await advance(30);
    expect(flowMsg()).toBe(refusal);
    expect(screen.queryByText('Verifying…')).toBeNull();
  });

  // A superseded status read is dropped: the account the newer read reported stays on screen.
  it('an older status answer landing after a newer one does not repaint the previous account', async () => {
    fakeTimers();
    const first = held<RouteAnswer>();
    let reads = 0;
    const { server } = loginServer({ state: 'idle' }, {
      'GET /api/claude-auth/status': () => (++reads === 1 ? first.answer : { json: { ...signedIn, email: 'new@example.com' } }),
      'POST /api/claude-auth/login': () => { server.snap = { state: 'succeeded' }; return { json: verifying }; },
    });
    wrap(<ClaudeLogin pollMs={10} />);
    fireEvent.click(loginBtn());
    await advance(10);
    await screen.findByText(/new@example.com/);
    await act(async () => first.release({ json: { ...signedIn, email: 'old@example.com' } }));
    expect(screen.getByTestId('ca-status').textContent).toMatch('new@example.com');
    expect(screen.getByTestId('ca-status').textContent).not.toMatch('old@example.com');
  });

  // A superseded status read that fails is dropped too: no error replaces the newer answer.
  it('an older status failure landing after a newer answer does not replace it', async () => {
    fakeTimers();
    const first = held<RouteAnswer>();
    let reads = 0;
    const { server } = loginServer({ state: 'idle' }, {
      'GET /api/claude-auth/status': () => (++reads === 1 ? first.answer : { json: { ...signedIn, email: 'new@example.com' } }),
      'POST /api/claude-auth/login': () => { server.snap = { state: 'succeeded' }; return { json: verifying }; },
    });
    wrap(<ClaudeLogin pollMs={10} />);
    fireEvent.click(loginBtn());
    await advance(10);
    await screen.findByText(/new@example.com/);
    await act(async () => first.release(new Error('boom')));
    expect(screen.getByText('Signed in')).toBeTruthy();
    expect(screen.queryByText(/Could not read the Claude login state/)).toBeNull();
  });
});

describe('Backends', () => {
  it('built-in rows offer no edit or remove; a row lists the custom models bound to it', () => {
    mockFetch({});
    modelsSettingsStore.set({ data: models() as any });
    wrap(<BackendsSection />);
    expect(screen.queryByRole('button', { name: 'Edit Claude' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Ollama' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit Mine' })).toBeTruthy();
    expect(screen.getByText('models: m1')).toBeTruthy();
  });

  it('the add form posts id / label / template with parsed env, then resets; the payload refreshes the catalog', async () => {
    const calls = mockFetch({ 'POST /api/settings/models/backends': () => models() });
    modelsSettingsStore.set({ data: models() as any });
    wrap(<BackendsSection />);
    fireEvent.change(screen.getByLabelText('Id'), { target: { value: ' px ' } });
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Proxy' } });
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'px {model}' } });
    fireEvent.change(screen.getByLabelText('Env (optional)'), { target: { value: 'K=v\nZ=1=2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add backend' }));
    await waitFor(() => expect(applyModels).toHaveBeenCalled());
    expect(calls[0].body).toEqual({ id: 'px', label: 'Proxy', template: 'px {model}', env: [{ key: 'K', value: 'v' }, { key: 'Z', value: '1=2' }] });
    expect((screen.getByLabelText('Id') as HTMLInputElement).value).toBe('');
  });

  it('editing a user row PATCHes label / template / env together', async () => {
    const calls = mockFetch({ 'PATCH /api/settings/models/backends/mine': () => models() });
    modelsSettingsStore.set({ data: models() as any });
    wrap(<BackendsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mine' }));
    expect((screen.getByLabelText('Id') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Mine 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls[0]?.body).toEqual({ label: 'Mine 2', template: 'mine run {model}', env: [{ key: 'A', value: '1' }] }));
  });

  it('a 409 on Remove shows the server message naming the bound models', async () => {
    mockFetch({ 'DELETE /api/settings/models/backends/mine': () => ({ status: 409, json: { error: 'still used by m1' } }) });
    modelsSettingsStore.set({ data: models() as any });
    wrap(<BackendsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Mine' }));
    await screen.findByText('Remove failed: still used by m1');
  });

  // A successful Remove renders the list from the DELETE answer, refreshes the catalog with it, and clears the earlier refusal.
  it('a successful Remove re-renders the list from the answer and clears an earlier refusal', async () => {
    const answer = models({ backends: models().backends.slice(0, 2) });
    let deletes = 0;
    mockFetch({ 'DELETE /api/settings/models/backends/mine': () => (deletes++ === 0 ? { status: 409, json: { error: 'still used by m1' } } : answer) });
    modelsSettingsStore.set({ data: models() as any });
    wrap(<BackendsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Mine' }));
    await screen.findByText('Remove failed: still used by m1');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Mine' }));
    await waitFor(() => expect([...document.querySelectorAll('[data-backend]')].map((e) => e.getAttribute('data-backend'))).toEqual(['claude', 'ollama']));
    expect(screen.queryByText('Remove failed: still used by m1')).toBeNull();
    expect(applyModels).toHaveBeenCalledWith(answer);
  });

  // Invariant: only a successful Remove of the edited backend ends edit mode; removing another user backend leaves the edit (id lock, typed values, edit title) intact.
  it('removing a backend other than the one being edited keeps that edit open', async () => {
    type BackendRow = NonNullable<ModelsPayload['backends']>[number];
    const CLAUDE: BackendRow = { id: 'claude', label: 'Claude', template: '', env: [], managed: true };
    const MINE: BackendRow = { id: 'mine', label: 'Mine', template: 'mine run {model}', env: [{ key: 'A', value: '1' }] };
    const PX: BackendRow = { id: 'px', label: 'My Proxy', template: 'px {model}', env: [] };
    const both: ModelsPayload = { backends: [CLAUDE, MINE, PX], customModels: [] };
    const afterRemove: ModelsPayload = { backends: [CLAUDE, MINE], customModels: [] };
    mockFetch({ 'DELETE /api/settings/models/backends/px': () => afterRemove });
    modelsSettingsStore.set({ data: both });
    wrap(<BackendsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mine' }));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Mine draft' } });
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'mine2 run {model}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove My Proxy' }));
    await waitFor(() => expect([...document.querySelectorAll('[data-backend]')].map((e) => e.getAttribute('data-backend'))).toEqual(['claude', 'mine']));
    expect((screen.getByLabelText('Id') as HTMLInputElement).value).toBe('mine');
    expect((screen.getByLabelText('Id') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Mine draft');
    expect((screen.getByLabelText('Template') as HTMLInputElement).value).toBe('mine2 run {model}');
    expect((screen.getByLabelText('Env (optional)') as HTMLTextAreaElement).value).toBe('A=1');
    expect(screen.getByText('Edit Mine', { selector: '[data-slot="card-title"]' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeNull();
  });
});

describe('Systems', () => {
  const list = { systems: [{ id: 'local', label: 'This machine', managed: true, projects: [] }, { id: 'box', label: 'Box', launch: null, projects: [{ name: 'p', remoteId: 'ctr' }] }] };

  it('the built-in row is read-only; a row without a command says it is a name only and lists its projects', async () => {
    mockFetch({ 'GET /api/settings/systems': () => list });
    wrap(<SystemsSection />);
    await screen.findByText('Box');
    expect(screen.queryByRole('button', { name: 'Edit This machine' })).toBeNull();
    expect(screen.getByText(/This system is a name only/)).toBeTruthy();
    expect(screen.getByText('projects: p (ctr)')).toBeTruthy();
  });

  it('adds with the provider command as argv; an empty command is sent as null', async () => {
    const calls = mockFetch({ 'GET /api/settings/systems': () => list, 'POST /api/settings/systems': () => list });
    wrap(<SystemsSection />);
    await screen.findByText('Box');
    fireEvent.change(screen.getByLabelText('Id'), { target: { value: 'b2' } });
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'B2' } });
    fireEvent.change(screen.getByLabelText('Provider command'), { target: { value: 'docker exec -i c p' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add system' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ id: 'b2', label: 'B2', launch: ['docker', 'exec', '-i', 'c', 'p'], worktreesDir: null }));
    fireEvent.change(screen.getByLabelText('Id'), { target: { value: 'b3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add system' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')[1]?.body.launch).toBeNull());
  });

  it('an unreachable system shows the provider\'s error and keeps the typed values', async () => {
    mockFetch({ 'GET /api/settings/systems': () => list, 'POST /api/settings/systems': () => ({ status: 502, json: { error: 'provider did not answer hello' } }) });
    wrap(<SystemsSection />);
    await screen.findByText('Box');
    fireEvent.change(screen.getByLabelText('Id'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add system' }));
    await screen.findByText('Save failed: provider did not answer hello');
    expect((screen.getByLabelText('Id') as HTMLInputElement).value).toBe('x');
  });

  // The Settings helper names a network failure with the one unreachable message, not the browser's wording.
  it('a save with no server shows the unreachable message and keeps the typed values', async () => {
    mockFetch({ 'GET /api/settings/systems': () => list, 'POST /api/settings/systems': () => { throw new TypeError('Failed to fetch'); } });
    wrap(<SystemsSection />);
    await screen.findByText('Box');
    fireEvent.change(screen.getByLabelText('Id'), { target: { value: 'offline-box' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add system' }));
    await screen.findByText(`Save failed: ${SERVER_UNREACHABLE_MESSAGE}`);
    expect((screen.getByLabelText('Id') as HTMLInputElement).value).toBe('offline-box');
  });

  const LOCAL = { id: 'local', label: 'This machine', managed: true, projects: [] };
  const PROD = { id: 'prod-box', label: 'Prod box', launch: ['ssh', 'prod', 'cc-provider'], projects: [{ name: 'shipping', remoteId: 'ctr-7' }] };
  const NAMED = { id: 'namedonly', label: 'Named only', launch: null, projects: [] };
  const rich = { systems: [LOCAL, PROD, NAMED] };
  const systemIds = () => [...document.querySelectorAll('[data-system]')].map((e) => e.getAttribute('data-system'));

  // Edit loads the row with its id locked; Save PATCHes that id with the new label and the loaded provider command as argv, then the form is back in add mode.
  it('editing a user row locks its id, PATCHes the new label with the provider command unchanged, and returns to add mode', async () => {
    const calls = mockFetch({ 'GET /api/settings/systems': () => rich, 'PATCH /api/settings/systems/prod-box': () => rich });
    wrap(<SystemsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Prod box' }));
    expect((screen.getByLabelText('Id') as HTMLInputElement).value).toBe('prod-box');
    expect((screen.getByLabelText('Id') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Prod box');
    expect((screen.getByLabelText('Provider command') as HTMLInputElement).value).toBe('ssh prod cc-provider');
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Production' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Add system' });
    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: 'PATCH', url: '/api/settings/systems/prod-box', body: { label: 'Production', launch: ['ssh', 'prod', 'cc-provider'], worktreesDir: null } });
    expect((screen.getByLabelText('Id') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Id') as HTMLInputElement).disabled).toBe(false);
  });

  // A refused Remove shows the server's message (naming the project) in the status line and keeps the row; only that one DELETE is sent.
  it('a refused Remove names the blocking project and keeps the row', async () => {
    const msg = "system 'prod-box' is still named by 1 project (shipping) — move or remove it first";
    const calls = mockFetch({ 'GET /api/settings/systems': () => rich, 'DELETE /api/settings/systems/prod-box': () => ({ status: 409, json: { error: msg } }) });
    wrap(<SystemsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Prod box' }));
    expect((await screen.findByText(`Remove failed: ${msg}`)).textContent).toBe(`Remove failed: ${msg}`);
    expect(document.querySelector('[data-system="prod-box"]')).not.toBeNull();
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/settings/systems/prod-box']);
  });

  // A successful Remove renders the list from the DELETE answer.
  it('a successful Remove re-renders the list from the answer', async () => {
    mockFetch({ 'GET /api/settings/systems': () => rich, 'DELETE /api/settings/systems/prod-box': () => ({ systems: [LOCAL] }) });
    wrap(<SystemsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Prod box' }));
    expect(systemIds()).toEqual(['local', 'prod-box', 'namedonly']);
    await waitFor(() => expect(systemIds()).toEqual(['local']));
  });

  // A user row shows its provider command joined, a command-less user row says it is a name only, and the built-in row has no command line at all.
  it('a row shows its provider command, a command-less row says it is a name only, and the built-in row shows neither', async () => {
    mockFetch({ 'GET /api/settings/systems': () => rich });
    wrap(<SystemsSection />);
    await screen.findByText('Prod box');
    expect(document.querySelector('[data-system="prod-box"] [data-launch]')?.textContent).toBe('ssh prod cc-provider');
    expect(document.querySelector('[data-system="namedonly"] [data-launch]')?.textContent).toMatch(/name only/);
    expect(document.querySelector('[data-system="local"] [data-launch]')).toBeNull();
  });

  // Invariant: only a successful Remove of the edited system ends edit mode; removing another user system leaves the edit (id lock, typed values, edit title) intact.
  it('removing a system other than the one being edited keeps that edit open', async () => {
    type SystemRow = { id: string; label: string; managed?: boolean; launch?: string[] | null; projects?: { name: string; remoteId?: string | null }[] };
    const afterRemove: { systems: SystemRow[] } = { systems: [LOCAL, PROD] };
    mockFetch({ 'GET /api/settings/systems': () => rich, 'DELETE /api/settings/systems/namedonly': () => afterRemove });
    wrap(<SystemsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Prod box' }));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Draft' } });
    fireEvent.change(screen.getByLabelText('Provider command'), { target: { value: 'ssh prod2 cc-provider' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Named only' }));
    await waitFor(() => expect(systemIds()).toEqual(['local', 'prod-box']));
    expect((screen.getByLabelText('Id') as HTMLInputElement).value).toBe('prod-box');
    expect((screen.getByLabelText('Id') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Draft');
    expect((screen.getByLabelText('Provider command') as HTMLInputElement).value).toBe('ssh prod2 cc-provider');
    expect(screen.getByText('Edit Prod box', { selector: '[data-slot="card-title"]' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeNull();
  });
});

describe('Models', () => {
  it('a tier whose level is missing shows the server default; a role\'s Inherit names the level it resolves to', () => {
    mockFetch({ 'GET /api/settings/spawn': () => ({ debugByDefault: false }) });
    modelsSettingsStore.set({ data: models() as any });
    wrap(<ModelsSection />);
    expect((screen.getByLabelText('Default effort for the Fast tier') as HTMLSelectElement).value).toBe('low');
    expect((screen.getByLabelText('Default effort for the Powerful tier') as HTMLSelectElement).value).toBe('medium');
    expect(screen.getByRole('option', { name: 'Inherit (high)' })).toBeTruthy();
  });

  it('the task-tools switch reflects the stored setting and posts only taskTools when toggled', async () => {
    const calls = mockFetch({
      'GET /api/settings/spawn': () => ({ debugByDefault: false, taskTools: false }),
      'POST /api/settings/spawn/prefs': () => ({ debugByDefault: false, taskTools: true }),
    });
    modelsSettingsStore.set({ data: models() as any });
    wrap(<ModelsSection />);
    const sw = await screen.findByRole('switch', { name: 'Enable the task tools for every session' });
    await waitFor(() => expect(sw).toHaveProperty('disabled', false));
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ taskTools: true }));
  });

  it('the task-tools switch renders checked when the server says it is on', async () => {
    mockFetch({ 'GET /api/settings/spawn': () => ({ taskTools: true }) });
    modelsSettingsStore.set({ data: models() as any });
    wrap(<ModelsSection />);
    const sw = await screen.findByRole('switch', { name: 'Enable the task tools for every session' });
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
  });

  it('changing a tier\'s effort posts tierEffort; the last enabled tier cannot be switched off', async () => {
    const calls = mockFetch({ 'GET /api/settings/spawn': () => ({}), 'POST /api/settings/models/prefs': () => models() });
    modelsSettingsStore.set({ data: models({ enabledTiers: { fast: false, powerful: true } }) as any });
    wrap(<ModelsSection />);
    expect(screen.getByRole('switch', { name: 'Enable the Powerful tier' })).toHaveProperty('disabled', true);
    expect((screen.getByLabelText('Default effort for the Fast tier') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Default effort for the Powerful tier'), { target: { value: 'max' } });
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ tierEffort: { tier: 'powerful', effort: 'max' } }));
  });

  it('switching a tier to a backend with no model refuses and names the backend', () => {
    mockFetch({ 'GET /api/settings/spawn': () => ({}) });
    modelsSettingsStore.set({ data: models() as any });
    wrap(<ModelsSection />);
    fireEvent.change(screen.getByLabelText('Backend for the Fast tier'), { target: { value: 'ollama' } });
    expect(screen.getByText('Add a Ollama model under Custom models first.')).toBeTruthy();
  });

  it('editing a custom model locks backend and id and PATCHes its pair URL; Cancel returns to add mode', async () => {
    const calls = mockFetch({ 'GET /api/settings/spawn': () => ({}), 'PATCH /api/settings/models/custom/mine/m1': () => models() });
    modelsSettingsStore.set({ data: models() as any });
    wrap(<ModelsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mine 1' }));
    expect((screen.getByLabelText('Model id') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Backend', { selector: '#cm-backend' }) as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Context'), { target: { value: '1m' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ label: 'Mine 1', contextWindow: 1000000, midTurnSteering: true }));
    await screen.findByText('Saved.');
    expect((screen.getByLabelText('Model id') as HTMLInputElement).disabled).toBe(false);
    // Cancel leaves edit mode without a request and unlocks the pair.
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mine 1' }));
    expect((screen.getByLabelText('Model id') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Backend', { selector: '#cm-backend' }) as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect((screen.getByLabelText('Model id') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText('Model id') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Backend', { selector: '#cm-backend' }) as HTMLSelectElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add model' })).toBeTruthy();
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  it('a custom model needs a parseable context', () => {
    mockFetch({ 'GET /api/settings/spawn': () => ({}) });
    modelsSettingsStore.set({ data: models() as any });
    wrap(<ModelsSection />);
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('Context'), { target: { value: 'big' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
    expect(screen.getByText(/Context is required/)).toBeTruthy();
  });

  it('loadModelsSettings reports a failed load', async () => {
    mockFetch({ 'GET /api/settings/models': () => ({ status: 500, json: { error: 'down' } }) });
    await loadModelsSettings();
    expect(modelsSettingsStore.get().error).toBe('Failed to load models: down');
  });

  it('EffortPicker falls back to the server default for an unknown level', () => {
    wrap(<EffortPicker data={models() as any} value="nonsense" enabled label="e" onPick={() => {}} />);
    expect((screen.getByLabelText('e') as HTMLSelectElement).value).toBe('medium');
  });
});

describe('Archived', () => {
  const groups = { groups: [{ project: 'p', sessions: [{ sessionId: 's1', title: 'T1', lastActivity: Date.now() }] }, { project: '.conduct', sessions: [{ sessionId: 's2' }] }] };

  it('Restore restores, then resumes the session; conductor sessions are listed first', async () => {
    mockFetch({ 'GET /api/archived': () => groups, 'POST /api/projects/p/sessions/s1/restore': () => ({ ok: true }) });
    wrap(<ArchivedSection />);
    await screen.findByText('2 archived sessions across 2 projects.');
    const triggers = screen.getAllByRole('button', { expanded: false });
    expect(triggers[0].textContent).toMatch('Conductor');
    fireEvent.click(screen.getByRole('button', { name: /^p/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(resumeSession).toHaveBeenCalledWith({ projectName: 'p', worktreeName: undefined, sessionId: 's1' }));
  });

  it('a failed restore does not resume', async () => {
    vi.mocked(resumeSession).mockClear();
    mockFetch({ 'GET /api/archived': () => groups, 'POST /api/projects/p/sessions/s1/restore': () => ({ status: 500, json: { error: 'nope' } }) });
    wrap(<ArchivedSection />);
    await screen.findByText(/archived sessions/);
    fireEvent.click(screen.getByRole('button', { name: /^p/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(resumeSession).not.toHaveBeenCalled();
  });

  // A refused Restore toasts the server's own reason, and a Restore with no server the one unreachable message; neither resumes.
  it('a Restore the server refuses shows its reason, and one with no server shows the unreachable message; neither resumes', async () => {
    vi.mocked(resumeSession).mockClear();
    const err = vi.spyOn(toast, 'error').mockImplementation(() => '' as any);
    let n = 0;
    mockFetch({
      'GET /api/archived': () => groups,
      'POST /api/projects/p/sessions/s1/restore': () => {
        if (++n === 1) return { status: 500, json: { error: 'transcript locked by s7' } };
        throw new TypeError('Failed to fetch');
      },
    });
    wrap(<ArchivedSection />);
    await screen.findByText(/archived sessions/);
    fireEvent.click(screen.getByRole('button', { name: /^p/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(err).toHaveBeenCalledWith('Restore failed', 'transcript locked by s7'));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(err).toHaveBeenCalledWith('Restore failed', SERVER_UNREACHABLE_MESSAGE));
    expect(err).toHaveBeenCalledTimes(2);
    expect(resumeSession).not.toHaveBeenCalled();
    err.mockRestore();
  });

  // The list refreshes after an archive change run unawaited: a refused one is logged, never an unhandled rejection, and the restore goes on to resume.
  it('a refused list refresh after a Restore is logged, and the session is still resumed', async () => {
    vi.mocked(resumeSession).mockClear();
    vi.mocked(refreshProjects).mockRejectedValueOnce(new Error('projects read refused'));
    vi.mocked(refreshInstances).mockRejectedValueOnce(new Error('instances read refused'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockFetch({ 'GET /api/archived': () => groups, 'POST /api/projects/p/sessions/s1/restore': () => ({ ok: true }) });
      wrap(<ArchivedSection />);
      await screen.findByText(/archived sessions/);
      fireEvent.click(screen.getByRole('button', { name: /^p/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
      await waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
      expect(warn.mock.calls).toEqual(expect.arrayContaining([
        ['refreshProjects after an archive change failed:', expect.objectContaining({ message: 'projects read refused' })],
        ['refreshInstances after an archive change failed:', expect.objectContaining({ message: 'instances read refused' })],
      ]));
      await waitFor(() => expect(resumeSession).toHaveBeenCalledWith({ projectName: 'p', worktreeName: undefined, sessionId: 's1' }));
    } finally {
      warn.mockRestore();
    }
  });

  it('an accepted Restore and an accepted Delete each mark every place\'s session list stale, exactly once', async () => {
    vi.mocked(resumeSession).mockClear();
    mockFetch({
      'GET /api/archived': () => groups,
      'POST /api/projects/p/sessions/s1/restore': () => ({ ok: true }),
      'DELETE /api/projects/p/sessions/s1': () => ({ ok: true }),
    });
    const stale: unknown[] = [];
    const off = on('sessionsStale', (p) => stale.push(p));
    try {
      wrap(<><ArchivedSection /><ConfirmHost /></>);
      await screen.findByText(/archived sessions/);
      fireEvent.click(screen.getByRole('button', { name: /^p/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
      await waitFor(() => expect(resumeSession).toHaveBeenCalled());
      expect(stale).toEqual([null]);

      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Delete permanently' }));
      await waitFor(() => expect(stale).toHaveLength(2));
      await new Promise((r) => setTimeout(r, 30));
      expect(stale).toEqual([null, null]);
    } finally {
      off();
    }
  });

  const three = () => ({ groups: [{ project: 'p', sessions: [
    { sessionId: 's1', title: 'T1', lastActivity: Date.now() - 5 * 60_000 },
    { sessionId: 's2', firstPrompt: 'fp', worktreeName: 'wt1', lastActivity: Date.now() - 2 * 3600_000 },
    { sessionId: 'abcdef0123456789' },
  ] }] });
  const row = (sid: string) => document.querySelector(`[data-session="${sid}"]`)?.textContent ?? '';

  // Rows stay hidden until their group is expanded; a row is labelled by title, else first prompt, else short id, and carries its worktree and last activity.
  it('groups start collapsed; an expanded row shows its title, else its first prompt, else its short id, with the worktree and last activity', async () => {
    mockFetch({ 'GET /api/archived': () => three() });
    wrap(<ArchivedSection />);
    const trigger = await screen.findByRole('button', { name: /^p/ });
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.textContent).toMatch('(3)');
    fireEvent.click(trigger);
    expect(await screen.findByText('T1')).toBeTruthy();
    expect(screen.getByText('fp')).toBeTruthy();
    expect(screen.getByText('abcdef01…')).toBeTruthy();
    expect(row('s2')).toMatch('wt1 · last');
    expect(row('s1')).toMatch('last 5m ago');
    expect(row('abcdef0123456789')).toMatch('last never');
  });

  // Delete is gated on the confirmation: declining sends nothing; confirming deletes exactly that transcript and the reloaded list drops it.
  it('Delete asks first: Cancel sends nothing; confirming deletes that transcript and reloads the list without it', async () => {
    let data = three();
    const calls = mockFetch({
      'GET /api/archived': () => data,
      'DELETE /api/projects/p/sessions/s1': () => { data = { groups: [{ project: 'p', sessions: data.groups[0].sessions.filter((x) => x.sessionId !== 's1') }] }; return { ok: true }; },
    });
    wrap(<><ArchivedSection /><ConfirmHost /></>);
    fireEvent.click(await screen.findByRole('button', { name: /^p/ }));
    const t1Delete = () => within(document.querySelector('[data-session="s1"]') as HTMLElement).getByRole('button', { name: 'Delete' });
    fireEvent.click(await waitFor(t1Delete));
    expect(await screen.findByRole('dialog', { name: 'Delete the transcript of “T1”?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    fireEvent.click(t1Delete());
    fireEvent.click(await screen.findByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(screen.queryByText('T1')).toBeNull());
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/projects/p/sessions/s1']);
    expect(calls.filter((c) => c.url === '/api/archived')).toHaveLength(2);
  });

  // A worktree session is deleted under its worktree's URL; a refused delete keeps the list as it was and reports the server's reason.
  it('deleting a worktree session addresses it under its worktree; a failed delete keeps the row and says so', async () => {
    const err = vi.spyOn(toast, 'error').mockImplementation(() => '' as any);
    const calls = mockFetch({
      'GET /api/archived': () => three(),
      'DELETE /api/projects/p/worktrees/wt1/sessions/s2': () => ({ status: 500, json: { error: 'locked' } }),
    });
    wrap(<><ArchivedSection /><ConfirmHost /></>);
    fireEvent.click(await screen.findByRole('button', { name: /^p/ }));
    await screen.findByText('fp');
    fireEvent.click(within(document.querySelector('[data-session="s2"]') as HTMLElement).getByRole('button', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(err).toHaveBeenCalledWith('Delete failed', 'locked'));
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/projects/p/worktrees/wt1/sessions/s2']);
    expect(calls.filter((c) => c.url === '/api/archived')).toHaveLength(1);
    expect(screen.getByText('fp')).toBeTruthy();
    err.mockRestore();
  });

  // A first prompt as the server lists it (cut by readFirstPrompt): a wake stub is labelled by its summary in the row, its tooltip and the Delete dialog's accessible name, never by its marker.
  it('an archived session whose first prompt is a wake stub is labelled by its wake summary, in the row and in the Delete dialog\'s name', async () => {
    const wake = buildWakeStub({ targetSessionId: 'labelwake', payloadText: '{"sessionId":"labelwake"}\nWAKE-ARCHIVED prose' }).slice(0, 200);
    mockFetch({ 'GET /api/archived': () => ({ groups: [{ project: 'p', sessions: [{ sessionId: 's-wake', firstPrompt: wake }] }] }) });
    wrap(<><ArchivedSection /><ConfirmHost /></>);
    fireEvent.click(await screen.findByRole('button', { name: /^p/ }));
    const label = await screen.findByText((t) => t.startsWith('Wake: Worker `labelwake` finished its turn.'));
    expect(label.getAttribute('title')).not.toContain('[[cc:');
    expect(row('s-wake')).not.toContain('[[cc:');
    fireEvent.click(within(document.querySelector('[data-session="s-wake"]') as HTMLElement).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('dialog', { name: (n) => n.includes('“Wake: Worker `labelwake` finished its turn.') })).toBeTruthy();
    expect(screen.queryAllByRole('dialog', { name: (n) => n.includes('[[cc:') })).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  });

  // A renewed session's file opens with the CLI's caveat record (modelled by RENEW_HEAD in tests/segmentChain.mjs; read here from a hand-authored fixture carrying the same record), which the server lists as its first prompt: it reads Context renewed, never by its tag.
  it('an archived session whose first prompt is a post-/clear caveat record is labelled Context renewed, in the row and in the Delete dialog\'s name', async () => {
    const caveat = readJsonl('awaiting-user/renew-two-segments.transcript.jsonl')
      .find((r) => r.type === 'user' && typeof r.message?.content === 'string' && r.message.content.startsWith('<local-command-caveat>'))!.message.content.slice(0, 200);
    mockFetch({ 'GET /api/archived': () => ({ groups: [{ project: 'p', sessions: [{ sessionId: 's-caveat', firstPrompt: caveat }] }] }) });
    wrap(<><ArchivedSection /><ConfirmHost /></>);
    fireEvent.click(await screen.findByRole('button', { name: /^p/ }));
    expect((await screen.findByText('Context renewed')).getAttribute('title')).toBe('Context renewed');
    expect(row('s-caveat')).not.toContain('<local-command-caveat>');
    fireEvent.click(within(document.querySelector('[data-session="s-caveat"]') as HTMLElement).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('dialog', { name: 'Delete the transcript of “Context renewed”?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  });

  // Negative control: a person's first prompt is the label as it is, in the row and the Delete dialog's name.
  it('an archived session whose first prompt a person wrote is labelled by that prompt unchanged', async () => {
    mockFetch({ 'GET /api/archived': () => ({ groups: [{ project: 'p', sessions: [{ sessionId: 's-human', firstPrompt: 'sweep the docs index' }] }] }) });
    wrap(<><ArchivedSection /><ConfirmHost /></>);
    fireEvent.click(await screen.findByRole('button', { name: /^p/ }));
    expect((await screen.findByText('sweep the docs index')).getAttribute('title')).toBe('sweep the docs index');
    fireEvent.click(within(document.querySelector('[data-session="s-human"]') as HTMLElement).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('dialog', { name: 'Delete the transcript of “sweep the docs index”?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  });
});

describe('Plugins', () => {
  const lib = { entries: [] };
  const row = (over: object) => ({ id: 'pl', name: 'Pl', project: 'pl', state: 'stopped', enabled: true, hasBackend: true, ...over });

  it('a plugin whose backend is local-only on a system hides Start and says so', async () => {
    mockFetch({
      'GET /api/plugins': () => ({ rows: [row({ system: 'box', localOnly: ['PLUGIN_BACKEND_LOCAL_ONLY'] })] }),
      'GET /api/projects': () => [], 'GET /api/plugins/library': () => lib,
    });
    wrap(<PluginsSection />);
    await screen.findByText('Pl');
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    expect(screen.getByText("on system 'box': PLUGIN_BACKEND_LOCAL_ONLY")).toBeTruthy();
  });

  it('Restart reports {action, ids}; Stop reports no change', async () => {
    const before = pluginsChangedSignal.version();
    mockFetch({
      'GET /api/plugins': () => ({ rows: [row({ state: 'ready', stale: true })] }),
      'GET /api/projects': () => [], 'GET /api/plugins/library': () => lib,
      'POST /api/plugins/pl/restart': () => ({ ok: true }), 'POST /api/plugins/pl/stop': () => ({ ok: true }),
    });
    wrap(<PluginsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(pluginsChangeStore.get().lastChange).toEqual({ action: 'restart', ids: ['pl'] }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(pluginsChangedSignal.version()).toBe(before + 2));
    expect(pluginsChangeStore.get().lastChange).toBeUndefined();
  });

  it('library: Update all is disabled with nothing to update and counts updatable entries otherwise', async () => {
    // With no entry both installed and behind its origin, Update all is offered disabled.
    // b is behind but not installed, a shape the server never sends: it pins the client's own conjunction, not the server's invariant.
    mockFetch({
      'GET /api/plugins': () => ({ rows: [] }), 'GET /api/projects': () => [],
      'GET /api/plugins/library': () => ({ entries: [
        { id: 'a', name: 'A', repo: 'r', installed: true, installedAs: 'a', updateAvailable: false },
        { id: 'b', name: 'B', repo: 'r', installed: false, updateAvailable: true },
      ] }),
    });
    const empty = wrap(<PluginsSection />);
    // Read Update all only once this load's library line has replaced the previous store's.
    await waitFor(() => expect(screen.getByText('2 available')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Update all' })).toHaveProperty('disabled', true);
    empty.unmount();
    mockFetch({
      'GET /api/plugins': () => ({ rows: [] }), 'GET /api/projects': () => [],
      'GET /api/plugins/library': () => ({ entries: [
        { id: 'a', name: 'A', repo: 'r', installed: true, installedAs: 'a', updateAvailable: true },
        { id: 'b', name: 'B', repo: 'r', installed: false },
      ] }),
    });
    wrap(<PluginsSection />);
    expect(await screen.findByRole('button', { name: 'Update all (1)' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy();
  });

  it('a corrupt-registry notice is surfaced in the status line', async () => {
    mockFetch({
      'GET /api/plugins': () => ({ rows: [], notices: [{ file: 'plugins.json', reason: 'bad json', backup: 'plugins.json.bak' }] }),
      'GET /api/projects': () => [], 'GET /api/plugins/library': () => lib,
    });
    wrap(<PluginsSection />);
    await screen.findByText(/plugins.json was unreadable \(bad json\) — moved aside to plugins.json.bak/);
  });
});
