// The two ways a settings file can silently break a redirected session, and the
// refusals that keep either from happening quietly.
//
// Both are read from the SAME files at the SAME moment — before the CLI is
// launched — because both are
// questions about settings the CLI is about to obey and cc cannot override.
//
//   1. A `Bash(...)` permission rule, which the forwarder rewrite makes
//      undiscriminating (below).
//   2. `disableAllHooks: true`, which turns the ENTIRE redirect off.
//
// THE SECOND IS THE WORSE ONE. Measured against 2.1.250 with cc's exact settings
// shape: with the key present the PreToolUse hook fires zero times and the
// WORKER'S OWN command runs — on the orchestrator's machine, in the CLI's cwd
// — while every result tells the worker it ran on the system. The write-back
// dies with it. And it does NOT disable `permissions.*`, so cc's injected denies
// still fire and nothing anywhere fails loudly: the session silently diverges,
// which is the one outcome the redirect exists to prevent.
//
// It needs no malice. `.claude/settings.json` is PULLED OFF THE SYSTEM every
// spawn (§3.4), so a user who turned hooks off locally and committed the file
// is enough.

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
import path from 'node:path';
import { claudeConfigDir } from '../projects.ts';
import type { System } from './system.ts';

export interface UnenforceableRule { rule: string; source: string }

// A pattern rule: `Bash(<something>)`. A BARE `Bash` is deliberately not one —
// it removes the tool outright rather than discriminating between commands, so
// redirection leaves it working exactly as before.
const BASH_PATTERN_RULE = /^Bash\(.*\)$/;

// Where the CLI's managed policy lives. 2.1.250's own layer list is
// `["userSettings","projectSettings","localSettings","flagSettings",
// "policySettings"]`, and `policySettings` is this file.
//
// IT IS THE MOST AUTHORITATIVE LAYER AND THE ONE THAT FAILS WORST. A
// `Bash(touch:*)` deny there is enforced today; under redirection the forwarder
// rewrite makes it silently dead. It is the operator's least-revocable safety
// decision, so skipping it would leave exactly the gap this module exists to
// close.
//
// Linux only, which is the only platform cc supports for a host; on anything
// else the path simply does not exist and the read is skipped like any other
// absent file.
const MANAGED_POLICY_PATH = '/etc/claude-code/managed-settings.json';

// Which machine a settings file lives on. The project pair are on the SYSTEM —
// there is no local copy of them any more, so they are read through the
// project's System handle; the user and managed layers are the orchestrator's
// own, and are read locally.
export type SettingsScope = 'project' | 'host';
export interface SettingsSource { path: string; scope: SettingsScope }

// The settings files cc can see for a redirected session, in the CLI's own
// precedence order.
//
// `flagSettings` — the CLI's own `--settings` argument — is deliberately absent:
// that one is cc's, built by src/settings.ts, and cc does not put Bash rules or
// `disableAllHooks` in it.
export function bashRuleSources(projectDir: string): SettingsSource[] {
  return [
    { path: path.join(projectDir, '.claude', 'settings.local.json'), scope: 'project' },
    { path: path.join(projectDir, '.claude', 'settings.json'), scope: 'project' },
    { path: path.join(claudeConfigDir(), 'settings.json'), scope: 'host' },
    { path: MANAGED_POLICY_PATH, scope: 'host' },
  ];
}

