import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isKnownTier, isKnownClaudeModel, CLAUDE_BACKEND_ID, type BackendBinding, type TierBinding } from '../modelVersions.ts';

// Plugin manifest: `conductor.plugin.json` at the plugin project root.
// readManifest(dir) reads + validates; validateManifest(json) normalizes a
// parsed object into the canonical shape or returns a structured error list.
// Validation is deliberately strict at load time: anything the MCP layer's
// shallow validateArgs (src/mcp/server.ts) can't validate is rejected HERE,
// so a schema the forwarder would silently mis-validate never registers.

export const MANIFEST_FILENAME = 'conductor.plugin.json';
export const SUPPORTED_PLUGIN_APIS = [1];

const ID_RE = /^[a-z][a-z0-9-]*$/;
const SLUG_RE = /^[a-z][a-z0-9-]*$/;
const SLUG_MAX = 40;
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const MCP_TIMEOUT_DEFAULT = 30000;
const MCP_TIMEOUT_CAP = 120000;

// A convention's `scope` is REQUIRED and explicit (no silent default). Only
// SUPPORTED scopes route today; PLANNED scopes are recognised so authors get a
// specific "not yet supported" error instead of a bare invalid-enum. Enabling a
// planned scope later is a one-line move from PLANNED → SUPPORTED here (+ wiring
// its catalog provider in server.ts) — no other file hardcodes the set.
export const SUPPORTED_CONVENTION_SCOPES = ['project', 'conductor'];
const PLANNED_CONVENTION_SCOPES = ['workspace'];
const quotedScopes = SUPPORTED_CONVENTION_SCOPES.map(s => `"${s}"`).join(', ');

// `conventions` (project-convention fragments, optionally carrying a one-time
// scaffold facet) is an active pluginApi:1 capability that requires no backend,
// so a conventions-only plugin is valid. `settings` stays reserved
// (validated-but-inert; accepted, never acted on).
const KNOWN_TOP_KEYS = new Set(['id', 'name', 'version', 'pluginApi', 'backend', 'frontend', 'mcp', 'settings', 'conventions', 'roles', 'claudePlugin']);

// ── Normalized manifest shapes ─────────────────────────────────────────────

export interface ConventionEntry {
  slug: string;
  name: string;
  description: string;
  file?: string;
  scope: string;
  scaffold?: { text: string } | { file: string };
}

export interface PluginRole {
  slug: string;
  name: string;
  binding: TierBinding | BackendBinding | null;
}

export interface PluginBackend {
  start: string;
  healthPath?: string;
  readyWhen?: string;
}

export interface PluginFrontend {
  path: string;
  navLabel: string;
}

