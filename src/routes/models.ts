import express from 'express';
import {
  MODEL_FAMILIES, CAPABILITY_TIERS, isKnownTier, type TierName, type BackendBinding, type TierBinding,
} from '../modelVersions.ts';
import { EFFORT_LEVELS, DEFAULT_EFFORT } from '../effortLevels.ts';
import { OLLAMA_CLOUD_MODELS, OLLAMA_CLOUD_TIER_DEFAULTS } from '../ollamaCloudModels.ts';
import {
  getOnOverageAction, setOnOverageAction, getOverageThreshold, setOverageThreshold, getConductorCompactWindow, setConductorCompactWindow, getConductorIdleNudge, setConductorIdleNudge, getLandingRenewNudge, setLandingRenewNudge, IDLE_NUDGE_MIN_MINUTES, IDLE_NUDGE_MAX_MINUTES, getEnabledTiers, setTierEnabled, getDefaultSpawnTier, setDefaultSpawnTier, getTierBackend, setTierBackend, getTierEffort, setTierEffort, getRoleEffort, setRoleEffort, inheritedRoleEffort, effectiveRoleBinding, setRoleBinding, getAllRoles, addCustomRole, removeCustomRole, getCustomModels, addCustomModel, updateCustomModel, removeCustomModel, getBackends, getSubstitutionBackends, backendModels, addBackend, updateBackend, removeBackend, getDebugByDefault, setDebugByDefault, getTaskToolsEnabled, setTaskToolsEnabled, getAutoBackground, setAutoBackground, autoBackgroundPatchError, AUTO_BACKGROUND_MIN_MS, AUTO_BACKGROUND_MAX_MS,
} from '../appSettings.ts';
import type { InstanceManagerLike } from '../instanceTypes.ts';
import { jsonBody } from './shared.ts';

// Body-patch shapes for /settings/models/prefs. The setters own validation
// (unknown tier/role/level, bad binding → 400), so each field is asserted to
// the setter's input type and the runtime value passes through unchanged.
interface ThresholdPatch { enabled: unknown; value: unknown }
interface TierEnabledPatch { tier: TierName; enabled?: unknown }
interface TierBackendPatch { tier: TierName; backend?: unknown }
interface RoleBackendPatch { role: string; backend?: unknown }
interface TierEffortPatch { tier: TierName; effort?: unknown }
interface RoleEffortPatch { role: string; effort?: unknown }

// Settings → Models group. Reports the backend REGISTRY (`backends` — the
// user-manageable launch recipes, see Settings → Backends), the Claude version
// catalog (`claudeFamilies` = MODEL_FAMILIES — the `claude` backend's model
// list), the user's custom models, the curated Ollama cloud preset catalog +
// its per-tier defaults (scoped to the built-in `ollama` backend), the
// capability-tier list + each tier's {backend, model} binding, and the role
// list + each role's stored binding (a tier binding {kind:'tier',tier} or a
// concrete {backend,model}). A binding is exactly {backend, model}: a model's
// context window is catalog data for `claude` and registry data for any other
// backend, resolved at spawn — never stored on the binding.
function modelsSettingsState(): Record<string, unknown> {
  const tierBackend: Record<string, unknown> = {};
  const tierEffort: Record<string, unknown> = {};
  for (const t of CAPABILITY_TIERS) {
    tierBackend[t.tier] = getTierBackend(t.tier); // {backend, model}
    tierEffort[t.tier] = getTierEffort(t.tier);   // always a concrete level
  }
  // roles = built-in + user-custom + plugin-owned (each {role,label,builtin?,plugin?}).
  // Every role's payload binding is its EFFECTIVE binding (a valid user
  // override wins, else the manifest binding for a plugin role or the
  // stored/default binding otherwise) — shown as the tier/{backend,model}
  // binding itself, NOT resolved to a concrete backend, so the tier identity
  // survives.
  const allRoles = getAllRoles();
  const roleBackend: Record<string, unknown> = {};
  // Each role's effort as {effort, inheritsTo}: `effort` is what's stored
  // ('inherit' or a level) and `inheritsTo` is what 'inherit' resolves to right
  // now. The client renders `Inherit (<inheritsTo>)` as a label — it never
  // recomputes the chain, so resolveSpawnEffort stays the only resolution point.
  const roleEffort: Record<string, unknown> = {};
  for (const r of allRoles) {
    roleBackend[r.role] = effectiveRoleBinding(r.role);
    roleEffort[r.role] = { effort: getRoleEffort(r.role), inheritsTo: inheritedRoleEffort(r.role) };
  }
  return { backends: getBackends(), claudeFamilies: MODEL_FAMILIES, onOverage: getOnOverageAction(),
    overageThreshold: getOverageThreshold(),
    conductorCompactWindow: getConductorCompactWindow(),
    // The bounds ride along so the client never restates them.
    conductorIdleNudge: { ...getConductorIdleNudge(), min: IDLE_NUDGE_MIN_MINUTES, max: IDLE_NUDGE_MAX_MINUTES },
    landingRenewNudge: getLandingRenewNudge(),
    tiers: CAPABILITY_TIERS,
    tierBackend,
    tierEffort,
    efforts: EFFORT_LEVELS,
    // The end of the precedence chain, shipped so a client fallback lands on the
    // level the SERVER would actually resolve rather than on the first level in
    // the catalog (see EffortPicker, web/src/features/settings/models/ModelsSection.tsx).
    defaultEffort: DEFAULT_EFFORT,
    roles: allRoles,
    roleBackend,
    roleEffort,
    customModels: getCustomModels(),
    // Every substitution backend's registered models ({model, label}), keyed
    // by backend id — what Change model offers every session, entry by entry.
    backendModels: Object.fromEntries(getSubstitutionBackends().map(b => [b.id, backendModels(b.id)])),
    ollamaCloudModels: OLLAMA_CLOUD_MODELS,
    ollamaCloudTierDefaults: OLLAMA_CLOUD_TIER_DEFAULTS,
    enabledTiers: getEnabledTiers(),
    defaultSpawnTier: getDefaultSpawnTier() };
}