// Parse one settings file, or null for one that is absent or unreadable. An
// absent or malformed file is SKIPPED rather than refused: most installs have no
// project settings at all, and a file cc cannot parse is the CLI's to complain
// about — blocking a session over it would refuse for a fault that is not this
// one.
async function readSettings(source: SettingsSource, system: System): Promise<Record<string, unknown> | null> {
  try {
    const raw = source.scope === 'project'
      ? (await system.readFileBytes(source.path)).toString('utf8')
      : await fs.readFile(source.path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

// Every scanned file that turns hooks off outright. Only `true` counts: the key
// present-and-false says hooks are ON, and refusing on it would block a session
// whose settings agree with cc.
export async function findDisabledHooks(sources: SettingsSource[], system: System): Promise<string[]> {
  const out: string[] = [];
  for (const source of sources) {
    const parsed = await readSettings(source, system);
    if (parsed?.disableAllHooks === true) out.push(source.path);
  }
  return out;
}

// Which of the CLI's settings layers a source is, in words. The path alone does
// not say: `/etc/claude-code/managed-settings.json` is ADMIN-OWNED, so "remove
// the setting" is advice the operator reading the refusal may have no power to
// act on, and the two project files live on the SYSTEM rather than on this
// machine.
function layerLabel(source: string, systemId: string): string {
  if (source === MANAGED_POLICY_PATH) return 'managed policy — admin-owned, so an administrator has to change it';
  if (source.startsWith(claudeConfigDir() + path.sep)) return 'your user settings';
  if (source.endsWith('settings.local.json')) return `project local settings, on '${systemId}'`;
  return `project settings, on '${systemId}'`;
}

// One line per offending file: the path, because the repair is to edit it, and
// the layer, because who can edit it differs.
function attribute(sources: string[], systemId: string): string {
  return sources.map(s => `  ${s}\n    (${layerLabel(s, systemId)})`).join('\n');
}

// The refusal text. Names the file, because the repair is to edit it, and names
// the CONSEQUENCE, because "cc cannot run this session" without it reads as a cc
// bug rather than as the protection it is.
export function hooksDisabledRefusal(systemId: string, sources: string[]): string {
  return `REDIRECT_HOOKS_DISABLED: this session would run on system '${systemId}', where every `
    + `Bash command, Read, Write and Edit is redirected by a PreToolUse hook. These settings files `
    + `set "disableAllHooks": true, which turns all of that off:\n`
    + `${attribute(sources, systemId)}\n`
    + `With hooks off the worker's own commands would run on the orchestrator's machine, in this `
    + `session's local directory, while every result told it they ran on '${systemId}' — and no edit `
    + `would ever reach the system. cc refuses the session rather than let that happen. Remove the `
    + `setting, or scope it to the projects that run locally.`;
}

// Every `Bash(...)` deny/ask rule in the given settings files, each attributed
// to the file it came from. An absent or unparseable file is SKIPPED: most
// installs have no project settings at all, and a file cc cannot read is the
// CLI's to complain about — refusing a spawn over it would block sessions for a
// fault that is not this one.
export async function findUnenforceableBashRules(sources: SettingsSource[], system: System): Promise<UnenforceableRule[]> {
  const out: UnenforceableRule[] = [];
  for (const source of sources) {
    const parsed = await readSettings(source, system);
    const perms = parsed?.permissions;
    if (!perms || typeof perms !== 'object') continue;
    for (const bucket of ['deny', 'ask'] as const) {
      const list = (perms as Record<string, unknown>)[bucket];
      if (!Array.isArray(list)) continue;
      for (const rule of list) {
        if (typeof rule === 'string' && BASH_PATTERN_RULE.test(rule)) out.push({ rule, source: source.path });
      }
    }
  }
  return out;
}

// The refusal text. Names every rule and its file, because the repair is to
// edit one of them — and says what redirection did to it, because "cc cannot
// enforce this" without the reason reads as a cc bug.
export function bashRulesRefusal(systemId: string, found: UnenforceableRule[]): string {
  // Same attribution as the hooks refusal, for the same reason: a rule in the
  // managed-policy layer is not the operator's to remove.
  const lines = found.map(f => `  ${f.rule}\n    in ${f.source}\n    (${layerLabel(f.source, systemId)})`).join('\n');
  return `BASH_RULES_NOT_ENFORCEABLE: this session would run on system '${systemId}', where every `
    + `Bash command is rewritten into one forwarder invocation — so the Claude CLI, which matches `
    + `permission rules against the rewritten command, can no longer tell two commands apart. `
    + `These rules would stop applying, silently:\n${lines}\n`
    + `cc refuses the session rather than let that happen. Remove or re-scope the rules if you `
    + `accept running without them on this system.`;
}