export interface PluginMcpTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface PluginMcp {
  endpoint: string;
  scope: string;
  timeoutMs: number;
  tools: PluginMcpTool[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  pluginApi: number;
  backend?: PluginBackend;
  frontend?: PluginFrontend;
  mcp?: PluginMcp;
  conventions?: ConventionEntry[];
  roles?: PluginRole[];
  claudePlugin?: string;
}

export type ReadManifestResult =
  | null
  | { manifest: PluginManifest }
  | { errors: string[]; incompatible?: boolean; id?: string };

// Result: null (no manifest file) | { manifest } | { errors, incompatible? }
export async function readManifest(dir: string): Promise<ReadManifestResult> {
  const file = path.join(dir, MANIFEST_FILENAME);
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (e) {
    if ((e as { code?: unknown }).code === 'ENOENT') return null;
    return { errors: [`manifest unreadable: ${(e as Error).message}`] };
  }
  let json: unknown;
  try { json = JSON.parse(raw); }
  catch (e) { return { errors: [`manifest is not valid JSON: ${(e as Error).message}`] }; }
  const result = validateManifest(json);
  if (result && 'manifest' in result) {
    // Fragment file refs are validated for shape in validateManifest; existence
    // is checked here (we have the checkout dir) — a stale path is a load-time
    // error, consistent with the module's strict-at-load stance.
    const fileErrors = await checkFragmentFiles(dir, result.manifest);
    if (fileErrors.length > 0) return { errors: fileErrors, id: result.manifest.id };
  }
  return result;
}

// Verify every convention fragment / scaffold-facet `file` ref resolves to a
// readable file under `dir`. Returns a (possibly empty) list of errors.
async function checkFragmentFiles(dir: string, manifest: PluginManifest): Promise<string[]> {
  const refs: Array<[string, string]> = [];
  for (const g of manifest.conventions ?? []) {
    if (g.file) refs.push([`conventions '${g.slug}' file`, g.file]);
    if (g.scaffold && 'file' in g.scaffold) refs.push([`conventions '${g.slug}' scaffold file`, g.scaffold.file]);
  }
  const errors: string[] = [];
  for (const [label, rel] of refs) {
    try { await fs.access(path.join(dir, rel)); }
    catch { errors.push(`${label} '${rel}' not found`); }
  }
  return errors;
}

// → { manifest } (normalized, defaults applied) or { errors: [..], incompatible? }.
// `incompatible: true` marks the one discovery state the UI renders
// differently from plain `invalid` (a valid manifest for a pluginApi we
// don't speak).
export function validateManifest(json: unknown): ReadManifestResult {
  const errors: string[] = [];
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { errors: ['manifest must be a JSON object'] };
  }
  const raw = json as Record<string, unknown>;

  for (const k of Object.keys(raw)) {
    if (!KNOWN_TOP_KEYS.has(k)) errors.push(`unknown key '${k}'`);
  }

  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id) || raw.id.length > 40) {
    errors.push("'id' is required and must match ^[a-z][a-z0-9-]*$ (max 40 chars)");
  }
  if (typeof raw.name !== 'string' || raw.name.trim() === '') {
    errors.push("'name' is required (non-empty string)");
  }
  if (typeof raw.version !== 'string' || raw.version.trim() === '') {
    errors.push("'version' is required (non-empty string)");
  }

  if (!Number.isInteger(raw.pluginApi)) {
    errors.push("'pluginApi' is required (integer)");
  } else if (!SUPPORTED_PLUGIN_APIS.includes(raw.pluginApi as number)) {
    return { errors: [`unsupported pluginApi ${raw.pluginApi} (conductor supports: ${SUPPORTED_PLUGIN_APIS.join(', ')})`], incompatible: true, id: displayId(raw) };
  }

  const backend = validateBackend(raw.backend, errors);
  const frontend = validateFrontend(raw.frontend, backend, raw.name, errors);
  const mcp = validateMcp(raw.mcp, backend, errors);
  const conventions = validateConventions(raw.conventions, errors);
  const roles = validateRoles(raw.roles, errors);
  const claudePlugin = validateClaudePlugin(raw.claudePlugin, errors);

  if (errors.length > 0) return { errors, id: displayId(raw) };
  return {
    manifest: {
      id: typeof raw.id === 'string' ? raw.id : '',
      name: typeof raw.name === 'string' ? raw.name.trim() : '',
      version: typeof raw.version === 'string' ? raw.version.trim() : '',
      pluginApi: raw.pluginApi as number,
      ...(backend ? { backend } : {}),
      ...(frontend ? { frontend } : {}),
      ...(mcp ? { mcp } : {}),
      ...(conventions ? { conventions } : {}),
      ...(roles ? { roles } : {}),
      ...(claudePlugin !== undefined ? { claudePlugin } : {}),
    },
  };
}

