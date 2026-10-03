// Settings → Account → Claude login (public/claudeAuth.js), driven under
// happy-dom against the real fieldset markup from public/index.html and a
// scripted fetch.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

// The Claude login fieldset as shipped, so the test meets the real ids.
const CLAUDE_LOGIN_MARKUP = (() => {
  const html = readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const m = /<fieldset class="sm-group">\s*<legend>Claude login<\/legend>[\s\S]*?<\/fieldset>/.exec(html);
  if (!m) throw new Error('Claude login fieldset not found in public/index.html');
  return m[0];
})();

let counter = 0;
const freshImport = () => import(pathToFileURL(path.join(PUB, 'claudeAuth.js')).href + '?t=' + (++counter));

const URL_ = 'https://claude.com/cai/oauth/authorize?code=true&state=STATE';
const SIGNED_IN = {
  loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
  email: 'user@example.com', orgId: 'org-1', orgName: 'Example Org', subscriptionType: 'team',
  apiKeySource: null, configDirectory: '/cfg',
};
const SIGNED_OUT = {
  loggedIn: false, authMethod: 'none', apiProvider: 'firstParty',
  email: null, orgId: null, orgName: null, subscriptionType: null, apiKeySource: null, configDirectory: '/cfg',
};
const API_KEY = { ...SIGNED_OUT, loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' };
const snap = (state, extra = {}) => ({ state, url: null, error: null, startedAt: 1, endedAt: null, ...extra });

const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 2)); };

// A test that leaves a flow active leaves its poll chain running; ending the
// flow on the scripted server stops it, so the file can exit.
let endFlow = null;
afterEach(async () => {
  endFlow?.();
  endFlow = null;
  await settle();
});

// `status` answers GET status (an Error → 500 {error}; a function is called per
// request and may return a promise); `login` is the list of
// snapshots GET login answers in turn (the last repeats); `post` maps a POST
// path to the snapshot it answers.
async function setup({ status = SIGNED_IN, login = [snap('idle')], post = {}, opts = {} } = {}) {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  window.document.body.innerHTML = CLAUDE_LOGIN_MARKUP;
  const calls = [];
  const queue = [...login];
  // While `holding`, a GET login stays pending until the test releases it.
  let holding = false;
  const held = [];
  const reply = (code, body) => ({ ok: code < 400, status: code, json: async () => structuredClone(body) });
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (url === '/api/claude-auth/status') {
      // A function answers each request in turn, possibly with a held promise.
      if (typeof status === 'function') return reply(200, await status());
      return status instanceof Error ? reply(500, { error: status.message }) : reply(200, status);
    }
    if (url === '/api/claude-auth/login' && method === 'GET') {
      if (holding) return new Promise(resolve => held.push((body) => resolve(reply(200, body))));
      return reply(200, queue.length > 1 ? queue.shift() : queue[0]);
    }
    if (method === 'POST' && post[url]) {
      const r = post[url];
      return r instanceof Error ? reply(409, { error: r.message }) : reply(200, r);
    }
    return reply(404, { error: 'unexpected' });
  };
  const { installClaudeAuth } = await freshImport();
  const ui = installClaudeAuth({ pollMs: 1, ...opts });
  const $ = (id) => window.document.getElementById(id);
  const count = (url, method = 'GET') => calls.filter(c => c.url === url && c.method === method).length;
  endFlow = () => { queue.splice(0, queue.length, snap('cancelled', { endedAt: 3 })); };
  return {
    window, ui, calls, $, count, held,
    setLogin: (list) => { queue.splice(0, queue.length, ...list); },
    hold: (on) => { holding = on; },
  };
}

const click = (el, window) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

test('signed in: identity, plan and method shown; the button reads "Re-log in"; an idle flow stays hidden', async () => {
  const { ui, $ } = await setup({ status: SIGNED_IN });
  await ui.load();
  const text = $('ca-status').textContent;
  assert.match(text, /^Signed in/);
  for (const part of ['user@example.com', 'Example Org', 'Team plan', 'Claude subscription', 'Credentials: /cfg']) {
    assert.ok(text.includes(part), `${part} in ${text}`);
  }
  assert.equal($('ca-login').textContent, 'Re-log in');
  assert.equal($('ca-flow').hidden, true);
});

test('signed in with null identity fields: they are skipped, not printed as "null"', async () => {
  const { ui, $ } = await setup({ status: { ...SIGNED_IN, email: null, orgName: null } });
  await ui.load();
  const text = $('ca-status').textContent;
  assert.ok(!text.includes('null'), text);
  assert.ok(text.includes('Team plan'), text);
});