export function mountSpawnPrefs(r: express.Router): void {
  // Settings → Models spawn prefs: debugByDefault (whether newly spawned
  // instances default to debug capture when a spawn call doesn't name `debug`;
  // an explicit per-spawn value always wins), taskTools (opt every launched
  // session into the CLI's task tools; see Instance.spawn) and autoBackground
  // (opt worker launches into the CLI's MCP auto-background, with its threshold
  // and the bounds the client's slider reads; see Instance.spawn).
  const spawnPrefs = () => ({
    debugByDefault: getDebugByDefault(),
    taskTools: getTaskToolsEnabled(),
    autoBackground: { ...getAutoBackground(), minMs: AUTO_BACKGROUND_MIN_MS, maxMs: AUTO_BACKGROUND_MAX_MS },
  });
  r.get('/settings/spawn', async (_req, res, next) => {
    try { res.json(spawnPrefs()); } catch (e) { next(e); }
  });
  r.post('/settings/spawn/prefs', async (req, res, next) => {
    try {
      const body = jsonBody(req);
      // The whole body is validated before any write: a refused autoBackground
      // leaves the request's other fields unsaved too.
      if (body.autoBackground !== undefined) {
        const error = autoBackgroundPatchError(body.autoBackground);
        if (error) { res.status(400).json({ error }); return; }
      }
      if (body.debugByDefault !== undefined) await setDebugByDefault(body.debugByDefault);
      if (body.taskTools !== undefined) await setTaskToolsEnabled(body.taskTools);
      if (body.autoBackground !== undefined) await setAutoBackground(body.autoBackground);
      res.json(spawnPrefs());
    } catch (e) { next(e); }
  });
}

