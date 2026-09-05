// Shared harness for the gated CLI-contract suites
// (tests/systems-cli-*.real.test.mjs). Skipped by default — opt in with
// `RUN_CLI_CONTRACT=1`.
//
// SPLIT ACROSS FILES ON PURPOSE. Every case here is a real `claude` run costing
// 6-26s, so one file was charged their SUM and crossed the hang guard's
// per-file deadline; separate files are charged the MAX (see the reasoning in
// tests/hangGuardConfig.mjs — the answer to a file over the deadline is more
// files, not a later deadline). This module is what keeps the two from drifting
// into two different ideas of how cc launches the CLI.
//
// Redirecting a worker to another system rests entirely on undocumented Claude
// Code behaviour. Nothing in the ordinary suite can notice if a CLI upgrade
// changes any of it, and every failure mode is silent and destructive — which is
// what each case's own header names.
//
// Two rules every case here follows:
//   * Assert over a MECHANICAL channel wherever one exists — a hook envelope,
//     the `system`/`init` frame's tool list, a file on disk — never the model's
//     prose. The model was measured reporting "the background task completed"
//     instead of relaying the path it was asked for.
//   * Every lever gets a CONTROL run without it. A RENAMED key would otherwise
//     leave the with-lever assertion passing for the wrong reason while cc's own
//     scan silently stopped finding the live one.

import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp } from './tmpRegistry.mjs';
import { rmrf } from './rmrf.mjs';

const ENABLED = process.env.RUN_CLI_CONTRACT === '1';
// Every case in every file of this family is registered through this, so the
// gate is stated once.
export const t = ENABLED ? test : test.skip.bind(test);
const MODEL = 'claude-haiku-4-5';
const RUN_TIMEOUT_MS = 180_000;

// A hook endpoint shaped exactly like cc's: one URL, both events, discriminated
// by `hook_event_name`. `reply(envelope)` returns the response body.
export async function hookServer(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let envelope = {};
      try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* record it anyway */ }
      seen.push(envelope);
      const body = (await reply(envelope)) ?? {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    seen,
    url: `http://127.0.0.1:${server.address().port}/hook`,
    close: () => new Promise((r) => server.close(r)),
    of: (event, tool) => seen.filter(e => e.hook_event_name === event && e.tool_name === tool),
  };
}

export function settingsJSON(url, { pre, post = [], deny, extra }) {
  const hooks = [{ type: 'http', url, timeout: 60 }];
  const out = { hooks: { PreToolUse: [{ matcher: pre.join('|'), hooks }] } };
  if (post.length) out.hooks.PostToolUse = [{ matcher: post.join('|'), hooks }];
  if (deny) out.permissions = { deny };
  return JSON.stringify({ ...out, ...extra });
}

// THE CHILD'S ENV, and the one thing this family changes about it: a session
// that repoints `ANTHROPIC_BASE_URL` at another backend cannot run these cases
// at all. Measured (card 2026-0321 §1f): every model reachable over such a
// proxy drove 0 of the four rewrite assertions, one of them completing green
// with `is_error:false` having never called the tool. So when — and ONLY when —
// a base URL is set, the child is launched off the host's STORED credentials
// instead.
//
// The three keys are the measured minimal-and-sufficient set: dropping the base
// URL alone leaves the proxy's key in place and yields a 401. Gating the whole
// scrub on the base URL is what makes this a no-op BY CONSTRUCTION on an
// ordinary host — an unconditional scrub was measured taking a host
// authenticated solely by `ANTHROPIC_API_KEY` (a configuration cc supports —
// src/health.ts reads that key) from passing to 401 (card 2026-0321 §1i).
//
// `ANTHROPIC_DEFAULT_HAIKU_MODEL` is deliberately NOT scrubbed: at CLI 2.1.258,
// the one version this was measured against, an explicit `--model` is not
// subject to the alias remap, so it diverts only the CLI's session-title
// subquery, which logs one cosmetic `unrecognized_model` line. Chasing that
// line is a dead end (card 2026-0321 §1b). That is a THIRD-PARTY invariant at a
// single version and NO TEST PINS IT, so a release that started honouring the
// alias for an explicit `--model` would surface either as a misleading gated
// failure or not at all, while silently re-breaking a remapped reviewer.
// Re-take it before trusting it on a newer CLI.
//
// ORDER MATTERS: `extra` spreads LAST, so a per-call `env` naming one of the
// three puts it straight back. That is deliberate — a case stating one of these
// explicitly means it, and beats a session-level scrub — but it is also how an
// editor opts out of this helper without noticing. No caller does today.
//
// ACCEPTED RESIDUAL (card 2026-0321 §2): a host whose ONLY route to a capable
// model is that proxy — base URL set, no first-party credentials — goes from a
// couple of passing cases to a legible 401. Those passes were not worth what
// they looked like; §1f is why.
//
// HARNESS-ONLY. cc's production spawn path scrubs nothing and shares none of
// this: `grep -rn cliEnv src/` is empty.
export function cliEnv(extra) {
  const env = { ...process.env };
  if (process.env.ANTHROPIC_BASE_URL) {
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return { ...env, ...extra };
}

// THE ONE DISCRIMINATOR that separates a CLI which never reached the API from
// one that ran. Keyed on `api_error_status` and on NOTHING ELSE.
//
// The two fields an editor reaches for first both lie about it — measured on
// the four frames committed under tests/fixtures/ (card 2026-0321 §1e), and
// pinned by the cases `a healthy frame and a 404 frame are indistinguishable by
// subtype` and `an interrupted turn is NOT an api error, though is_error is
// true`:
//   * `subtype` reads "success" on the healthy frame AND on the 404 frame.
//   * `is_error` reads true on a legitimate INTERRUPT — the stimulus the case
//     `an interrupt kills the forwarder and aborts its in-flight request`
//     depends on succeeding, so an `is_error` guard would turn that green case
//     red.
//
// `terminal_reason` is the third candidate, and on all four captured frames it
// is EXTENSIONALLY IDENTICAL to this one — so no fixture can say which key is
// being read. The case `the diagnosis reads api_error_status, not
// terminal_reason` is what pins the choice, and it has to build its frames to
// do it.
//
// `result` may be absent entirely (the interrupt frame carries no such key), so
// the CLI's own words are relayed only when it said any.
export function apiErrorReason(frame) {
  const status = frame?.api_error_status;
  if (status == null) return null;
  const said = typeof frame.result === 'string' ? frame.result : '';
  return `the CLI never reached the API (api_error_status ${status})${said ? `: ${said}` : ''}`;
}

export function runClaudeEnv(cwd, settings, prompt, env) {
  return new Promise((resolve, reject) => {
    execFile('claude', claudeArgs(settings, prompt, ['--output-format', 'json']),
      { cwd, env: cliEnv(env), timeout: RUN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) { reject(err); return; }
        let frame;
        try { frame = JSON.parse(stdout); } catch { reject(new Error(`unparseable CLI output: ${stdout.slice(0, 500)}`)); return; }
        const why = apiErrorReason(frame);
        if (why) { reject(new Error(why)); return; }
        resolve(frame);
      });
  });
}