// claudePlugin: OPTIONAL string — a path relative to the cc plugin root pointing
// at a Claude Code plugin root (a dir directly containing
// `.claude-plugin/plugin.json`; skills resolve at `<root>/skills/<name>/SKILL.md`).
// `"."` makes the cc plugin root itself the CC root. Shape-only here (relative,
// no `..`, no leading '/'); the `.claude-plugin/plugin.json` existence check runs
// at launch/resolve time (registry.claudePluginDirs) so a missing target warns +
// drops the flag rather than invalidating the plugin. Returns the string or
// undefined. Kept a string for now — `claudePluginPaths()` is the single accessor,
// so widening to `string | string[]` later is non-breaking.
function validateClaudePlugin(value: unknown, errors: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push("'claudePlugin' must be a non-empty relative path");
    return undefined;
  }
  const trimmed = value.trim();
  // Segment-level `..` check so a legitimate component like `data..v2` is fine —
  // only a real `..` path segment is a traversal.
  if (trimmed.startsWith('/') || path.isAbsolute(trimmed) || trimmed.split('/').includes('..')) {
    errors.push("'claudePlugin' must be a relative path with no '..' segment");
    return undefined;
  }
  return trimmed;
}

// The one accessor consumers use to read a manifest's Claude Code plugin roots.
// Today `claudePlugin` is a single string → `[]` | `[str]`; widening the field to
// `string | string[]` later only touches validateClaudePlugin + this function.
export function claudePluginPaths(manifest: PluginManifest | null | undefined): string[] {
  return manifest?.claudePlugin ? [manifest.claudePlugin] : [];
}

// A plugin-relative fragment path: must be a relative `.md` path with no `..`
// segment and no leading '/'. Resolved against the plugin checkout at read time.
function validateFragmentPath(value: unknown, label: string, errors: string[]): boolean {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`'${label}' is required (relative .md path)`);
    return false;
  }
  if (value.startsWith('/') || value.includes('..') || path.isAbsolute(value)) {
    errors.push(`'${label}' must be a relative path with no '..' segment`);
    return false;
  }
  if (!value.endsWith('.md')) {
    errors.push(`'${label}' must end with '.md'`);
    return false;
  }
  return true;
}

