// The one spawn implementation behind POST /api/instances and the headless
// runner (src/headless/runner.ts): the request body's validation, the temp →
// bypassPermissions mapping and the Settings → Models row a model-less spawn
// runs on, then create(). Throws a statusCode-bearing error on a refusal, which
// the route's error middleware renders.

import { CONDUCT_PROJECT_NAME } from './conduct.ts';
import { httpError } from './httpError.ts';
import { PLAYBOOK_ENFORCEMENT_MODES, isPlaybookEnforcement } from './playbooks.ts';
import { isKnownTier, CLAUDE_BACKEND_ID, type BackendBinding } from './modelVersions.ts';
import {
  getDefaultSpawnTier, getTierBackend, defaultSpawnBinding, resolveRoleBackend, isResolvableRole,
} from './appSettings.ts';
import type { InstanceLike, InstanceManagerLike } from './instanceTypes.ts';

export async function spawnFromBody(instances: InstanceManagerLike, body: Record<string, unknown>): Promise<InstanceLike> {
  // No context-window input: capacity is resolved server-side from
  // {backend, model} (see resolveContextWindowTokens), never accepted
  // from the client.
  const { project, resume, mode, effort, tier, role, thinking, model, backend, worktree, temp, debug, autoApprovePlan, playbookEnforcement, pristine } = body;
  // Pristine (src/pristine.ts) is New conductor's state and nothing else's.
  if (pristine === true && !(project === CONDUCT_PROJECT_NAME && temp === true && resume == null)) {
    throw httpError(400, `pristine applies only to a fresh temp spawn in ${CONDUCT_PROJECT_NAME}`, { code: 'PRISTINE_NOT_FRESH_CONDUCTOR' });
  }
  // Ingress validation for the enforcement level — instances.ts stores it
  // as an already-narrowed type, so the allow-list is checked here.
  if (playbookEnforcement !== undefined && !isPlaybookEnforcement(playbookEnforcement)) {
    throw httpError(400, `playbookEnforcement must be one of ${PLAYBOOK_ENFORCEMENT_MODES.join(' | ')}`);
  }
  // UI shortcut: the temp checkbox implies bypassPermissions when no
  // mode is picked (a disposable session is almost always for *doing*,
  // not planning). create() is policy-light and no longer couples
  // these, so the mapping lives here. An explicit mode still wins.
  // `temp === true` (NOT truthiness): a malformed non-boolean temp (e.g.
  // the string "false") must not force bypassPermissions — pinned by
  // tests/instances.test.mjs.
  const effectiveMode = (mode == null && temp === true) ? 'bypassPermissions' : mode;
  // `tier`/`role` name the Settings → Models row this spawn resolves both
  // `model`+`backend` AND (when `effort` is omitted) the default effort from
  // (resolveSpawnEffort) — one resolution point, server-side. The web UI
  // sends `tier`/`role` and no `model`/`backend`, so it always takes this
  // named-row branch; a raw API client that omits both is the one that falls
  // through to the default-spawn-tier branch below.
  // A fresh spawn that names no model runs on a Settings → Models ROW, never the
  // account default. Policy + the same-row mechanism: docs/models.md → Capability
  // tiers & roles.
  //
  // "Names no model" is tested on the TRIMMED value — `_doCreate` trims `model`
  // itself, so an untrimmed check would let `model:""` through to a bare `claude`
  // on the account default. `backend` gets the same treatment because `_doCreate`
  // reads it by truthiness, so `""` there already means "absent". This matches the
  // MCP surface for `""`/null/undefined/omitted, the shapes a client actually
  // sends. It deliberately does NOT match for a whitespace-only string: `"   "` is
  // truthy and unresolvable to `resolveSpawnModel`, so MCP refuses BAD_MODEL 400,
  // while here it trims to absent and resolves a row. Neither reaches the account
  // default, so the rule holds on both surfaces; only the diagnostic differs.
  //
  // Which row: the one the caller NAMED (`role`, else `tier`) when it is
  // resolvable, else the default spawn tier. `role` is checked first, the same
  // precedence resolveSpawnEffort uses. Whichever row wins, the name forwarded to
  // create() is the TRIMMED one that resolved the binding — a padded `role` would
  // otherwise resolve the model here and then go unrecognised by
  // resolveSpawnEffort, splitting the two axes across different rows.
  const named = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null;
  let spawnModel = named(model);
  let spawnBackend = named(backend);
  let spawnTier = tier as string | undefined;
  let spawnRole = role as string | undefined;
  // The row a model-less fresh spawn runs on, plus the side effect of committing
  // to it: the name forwarded for effort is the one that resolved the binding.
  const takeSpawnRow = (): BackendBinding => {
    const namedRole = named(role);
    const namedTier = named(tier);
    if (namedRole && isResolvableRole(namedRole)) {
      // No need to clear a stale `tier`: resolveSpawnEffort ranks role above it.
      spawnRole = namedRole;
      return resolveRoleBackend(namedRole);
    }
    if (namedTier && isKnownTier(namedTier)) {
      spawnTier = namedTier;
      return getTierBackend(namedTier);
    }
    spawnTier = getDefaultSpawnTier();
    return defaultSpawnBinding();
  };
  if (!resume && spawnModel == null && spawnBackend == null) {
    const binding = takeSpawnRow();
    spawnModel = binding.model;
    spawnBackend = binding.backend;
  } else if (!resume && spawnModel == null && spawnBackend === CLAUDE_BACKEND_ID) {
    // A named backend with no model. Naming a backend is a choice this must not
    // overwrite, so the row can only supply the MODEL, and only when the row is on
    // that same backend — otherwise there is nothing to fill and the request is
    // refused with the same BACKEND_MODEL_MISSING every other backend already
    // gives for this input (minted here rather than in _doCreate, whose own guard
    // is `backend !== claude`, i.e. deliberately blind to the identity backend).
    //
    // Scoped to the IDENTITY backend, which is the whole gap: `claude` with no
    // model is the only combination that reaches the CLI's account default. A
    // named SUBSTITUTION backend falls through untouched and keeps _doCreate's
    // existing refusal — see the report note; filling one from a matching row
    // would turn a refusal into a spawn, which is not what was approved.
    const binding = takeSpawnRow();
    if (binding.backend !== CLAUDE_BACKEND_ID) {
      throw Object.assign(
        new Error(`backend '${spawnBackend}' was named with no model, and the row this spawn resolves to is bound to backend '${binding.backend}' — pass an explicit model, or rebind that row to '${CLAUDE_BACKEND_ID}'`),
        { statusCode: 422, code: 'BACKEND_MODEL_MISSING' },
      );
    }
    spawnModel = binding.model;
  }
  // Each field is asserted to create()'s input type — create() remains the
  // runtime validator (unknown project / bad effort → its own error), so
  // the erased casts change nothing at runtime.
  return instances.create({
    project: project as string,
    resume: resume as string | undefined,
    mode: effectiveMode as string | null | undefined,
    effort: effort as string | null | undefined,
    tier: spawnTier,
    role: spawnRole,
    thinking: thinking as string | null | undefined,
    model: spawnModel,
    backend: spawnBackend,
    worktree: worktree as string | boolean | null | undefined,
    temp: temp as boolean | undefined,
    pristine: pristine === true,
    debug: debug as boolean | undefined,
    autoApprovePlan: autoApprovePlan as boolean | undefined,
    playbookEnforcement,
  });

}