// cc's OWN launch flags, including `--permission-prompt-tool stdio`. The
// headless tool profile depends on them — that flag is what un-strips the
// interactive tools — so a probe run without them is measuring a different
// session than the one cc ships.
export function claudeArgs(settings, prompt, format) {
  return [
    '-p', '--model', MODEL, ...format,
    '--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions',
    '--permission-prompt-tool', 'stdio',
    '--settings', settings, prompt,
  ];
}

export function runClaude(cwd, settings, prompt) {
  return new Promise((resolve, reject) => {
    execFile('claude', claudeArgs(settings, prompt, ['--output-format', 'json']),
      { cwd, env: cliEnv(), timeout: RUN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) { reject(err); return; }
        let frame;
        try { frame = JSON.parse(stdout); } catch { reject(new Error(`unparseable CLI output: ${stdout.slice(0, 500)}`)); return; }
        const why = apiErrorReason(frame);
        if (why) { reject(new Error(why)); return; }
        resolve(frame);
      });
  });
}

// The `system`/`init` frame's own `tools` list — what the session actually has,
// stated by the CLI rather than inferred from what a model chose to reach for.
//
// DELIBERATELY UNGUARDED by apiErrorReason, unlike the two above. The one case
// it serves today — `a cc-shaped session can reach neither Glob nor Grep` —
// resolves off the `system`/`init` frame, which the CLI emits BEFORE it calls
// the API, and was measured passing truthfully under a 404 (card 2026-0321
// §1g). The rule: guard a launch helper whose cases need the API to answer;
// leave unguarded one whose every case is pre-API. Guarding here would make an
// always-truthful case always-red.
export function toolRegistry(cwd, settings) {
  return new Promise((resolve, reject) => {
    execFile('claude', claudeArgs(settings, 'Reply with the single word OK.', ['--output-format', 'stream-json', '--verbose']),
      { cwd, env: cliEnv(), timeout: RUN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) { reject(err); return; }
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          let f; try { f = JSON.parse(line); } catch { continue; }
          if (f.type === 'system' && f.subtype === 'init' && Array.isArray(f.tools)) { resolve(f.tools); return; }
        }
        reject(new Error(`no system/init frame with a tool list: ${stdout.slice(0, 500)}`));
      });
  });
}

// A plain command in a directory — the git fixture below is the only user.
export function run(argv, cwd) {
  return new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), { cwd }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export async function fixture() {
  const dir = await fs.realpath(await mkdtemp('cc-cli-contract-'));
  return { dir, clean: () => rmrf(dir) };
}

export const allow = (updatedInput) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'allow',
    ...(updatedInput ? { updatedInput } : {}),
  },
});


