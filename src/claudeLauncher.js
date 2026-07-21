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

// Mirrors resolveClaudeBin's CLAUDE_BIN convention for the `ollama` command,
// so tests can point it at a fake script instead of a real ollama install.
function resolveOllamaBin() {
  const raw = (process.env.OLLAMA_BIN ?? 'ollama').trim();
  const parts = raw.split(/\s+/);
  return { command: parts[0], prefixArgs: parts.slice(1) };
}

// Backend-agnostic launch target: given a resolved claude binary and a
// {backendKind, model} pair, returns the {command, prefixArgs} to spawn as a
// drop-in for `claude` — the SAME claude args (including --model) are then
// appended uniformly by the caller.
//   claude  → the resolved claude binary + its prefixArgs (empty in prod; the
//             test CLAUDE_BIN="node fake.mjs" injection).
//   ollama  → `ollama launch claude --model <tag> --yes --`. ollama sets the
//             Anthropic endpoint + auth internally and re-injects --model into
//             the child; a caller-forwarded --model later in its own args is a
//             matching no-op (verified in tests/ollama-spawn.test.mjs). --yes
//             bypasses the non-agent-capable confirmation (else a piped spawn
//             fails). Localhost only — no host plumbing. `ollama` itself is
//             resolved via resolveOllamaBin() (OLLAMA_BIN test injection).
export function resolveBackendLaunch(backendKind, model, claudeBin) {
  if (backendKind === 'ollama') {
    // Invariant: an ollama-backed launch always has a concrete tag — never
    // emit `--model undefined`. Every caller (Instance.spawn(), generateSummary,
    // generateBundle) is expected to already have resolved a real tag before
    // reaching here; this is the shared, single place that guarantees it.
    if (!model) {
      throw new Error('ollama-backed spawn requires a model (tag); none resolved — rebind the tier or resume with an explicit model');
    }
    const { command, prefixArgs: ollamaPrefixArgs } = resolveOllamaBin();
    return { command, prefixArgs: [...ollamaPrefixArgs, 'launch', 'claude', '--model', model, '--yes', '--'] };
  }
  return { command: claudeBin.command, prefixArgs: claudeBin.prefixArgs };
}
