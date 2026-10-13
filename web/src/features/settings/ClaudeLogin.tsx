// Settings → Account → Claude login: the CLI's sign-in state and the
// browser-driven `claude auth login` flow. The flow lives on the server, so
// any tab sees it: opening the panel resumes an in-flight one; while active the
// snapshot is polled. Generations drop answers that a newer action superseded.
import * as React from 'react';
import { ExternalLinkIcon, LogInIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CopyButton } from '@/components/CopyButton';
import { SettingsCard, Status } from './ui';
import { json, post, errText } from './api';

const BASE = '/api/claude-auth';
const ACTIVE = new Set(['starting', 'awaiting_code', 'verifying']);
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export type AuthStatus = {
  loggedIn?: boolean; authMethod?: string | null; apiProvider?: string | null; email?: string | null; orgName?: string | null;
  subscriptionType?: string | null; apiKeySource?: string | null; configDirectory?: string | null;
};
export type LoginSnapshot = { state: string; url?: string | null; error?: string | null };

/** The status line: headline + the non-empty identity details. */
export function describeAuth(s: AuthStatus): { head: string; details: string[]; apiKeyNote: boolean } {
  const details: (string | null | undefined | false)[] = [];
  let head = 'Not signed in';
  if (s.loggedIn && s.authMethod === 'claude.ai') {
    head = 'Signed in';
    details.push(s.email, s.orgName, s.subscriptionType && `${capitalise(s.subscriptionType)} plan`, 'Claude subscription');
  } else if (s.loggedIn && s.authMethod === 'api_key') {
    head = 'Using an API key';
    if (s.apiKeySource) details.push(s.apiKeySource);
  } else if (s.loggedIn) {
    head = 'Signed in';
    details.push(s.authMethod);
  }
  return { head, details: details.filter(Boolean) as string[], apiKeyNote: !!s.loggedIn && s.authMethod === 'api_key' };
}

