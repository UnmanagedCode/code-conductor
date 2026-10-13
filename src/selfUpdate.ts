import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProjectUpstreamStatus } from './worktrees.ts';
import { runGitLive, fetchOriginBounded } from './gitLive.ts';
import { httpError } from './httpError.ts';
import { RESULT_TAIL_CAP } from './groupedCommand.ts';
import { ensureDependencies, withMaintenanceLock } from './relaunchPrep.ts';
// Self-update operates on cc's OWN checkout — always the local system, never a
// project on one.
import { localSystem, LOCAL_SYSTEM_ID } from './systems/registry.ts';
import { hostPlatform } from './platform/index.ts';
import { findSelfProject } from './projects.ts';
import { pullPastGeneratedConventions } from './conventionsCheckout.ts';

// Conductor self-update — the app's own version of the Plugin Library update
// path (src/plugins/library.ts). The conductor is distributed as a git clone
// (README quick start), so "update" == `git pull --ff-only` in the repo root,
// then `npm install` if node_modules differs from the pulled package-lock.json
// (ensureDependencies, src/relaunchPrep.ts), then a restart so the running node
// process loads the new files. This module owns the git/npm half; the restart
// — which also stages the web build — is the caller's step (the client hands off to the
// restart+resume engine after a successful apply — see performRestart in
// web/src/features/sidebar/restart.ts), keeping this a pure git/npm action like
// pluginLibrary.update().

// Repo root = one level up from src/ (this module's dir). Resolved from
// import.meta.url, not process.cwd(), so it points at the checkout the running
// code was loaded from regardless of where `npm start` was invoked. The
// SELF_UPDATE_REPO_ROOT env override (read per call) lets the HTTP-route tests
// — which call these with no args — target a throwaway clone. Callers may also
// pass repoRoot explicitly (the service-level tests do).
const MODULE_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function defaultRepoRoot(): string {
  return process.env.SELF_UPDATE_REPO_ROOT || MODULE_REPO_ROOT;
}


async function readVersion(repoRoot: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8');
    const pkg: { version?: unknown } = JSON.parse(raw);
    // npm requires a string version — a non-string is malformed → null.
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch { return null; }
}

// { version, upstream, behind, canCheck, updateAvailable }. Mirrors
// pluginLibrary.list()'s per-entry detection: a bounded best-effort fetch so
// the behind-count reflects the real remote, then getProjectUpstreamStatus.
// canCheck:false (behind null) when HEAD is detached or the branch has no
// configured upstream (e.g. a dev worktree) — the UI shows "can't check".
export async function getSelfUpdateStatus({ repoRoot = defaultRepoRoot() }: { repoRoot?: string } = {}): Promise<{
  version: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  canCheck: boolean;
  diverged: boolean;
  updateAvailable: boolean;
}> {
  const version = await readVersion(repoRoot);
  await fetchOriginBounded(repoRoot, hostPlatform);
  const status = await getProjectUpstreamStatus(localSystem(), repoRoot);
  const canCheck = typeof status.behind === 'number';
  const behind = canCheck ? status.behind : null;
  const ahead = canCheck ? status.ahead : null;
  // A checkout with local commits AND remote-ahead can't fast-forward — the
  // `git pull --ff-only` apply would refuse. Report it as its own state so the
  // UI never offers an Update button that's guaranteed to fail; gate
  // updateAvailable on ahead === 0 so only an applicable update advertises one.
  // (`?? 0` is a defensive no-op: when canCheck, ahead/behind are both numbers.)
  const diverged = canCheck && (ahead ?? 0) > 0 && (behind ?? 0) > 0;
  return {
    version,
    upstream: status.upstream,
    ahead,
    behind,
    canCheck,
    diverged,
    updateAvailable: canCheck && (behind ?? 0) > 0 && (ahead ?? 0) === 0,
  };
}

// The update's npm step. `error` (a failure only) is why it failed: the install's
// own message, or a refusal that never ran npm (`ran:false`, DEPS_LINKED).
type NpmStep = { ran: boolean; ok: boolean; code: number; tail: string; error?: string };

// Apply an update: `git pull --ff-only` in the repo root, then `npm install`
// iff node_modules then differs from package-lock.json — drift that predates the
// pull included. Holds the maintenance lock throughout, so it never overlaps a
// restart; contention is refused 409 before onValidated. `--ff-only` never mutates on
// failure (diverged/dirty/no-remote all refuse cleanly) — surface the tail;
// the only pre-pull change is the discard of cc's own generated files, which
// the regeneration after the pull restores either way.
// onValidated flips the route into NDJSON streaming (nothing done before it);
// onChunk(phase, text) streams live pull/npm output. Returns restartRequired
// so the caller knows to bounce the process; the restart itself is NOT done
// here (the client owns it via the existing restart+resume engine).
export async function applySelfUpdate({
  repoRoot = defaultRepoRoot(),
  npmCmd,
  onChunk,
  onValidated,
}: {
  repoRoot?: string;
  npmCmd?: string;
  onChunk?: (phase: 'pull' | 'npm', text: string) => void;
  onValidated?: () => void;
} = {}): Promise<{
  ok: boolean;
  version: string | null;
  depsChanged: boolean;
  npm: NpmStep | null;
  restartRequired: boolean;
}> {
  return withMaintenanceLock('update', async () => {
    onValidated?.();

    // A checkout registered as a project carries cc's own regenerated
    // CONVENTIONS.md/CLAUDE.md; they are discarded before the pull and
    // regenerated after it (src/conventionsCheckout.ts). An unregistered one is
    // never written by cc, so it is pulled untouched — and so is one paired only
    // with a project on another system, which regeneration would write through
    // while classification reads this local tree.
    const self = await findSelfProject(repoRoot);
    const project = self && self.system === LOCAL_SYSTEM_ID ? self.name : null;
    await pullPastGeneratedConventions({
      system: localSystem(), dir: repoRoot, project,
      note: (t) => onChunk?.('pull', t),
      run: async () => {
        const pull = await runGitLive(['pull', '--ff-only'], repoRoot, { onChunk: (t) => onChunk?.('pull', t), platform: hostPlatform });
        if (pull.code !== 0) {
          const tail = (pull.stderr || pull.stdout || '').slice(-RESULT_TAIL_CAP);
          throw httpError(502, 'git pull --ff-only failed', { tail });
        }
      },
    });

    // `depsChanged` = node_modules differed from the pulled lock. A linked
    // node_modules (DEPS_LINKED) and a failed or unverified install are all a
    // failed npm step: the client gates its restart on npm.ok.
    let depsChanged = false;
    let npm: NpmStep | null = null;
    try {
      const r = await ensureDependencies({ repoRoot, npmCmd, onChunk: (t) => onChunk?.('npm', t) });
      if (r.ran) { depsChanged = true; npm = { ran: true, ok: true, code: r.code, tail: r.tail }; }
    } catch (e) {
      const err = e as { message?: string; ran?: boolean; exitCode?: number; tail?: string };
      depsChanged = true;
      npm = {
        ran: !!err.ran, ok: false, code: err.exitCode ?? 1,
        tail: [err.tail, err.message].filter(Boolean).join('\n').slice(-RESULT_TAIL_CAP),
        error: err.message ?? 'npm install failed',
      };
    }

    // Truthful restart signal: a failed npm install must NOT advertise a
    // ready-to-restart tree (the client already gates on npm.ok, but the field
    // shouldn't lie).
    const restartRequired = npm ? npm.ok : true;
    return { ok: true, version: await readVersion(repoRoot), depsChanged, npm, restartRequired };
  });
}