// conventions: [{ slug, name, description, scope, file?, scaffold? }] —
// convention entries contributed to a Conventions catalog (namespaced
// <plugin-id>/<slug> there). `scope` is required and routes the entry to its
// catalog (see SUPPORTED_CONVENTION_SCOPES). An entry may carry a fragment
// (`file`) and/or a one-time setup directive (`scaffold`, plugin-only, project-
// scope only in practice — no catalog outside project creation consumes it),
// but MUST carry at least one of the two. No backend required. Returns a
// normalized array or null.
function validateConventions(g: unknown, errors: string[]): ConventionEntry[] | null {
  if (g === undefined) return null;
  if (!Array.isArray(g) || g.length === 0) {
    errors.push("'conventions' must be a non-empty array");
    return null;
  }
  const out: ConventionEntry[] = [];
  const seen = new Set<string>();
  g.forEach((entry, i) => {
    const label = `conventions[${i}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`'${label}' must be an object`);
      return;
    }
    const e = entry as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (!['slug', 'name', 'description', 'file', 'scope', 'scaffold'].includes(k)) errors.push(`unknown key '${label}.${k}'`);
    }
    if (typeof e.slug !== 'string' || !SLUG_RE.test(e.slug) || e.slug.length > SLUG_MAX) {
      errors.push(`'${label}.slug' is required and must match ^[a-z][a-z0-9-]*$ (max 40 chars)`);
    } else if (seen.has(e.slug)) {
      errors.push(`duplicate convention slug '${e.slug}'`);
    } else {
      seen.add(e.slug);
    }
    if (typeof e.name !== 'string' || e.name.trim() === '') errors.push(`'${label}.name' is required (non-empty string)`);
    if (typeof e.description !== 'string' || e.description.trim() === '') errors.push(`'${label}.description' is required (non-empty string)`);
    // `file` is optional; validate its shape only when present.
    if (e.file !== undefined) validateFragmentPath(e.file, `${label}.file`, errors);
    const scaffold = validateScaffoldFacet(e.scaffold, label, errors);
    // At least one of fragment / scaffold must be present.
    if (e.file === undefined && e.scaffold === undefined) {
      errors.push(`'${label}' requires at least one of 'file' or 'scaffold'`);
    }
    validateConventionScope(e.scope, label, errors);
    out.push({
      slug: typeof e.slug === 'string' ? e.slug : '',
      name: typeof e.name === 'string' ? e.name.trim() : '',
      description: typeof e.description === 'string' ? e.description.trim() : '',
      ...(typeof e.file === 'string' ? { file: e.file } : {}),
      scope: typeof e.scope === 'string' ? e.scope : '',
      ...(scaffold ? { scaffold } : {}),
    });
  });
  return out;
}

// scaffold facet: { text | file } — a one-time project-setup directive body via
// exactly one of inline `text` or a fragment `file`. Optional; validated only
// when present. Returns the normalized facet ({text}|{file}) or null.
function validateScaffoldFacet(scaffold: unknown, label: string, errors: string[]): { text: string } | { file: string } | null {
  if (scaffold === undefined) return null;
  const sl = `${label}.scaffold`;
  if (typeof scaffold !== 'object' || scaffold === null || Array.isArray(scaffold)) {
    errors.push(`'${sl}' must be an object`);
    return null;
  }
  const s = scaffold as Record<string, unknown>;
  for (const k of Object.keys(s)) {
    if (!['text', 'file'].includes(k)) errors.push(`unknown key '${sl}.${k}'`);
  }
  const hasText = s.text !== undefined;
  const hasFile = s.file !== undefined;
  if (hasText === hasFile) {
    errors.push(`'${sl}' requires exactly one of 'text' or 'file'`);
    return null;
  }
  if (hasText) {
    if (typeof s.text !== 'string' || s.text.trim() === '') {
      errors.push(`'${sl}.text' must be a non-empty string`);
      return null;
    }
    return { text: s.text };
  }
  if (!validateFragmentPath(s.file, `${sl}.file`, errors)) return null;
  return { file: s.file as string };
}

// Required, explicit scope. A recognised-but-not-yet-wired scope gets a specific
// message; anything else gets the standard invalid-enum error.
function validateConventionScope(scope: unknown, label: string, errors: string[]): void {
  if (typeof scope !== 'string' || scope === '') {
    errors.push(`'${label}.scope' is required (one of: ${SUPPORTED_CONVENTION_SCOPES.join(', ')})`);
    return;
  }
  if (SUPPORTED_CONVENTION_SCOPES.includes(scope)) return;
  if (PLANNED_CONVENTION_SCOPES.includes(scope)) {
    const verb = SUPPORTED_CONVENTION_SCOPES.length === 1 ? 'is' : 'are';
    errors.push(`scope "${scope}" not yet supported (only ${quotedScopes} ${verb} currently accepted)`);
  } else {
    errors.push(`'${label}.scope' must be one of: ${SUPPORTED_CONVENTION_SCOPES.join(', ')}`);
  }
}

// roles: [{ slug, name, binding }] — plugin-owned roles, surfaced namespaced
// <plugin-id>/<slug> and resolvable anywhere built-in roles are. A role is a
// named model-binding indirection only (no persona/system-prompt — parity with
// built-in roles). Live-derived from enabled plugins, so no backend is required.
// Returns a normalized array or null.
function validateRoles(roles: unknown, errors: string[]): PluginRole[] | null {
  if (roles === undefined) return null;
  if (!Array.isArray(roles) || roles.length === 0) {
    errors.push("'roles' must be a non-empty array");
    return null;
  }
  const out: PluginRole[] = [];
  const seen = new Set<string>();
  roles.forEach((entry, i) => {
    const label = `roles[${i}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`'${label}' must be an object`);
      return;
    }
    const e = entry as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (!['slug', 'name', 'binding'].includes(k)) errors.push(`unknown key '${label}.${k}'`);
    }
    if (typeof e.slug !== 'string' || !SLUG_RE.test(e.slug) || e.slug.length > SLUG_MAX) {
      errors.push(`'${label}.slug' is required and must match ^[a-z][a-z0-9-]*$ (max 40 chars)`);
    } else if (seen.has(e.slug)) {
      errors.push(`duplicate role slug '${e.slug}'`);
    } else {
      seen.add(e.slug);
    }
    if (typeof e.name !== 'string' || e.name.trim() === '') errors.push(`'${label}.name' is required (non-empty string)`);
    const binding = validateRoleBinding(e.binding, label, errors);
    out.push({
      slug: typeof e.slug === 'string' ? e.slug : '',
      name: typeof e.name === 'string' ? e.name.trim() : '',
      binding,
    });
  });
  return out;
}