export function ClaudeLogin({ onLoginSuccess, pollMs = 1000 }: { onLoginSuccess?: () => void; pollMs?: number }) {
  const [auth, setAuth] = React.useState<AuthStatus | null>(null);
  const [authError, setAuthError] = React.useState<string | null>(null);
  const [snap, setSnap] = React.useState<LoginSnapshot | null>(null);
  const [flowShown, setFlowShown] = React.useState(false);
  const [msg, setMsg] = React.useState('');
  const [code, setCode] = React.useState('');

  const gen = React.useRef(0);
  const statusGen = React.useRef(0);
  const flowActive = React.useRef(false);
  const notice = React.useRef('');
  const pollTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSuccessRef = React.useRef(onLoginSuccess);
  onSuccessRef.current = onLoginSuccess;

  const stopPoll = () => { if (pollTimer.current) clearTimeout(pollTimer.current); pollTimer.current = null; };

  const loadStatus = React.useCallback(async () => {
    const g = ++statusGen.current;
    try {
      const s = await json<AuthStatus>(`${BASE}/status`);
      if (g === statusGen.current) { setAuth(s); setAuthError(null); }
    } catch (e) {
      if (g === statusGen.current) setAuthError(`Could not read the Claude login state: ${errText(e)}`);
    }
  }, []);

  const renderFlow = React.useCallback((s: LoginSnapshot, { initial = false } = {}) => {
    const active = ACTIVE.has(s.state);
    const wasActive = flowActive.current;
    flowActive.current = active;
    setSnap(s);
    setFlowShown(!(s.state === 'idle' || (initial && !active)));
    switch (s.state) {
      case 'starting': setMsg(notice.current || 'Starting…'); break;
      case 'awaiting_code': setMsg(s.error || notice.current); break;
      case 'verifying': setMsg(notice.current || 'Verifying…'); break;
      case 'succeeded': setMsg('Signed in.'); break;
      case 'failed': setMsg(s.error || 'Login failed.'); break;
      case 'cancelled': setMsg('Login cancelled.'); break;
      default: setMsg('');
    }
    if (active) {
      stopPoll();
      pollTimer.current = setTimeout(poll, pollMs);
    } else {
      gen.current++;
      notice.current = '';
      stopPoll();
    }
    if (wasActive && s.state === 'succeeded') {
      void loadStatus();
      onSuccessRef.current?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadStatus, pollMs]);

  async function poll() {
    pollTimer.current = null;
    const g = gen.current;
    try {
      const s = await json<LoginSnapshot>(`${BASE}/login`);
      if (g === gen.current) renderFlow(s);
    } catch (e) {
      if (g !== gen.current) return;
      setMsg(`Could not read the login progress: ${errText(e)}`);
      pollTimer.current = setTimeout(poll, pollMs);
    }
  }

  async function act(url: string, body?: unknown): Promise<string | null> {
    notice.current = '';
    stopPoll();
    const g = ++gen.current;
    try {
      const s = await post<LoginSnapshot>(url, body ?? {});
      if (g === gen.current) renderFlow(s);
      return null;
    } catch (e) {
      const m = errText(e);
      if (g === gen.current) setMsg(m);
      return m;
    }
  }

  const load = React.useCallback(async () => {
    stopPoll();
    const g = ++gen.current;
    const [, s] = await Promise.all([loadStatus(), json<LoginSnapshot>(`${BASE}/login`).catch(() => null)]);
    if (s && g === gen.current) renderFlow(s, { initial: true });
  }, [loadStatus, renderFlow]);

  React.useEffect(() => {
    void load();
    return () => { gen.current++; stopPoll(); };
  }, [load]);

  async function login() {
    setCode('');
    setFlowShown(true);
    const refused = await act(`${BASE}/login`);
    if (!refused) return;
    // Refused (e.g. another tab's flow): show whatever flow the server has, with the reason.
    notice.current = refused;
    await load();
    setFlowShown(true);
    setMsg(refused);
  }

  function submit() {
    if (snap?.state !== 'awaiting_code') return;
    void act(`${BASE}/login/code`, { code: code.trim() });
  }

  const active = !!snap && ACTIVE.has(snap.state);
  const awaiting = snap?.state === 'awaiting_code' || snap?.state === 'verifying';
  const d = auth ? describeAuth(auth) : null;

  return (
    <SettingsCard
      title="Claude login"
      description="Signed in means credentials are present; the CLI does not check them. New sessions use the new login; running sessions keep the previous one until they restart."
      action={
        <Button variant="outline" size="sm" onClick={() => void login()} disabled={active} data-testid="ca-login">
          <LogInIcon /> {auth?.loggedIn ? 'Re-log in' : 'Log in'}
        </Button>
      }
    >
      <div className="space-y-1" data-testid="ca-status">
        {authError ? <Status text={authError} tone="error" /> : !d ? <Status text="Loading…" /> : (
          <>
            <div className="text-sm">
              <strong className="font-medium">{d.head}</strong>
              {d.details.length > 0 && <span className="text-muted-foreground"> · {d.details.join(' · ')}</span>}
            </div>
            {d.apiKeyNote && <p className="text-xs text-muted-foreground">cc's environment sets this key and sessions use it; a login here won't change that.</p>}
            {auth?.configDirectory && <p className="font-mono text-xs text-muted-foreground">Credentials: {auth.configDirectory}</p>}
          </>
        )}
      </div>
      {flowShown && (
        <div className="space-y-3 rounded-lg border border-dashed p-3" data-testid="ca-flow">
          {awaiting && snap?.url && (
            <div className="space-y-2" data-testid="ca-await">
              <a href={snap.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline" data-testid="ca-url">
                <ExternalLinkIcon className="size-4" /> Open the sign-in page
              </a>
              <div className="flex gap-1">
                <Input readOnly value={snap.url} aria-label="Sign-in URL" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                <CopyButton getText={() => snap.url ?? ''} label="Copy sign-in URL" className="size-9" />
              </div>
              <p className="text-xs text-muted-foreground">Open the link on any device. After signing in, the page shows a code. Paste it here.</p>
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  disabled={snap.state !== 'awaiting_code'}
                  placeholder="Paste the code"
                  aria-label="Sign-in code"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button type="submit" disabled={snap.state !== 'awaiting_code'}>Submit</Button>
              </form>
            </div>
          )}
          <Status text={msg} tone={snap?.state === 'failed' ? 'error' : snap?.state === 'succeeded' ? 'ok' : 'muted'} />
          {active && <Button variant="ghost" size="sm" onClick={() => void act(`${BASE}/login/cancel`)}>Cancel</Button>}
        </div>
      )}
    </SettingsCard>
  );
}
