// Scenario engine for the fake `claude` CLI used by integration tests.
//
// This is the SINGLE SOURCE OF TRUTH for the fake's stream-json protocol. Two
// callers drive it:
//   - tests/fake-claude.mjs         — a thin subprocess entrypoint (real OS
//                                     process; opt-in `realProcess:true` tests)
//   - tests/inProcessLauncher.mjs   — runs it on the event loop, no OS process
//                                     (the default for bootServer)
//
// Everything the old subprocess read from globals is now a parameter, so the
// engine behaves identically whether it owns `process.*` or is handed in-memory
// streams: argv (was process.argv.slice(2)), cwd (was process.cwd()), env (was
// process.env), and the three stdio streams.
//
// Honors a subset of the real CLI's argv: --session-id, --resume,
// --permission-mode (any other flag is ignored). Reads stdin line by line
// expecting Claude Code stream-json input. Emits canned events from a scenario
// JSON file pointed at by env.FAKE_CLAUDE_SCENARIO.
//
// Scenario shape:
//   {
//     "events": [ <events emitted on startup> ],
//     "turns":  [ { "on": {"type":"prompt" | "control", "subtype"?: string},
//                   "emit": [<events>],
//                   "delay_ms"?: number } ]
//   }
//
// Inbound control_request messages always get a synthetic control_response
// (success) emitted automatically — the scenario can layer on additional
// events for the same input (e.g. a `result` after `interrupt`).
//
// Optional env vars:
//   FAKE_CLAUDE_TRANSCRIPT  Path to append every received stdin line to
//   FAKE_CLAUDE_ARGV_DUMP   Path to write the received argv to (one per line)
//   FAKE_CLAUDE_ENV_DUMP    Path to write the received env to (k=v per line)

import { promises as fs, writeFileSync } from 'node:fs';
import readline from 'node:readline';

function parseArgv(argv) {
  const out = { sessionId: null, resumeId: null, mode: 'default', otherFlags: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--session-id') out.sessionId = next();
    else if (a === '--resume') out.resumeId = next();
    else if (a === '--permission-mode') out.mode = next();
    else out.otherFlags.push(a);
  }
  return out;
}