// A plugin role binding: {kind:'tier', tier} (a known capability tier) or
// {backend:'claude', model} (a known Claude version id). Any OTHER backend is
// user-local — its rows and models exist only in this user's settings — so a
// plugin can't bind to one. Validated against the shared modelVersions catalog
// at load — an unknown tier/model marks the plugin invalid. This is a load-TIME
// check only: the catalog can move on afterwards (a Claude version retired), so
// resolveRoleBackend (appSettings.ts) re-guards a claude model at resolve time
// and falls back rather than spawn a dead id. Returns the normalized binding or
// null.
//
// LEGACY SHAPE, TRANSLATED ON READ: before the backend registry a concrete binding
// was `{kind:'claude', model}`. A manifest is an EXTERNAL format — it lives in a
// third-party repo we can't migrate (the same carve-out the no-read-time-back-compat
// rule makes for the Claude CLI's jsonls), and rejecting it would mark the whole
// plugin invalid on upgrade. So `kind:'claude'` is accepted and normalized to
// `backend:'claude'`. `kind:<anything else>` stays rejected: those backends are
// user-local, exactly as before.
function validateRoleBinding(b: unknown, label: string, errors: string[]): PluginRole['binding'] {
  const bl = `${label}.binding`;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) {
    errors.push(`'${bl}' is required (object {kind:'tier',tier} or {backend:'claude',model})`);
    return null;
  }
  const rec = b as Record<string, unknown>;
  if (rec.kind === 'tier') {
    for (const k of Object.keys(rec)) {
      if (!['kind', 'tier'].includes(k)) errors.push(`unknown key '${bl}.${k}'`);
    }
    if (!isKnownTier(rec.tier)) {
      errors.push(`'${bl}.tier' must be a known capability tier`);
      return null;
    }
    return { kind: 'tier', tier: rec.tier };
  }
  // `backend` (current) or `kind` (legacy pre-registry) may name the backend.
  const backendKey = rec.backend !== undefined ? 'backend' : (rec.kind !== undefined ? 'kind' : null);
  if (backendKey) {
    for (const k of Object.keys(rec)) {
      if (![backendKey, 'model'].includes(k)) errors.push(`unknown key '${bl}.${k}'`);
    }
    if (rec[backendKey] !== CLAUDE_BACKEND_ID) {
      errors.push(`'${bl}.${backendKey}' must be '${CLAUDE_BACKEND_ID}' — other backends are user-local`);
      return null;
    }
    if (!isKnownClaudeModel(rec.model)) errors.push(`'${bl}.model' must be a known Claude model id`);
    return { backend: CLAUDE_BACKEND_ID, model: typeof rec.model === 'string' ? rec.model : '' };
  }
  errors.push(`'${bl}' must be {kind:'tier',tier} or {backend:'claude',model}`);
  return null;
}

// Best-effort id for listing an invalid/incompatible manifest.
function displayId(json: Record<string, unknown>): string | undefined {
  return typeof json.id === 'string' && json.id !== '' ? json.id : undefined;
}