test('signed out: "Not signed in" and a "Log in" button', async () => {
  const { ui, $ } = await setup({ status: SIGNED_OUT });
  await ui.load();
  assert.match($('ca-status').textContent, /^Not signed in/);
  assert.equal($('ca-login').textContent, 'Log in');
});

test('an API key: says so, names its source, and notes a login here will not change it', async () => {
  const { ui, $ } = await setup({ status: API_KEY });
  await ui.load();
  const text = $('ca-status').textContent;
  assert.match(text, /^Using an API key/);
  assert.ok(text.includes('ANTHROPIC_API_KEY'), text);
  assert.ok(text.includes("a login here won't change that"), text);
});

test('a status fetch failure shows the error, never "Not signed in"', async () => {
  const { ui, $ } = await setup({ status: new Error('claude CLI could not be started (claude): ENOENT') });
  await ui.load();
  const text = $('ca-status').textContent;
  assert.ok(text.includes('ENOENT'), text);
  assert.ok(!text.includes('Not signed in'), text);
});

test('Log in POSTs the start, then the polled awaiting_code shows the URL as a new-tab link and a copyable field', async () => {
  const { window, ui, $, count, setLogin } = await setup({
    status: SIGNED_OUT,
    post: { '/api/claude-auth/login': snap('starting') },
  });
  await ui.load();
  setLogin([snap('awaiting_code', { url: URL_ })]);
  click($('ca-login'), window);
  await settle();
  assert.equal(count('/api/claude-auth/login', 'POST'), 1);
  assert.equal($('ca-flow').hidden, false);
  assert.equal($('ca-await').hidden, false);
  assert.equal($('ca-url').getAttribute('href'), URL_);
  assert.equal($('ca-url').getAttribute('target'), '_blank');
  assert.ok($('ca-url').getAttribute('rel').split(/\s+/).includes('noopener'));
  assert.equal($('ca-url-text').value, URL_);
  assert.equal($('ca-code').disabled, false);
  assert.equal($('ca-login').disabled, true, 'no second start while active');
  assert.equal($('ca-cancel').hidden, false);
});

test('Submit POSTs the trimmed code; an awaiting_code snapshot with an error shows it and keeps the input', async () => {
  const { window, ui, $, calls, setLogin } = await setup({
    login: [snap('awaiting_code', { url: URL_ })],
    post: { '/api/claude-auth/login/code': snap('verifying', { url: URL_ }) },
  });
  await ui.load();
  $('ca-code').value = '  abc#STATE  ';
  setLogin([snap('awaiting_code', { url: URL_, error: 'Invalid code. Please make sure the full code was copied.' })]);
  click($('ca-submit'), window);
  await settle();
  const posts = calls.filter(c => c.url === '/api/claude-auth/login/code');
  assert.deepEqual(posts.map(c => c.body), [{ code: 'abc#STATE' }]);
  assert.equal($('ca-flow-msg').textContent, 'Invalid code. Please make sure the full code was copied.');
  assert.equal($('ca-code').disabled, false);
  assert.equal($('ca-code').value, '  abc#STATE  ');
});

test('Enter in the code field submits it', async () => {
  const { window, ui, $, calls } = await setup({
    login: [snap('awaiting_code', { url: URL_ })],
    post: { '/api/claude-auth/login/code': snap('verifying', { url: URL_ }) },
  });
  await ui.load();
  $('ca-code').value = 'abc#STATE';
  $('ca-code').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle(3);
  assert.deepEqual(calls.filter(c => c.url === '/api/claude-auth/login/code').map(c => c.body), [{ code: 'abc#STATE' }]);
});

test('verifying disables the code input; succeeded re-fetches the status, says so, and stops polling', async () => {
  const { ui, $, count, setLogin } = await setup({ status: SIGNED_OUT, login: [snap('verifying', { url: URL_ })] });
  await ui.load();
  assert.equal($('ca-code').disabled, true);
  assert.equal($('ca-submit').disabled, true);
  assert.equal($('ca-flow-msg').textContent, 'Verifying…');
  const statusBefore = count('/api/claude-auth/status');
  setLogin([snap('succeeded', { url: URL_, endedAt: 2 })]);
  await settle();
  assert.equal($('ca-flow-msg').textContent, 'Signed in.');
  assert.equal($('ca-flow').hidden, false, 'the outcome stays on screen');
  assert.equal($('ca-cancel').hidden, true);
  assert.equal($('ca-login').disabled, false);
  assert.equal(count('/api/claude-auth/status'), statusBefore + 1);
  const polls = count('/api/claude-auth/login');
  await settle();
  assert.equal(count('/api/claude-auth/login'), polls, 'no poll after the terminal state');
});