// Run the fake-claude scenario engine to completion.
//   argv          the CLI flags (already sliced — no node/script prefix)
//   env           the environment map (FAKE_CLAUDE_* + FAKE_PLAN_FILE read here)
//   cwd           the launch cwd (used for the $CWD substitution)
//   stdin         Readable — user stream-json lines
//   stdout/stderr Writable — event output / diagnostics
//   onReaderReady optional (closeReader) => void callback, handed a function
//                 that closes the stdin reader (the SIGTERM / graceful-stop hook)
// Resolves with the exit code once stdin closes AND all in-flight (possibly
// delayed) emits have flushed — so a trailing turn_end is never truncated.
export async function runFakeClaude({ argv, env, cwd, stdin, stdout, stderr, onReaderReady } = {}) {
  const args = parseArgv(argv ?? []);

  if (env.FAKE_CLAUDE_ARGV_DUMP) {
    // Synchronous so tests can read it immediately after detecting `idle`.
    writeFileSync(env.FAKE_CLAUDE_ARGV_DUMP, (argv ?? []).join('\n') + '\n');
  }
  // Optional env dump — used by tests that need to assert which env vars the
  // orchestrator did (or did not) pass to the subprocess. Dumps the env HANDED
  // TO THIS LAUNCH (the computed child env), not the parent process.env, so the
  // assertions stay honest whether run in-process or as a real subprocess.
  if (env.FAKE_CLAUDE_ENV_DUMP) {
    writeFileSync(
      env.FAKE_CLAUDE_ENV_DUMP,
      Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n',
    );
  }

  const SID = args.resumeId ?? args.sessionId ?? '00000000-0000-0000-0000-000000000000';
  const MODE = args.mode;
  const CWD = cwd;

  const scenarioPath = env.FAKE_CLAUDE_SCENARIO;
  if (!scenarioPath) {
    stderr.write('fake-claude: FAKE_CLAUDE_SCENARIO env var required\n');
    return 2;
  }

  const scenario = JSON.parse(await fs.readFile(scenarioPath, 'utf8'));
  const turns = [...(scenario.turns ?? [])];

  const transcriptPath = env.FAKE_CLAUDE_TRANSCRIPT;
  let transcriptHandle = null;
  if (transcriptPath) transcriptHandle = await fs.open(transcriptPath, 'a');

  function substitute(obj) {
    if (typeof obj === 'string') {
      // The harness supports both whole-string sentinels and substring
      // replacement for convenience in existing tests. This allows
      // placeholders inside an `input_json_delta` partial_json (which is
      // itself a JSON-string) to get resolved.
      if (obj === '$SID') return SID;
      if (obj === '$CWD') return CWD;
      if (obj === '$MODE') return MODE;
      // `$NOWSEC` / `$NOWSEC+N` / `$NOWSEC-N` → a NUMBER (epoch seconds at emit
      // time, ± offset). Used for time-relative fields like a rate_limit_event's
      // resetsAt so tests don't race wall-clock between scenario build and emit.
      const nowsec = /^\$NOWSEC([+-]\d+)?$/.exec(obj);
      if (nowsec) return Math.floor(Date.now() / 1000) + (nowsec[1] ? parseInt(nowsec[1], 10) : 0);
      return obj
        .replaceAll('$SID', SID)
        .replaceAll('$CWD', CWD)
        .replaceAll('$MODE', MODE)
        .replaceAll('$PLANFILE', env.FAKE_PLAN_FILE ?? '');
    }
    if (Array.isArray(obj)) return obj.map(substitute);
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) out[k] = substitute(v);
      return out;
    }
    return obj;
  }

  function emit(event) {
    stdout.write(JSON.stringify(substitute(event)) + '\n');
  }

  async function emitMany(events, delay = 0) {
    for (const e of events) {
      emit(e);
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
    }
  }

  async function recordStdin(line) {
    if (!transcriptHandle) return;
    await transcriptHandle.write(line + '\n');
  }

  // Extract the plain text of a user (prompt) input so a turn can optionally
  // match only prompts whose text contains a given substring (`on.text`). Lets a
  // single shared scenario drive differentiated behavior across instances
  // (e.g. one worker trips overage while its conductor stays mid-turn).
  function userText(input) {
    const c = input?.message?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(p => (typeof p?.text === 'string' ? p.text : '')).join(' ');
    return '';
  }

  function matchTurn(input) {
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const on = t.on ?? {};
      if (on.type === 'prompt' && input.type === 'user') {
        // Optional substring filter — when absent the turn matches any prompt.
        if (on.text && !userText(input).includes(on.text)) continue;
        turns.splice(i, 1);
        return t;
      }
      if (on.type === 'control' && input.type === 'control_request') {
        const reqSub = input.request?.subtype;
        if (!on.subtype || on.subtype === reqSub) {
          turns.splice(i, 1);
          return t;
        }
      }
      if (on.type === 'control_response' && input.type === 'control_response') {
        const inner = input.response ?? {};
        // Filter by request_id if specified; behavior (allow/deny) routes via
        // different scenario steps if the user wants to model both branches.
        const idOk = !on.request_id || on.request_id === inner.request_id;
        const behaviorOk = !on.behavior || on.behavior === inner.response?.behavior;
        if (idOk && behaviorOk) {
          turns.splice(i, 1);
          return t;
        }
      }
    }
    return null;
  }

  // Match real claude: nothing is emitted on stdout until the first stdin line
  // is received. Startup events (`scenario.events`) are emitted alongside the
  // first turn's response.
  let startupEmitted = false;
  const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });

  // Hand the caller a way to close the reader (SIGTERM / graceful stop), mirroring
  // the old subprocess's `process.on('SIGTERM', () => rl.close())`.
  if (typeof onReaderReady === 'function') onReaderReady(() => rl.close());

  // Serialize line handlers so a delayed emitMany from one line can't interleave
  // with the next, and so `close` can await all in-flight work before resolving
  // — the old subprocess `process.exit(0)` on close could truncate a delayed
  // trailing event; awaiting the chain here fixes that for the in-process path.
  let chain = Promise.resolve();

  async function handleLine(line) {
    await recordStdin(line);
    let obj;
    try { obj = JSON.parse(line); }
    catch { return; }

    if (obj.type === 'keep_alive') return;

    if (!startupEmitted) {
      startupEmitted = true;
      await emitMany(scenario.events ?? []);
    }

    // Auto-ack inbound control_requests from the parent (set_permission_mode,
    // interrupt, etc.). control_responses are FROM the parent in response to a
    // control_request we (fake-claude) emitted via a scenario step — don't
    // ack those, they're routed to matchTurn instead.
    if (obj.type === 'control_request') {
      const ack = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: obj.request_id,
          response: obj.request?.subtype === 'set_permission_mode'
            ? { mode: obj.request.mode }
            : null,
        },
      };
      emit(ack);
    }

    const turn = matchTurn(obj);
    if (turn) await emitMany(turn.emit, turn.delay_ms ?? 0);
  }

  rl.on('line', (line) => { chain = chain.then(() => handleLine(line)); });

  await new Promise((resolve) => rl.once('close', resolve));
  await chain;
  if (transcriptHandle) await transcriptHandle.close();
  return 0;
}