// The server side of `POST /api/instances/:id/bash-forward`, shaped exactly
// like src/routes.ts's — same NDJSON framing, and the same `close` predicate,
// `!res.writableEnded`, which is the ONE thing under test here: it is what
// tells a client disconnect (cc's cancellation signal) from a normal end.
//
// It keeps writing `{t:'out'}` frames until `finish()` is called, so a test can
// prove the socket is still WRITABLE rather than merely un-closed — a negative
// that only says "no close event fired" would also pass against a half-dead
// connection.
export async function forwardServer({ frameMs = 500 } = {}) {
  const state = { postAt: 0, closeAt: 0, closeWasAbort: null, writes: 0, command: null };
  let finish = () => {};
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      state.postAt = Date.now();
      try { state.command = JSON.parse(Buffer.concat(chunks).toString('utf8')).command; } catch { /* recorded as null */ }
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      res.flushHeaders();
      res.on('close', () => {
        state.closeAt = Date.now();
        state.closeWasAbort = !res.writableEnded;
      });
      const timer = setInterval(() => {
        if (res.writableEnded || res.destroyed) return;
        res.write(`${JSON.stringify({ t: 'out', text: 'tick\n' })}\n`);
        state.writes++;
      }, frameMs);
      timer.unref();
      finish = (code = 0) => {
        clearInterval(timer);
        if (!res.writableEnded && !res.destroyed) res.end(`${JSON.stringify({ t: 'exit', code })}\n`);
      };
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}/api/instances/probe/bash-forward`,
    finish: (code) => finish(code),
    // closeAllConnections first: an open streamed response holds `close()` open
    // forever, which is exactly the state most of these cases end in.
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}

// A LIVE stream-json session, not a one-shot: the cases below have to send a
// second prompt or a control_request while the first turn is still running, and
// they must not have the CLI exit underneath them and kill the forwarder for an
// unrelated reason. stdin is left OPEN for exactly that reason.
//
// THE WHOLE DELTA FROM claudeArgs ABOVE, enumerated because keeping every
// case's launch from drifting is this module's job.
// `--output-format=stream-json` and the `--verbose` that goes with it are
// claudeArgs's `format` parameter, fixed here rather than passed.
// `--input-format=stream-json` opens the input channel, and
// `--include-hook-events` is a flag cc passes (src/instances.ts) that
// claudeArgs omits. Everything else is claudeArgs's set unchanged: `-p`, the
// model, `--permission-mode`, `--allow-dangerously-skip-permissions`,
// `--permission-prompt-tool stdio`, `--settings`. The prompt is NOT an argv
// element here — it goes over stdin, which is what lets a case send a second
// one.
export function claudeSession({ cwd, settings }) {
  const child = spawn('claude', [
    '-p', '--model', MODEL,
    '--input-format=stream-json', '--output-format=stream-json', '--verbose',
    '--include-hook-events',
    '--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions',
    '--permission-prompt-tool', 'stdio',
    '--settings', settings,
  ], { cwd, env: cliEnv(), stdio: ['pipe', 'pipe', 'pipe'] });

  const events = [];
  const waiters = [];
  // A CLI that could not reach the API emits its error `result` frame in well
  // under a second and then STAYS ALIVE: stdin is held open on purpose here, so
  // nothing exits and no watcher on the child's exit would fire. Left alone,
  // every bounded wait below runs to its own full length and their SUM crosses
  // the hang guard's per-file deadline — measured as a 90s SIGKILL with a
  // leaked process and the file reporting nothing at all (card 2026-0321 §1d,
  // §1k). Recording the diagnosis and failing every waiter with it turns that
  // into an immediate, truthful red.
  let apiError = null;
  let pending = '';
  child.stdout.on('data', (b) => {
    pending += b;
    let nl;
    while ((nl = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (!line.trim()) continue;
      let f;
      try { f = JSON.parse(line); } catch { continue; }
      events.push(f);
      if (f.type === 'result' && !apiError) {
        apiError = apiErrorReason(f);
        if (apiError) for (const w of waiters.splice(0)) w.reject(new Error(apiError));
      }
      for (const w of waiters.slice()) {
        if (!w.match(f)) continue;
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(f);
      }
    }
  });
  const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);

  return {
    events,
    // For a case polling something OTHER than a frame — cc's forwarder state,
    // say — which the rejection above cannot reach.
    get apiError() { return apiError; },
    prompt: (text) => send({
      type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null,
    }),
    // cc's real interrupt channel (src/instances.ts `_controlRequest`).
    interrupt: () => send({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } }),
    waitFor: (match, ms) => new Promise((resolve, reject) => {
      if (apiError) { reject(new Error(apiError)); return; }
      for (const f of events) if (match(f)) { resolve(f); return; }
      const w = { match, resolve, reject };
      waiters.push(w);
      setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i < 0) return;
        waiters.splice(i, 1);
        reject(new Error('timed out waiting for a CLI event'));
      }, ms).unref();
    }),
    // MUST run in a finally: this session outlives its turn by design, so
    // nothing else ends it.
    kill: () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } },
  };
}
