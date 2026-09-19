// THE BASE ENVIRONMENT EVERY `claude` SUBPROCESS cc STARTS FROM.
//
// cc spawns the CLI from three places — a session (src/instances.ts), the
// one-shot summariser (src/summarize.ts) and the shell-env probe
// (src/claudeShellEnv.ts) — and every one of them begins `{ ...process.env }`,
// copying the host environment wholesale (card 2026-0384). A variable the
// operator happens to have exported therefore reaches the CLI unless something
// removes it, and the three sites had three different ideas of which ones to
// remove.

// Host variables that must never reach a cc-spawned CLI.
//
// The three context ones: cc resolves a session's context window from its
// {backend, model} and sets these itself where they apply, so an ambient value
// would silently downgrade a 1M session to 200k. They are deleted BEFORE the
// per-session blocks so those always win.
//
// `CLAUDE_CODE_PROJECT_DIR_NAME` is the one that matters outside sessions too,
// and the delete is UNCONDITIONAL for that reason: it renames the CLI's
// transcript directory outright, so a host-set value would land every session
// on this orchestrator — local and remote, plus the summariser's scratch run,
// which spawns in its own dir precisely so its jsonl never surfaces as a
// project — in ONE directory. That is strictly worse than the collision this
// module's callers exist to fix, and cc never sets the variable itself.
const STRIPPED = [
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_PROJECT_DIR_NAME',
] as const;

export function cliEnvBase(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of STRIPPED) delete env[k];
  return env;
}
