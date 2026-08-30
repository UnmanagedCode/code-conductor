// The one permission rule redirection breaks, and how cc refuses to break it
// quietly.
//
// MEASURED against claude 2.1.250: a `permissions.deny` entry like
// `Bash(touch:*)` IS enforced under `--permission-mode bypassPermissions
// --allow-dangerously-skip-permissions`, which is how every cc worker launches.
// Rules also match the POST-hook tool input. Put those together with the Bash
// forwarder — which rewrites EVERY command into one invocation of one script —
// and every Bash call becomes byte-identical to the permission layer: no
// `Bash(...)` rule can tell any two commands apart, so a pattern rule silently
// stops applying to every one of them.
//
// WHY A REFUSAL AND NOT AN ENFORCER. cc could match the rules itself against the
// pre-rewrite command, but only approximately: the CLI splits a command on `&&`
// and `|` and matches each part, so a cc-side prefix matcher would let
// `npm test && rm -rf /` past a `Bash(rm:*)` deny while claiming the rule was
// honoured. A subset matcher that under-denies is FALSE ASSURANCE about a
// safety rule, which is worse than the collapse it was meant to fix.
//
// WHY NOT A WARNING. The rule is the operator's own safety decision. Trading it
// away to use a feature is their call to make knowingly, at the moment they are
// looking — which is the spawn — rather than in a log line under a session that
// already started.
//
// Only `deny` and `ask` are checked. An `allow` that stops matching costs a
// prompt, never a command that should not have run.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface UnenforceableRule { rule: string; source: string }

// A pattern rule: `Bash(<something>)`. A BARE `Bash` is deliberately not one —
// it removes the tool outright rather than discriminating between commands, so
// redirection leaves it working exactly as before.
const BASH_PATTERN_RULE = /^Bash\(.*\)$/;

// The settings files cc can see for a redirected session, in the CLI's own
// precedence order. The project pair are the copies cc PULLED from the system
// into the session root, so they are the project's real rules rather than a
// guess. An enterprise managed-policy file is not read: it is OS-specific and
// cc has never known where it is, so a rule there produces no refusal — the
// same silence as today, not a new claim of coverage.
export function bashRuleSources(sessionRoot: string): string[] {
  return [
    path.join(sessionRoot, '.claude', 'settings.local.json'),
    path.join(sessionRoot, '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];
}

// Every `Bash(...)` deny/ask rule in the given settings files, each attributed
// to the file it came from. An absent or unparseable file is SKIPPED: most
// installs have no project settings at all, and a file cc cannot read is the
// CLI's to complain about — refusing a spawn over it would block sessions for a
// fault that is not this one.
export async function findUnenforceableBashRules(sources: string[]): Promise<UnenforceableRule[]> {
  const out: UnenforceableRule[] = [];
  for (const source of sources) {
    let parsed: unknown;
    try { parsed = JSON.parse(await fs.readFile(source, 'utf8')); }
    catch { continue; }
    const perms = (parsed as { permissions?: unknown } | null)?.permissions;
    if (!perms || typeof perms !== 'object') continue;
    for (const bucket of ['deny', 'ask'] as const) {
      const list = (perms as Record<string, unknown>)[bucket];
      if (!Array.isArray(list)) continue;
      for (const rule of list) {
        if (typeof rule === 'string' && BASH_PATTERN_RULE.test(rule)) out.push({ rule, source });
      }
    }
  }
  return out;
}

// The refusal text. Names every rule and its file, because the repair is to
// edit one of them — and says what redirection did to it, because "cc cannot
// enforce this" without the reason reads as a cc bug.
export function bashRulesRefusal(systemId: string, found: UnenforceableRule[]): string {
  const lines = found.map(f => `  ${f.rule}  (${f.source})`).join('\n');
  return `BASH_RULES_NOT_ENFORCEABLE: this session would run on system '${systemId}', where every `
    + `Bash command is rewritten into one forwarder invocation — so the Claude CLI, which matches `
    + `permission rules against the rewritten command, can no longer tell two commands apart. `
    + `These rules would stop applying, silently:\n${lines}\n`
    + `cc refuses the session rather than let that happen. Remove or re-scope the rules if you `
    + `accept running without them on this system.`;
}