test('failed shows the CLI\'s error, re-enables Log in, and stops polling', async () => {
  const { ui, $, count, setLogin } = await setup({ login: [snap('verifying', { url: URL_ })] });
  await ui.load();
  setLogin([snap('failed', { error: 'Login failed: Request failed with status code 400', endedAt: 2 })]);
  await settle();
  assert.equal($('ca-flow-msg').textContent, 'Login failed: Request failed with status code 400');
  assert.equal($('ca-login').disabled, false);
  const polls = count('/api/claude-auth/login');
  await settle();
  assert.equal(count('/api/claude-auth/login'), polls);
});

test('Cancel POSTs the cancel and shows the cancelled state', async () => {
  const { window, ui, $, count } = await setup({
    login: [snap('awaiting_code', { url: URL_ })],
    post: { '/api/claude-auth/login/cancel': snap('cancelled', { url: URL_, endedAt: 2 }) },
  });
  await ui.load();
  click($('ca-cancel'), window);
  await settle(3);
  assert.equal(count('/api/claude-auth/login/cancel', 'POST'), 1);
  assert.equal($('ca-flow-msg').textContent, 'Login cancelled.');
  assert.equal($('ca-await').hidden, true);
  assert.equal($('ca-login').disabled, false);
});

test('load() with a flow already active on the server shows it and resumes polling (a reopened tab)', async () => {
  const { ui, $, count } = await setup({ login: [snap('awaiting_code', { url: URL_ })] });
  await ui.load();
  assert.equal($('ca-flow').hidden, false);
  assert.equal($('ca-url-text').value, URL_);
  const after = count('/api/claude-auth/login');
  await settle();
  assert.ok(count('/api/claude-auth/login') > after, 'polling resumed');
});

test('load() with a flow that already ended earlier keeps the panel hidden', async () => {
  const { ui, $ } = await setup({ login: [snap('succeeded', { endedAt: 2 })] });
  await ui.load();
  assert.equal($('ca-flow').hidden, true);
});

test('a refused start shows the server\'s error', async () => {
  const { window, ui, $ } = await setup({ post: { '/api/claude-auth/login': new Error('a Claude login is already in progress') } });
  await ui.load();
  click($('ca-login'), window);
  await settle(3);
  assert.equal($('ca-flow').hidden, false);
  assert.equal($('ca-flow-msg').textContent, 'a Claude login is already in progress');
});

test('reopening: a code typed into a cancelled flow is cleared when a new login starts', async () => {
  const { window, ui, $, calls, setLogin } = await setup({
    login: [snap('awaiting_code', { url: URL_ })],
    post: {
      '/api/claude-auth/login/cancel': snap('cancelled', { url: URL_, endedAt: 2 }),
      '/api/claude-auth/login': snap('starting'),
      '/api/claude-auth/login/code': snap('verifying', { url: URL_ }),
    },
  });
  await ui.load();
  $('ca-code').value = 'stale#STATE';
  click($('ca-cancel'), window);
  await settle(3);
  setLogin([snap('awaiting_code', { url: URL_ })]);
  click($('ca-login'), window);
  await settle();
  assert.equal($('ca-code').value, '');
  $('ca-code').value = 'fresh#STATE';
  click($('ca-submit'), window);
  await settle(3);
  assert.deepEqual(calls.filter(c => c.url === '/api/claude-auth/login/code').map(c => c.body), [{ code: 'fresh#STATE' }]);
});

test('a poll still in flight when Cancel lands is dropped: no re-enabled input, no restarted polling', async () => {
  const { window, ui, $, count, held, hold } = await setup({
    login: [snap('awaiting_code', { url: URL_ })],
    post: { '/api/claude-auth/login/cancel': snap('cancelled', { url: URL_, endedAt: 2 }) },
  });
  await ui.load();
  hold(true);
  await settle(3);
  assert.equal(held.length, 1, 'one poll in flight');
  click($('ca-cancel'), window);
  await settle(3);
  assert.equal($('ca-flow-msg').textContent, 'Login cancelled.');
  held[0](snap('awaiting_code', { url: URL_ }));
  await settle();
  assert.equal($('ca-code').disabled, true);
  assert.equal($('ca-cancel').hidden, true);
  assert.equal($('ca-flow-msg').textContent, 'Login cancelled.');
  const polls = count('/api/claude-auth/login');
  await settle();
  assert.equal(count('/api/claude-auth/login'), polls, 'polling stays stopped');
});