function validateBackend(b: unknown, errors: string[]): PluginBackend | null {
  if (b === undefined) return null;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) {
    errors.push("'backend' must be an object");
    return null;
  }
  const rec = b as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (!['start', 'healthPath', 'readyWhen'].includes(k)) errors.push(`unknown key 'backend.${k}'`);
  }
  if (typeof rec.start !== 'string' || rec.start.trim() === '') {
    errors.push("'backend.start' is required (non-empty command string)");
  }
  if (rec.healthPath !== undefined && (typeof rec.healthPath !== 'string' || !rec.healthPath.startsWith('/'))) {
    errors.push("'backend.healthPath' must be a path starting with '/'");
  }
  if (rec.readyWhen !== undefined) {
    if (typeof rec.readyWhen !== 'string' || rec.readyWhen === '') {
      errors.push("'backend.readyWhen' must be a non-empty regex string");
    } else {
      try { new RegExp(rec.readyWhen); }
      catch (e) { errors.push(`'backend.readyWhen' is not a valid regex: ${(e as Error).message}`); }
    }
  }
  return {
    start: typeof rec.start === 'string' ? rec.start.trim() : '',
    ...(typeof rec.healthPath === 'string' ? { healthPath: rec.healthPath } : {}),
    ...(typeof rec.readyWhen === 'string' ? { readyWhen: rec.readyWhen } : {}),
  };
}

function validateFrontend(f: unknown, backend: PluginBackend | null, name: unknown, errors: string[]): PluginFrontend | null {
  if (f === undefined) return null;
  if (typeof f !== 'object' || f === null || Array.isArray(f)) {
    errors.push("'frontend' must be an object");
    return null;
  }
  const rec = f as Record<string, unknown>;
  if (!backend) errors.push("'frontend' requires 'backend'");
  for (const k of Object.keys(rec)) {
    if (!['path', 'navLabel'].includes(k)) errors.push(`unknown key 'frontend.${k}'`);
  }
  if (rec.path !== undefined && (typeof rec.path !== 'string' || !rec.path.startsWith('/'))) {
    errors.push("'frontend.path' must be a path starting with '/'");
  }
  if (rec.navLabel !== undefined && (typeof rec.navLabel !== 'string' || rec.navLabel.trim() === '')) {
    errors.push("'frontend.navLabel' must be a non-empty string");
  }
  return {
    path: typeof rec.path === 'string' ? rec.path : '/',
    navLabel: typeof rec.navLabel === 'string' && rec.navLabel.trim() !== '' ? rec.navLabel.trim() : (typeof name === 'string' ? name.trim() : ''),
  };
}

function validateMcp(m: unknown, backend: PluginBackend | null, errors: string[]): PluginMcp | null {
  if (m === undefined) return null;
  if (typeof m !== 'object' || m === null || Array.isArray(m)) {
    errors.push("'mcp' must be an object");
    return null;
  }
  const rec = m as Record<string, unknown>;
  if (!backend) errors.push("'mcp' requires 'backend'");
  for (const k of Object.keys(rec)) {
    if (!['endpoint', 'scope', 'timeoutMs', 'tools'].includes(k)) errors.push(`unknown key 'mcp.${k}'`);
  }
  if (typeof rec.endpoint !== 'string' || !rec.endpoint.startsWith('/')) {
    errors.push("'mcp.endpoint' is required and must be a path starting with '/'");
  }
  // `scope` is accepted for manifest compatibility but INERT — plugin MCP
  // tools are always visible to every caller (see mcpBridge.ts).
  if (rec.scope !== undefined && !['project', 'global'].includes(rec.scope as string)) {
    errors.push("'mcp.scope' must be 'project' or 'global'");
  }
  let timeoutMs = MCP_TIMEOUT_DEFAULT;
  if (rec.timeoutMs !== undefined) {
    if (!Number.isInteger(rec.timeoutMs) || (rec.timeoutMs as number) <= 0) {
      errors.push("'mcp.timeoutMs' must be a positive integer");
    } else {
      timeoutMs = Math.min(rec.timeoutMs as number, MCP_TIMEOUT_CAP);
    }
  }
  const tools: PluginMcpTool[] = [];
  if (!Array.isArray(rec.tools) || rec.tools.length === 0) {
    errors.push("'mcp.tools' is required (non-empty array)");
  } else {
    const seen = new Set<string>();
    rec.tools.forEach((t, i) => {
      if (typeof t !== 'object' || t === null) { errors.push(`'mcp.tools[${i}]' must be an object`); return; }
      const tool = t as Record<string, unknown>;
      if (typeof tool.name !== 'string' || !TOOL_NAME_RE.test(tool.name)) {
        errors.push(`'mcp.tools[${i}].name' is required and must match ^[a-zA-Z0-9_-]+$`);
      } else if (seen.has(tool.name)) {
        errors.push(`duplicate tool name '${tool.name}'`);
      } else {
        seen.add(tool.name);
      }
      if (typeof tool.description !== 'string' || tool.description.trim() === '') {
        errors.push(`'mcp.tools[${i}].description' is required (non-empty string)`);
      }
      checkSchemaSubset(tool.inputSchema, `mcp.tools[${i}].inputSchema`, errors);
      tools.push({ name: typeof tool.name === 'string' ? tool.name : '', description: typeof tool.description === 'string' ? tool.description : '', inputSchema: tool.inputSchema });
    });
  }
  return {
    endpoint: typeof rec.endpoint === 'string' ? rec.endpoint : '/',
    scope: rec.scope === 'global' ? 'global' : 'project',
    timeoutMs,
    tools,
  };
}