export function mountModels(r: express.Router, { instances }: { instances?: InstanceManagerLike | null }): void {
  r.get('/settings/models', (_req, res) => {
    res.json(modelsSettingsState());
  });

  // The prefs setters all validate internally (unknown names → 400), so each
  // body field is asserted to the setter's input type — behavior identical to
  // the untyped original.
  r.post('/settings/models/prefs', async (req, res, next) => {
    try {
      const body = jsonBody(req);
      const { onOverage, overageThreshold, conductorCompactWindow, conductorIdleNudge, landingRenewNudge,
              tierEnabled, defaultSpawnTier, tierBackend, roleBackend,
              tierEffort, roleEffort } = body;
      if (typeof onOverage === 'string') await setOnOverageAction(onOverage);
      if (overageThreshold !== undefined) await setOverageThreshold(overageThreshold as ThresholdPatch);
      if (conductorCompactWindow !== undefined) await setConductorCompactWindow(conductorCompactWindow as ThresholdPatch);
      if (conductorIdleNudge !== undefined) {
        await setConductorIdleNudge(conductorIdleNudge as ThresholdPatch);
        instances?.syncIdleRenewNudge();
      }
      if (landingRenewNudge !== undefined) {
        if (typeof landingRenewNudge !== 'boolean') {
          return res.status(400).json({ error: 'landingRenewNudge must be a boolean' });
        }
        await setLandingRenewNudge(landingRenewNudge);
      }
      if (tierEnabled !== undefined) {
        if (!tierEnabled || typeof tierEnabled !== 'object' || !isKnownTier((tierEnabled as TierEnabledPatch).tier)) {
          return res.status(400).json({ error: 'tierEnabled.tier must be a known capability tier' });
        }
        const patch = tierEnabled as TierEnabledPatch;
        await setTierEnabled(patch.tier, !!patch.enabled);
      }
      if (defaultSpawnTier !== undefined) await setDefaultSpawnTier(defaultSpawnTier);
      if (tierBackend !== undefined) {
        // backend is a {backend, model} record — setTierBackend validates it names
        // a known Claude version or a configured backend's model (400 otherwise).
        // A `window` from an older client is dropped by persistBinding, not stored:
        // a model's context window is catalog/registry data, resolved at spawn.
        if (!tierBackend || typeof tierBackend !== 'object' || !isKnownTier((tierBackend as TierBackendPatch).tier)) {
          return res.status(400).json({ error: 'tierBackend must be {tier, backend:{backend,model}} with a known tier' });
        }
        const patch = tierBackend as TierBackendPatch;
        await setTierBackend(patch.tier, patch.backend);
      }
      if (roleBackend !== undefined) {
        // backend is a tier binding {kind:'tier',tier} or a concrete
        // {backend,model}. setRoleBinding validates the role is built-in, custom, or a
        // plugin role (an unknown role, or a bad binding, throws 400) — so no
        // isKnownRole precheck here; the store is the single source of truth.
        if (!roleBackend || typeof roleBackend !== 'object' || typeof (roleBackend as RoleBackendPatch).role !== 'string') {
          return res.status(400).json({ error: 'roleBackend must be {role, backend}' });
        }
        const patch = roleBackend as RoleBackendPatch;
        await setRoleBinding(patch.role, patch.backend as BackendBinding | TierBinding);
      }
      // The DEFAULT-EFFORT axis of the same rows — {tier, effort} / {role, effort}.
      // Shaped like the two binding patches above; the setters own validation
      // (unknown tier/role, unknown level, or 'inherit' on a tier → 400).
      if (tierEffort !== undefined) {
        if (!tierEffort || typeof tierEffort !== 'object') {
          return res.status(400).json({ error: 'tierEffort must be {tier, effort}' });
        }
        const patch = tierEffort as TierEffortPatch;
        await setTierEffort(patch.tier, patch.effort);
      }
      if (roleEffort !== undefined) {
        if (!roleEffort || typeof roleEffort !== 'object') {
          return res.status(400).json({ error: 'roleEffort must be {role, effort}' });
        }
        const patch = roleEffort as RoleEffortPatch;
        await setRoleEffort(patch.role, patch.effort);
      }
      // Bidirectional on-demand re-evaluation: a save that touched the overage action
      // or threshold should take effect on whatever is happening right now, not wait
      // for the next ~60s poll tick (lower threshold) or the resume deadline, which
      // can be hours away (raised/disabled threshold). Best-effort only — the setting
      // itself is already persisted above regardless of outcome here.
      try {
        if (instances && (onOverage !== undefined || overageThreshold !== undefined)) {
          instances.syncOveragePolicy();             // policy direction: a switch off stop-resume unmarks now
          await instances.forceUsageTick();          // stop direction: lower threshold trips now
          instances.reevaluateOverageResumes();      // release direction: raised/disabled threshold resumes now
        }
      } catch { /* best-effort re-evaluation */ }
      res.json(modelsSettingsState());
    } catch (e) { next(e); }
  });

  // The backend registry (Settings → Backends). addBackend/updateBackend/
  // removeBackend own all validation + status codes; managed rows are read-only
  // (all field edits → 400) and can never be removed.
  r.post('/settings/models/backends', async (req, res, next) => {
    try {
      const body = jsonBody(req);
      const { id, label, template, env } = body;
      const rec = await addBackend({ id, label, template, env });
      res.status(201).json({ ...modelsSettingsState(), added: rec });
    } catch (e) { next(e); }
  });

  r.patch('/settings/models/backends/:id', async (req, res, next) => {
    try {
      const body = jsonBody(req);
      const { label, template, env } = body;
      const rec = await updateBackend(req.params.id, { label, template, env });
      if (!rec) return res.status(404).json({ error: 'backend not found' });
      res.json({ ...modelsSettingsState(), updated: rec });
    } catch (e) { next(e); }
  });

  // Removal NEVER cascades: a backend still referenced by a custom model is
  // refused with 409 naming them (removeBackend throws it), a managed row with
  // 400, an unknown id with 404.
  r.delete('/settings/models/backends/:id', async (req, res, next) => {
    try {
      const ok = await removeBackend(req.params.id);
      if (!ok) return res.status(404).json({ error: 'backend not found' });
      res.json(modelsSettingsState());
    } catch (e) { next(e); }
  });
}

