#!/usr/bin/env node
// Fake `claude` CLI for integration tests.
//
// Honors a subset of the real CLI's argv: --session-id, --resume,
// --permission-mode (plus any other flag — ignored). Reads stdin line by line
// expecting Claude Code stream-json input format. Emits canned events from a
// scenario JSON file pointed at by FAKE_CLAUDE_SCENARIO.
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
//   FAKE_CLAUDE_INIT_DELAY  ms to wait before emitting startup events

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

const args = parseArgv(process.argv.slice(2));
if (process.env.FAKE_CLAUDE_ARGV_DUMP) {
  // Synchronous so tests can read it immediately after detecting `idle`.
  writeFileSync(process.env.FAKE_CLAUDE_ARGV_DUMP, process.argv.slice(2).join('\n') + '\n');
}
// Optional env dump — used by tests that need to assert which env vars the
// orchestrator did (or did not) pass to the subprocess.
if (process.env.FAKE_CLAUDE_ENV_DUMP) {
  writeFileSync(
    process.env.FAKE_CLAUDE_ENV_DUMP,
    Object.entries(process.env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n',
  );
}
const SID = args.resumeId ?? args.sessionId ?? '00000000-0000-0000-0000-000000000000';
const MODE = args.mode;
const CWD = process.cwd();

const scenarioPath = process.env.FAKE_CLAUDE_SCENARIO;
if (!scenarioPath) {
  console.error('fake-claude: FAKE_CLAUDE_SCENARIO env var required');
  process.exit(2);
}

const scenario = JSON.parse(await fs.readFile(scenarioPath, 'utf8'));
const turns = [...(scenario.turns ?? [])];

const transcriptPath = process.env.FAKE_CLAUDE_TRANSCRIPT;
let transcriptHandle = null;
if (transcriptPath) transcriptHandle = await fs.open(transcriptPath, 'a');

function substitute(obj) {
  if (typeof obj === 'string') {
    // Whole-string sentinels keep working for backwards compat, but we
    // also do substring replacement so placeholders inside an
    // `input_json_delta` partial_json (which is itself a JSON-string)
    // get resolved.
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
      .replaceAll('$PLANFILE', process.env.FAKE_PLAN_FILE ?? '');
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
  process.stdout.write(JSON.stringify(substitute(event)) + '\n');
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
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
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
});

rl.on('close', async () => {
  if (transcriptHandle) await transcriptHandle.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  rl.close();
});