// Static check that a tool schema stays inside the subset the MCP layer's
// validateArgs actually enforces: a flat object schema. Combinators and
// nested object validation would silently not be validated, so they are
// rejected at manifest load. A boolean `additionalProperties` is accepted
// and ignored (common author idiom; validateArgs rejects unknown args
// unconditionally anyway).
const FORBIDDEN_SCHEMA_KEYS = ['$ref', 'oneOf', 'anyOf', 'allOf', 'not'];
const ALLOWED_PROP_KEYS = new Set(['type', 'description', 'enum', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'items', 'default']);

function checkSchemaSubset(schema: unknown, label: string, errors: string[]): void {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    errors.push(`'${label}' is required (object)`);
    return;
  }
  const s = schema as Record<string, unknown>;
  if (s.type !== 'object') {
    errors.push(`'${label}.type' must be 'object'`);
  }
  for (const k of Object.keys(s)) {
    if (FORBIDDEN_SCHEMA_KEYS.includes(k)) errors.push(`'${label}' uses unsupported '${k}'`);
    else if (!['type', 'properties', 'required', 'description', 'additionalProperties'].includes(k)) {
      errors.push(`'${label}' has unsupported key '${k}'`);
    }
  }
  if (s.additionalProperties !== undefined && typeof s.additionalProperties !== 'boolean') {
    errors.push(`'${label}.additionalProperties' must be a boolean (and is ignored)`);
  }
  if (s.required !== undefined && !(Array.isArray(s.required) && s.required.every(r => typeof r === 'string'))) {
    errors.push(`'${label}.required' must be an array of strings`);
  }
  if (s.properties === undefined) return;
  if (typeof s.properties !== 'object' || s.properties === null) {
    errors.push(`'${label}.properties' must be an object`);
    return;
  }
  for (const [prop, spec] of Object.entries(s.properties as Record<string, unknown>)) {
    const pl = `${label}.properties.${prop}`;
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
      errors.push(`'${pl}' must be an object`);
      continue;
    }
    const specRec = spec as Record<string, unknown>;
    for (const k of Object.keys(specRec)) {
      if (FORBIDDEN_SCHEMA_KEYS.includes(k)) errors.push(`'${pl}' uses unsupported '${k}'`);
      else if (k === 'properties') errors.push(`'${pl}' uses nested 'properties' (nested object validation is unsupported)`);
      else if (!ALLOWED_PROP_KEYS.has(k)) errors.push(`'${pl}' has unsupported key '${k}'`);
    }
    if (specRec.items !== undefined) {
      if (typeof specRec.items !== 'object' || specRec.items === null || Array.isArray(specRec.items)) {
        errors.push(`'${pl}.items' must be an object`);
      } else {
        for (const k of Object.keys(specRec.items as Record<string, unknown>)) {
          if (!['type', 'description'].includes(k)) errors.push(`'${pl}.items' supports only 'type' (got '${k}')`);
        }
      }
    }
  }
}