export function mountModelCatalog(r: express.Router): void {
  // Custom models — a label + the backend's own model id + its REQUIRED native
  // context window. There is no reachability preflight: a bad backend/model
  // simply fails at spawn (and surfaces as `launch_failed`).
  r.post('/settings/models/custom', async (req, res, next) => {
    try {
      const body = jsonBody(req);
      const { label, model, backend, contextWindow, midTurnSteering } = body;
      const rec = await addCustomModel({ label, model, backend, contextWindow, midTurnSteering });
      res.status(201).json({ ...modelsSettingsState(), added: rec });
    } catch (e) { next(e); }
  });

  // Edit label / contextWindow / midTurnSteering in place; the pair is the identity.
  r.patch('/settings/models/custom/:backend/:model', async (req, res, next) => {
    try {
      const { label, contextWindow, midTurnSteering, backend, model } = jsonBody(req);
      const rec = await updateCustomModel(req.params.backend, req.params.model, { label, contextWindow, midTurnSteering, backend, model });
      if (!rec) return res.status(404).json({ error: 'custom model not found' });
      res.json({ ...modelsSettingsState(), updated: rec });
    } catch (e) { next(e); }
  });

  // Remove by the (backend, model) pair (the identity). Backend ids are slugs;
  // `:model` is URL-encoded (ids contain ':' and '/').
  r.delete('/settings/models/custom/:backend/:model', async (req, res, next) => {
    try {
      const ok = await removeCustomModel(req.params.backend, req.params.model);
      if (!ok) return res.status(404).json({ error: 'custom model not found' });
      res.json(modelsSettingsState());
    } catch (e) { next(e); }
  });

  // Custom roles — user-defined, name-only model bindings. The name IS the
  // identity/display (no separate label); its binding lives in roleBackend
  // (edited via the shared /settings/models/prefs roleBackend path, same as
  // built-in roles) and defaults to the `powerful` tier at creation. Plugin
  // roles are contributed by plugins (read-only) and never touched here.
  r.post('/settings/models/roles', async (req, res, next) => {
    try {
      const body = jsonBody(req);
      const { role, binding } = body;
      // addCustomRole validates the name + collisions (400/409); binding is
      // optional (defaults to the powerful tier) and validated when present.
      const rec = await addCustomRole({ role, binding });
      res.status(201).json({ ...modelsSettingsState(), added: rec });
    } catch (e) { next(e); }
  });

  // Delete a custom role (and its binding). A built-in or plugin-owned role
  // can't be deleted (400); an unknown name is 404. Plugin role names are
  // '/'-namespaced so they never even match this `:role` param.
  r.delete('/settings/models/roles/:role', async (req, res, next) => {
    try {
      const role = req.params.role;
      const ok = await removeCustomRole(role);
      if (ok) return res.json(modelsSettingsState());
      // Case-insensitive, matching removeCustomRole above: a case-variant of a
      // built-in/plugin role is still "known" → 400, not a 404 miss.
      const known = getAllRoles().some(x => x.role.toLowerCase() === role.toLowerCase());
      return res.status(known ? 400 : 404).json({ error: known ? 'cannot delete a built-in or plugin-owned role' : 'custom role not found' });
    } catch (e) { next(e); }
  });
}
