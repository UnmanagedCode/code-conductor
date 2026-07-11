import { promises as fs } from 'node:fs';
import path from 'node:path';

// Plugin manifest: `conductor.plugin.json` at the plugin project root.
// readManifest(dir) reads + validates; validateManifest(json) normalizes a
// parsed object into the canonical shape or returns a structured error list.
// Validation is deliberately strict at load time: anything the MCP layer's
// shallow validateArgs (src/mcp/server.js) can't validate is rejected HERE,
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
// its catalog provider in server.js) — no other file hardcodes the set.
export const SUPPORTED_CONVENTION_SCOPES = ['project', 'conductor'];
const PLANNED_CONVENTION_SCOPES = ['workspace'];
const quotedScopes = SUPPORTED_CONVENTION_SCOPES.map(s => `"${s}"`).join(', ');

// `conventions` (project-convention fragments, optionally carrying a one-time
// scaffold facet) is an active pluginApi:1 capability that requires no backend,
// so a conventions-only plugin is valid. `settings` stays reserved
// (validated-but-inert; accepted, never acted on).
const KNOWN_TOP_KEYS = new Set(['id', 'name', 'version', 'pluginApi', 'backend', 'frontend', 'mcp', 'settings', 'conventions']);

// Result: null (no manifest file) | { manifest } | { errors, incompatible? }
export async function readManifest(dir) {
  const file = path.join(dir, MANIFEST_FILENAME);
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return null;
    return { errors: [`manifest unreadable: ${e.message}`] };
  }
  let json;
  try { json = JSON.parse(raw); }
  catch (e) { return { errors: [`manifest is not valid JSON: ${e.message}`] }; }
  const result = validateManifest(json);
  if (result.manifest) {
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
async function checkFragmentFiles(dir, manifest) {
  const refs = [];
  for (const g of manifest.conventions ?? []) {
    if (g.file) refs.push([`conventions '${g.slug}' file`, g.file]);
    if (g.scaffold?.file) refs.push([`conventions '${g.slug}' scaffold file`, g.scaffold.file]);
  }
  const errors = [];
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
export function validateManifest(json) {
  const errors = [];
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { errors: ['manifest must be a JSON object'] };
  }

  for (const k of Object.keys(json)) {
    if (!KNOWN_TOP_KEYS.has(k)) errors.push(`unknown key '${k}'`);
  }

  if (typeof json.id !== 'string' || !ID_RE.test(json.id) || json.id.length > 40) {
    errors.push("'id' is required and must match ^[a-z][a-z0-9-]*$ (max 40 chars)");
  }
  if (typeof json.name !== 'string' || json.name.trim() === '') {
    errors.push("'name' is required (non-empty string)");
  }
  if (typeof json.version !== 'string' || json.version.trim() === '') {
    errors.push("'version' is required (non-empty string)");
  }

  if (!Number.isInteger(json.pluginApi)) {
    errors.push("'pluginApi' is required (integer)");
  } else if (!SUPPORTED_PLUGIN_APIS.includes(json.pluginApi)) {
    return { errors: [`unsupported pluginApi ${json.pluginApi} (conductor supports: ${SUPPORTED_PLUGIN_APIS.join(', ')})`], incompatible: true, id: displayId(json) };
  }

  const backend = validateBackend(json.backend, errors);
  const frontend = validateFrontend(json.frontend, backend, json.name, errors);
  const mcp = validateMcp(json.mcp, backend, errors);
  const conventions = validateConventions(json.conventions, errors);

  if (errors.length > 0) return { errors, id: displayId(json) };
  return {
    manifest: {
      id: json.id,
      name: json.name.trim(),
      version: json.version.trim(),
      pluginApi: json.pluginApi,
      ...(backend ? { backend } : {}),
      ...(frontend ? { frontend } : {}),
      ...(mcp ? { mcp } : {}),
      ...(conventions ? { conventions } : {}),
    },
  };
}

// A plugin-relative fragment path: must be a relative `.md` path with no `..`
// segment and no leading '/'. Resolved against the plugin checkout at read time.
function validateFragmentPath(value, label, errors) {
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
function validateConventions(g, errors) {
  if (g === undefined) return null;
  if (!Array.isArray(g) || g.length === 0) {
    errors.push("'conventions' must be a non-empty array");
    return null;
  }
  const out = [];
  const seen = new Set();
  g.forEach((entry, i) => {
    const label = `conventions[${i}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`'${label}' must be an object`);
      return;
    }
    for (const k of Object.keys(entry)) {
      if (!['slug', 'name', 'description', 'file', 'scope', 'scaffold'].includes(k)) errors.push(`unknown key '${label}.${k}'`);
    }
    if (typeof entry.slug !== 'string' || !SLUG_RE.test(entry.slug) || entry.slug.length > SLUG_MAX) {
      errors.push(`'${label}.slug' is required and must match ^[a-z][a-z0-9-]*$ (max 40 chars)`);
    } else if (seen.has(entry.slug)) {
      errors.push(`duplicate convention slug '${entry.slug}'`);
    } else {
      seen.add(entry.slug);
    }
    if (typeof entry.name !== 'string' || entry.name.trim() === '') errors.push(`'${label}.name' is required (non-empty string)`);
    if (typeof entry.description !== 'string' || entry.description.trim() === '') errors.push(`'${label}.description' is required (non-empty string)`);
    // `file` is optional; validate its shape only when present.
    if (entry.file !== undefined) validateFragmentPath(entry.file, `${label}.file`, errors);
    const scaffold = validateScaffoldFacet(entry.scaffold, label, errors);
    // At least one of fragment / scaffold must be present.
    if (entry.file === undefined && entry.scaffold === undefined) {
      errors.push(`'${label}' requires at least one of 'file' or 'scaffold'`);
    }
    validateConventionScope(entry.scope, label, errors);
    out.push({
      slug: entry.slug,
      name: typeof entry.name === 'string' ? entry.name.trim() : '',
      description: typeof entry.description === 'string' ? entry.description.trim() : '',
      ...(entry.file !== undefined ? { file: entry.file } : {}),
      scope: entry.scope,
      ...(scaffold ? { scaffold } : {}),
    });
  });
  return out;
}

// scaffold facet: { text | file } — a one-time project-setup directive body via
// exactly one of inline `text` or a fragment `file`. Optional; validated only
// when present. Returns the normalized facet ({text}|{file}) or null.
function validateScaffoldFacet(scaffold, label, errors) {
  if (scaffold === undefined) return null;
  const sl = `${label}.scaffold`;
  if (typeof scaffold !== 'object' || scaffold === null || Array.isArray(scaffold)) {
    errors.push(`'${sl}' must be an object`);
    return null;
  }
  for (const k of Object.keys(scaffold)) {
    if (!['text', 'file'].includes(k)) errors.push(`unknown key '${sl}.${k}'`);
  }
  const hasText = scaffold.text !== undefined;
  const hasFile = scaffold.file !== undefined;
  if (hasText === hasFile) {
    errors.push(`'${sl}' requires exactly one of 'text' or 'file'`);
    return null;
  }
  if (hasText) {
    if (typeof scaffold.text !== 'string' || scaffold.text.trim() === '') {
      errors.push(`'${sl}.text' must be a non-empty string`);
      return null;
    }
    return { text: scaffold.text };
  }
  if (!validateFragmentPath(scaffold.file, `${sl}.file`, errors)) return null;
  return { file: scaffold.file };
}

// Required, explicit scope. A recognised-but-not-yet-wired scope gets a specific
// message; anything else gets the standard invalid-enum error.
function validateConventionScope(scope, label, errors) {
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

// Best-effort id for listing an invalid/incompatible manifest.
function displayId(json) {
  return typeof json.id === 'string' && json.id !== '' ? json.id : undefined;
}

function validateBackend(b, errors) {
  if (b === undefined) return null;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) {
    errors.push("'backend' must be an object");
    return null;
  }
  for (const k of Object.keys(b)) {
    if (!['start', 'healthPath', 'readyWhen'].includes(k)) errors.push(`unknown key 'backend.${k}'`);
  }
  if (typeof b.start !== 'string' || b.start.trim() === '') {
    errors.push("'backend.start' is required (non-empty command string)");
  }
  if (b.healthPath !== undefined && (typeof b.healthPath !== 'string' || !b.healthPath.startsWith('/'))) {
    errors.push("'backend.healthPath' must be a path starting with '/'");
  }
  if (b.readyWhen !== undefined) {
    if (typeof b.readyWhen !== 'string' || b.readyWhen === '') {
      errors.push("'backend.readyWhen' must be a non-empty regex string");
    } else {
      try { new RegExp(b.readyWhen); }
      catch (e) { errors.push(`'backend.readyWhen' is not a valid regex: ${e.message}`); }
    }
  }
  return {
    start: typeof b.start === 'string' ? b.start.trim() : '',
    ...(b.healthPath ? { healthPath: b.healthPath } : {}),
    ...(b.readyWhen ? { readyWhen: b.readyWhen } : {}),
  };
}

function validateFrontend(f, backend, name, errors) {
  if (f === undefined) return null;
  if (typeof f !== 'object' || f === null || Array.isArray(f)) {
    errors.push("'frontend' must be an object");
    return null;
  }
  if (!backend) errors.push("'frontend' requires 'backend'");
  for (const k of Object.keys(f)) {
    if (!['path', 'navLabel'].includes(k)) errors.push(`unknown key 'frontend.${k}'`);
  }
  if (f.path !== undefined && (typeof f.path !== 'string' || !f.path.startsWith('/'))) {
    errors.push("'frontend.path' must be a path starting with '/'");
  }
  if (f.navLabel !== undefined && (typeof f.navLabel !== 'string' || f.navLabel.trim() === '')) {
    errors.push("'frontend.navLabel' must be a non-empty string");
  }
  return {
    path: typeof f.path === 'string' ? f.path : '/',
    navLabel: typeof f.navLabel === 'string' && f.navLabel.trim() !== '' ? f.navLabel.trim() : (typeof name === 'string' ? name.trim() : ''),
  };
}

function validateMcp(m, backend, errors) {
  if (m === undefined) return null;
  if (typeof m !== 'object' || m === null || Array.isArray(m)) {
    errors.push("'mcp' must be an object");
    return null;
  }
  if (!backend) errors.push("'mcp' requires 'backend'");
  for (const k of Object.keys(m)) {
    if (!['endpoint', 'scope', 'timeoutMs', 'tools'].includes(k)) errors.push(`unknown key 'mcp.${k}'`);
  }
  if (typeof m.endpoint !== 'string' || !m.endpoint.startsWith('/')) {
    errors.push("'mcp.endpoint' is required and must be a path starting with '/'");
  }
  // `scope` is accepted for manifest compatibility but INERT — plugin MCP
  // tools are always visible to every caller (see mcpBridge.js).
  if (m.scope !== undefined && !['project', 'global'].includes(m.scope)) {
    errors.push("'mcp.scope' must be 'project' or 'global'");
  }
  let timeoutMs = MCP_TIMEOUT_DEFAULT;
  if (m.timeoutMs !== undefined) {
    if (!Number.isInteger(m.timeoutMs) || m.timeoutMs <= 0) {
      errors.push("'mcp.timeoutMs' must be a positive integer");
    } else {
      timeoutMs = Math.min(m.timeoutMs, MCP_TIMEOUT_CAP);
    }
  }
  const tools = [];
  if (!Array.isArray(m.tools) || m.tools.length === 0) {
    errors.push("'mcp.tools' is required (non-empty array)");
  } else {
    const seen = new Set();
    m.tools.forEach((t, i) => {
      if (typeof t !== 'object' || t === null) { errors.push(`'mcp.tools[${i}]' must be an object`); return; }
      if (typeof t.name !== 'string' || !TOOL_NAME_RE.test(t.name)) {
        errors.push(`'mcp.tools[${i}].name' is required and must match ^[a-zA-Z0-9_-]+$`);
      } else if (seen.has(t.name)) {
        errors.push(`duplicate tool name '${t.name}'`);
      } else {
        seen.add(t.name);
      }
      if (typeof t.description !== 'string' || t.description.trim() === '') {
        errors.push(`'mcp.tools[${i}].description' is required (non-empty string)`);
      }
      checkSchemaSubset(t.inputSchema, `mcp.tools[${i}].inputSchema`, errors);
      tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
    });
  }
  return {
    endpoint: typeof m.endpoint === 'string' ? m.endpoint : '/',
    scope: m.scope === 'global' ? 'global' : 'project',
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

function checkSchemaSubset(schema, label, errors) {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    errors.push(`'${label}' is required (object)`);
    return;
  }
  if (schema.type !== 'object') {
    errors.push(`'${label}.type' must be 'object'`);
  }
  for (const k of Object.keys(schema)) {
    if (FORBIDDEN_SCHEMA_KEYS.includes(k)) errors.push(`'${label}' uses unsupported '${k}'`);
    else if (!['type', 'properties', 'required', 'description', 'additionalProperties'].includes(k)) {
      errors.push(`'${label}' has unsupported key '${k}'`);
    }
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    errors.push(`'${label}.additionalProperties' must be a boolean (and is ignored)`);
  }
  if (schema.required !== undefined && !(Array.isArray(schema.required) && schema.required.every(r => typeof r === 'string'))) {
    errors.push(`'${label}.required' must be an array of strings`);
  }
  if (schema.properties === undefined) return;
  if (typeof schema.properties !== 'object' || schema.properties === null) {
    errors.push(`'${label}.properties' must be an object`);
    return;
  }
  for (const [prop, spec] of Object.entries(schema.properties)) {
    const pl = `${label}.properties.${prop}`;
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
      errors.push(`'${pl}' must be an object`);
      continue;
    }
    for (const k of Object.keys(spec)) {
      if (FORBIDDEN_SCHEMA_KEYS.includes(k)) errors.push(`'${pl}' uses unsupported '${k}'`);
      else if (k === 'properties') errors.push(`'${pl}' uses nested 'properties' (nested object validation is unsupported)`);
      else if (!ALLOWED_PROP_KEYS.has(k)) errors.push(`'${pl}' has unsupported key '${k}'`);
    }
    if (spec.items !== undefined) {
      if (typeof spec.items !== 'object' || spec.items === null || Array.isArray(spec.items)) {
        errors.push(`'${pl}.items' must be an object`);
      } else {
        for (const k of Object.keys(spec.items)) {
          if (!['type', 'description'].includes(k)) errors.push(`'${pl}.items' supports only 'type' (got '${k}')`);
        }
      }
    }
  }
}