test('a poll in flight when the flow ends is dropped', async () => {
  const { ui, $, held, hold, setLogin } = await setup({ login: [snap('verifying', { url: URL_ })] });
  await ui.load();
  hold(true);
  await settle(3);
  assert.equal(held.length, 1);
  hold(false);
  setLogin([snap('failed', { error: 'Login failed: Request failed with status code 400', endedAt: 2 })]);
  await ui.load();
  held[0](snap('verifying', { url: URL_ }));
  await settle();
  assert.equal($('ca-login').disabled, false, 'the stale verifying snapshot did not re-disable Log in');
});

test('a start refused because another tab\'s flow is running surfaces that flow, cancellable and polled', async () => {
  const { window, ui, $, count } = await setup({
    login: [snap('idle'), snap('awaiting_code', { url: URL_ })],
    post: { '/api/claude-auth/login': new Error('a Claude login is already in progress') },
  });
  await ui.load();
  assert.equal($('ca-flow').hidden, true);
  click($('ca-login'), window);
  await settle(3);
  assert.equal($('ca-flow').hidden, false);
  assert.equal($('ca-cancel').hidden, false, 'the running flow can be cancelled');
  assert.equal($('ca-await').hidden, false);
  assert.equal($('ca-url-text').value, URL_);
  assert.equal($('ca-flow-msg').textContent, 'a Claude login is already in progress');
  const polls = count('/api/claude-auth/login');
  await settle();
  assert.ok(count('/api/claude-auth/login') > polls, 'polling the surfaced flow');
});

test('onLoginSuccess fires once when a watched flow succeeds', async () => {
  let n = 0;
  const { ui, setLogin } = await setup({ login: [snap('verifying', { url: URL_ })], opts: { onLoginSuccess: () => { n++; } } });
  await ui.load();
  setLogin([snap('succeeded', { url: URL_, endedAt: 2 })]);
  await settle();
  assert.equal(n, 1);
  await ui.load();
  assert.equal(n, 1, 'reloading the finished flow is not a second success');
});

test('onLoginSuccess does not fire for a flow that had already succeeded before load()', async () => {
  let n = 0;
  const { ui } = await setup({ login: [snap('succeeded', { endedAt: 2 })], opts: { onLoginSuccess: () => { n++; } } });
  await ui.load();
  await settle();
  assert.equal(n, 0);
});

test('a start refused while another tab\'s flow is verifying keeps the refusal on screen', async () => {
  const { window, ui, $ } = await setup({
    login: [snap('idle'), snap('verifying', { url: URL_ })],
    post: { '/api/claude-auth/login': new Error('a Claude login is already in progress') },
  });
  await ui.load();
  click($('ca-login'), window);
  await settle();
  assert.equal($('ca-cancel').hidden, false, 'the running flow is shown');
  assert.equal($('ca-flow-msg').textContent, 'a Claude login is already in progress');
});

test('overlapping loads: an older status answer landing last does not repaint the previous account', async () => {
  const releases = [];
  const answers = [{ ...SIGNED_IN, email: 'old@example.com' }, { ...SIGNED_IN, email: 'new@example.com' }];
  let n = 0;
  const { ui, $ } = await setup({
    status: () => { const i = n++; return i === 0 ? new Promise(r => releases.push(() => r(answers[0]))) : answers[i] ?? answers[1]; },
  });
  const first = ui.load();
  await settle(3);
  await ui.load();
  assert.ok($('ca-status').textContent.includes('new@example.com'));
  releases[0]();
  await first;
  await settle(3);
  const text = $('ca-status').textContent;
  assert.ok(text.includes('new@example.com') && !text.includes('old@example.com'), text);
});

test('overlapping loads: an older status FAILURE landing last does not overwrite the newer state', async () => {
  const fails = [];
  let n = 0;
  const { ui, $ } = await setup({
    status: () => (n++ === 0 ? new Promise((_, reject) => fails.push(reject)) : SIGNED_IN),
  });
  const first = ui.load();
  await settle(3);
  await ui.load();
  fails[0](new Error('boom'));
  await first;
  await settle(3);
  assert.match($('ca-status').textContent, /^Signed in/);
});
