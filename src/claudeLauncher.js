import { spawn } from 'node:child_process';

// The single seam through which an Instance launches its `claude` subprocess.
// `launch({command,args,cwd,env})` returns a ChildProcess-like handle:
//   .pid, .stdin (Writable), .stdout/.stderr (Readable), .kill(signal?),
//   and EventEmitter 'exit'(code,signal) / 'close'(code,signal) / 'error'(err).
// Instance.spawn() treats the return value as opaque, so the production path
// (RealClaudeLauncher) hands back a raw ChildProcess with zero behavior change,
// while tests inject an in-process implementation that runs the fake-claude
// scenario engine on the event loop (no OS process — see tests/inProcessLauncher.mjs).
export class RealClaudeLauncher {
  launch({ command, args, cwd, env }) {
    return spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  }
}

// Production default. Injected at the composition root (createServer) only when a
// caller overrides it; omitting the option keeps this real launcher.
export const defaultClaudeLauncher = new RealClaudeLauncher();

// Lives here (not instances.js) so pure one-shot spawners — health.js's boot
// probe, summarize.js's summary generation, claudeShellEnv.js's bundle-gen —
// can depend on just the launch-resolution primitives without pulling in the
// whole Instance/InstanceManager module.
export function resolveClaudeBin() {
  // CLAUDE_BIN may be "node /path/to/script.mjs" so callers can swap in the
  // fake CLI used by tests; split on whitespace.
  const raw = (process.env.CLAUDE_BIN ?? 'claude').trim();
  const parts = raw.split(/\s+/);
  return { command: parts[0], prefixArgs: parts.slice(1) };
}

// THE substitution point. Given a resolved claude binary and a backend RECORD
// ({id,label,template,env} — see appSettings.getBackends), returns the
// {command, prefixArgs, env} to spawn as a drop-in for `claude`; the SAME claude
// args (including --model) are then appended uniformly by the caller.
//
//   empty template → the resolved claude binary + its prefixArgs (empty in prod;
//                    the test CLAUDE_BIN="node fake.mjs" injection).
//   a template     → the template's whitespace-split argv, with `{model}`
//                    substituted, token 0 as the command and the rest as the
//                    prefix. E.g. the built-in `ollama` row,
//                    `ollama launch claude --model {model} --yes --`: ollama sets
//                    the Anthropic endpoint + auth internally and re-injects
//                    --model into the child, so a caller-forwarded --model later
//                    in its own args is a matching no-op (verified in
//                    tests/backend-spawn.test.mjs); `--yes` bypasses the
//                    non-agent-capable confirmation (else a piped spawn fails);
//                    the trailing `--` terminates its own flags.
//
// `env` is the backend's user-configured key/value pairs, applied by callers
// BEFORE any cc-managed variable so cc-managed always wins.
export function resolveBackendLaunch(backend, model, claudeBin) {
  const template = typeof backend?.template === 'string' ? backend.template.trim() : '';
  const env = backendEnv(backend);
  if (!template) {
    return { command: claudeBin.command, prefixArgs: claudeBin.prefixArgs, env };
  }
  // Invariant: a template that names {model} always launches with a concrete
  // model — never emit `--model undefined`. Every caller (Instance.spawn(),
  // generateSummary, generateBundle) is expected to have resolved a real model
  // before reaching here; this is the shared, single place that guarantees it.
  if (template.includes('{model}') && !model) {
    throw new Error(`backend '${backend?.id ?? '?'}' requires a model; none resolved — rebind the tier or resume with an explicit model`);
  }
  // Substitute inside each token (not only whole tokens) so `--model={model}`
  // works as well as `--model {model}`.
  const tokens = template.split(/\s+/).filter(Boolean).map(t => t.replaceAll('{model}', model ?? ''));
  return { command: tokens[0], prefixArgs: tokens.slice(1), env };
}

// A backend's env pairs as a plain object, later keys winning. Returns {} for a
// backend with no env, so callers can spread it unconditionally.
export function backendEnv(backend) {
  const out = {};
  for (const e of Array.isArray(backend?.env) ? backend.env : []) {
    if (e && typeof e.key === 'string' && e.key) out[e.key] = String(e.value ?? '');
  }
  return out;
}
