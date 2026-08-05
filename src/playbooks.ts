// Playbooks — the definition catalog, the load-time graph validator, and the
// pure policy decision `decide()`.
//
// A playbook is a JSON graph of STAGES. Workers are bound to a stage; the
// conductor states its intent on the calls that create or move workers; this
// module verifies the move against the graph. Playbooks govern only the
// CONDUCTOR's tool calls — worker-side calls keep their existing recursion rules.
//
// `require` vs `needs` — these are the two easiest things here to conflate, and
// they are kept distinct in the schema, in this file, and in every message:
//   • `needs`   — WORKER PROVENANCE: which other worker must exist, in which
//                 stage. An entry condition of the stage.
//   • `require` — ARGUMENT VALUES: what one tool call's arguments must be.
//
// GOVERNABLE SURFACE (targeted-only policy scope). A tool is governable iff its
// inputSchema declares a `sessionId` — it names a worker — plus `spawn_instance`,
// which is governed by the stage being ENTERED. Everything else is ungoverned by
// construction and can never appear in a `tools` map: `project_*`, `list_*`,
// `create_*`, every plugin tool, `delete_worktree` (its signature is
// {project, worktree, force}), and `renew_session` (it acts on the caller, so it
// carries no sessionId). That gap is accepted. It is NOT the same fact as the
// renew_session projection limitation documented in playbookLedger.ts — that one
// is about a sessionId rotation orphaning stage state.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { orchStoreRoot } from './projects.ts';
import { createFragmentCatalog, validateSlug, type ExtraEntry } from './fragmentCatalog.ts';
import {
  type Projection, hasEverBeen, liveInStage, runRootOf, sameRun,
} from './playbookLedger.ts';

const PLAYBOOKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'playbooks');

// The ids of the built-in playbooks. Bodies live in playbooks/<id>.json, and
// each body owns its own `name`/`description` — restating them here would be a
// second source that drifts, so the catalog seeds carry the id only and
// getPlaybooks() reads the metadata from the parsed body.
export const SEED_PLAYBOOK_IDS = ['classic', 'split', 'research', 'freeform'] as const;

export const TOOL_NAME_PREFIX = 'mcp__code-conductor__';

// The registered server-side tool name, with the MCP namespace prefix stripped.
// A conductor may name either form; policy maps are written bare.
export function normalizeToolName(name: string): string {
  return name.startsWith(TOOL_NAME_PREFIX) ? name.slice(TOOL_NAME_PREFIX.length) : name;
}

// `require` may never constrain the policy layer's OWN inputs — constraining
// their value is meaningless or actively harmful.
export const REQUIRE_FORBIDDEN_KEYS = ['sessionId', 'stage', 'playbook', 'needs'] as const;

export const WILDCARD = '*';

// ── the tool index (governable names + their real argument names) ────────────

// toolName -> the set of its inputSchema.properties keys.
export type ToolIndex = Map<string, Set<string>>;

let toolIndexPromise: Promise<ToolIndex> | null = null;

// DYNAMIC import, deliberately. A static `import { buildTools } from
// './mcp/tools.ts'` would close a cycle: tools.ts -> handlers.ts, and
// handlers.ts imports THIS module (the read tools: list_playbooks /
// describe_playbook / playbook_state). Resolving the registry lazily, after
// module init, keeps the dependency one-directional.
export async function loadToolIndex(): Promise<ToolIndex> {
  if (!toolIndexPromise) {
    toolIndexPromise = (async () => {
      const { buildTools } = await import('./mcp/tools.ts');
      const index: ToolIndex = new Map();
      for (const tool of buildTools()) {
        const props = asRecord(asRecord(tool.inputSchema).properties);
        // The same schema gate mcp/server.ts's hasSessionIdProperty applies at
        // the prefix-resolution chokepoint: a tool is targeted iff it declares a
        // `sessionId`. spawn_instance is governed by the stage it enters.
        const governable = (!!props.sessionId) || tool.name === 'spawn_instance';
        if (governable) index.set(tool.name, new Set(Object.keys(props)));
      }
      return index;
    })();
  }
  return toolIndexPromise;
}

export function governableToolNames(index: ToolIndex): string[] {
  return [...index.keys()].sort();
}

// ── definition types (post-validation: defaults applied) ────────────────────

export type RequireLiteral = string | number | boolean | null;
export type ToolPolicy = 'allow' | 'deny' | { require: Record<string, RequireLiteral> };

export interface NeedsEntry {
  stage: string;
  // "current" (default) — the target is in that stage NOW: a handoff.
  // "ever"              — the target has passed through it: provenance.
  at: 'current' | 'ever';
}

export interface Stage {
  needs: NeedsEntry[];
  workers: 'one' | 'many';
  tools: Record<string, ToolPolicy>;
}

export interface Transition {
  from: string;
  to: string;
  // A declared `on` names the tool that drives this edge — and THAT TOOL ONLY,
  // so send_prompt cannot sneak a worker past it. An edge with no `on` is driven
  // by send_prompt (which always carries `stage`).
  on?: string;
}

export interface Playbook {
  id: string;
  name: string;
  description: string;
  entryStages: string[];
  stages: Record<string, Stage>;
  transitions: Transition[];
}

const STAGE_KEYS = new Set(['needs', 'workers', 'tools']);
const PLAYBOOK_KEYS = new Set(['id', 'name', 'description', 'entryStages', 'stages', 'transitions']);
const TRANSITION_KEYS = new Set(['from', 'to', 'on']);
const NEEDS_KEYS = new Set(['stage', 'at']);
const WORKERS_VALUES = new Set(['one', 'many']);
const AT_VALUES = new Set(['current', 'ever']);

// ── validator ───────────────────────────────────────────────────────────────

export type ValidateResult =
  | { ok: true; playbook: Playbook }
  | { ok: false; errors: string[] };

// Pure and synchronous. `index` is the tool index (see loadToolIndex) — passed
// in rather than fetched so this stays a pure function of its arguments.
export function validatePlaybook(raw: unknown, id: string, index: ToolIndex): ValidateResult {
  const errors: string[] = [];
  const err = (m: string): void => { errors.push(m); };

  if (!isRecord(raw)) return { ok: false, errors: [`playbook '${id}' must be a JSON object`] };

  for (const k of Object.keys(raw)) {
    if (!PLAYBOOK_KEYS.has(k)) err(`unknown top-level key '${k}' (allowed: ${[...PLAYBOOK_KEYS].join(', ')})`);
  }

  // id must be a valid slug and must match the file it came from.
  try { validateSlug(String(raw.id)); } catch { err(`invalid id '${String(raw.id)}' (must match ^[a-z][a-z0-9-]*$, max 40 chars)`); }
  if (raw.id !== id) err(`id '${String(raw.id)}' does not match its filename id '${id}'`);
  for (const field of ['name', 'description'] as const) {
    if (typeof raw[field] !== 'string' || !raw[field].trim()) err(`${field} is required and must be a non-empty string`);
  }

  if (!isRecord(raw.stages) || Object.keys(raw.stages).length === 0) {
    // Everything below indexes into stages; without them there is nothing to check.
    err('stages must be a non-empty object');
    return { ok: false, errors };
  }
  const stageNames = new Set(Object.keys(raw.stages));

  const entryStages: string[] = [];
  if (!Array.isArray(raw.entryStages)) {
    err('entryStages must be an array of stage names');
  } else {
    for (const s of raw.entryStages) {
      if (typeof s !== 'string') { err('entryStages entries must be strings'); continue; }
      if (!stageNames.has(s)) err(`entryStages names unknown stage '${s}'`);
      else entryStages.push(s);
    }
  }

  // ── stages ──
  const stages: Record<string, Stage> = {};
  for (const [name, rawStageU] of Object.entries(raw.stages)) {
    if (!isRecord(rawStageU)) { err(`stage '${name}' must be an object`); continue; }
    const rawStage = rawStageU;
    for (const k of Object.keys(rawStage)) {
      if (!STAGE_KEYS.has(k)) err(`stage '${name}': unknown key '${k}' (allowed: ${[...STAGE_KEYS].join(', ')})`);
    }

    // needs — default []
    const needs: NeedsEntry[] = [];
    if (rawStage.needs !== undefined) {
      if (!Array.isArray(rawStage.needs)) err(`stage '${name}': needs must be an array`);
      else for (const nU of rawStage.needs) {
        if (!isRecord(nU)) { err(`stage '${name}': each needs entry must be an object`); continue; }
        for (const k of Object.keys(nU)) {
          if (!NEEDS_KEYS.has(k)) err(`stage '${name}': needs entry has unknown key '${k}' (allowed: ${[...NEEDS_KEYS].join(', ')})`);
        }
        const target = nU.stage;
        if (typeof target !== 'string' || !stageNames.has(target)) {
          err(`stage '${name}': needs names unknown stage '${String(target)}'`);
          continue;
        }
        const at = nU.at === undefined ? 'current' : nU.at;
        if (typeof at !== 'string' || !AT_VALUES.has(at)) {
          err(`stage '${name}': needs.at must be one of ${[...AT_VALUES].join(' | ')} (got ${JSON.stringify(nU.at)})`);
          continue;
        }
        needs.push({ stage: target, at: at as 'current' | 'ever' });
      }
    }

    // workers — default "one"
    let workers: 'one' | 'many' = 'one';
    if (rawStage.workers !== undefined) {
      if (typeof rawStage.workers !== 'string' || !WORKERS_VALUES.has(rawStage.workers)) {
        err(`stage '${name}': workers must be one of ${[...WORKERS_VALUES].join(' | ')} (got ${JSON.stringify(rawStage.workers)})`);
      } else {
        workers = rawStage.workers as 'one' | 'many';
      }
    }

    // tools — default {} (all allowed, except spawn_instance which fails closed)
    const tools: Record<string, ToolPolicy> = {};
    if (rawStage.tools !== undefined) {
      if (!isRecord(rawStage.tools)) {
        err(`stage '${name}': tools must be an object mapping tool name -> policy`);
      } else {
        for (const [toolName, policy] of Object.entries(rawStage.tools)) {
          const checked = validateToolPolicy({ stage: name, toolName, policy, index, err });
          if (checked) tools[toolName] = checked;
        }
      }
    }

    stages[name] = { needs, workers, tools };
  }

  // ── spawnability rules ──
  const spawnable = (name: string): boolean => isSpawnable(stages[name]);

  for (const s of entryStages) {
    // An entry stage a run cannot actually start in is a definition bug.
    if (stages[s] && !spawnable(s)) {
      err(`entryStages names '${s}', which does not declare spawn_instance in its tools map — ` +
          'an entry stage must be spawnable. spawn_instance defaults to "deny" and a "*" entry does NOT ' +
          'confer spawnability: name spawn_instance explicitly.');
    }
  }

  // Run identity is DERIVED from `needs` edges, so a stage that is spawnable but
  // declares no needs and is not an entry stage produces a worker in no
  // component — a run of one, floating free of the graph it was meant to join.
  for (const [name, stage] of Object.entries(stages)) {
    if (isSpawnable(stage) && !entryStages.includes(name) && stage.needs.length === 0) {
      err(`stage '${name}' declares spawn_instance but is neither listed in entryStages nor declares a ` +
          'non-empty `needs` — a worker spawned into it would belong to no run');
    }
  }

  // ── transitions ──
  const transitions: Transition[] = [];
  const seenEdges = new Set<string>();
  // "<from>:<on>" — the driver-uniqueness index (see the duplicate-driver check).
  const seenDrivers = new Set<string>();
  if (!Array.isArray(raw.transitions)) {
    err('transitions must be an array');
  } else {
    for (const tU of raw.transitions) {
      if (!isRecord(tU)) { err('each transition must be an object'); continue; }
      for (const k of Object.keys(tU)) {
        if (!TRANSITION_KEYS.has(k)) err(`transition has unknown key '${k}' (allowed: ${[...TRANSITION_KEYS].join(', ')})`);
      }
      const from = tU.from; const to = tU.to;
      let bad = false;
      for (const [field, val] of [['from', from], ['to', to]] as const) {
        if (typeof val !== 'string' || !stageNames.has(val)) {
          err(`transition ${field} names unknown stage '${String(val)}'`);
          bad = true;
        }
      }
      if (bad) continue;
      const edge = `${String(from)}->${String(to)}`;
      if (seenEdges.has(edge)) { err(`duplicate transition ${edge}`); continue; }
      seenEdges.add(edge);
      const t: Transition = { from: from as string, to: to as string };
      if (tU.on !== undefined) {
        const on = tU.on;
        if (typeof on !== 'string' || !index.has(on)) {
          err(`transition ${edge}: on names '${String(on)}', which is not a governable tool ` +
              `(governable: ${governableToolNames(index).join(', ')})`);
        } else if (on === 'spawn_instance') {
          err(`transition ${edge}: on cannot be spawn_instance — spawn_instance enters a stage, it does not move a worker between stages`);
        } else if (on === 'send_prompt') {
          err(`transition ${edge}: on cannot be send_prompt — send_prompt is the DEFAULT driver for an edge with no \`on\`, so declaring it is an ambiguous no-op`);
        } else if (seenDrivers.has(`${String(from)}:${on}`)) {
          // Two edges out of the same stage driven by the same tool: resolveMove
          // resolves a driver by (from, on) and takes the FIRST match, so the
          // second edge would be silently dead. Ambiguous, so refuse it here
          // rather than let file order decide which transition happens.
          err(`transition ${edge}: '${on}' already drives another transition out of '${String(from)}' — ` +
              'a tool can drive at most one edge per stage, or which destination fires would depend on file order');
        } else {
          t.on = on;
          seenDrivers.add(`${String(from)}:${on}`);
        }
      }
      transitions.push(t);
    }
  }

  // ── reachability ──
  for (const name of stageNames) {
    if (entryStages.includes(name)) continue;
    if (stages[name] && isSpawnable(stages[name])) continue;
    if (transitions.some(t => t.to === name)) continue;
    err(`stage '${name}' is unreachable — not an entry stage, does not declare spawn_instance, and has no inbound transition`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    playbook: {
      id,
      name: String(raw.name),
      description: String(raw.description),
      entryStages,
      stages,
      transitions,
    },
  };
}

function validateToolPolicy(
  { stage, toolName, policy, index, err }:
  { stage: string; toolName: string; policy: unknown; index: ToolIndex; err: (m: string) => void },
): ToolPolicy | null {
  if (toolName !== WILDCARD && !index.has(toolName)) {
    err(`stage '${stage}': '${toolName}' is not a governable tool — policy is targeted-only, so only tools ` +
        `taking a sessionId (plus spawn_instance) can be governed. Governable: ${governableToolNames(index).join(', ')}`);
    return null;
  }
  if (policy === 'allow' || policy === 'deny') return policy;
  if (!isRecord(policy) || !('require' in policy) || Object.keys(policy).length !== 1) {
    err(`stage '${stage}': tools.${toolName} must be "allow", "deny", or { "require": {...} } (got ${JSON.stringify(policy)})`);
    return null;
  }
  if (toolName === WILDCARD) {
    err(`stage '${stage}': the "${WILDCARD}" fallback entry cannot carry \`require\` — there is no single tool ` +
        'schema to validate the argument names against. Name the tool explicitly.');
    return null;
  }
  if (!isRecord(policy.require) || Object.keys(policy.require).length === 0) {
    err(`stage '${stage}': tools.${toolName}.require must be a non-empty object of argument -> literal value`);
    return null;
  }
  const props = index.get(toolName) as Set<string>;
  const out: Record<string, RequireLiteral> = {};
  for (const [arg, val] of Object.entries(policy.require)) {
    // ORDER IS LOAD-BEARING: the forbidden-key check must precede the
    // exists-in-inputSchema check. spawn_instance does not (yet) declare
    // `playbook`/`stage`/`needs` as arguments, so checking existence first would
    // report a `require` on `stage` as a typo today and silently start reporting
    // it as a policy-layer input once those arguments are added. A test pins
    // this precedence.
    if ((REQUIRE_FORBIDDEN_KEYS as readonly string[]).includes(arg)) {
      err(`stage '${stage}': tools.${toolName}.require cannot constrain '${arg}' — it is a policy-layer ` +
          'input (the stage/playbook/worker this call is about), not an ordinary tool argument. ' +
          'Note `require` constrains ARGUMENT VALUES; to require a worker in another stage use the stage\'s `needs`.');
      continue;
    }
    if (!props.has(arg)) {
      err(`stage '${stage}': tools.${toolName}.require names '${arg}', which is not an argument of ` +
          `${toolName} (arguments: ${[...props].sort().join(', ')})`);
      continue;
    }
    if (val !== null && typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean') {
      err(`stage '${stage}': tools.${toolName}.require.${arg} must be a literal string, number, boolean or null ` +
          '(there is no expression language)');
      continue;
    }
    out[arg] = val;
  }
  return { require: out };
}

// A stage is spawnable iff it EXPLICITLY declares spawn_instance as "allow" or
// {require:…}. Deliberately NOT resolvePolicy(): a `"*"` wildcard must never
// confer spawnability.
//
// This is where the schema's two rules would otherwise collide — the general
// lookup rule ("exact name, else the `"*"` entry, else the default") and the
// fail-closed rule ("a stage is spawnable only if it DECLARES spawn_instance").
// Fail-closed wins, because the entire point of the default is that forgetting
// one line must not let the conductor spawn straight into `implement` and skip
// planning; a wildcard silently rescuing that omission is precisely the failure
// the rule exists to prevent. Creating a worker is the one irreversible entry
// into the graph, so it is the one tool that must be named to be permitted.
//
// resolvePolicy keeps its general lookup for every other tool, including for
// spawn_instance's `require` constraints once a stage IS spawnable.
export function isSpawnable(stage: Stage | undefined): boolean {
  if (!stage) return false;
  const declared = stage.tools['spawn_instance'];
  return declared !== undefined && declared !== 'deny';
}

// One-step lookup: exact tool name, else the "*" entry, else the default —
// "deny" for spawn_instance, "allow" for everything else.
//
// NOTE: spawnability does NOT go through here — see isSpawnable. A `"*"` entry
// answers "may this tool be called on a worker in this stage", which for
// spawn_instance is a different question from "may a worker be CREATED here".
export function resolvePolicy(stage: Stage, toolName: string): ToolPolicy {
  const exact = stage.tools[toolName];
  if (exact !== undefined) return exact;
  const wild = stage.tools[WILDCARD];
  if (wild !== undefined) return wild;
  return toolName === 'spawn_instance' ? 'deny' : 'allow';
}

// ── catalog ─────────────────────────────────────────────────────────────────

// Built-ins from playbooks/<id>.json via the shared fragment-catalog factory
// (seedExt: '.json'); the user overlay is a DIRECTORY of hand-authored files at
// <orchStoreRoot>/playbooks/*.json, read through the factory's extraProvider
// hook so there is no second discovery layer. Bodies come back as raw JSON
// strings which getPlaybooks() parses. No CRUD surface: playbooks are authored
// as files, not through the UI.
const catalog = createFragmentCatalog({
  seeds: SEED_PLAYBOOK_IDS.map(slug => ({ slug, name: '', description: '' })),
  seedDir: PLAYBOOKS_DIR,
  seedExt: '.json',
  // Never called (no CRUD), but the factory requires it and it must stay lazy so
  // a PROJECTS_ROOT override in tests is honoured per-call.
  storeFile: () => path.join(orchStoreRoot(), 'playbooks', 'custom.json'),
  noun: 'playbook',
  extraProvider: userPlaybookFiles,
});

async function userPlaybookFiles(): Promise<ExtraEntry[]> {
  const dir = path.join(orchStoreRoot(), 'playbooks');
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if (errCode(e) === 'ENOENT') return [];
    throw e;
  }
  const out: ExtraEntry[] = [];
  for (const n of names.sort()) {
    if (!n.endsWith('.json') || n === 'custom.json') continue;
    const slug = n.slice(0, -'.json'.length);
    try {
      out.push({ slug, name: '', description: '', body: await fs.readFile(path.join(dir, n), 'utf8') });
    } catch (e) {
      console.warn(`playbooks: failed to read ${path.join(dir, n)}: ${errMsg(e)}`);
    }
  }
  return out;
}

export interface LoadResult {
  playbooks: Map<string, Playbook>;
  errors: Array<{ id: string; message: string }>;
}

// Load and validate every definition. A bad definition is REJECTED AT LOAD TIME
// (excluded from the map and reported) rather than blowing up at spawn time. A
// user-overlay file with the same id as a built-in overrides it.
export async function loadPlaybooks(): Promise<LoadResult> {
  const index = await loadToolIndex();
  const entries = await catalog.getCatalog();
  const playbooks = new Map<string, Playbook>();
  const errors: Array<{ id: string; message: string }> = [];
  for (const entry of entries) {
    const id = entry.slug;
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.body ?? '');
    } catch (e) {
      errors.push({ id, message: `not valid JSON: ${errMsg(e)}` });
      continue;
    }
    const res = validatePlaybook(parsed, id, index);
    if (res.ok) playbooks.set(id, res.playbook);
    else for (const message of res.errors) errors.push({ id, message });
  }
  return { playbooks, errors };
}

// ── the pure policy decision ────────────────────────────────────────────────

export type RefusalCode =
  | 'PLAYBOOK_UNKNOWN' | 'STAGE_UNKNOWN' | 'STAGE_NOT_SPAWNABLE' | 'TRANSITION_ILLEGAL'
  | 'NEEDS_UNSATISFIED' | 'ARG_REQUIRE_CONFLICT' | 'TOOL_DENIED_IN_STAGE' | 'STAGE_AT_CAPACITY'
  | 'PLAYBOOK_MISMATCH';

export interface LegalMoves {
  playbook: string | null;
  stage: string | null;
  // Every edge out of `stage`, with the tool that drives it.
  transitions: Array<{ to: string; via: string }>;
}

// What the call DID to the graph, so step 4 knows what to ledger. A self-edge
// ('self') and an ordinary governed call ('none') move nothing.
export interface Move {
  kind: 'spawn' | 'transition' | 'self' | 'none';
  from?: string;
  to?: string;
  via?: string;
}

export type Decision =
  | { ok: true; patchedArgs: Record<string, unknown>; move: Move }
  | { ok: false; code: RefusalCode; reason: string; legalMoves: LegalMoves };

export interface DecideInput {
  toolName: string;
  args: Record<string, unknown>;
  projection: Projection;
  playbooks: Map<string, Playbook>;
}

export function legalMovesFrom(playbook: Playbook | null, stage: string | null): LegalMoves {
  const transitions = playbook && stage
    ? playbook.transitions.filter(t => t.from === stage).map(t => ({ to: t.to, via: t.on ?? 'send_prompt' }))
    : [];
  return { playbook: playbook?.id ?? null, stage, transitions };
}

// TWO SCOPE RULES, and they are deliberately different:
//   • PERMISSION (`tools`) is read from the worker's CURRENT stage — "may this
//     worker be subjected to this call?"
//   • ENTRY CONDITIONS (`needs`, `require`) are read from the RESULTING stage —
//     the entered stage for a spawn, the destination for a transition, the
//     current stage otherwise. "What must a worker in this stage look like?"
// resolveMove is what makes the split inspectable; implementing it backwards is
// easy, so both directions have their own test.
export interface ResolvedMove {
  currentStage: string | null;
  resultingStage: string | null;
  kind: Move['kind'];
  via?: string;
  // Set when the requested move is not a legal edge.
  illegal?: { code: 'TRANSITION_ILLEGAL' | 'STAGE_UNKNOWN'; reason: string };
}

export function resolveMove(
  { toolName, args, playbook, currentStage }:
  { toolName: string; args: Record<string, unknown>; playbook: Playbook; currentStage: string },
): ResolvedMove {
  // send_prompt ALWAYS carries `stage`, which makes it the default driver.
  if (toolName === 'send_prompt' && typeof args.stage === 'string') {
    const target = args.stage;
    if (target === currentStage) {
      // SELF-EDGE. Implicitly legal and never checked against the edge set, not
      // ledgered as a transition, and it does NOT re-run the stage's `needs`.
      // Load-bearing: every ordinary follow-up prompt is a self-edge, so without
      // this rule every one of them is refused. (The current stage's `tools`
      // permission and its `require` still apply — the resulting stage IS the
      // current stage.)
      return { currentStage, resultingStage: currentStage, kind: 'self' };
    }
    if (!playbook.stages[target]) {
      return {
        currentStage, resultingStage: null, kind: 'none',
        illegal: { code: 'STAGE_UNKNOWN', reason: `'${target}' is not a stage of playbook '${playbook.id}'.` },
      };
    }
    const edge = playbook.transitions.find(t => t.from === currentStage && t.to === target);
    if (!edge) {
      return {
        currentStage, resultingStage: null, kind: 'none',
        illegal: {
          code: 'TRANSITION_ILLEGAL',
          reason: `playbook '${playbook.id}' has no transition ${currentStage} -> ${target}.`,
        },
      };
    }
    if (edge.on) {
      return {
        currentStage, resultingStage: null, kind: 'none',
        illegal: {
          code: 'TRANSITION_ILLEGAL',
          reason: `the ${currentStage} -> ${target} transition fires on '${edge.on}' only — it cannot be ` +
                  `driven by send_prompt. Call ${edge.on} instead.`,
        },
      };
    }
    return { currentStage, resultingStage: target, kind: 'transition', via: 'send_prompt' };
  }
  // A declared `on` auto-fires its edge on success.
  const auto = playbook.transitions.find(t => t.from === currentStage && t.on === toolName);
  if (auto) return { currentStage, resultingStage: auto.to, kind: 'transition', via: toolName };
  return { currentStage, resultingStage: currentStage, kind: 'none' };
}

export function decide({ toolName: rawToolName, args, projection, playbooks }: DecideInput): Decision {
  const toolName = normalizeToolName(rawToolName);
  return toolName === 'spawn_instance'
    ? decideSpawn({ args, projection, playbooks })
    : decideTargeted({ toolName, args, projection, playbooks });
}

// spawn_instance is governed by the stage being ENTERED: there is no "current"
// worker (the conductor itself is in no stage), so that one stage supplies both
// the permission (is it spawnable?) and the entry conditions (needs, require).
function decideSpawn(
  { args, projection, playbooks }:
  { args: Record<string, unknown>; projection: Projection; playbooks: Map<string, Playbook> },
): Decision {
  const needsArg = isRecord(args.needs) ? args.needs : {};
  const suppliedNeeds: Record<string, string> = {};
  for (const [stage, sid] of Object.entries(needsArg)) {
    if (typeof sid === 'string') suppliedNeeds[stage] = sid;
  }
  const noMoves: LegalMoves = { playbook: null, stage: null, transitions: [] };

  // Playbook binding: declared at the run root, inherited along `needs` edges.
  let playbookId: string | null = null;
  const ancestors = Object.values(suppliedNeeds);
  if (ancestors.length > 0) {
    const seen = new Set<string>();
    for (const sid of ancestors) {
      const st = projection.bySession.get(sid);
      if (!st) {
        return refuse('NEEDS_UNSATISFIED',
          `needs names sessionId '${sid}', which is not a playbook-tracked worker — its playbook and stage ` +
          'are unknown, so it cannot satisfy a `needs` entry.', noMoves);
      }
      seen.add(st.playbook);
    }
    if (seen.size > 1) {
      return refuse('PLAYBOOK_MISMATCH',
        `the workers named in \`needs\` disagree about their playbook (${[...seen].sort().join(', ')}) — ` +
        'a spawn inherits one playbook along its `needs` edges.', noMoves);
    }
    playbookId = [...seen][0];
    if (typeof args.playbook === 'string' && args.playbook && args.playbook !== playbookId) {
      return refuse('PLAYBOOK_MISMATCH',
        `playbook '${args.playbook}' was supplied, but this spawn inherits '${playbookId}' from the workers ` +
        'named in `needs`. Omit `playbook` on a non-root spawn, or name the inherited one.', noMoves);
    }
  } else if (typeof args.playbook === 'string' && args.playbook) {
    playbookId = args.playbook;
  } else {
    return refuse('PLAYBOOK_UNKNOWN',
      'this spawn has no `needs`, so it starts a new run and must name a `playbook`. ' +
      `Known playbooks: ${[...playbooks.keys()].sort().join(', ') || '(none)'}.`, noMoves);
  }

  const playbook = playbooks.get(playbookId);
  if (!playbook) {
    return refuse('PLAYBOOK_UNKNOWN',
      `no playbook '${playbookId}'. Known playbooks: ${[...playbooks.keys()].sort().join(', ') || '(none)'}.`,
      noMoves);
  }

  const stageName = typeof args.stage === 'string' ? args.stage : '';
  if (!stageName) {
    return refuse('STAGE_UNKNOWN',
      `spawn_instance must name the \`stage\` to enter. Playbook '${playbook.id}' can be entered at: ` +
      `${playbook.entryStages.join(', ')} (or a stage whose \`needs\` you satisfy).`,
      legalMovesFrom(playbook, null));
  }
  const stage = playbook.stages[stageName];
  if (!stage) {
    return refuse('STAGE_UNKNOWN',
      `playbook '${playbook.id}' has no stage '${stageName}'. Stages: ${Object.keys(playbook.stages).join(', ')}.`,
      legalMovesFrom(playbook, null));
  }

  // Permission for a spawn IS the spawnability check (spawn_instance fails closed).
  if (!isSpawnable(stage)) {
    return refuse('STAGE_NOT_SPAWNABLE',
      `stage '${stageName}' of playbook '${playbook.id}' does not declare spawn_instance, so a worker cannot ` +
      `be created directly in it — it is transition-only. Spawnable stages: ` +
      `${Object.keys(playbook.stages).filter(s => isSpawnable(playbook.stages[s])).join(', ') || '(none)'}.`,
      legalMovesFrom(playbook, stageName));
  }

  // `needs` before capacity: the run whose slots are being counted is the one the
  // `needs` targets belong to, so there is nothing meaningful to count until
  // those targets are known-good. (decideTargeted checks them in the same order.)
  const needsRefusal = checkNeeds({ playbook, stage, stageName, suppliedNeeds, projection, subject: null });
  if (needsRefusal) return needsRefusal;

  // Capacity is scoped to the RUN (the connected component), not globally. Only
  // a non-root spawn joins an existing run, so a root spawn always has room.
  if (stage.workers === 'one' && ancestors.length > 0) {
    const anchor = ancestors[0];
    if (liveInStage(projection, anchor, stageName) >= 1) {
      return refuse('STAGE_AT_CAPACITY',
        `stage '${stageName}' declares workers:"one" and this run already has a live worker in it. ` +
        'Retire that worker (kill_instance) to free the slot, or use a playbook whose stage declares workers:"many".',
        legalMovesFrom(playbook, stageName));
    }
  }

  return applyRequire({ stage, stageName, playbook, toolName: 'spawn_instance', args, move: { kind: 'spawn', to: stageName } });
}

function decideTargeted(
  { toolName, args, projection, playbooks }:
  { toolName: string; args: Record<string, unknown>; projection: Projection; playbooks: Map<string, Playbook> },
): Decision {
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
  const subject = sessionId ? projection.bySession.get(sessionId) : undefined;
  // Not a playbook-tracked worker (spawned with enforcement off, or not conducted
  // at all) — ungoverned, nothing to check.
  if (!subject) return { ok: true, patchedArgs: args, move: { kind: 'none' } };

  const playbook = playbooks.get(subject.playbook);
  if (!playbook) {
    // §9 settled: definitions are NOT pinned to a run, so a live worker can
    // outlive its definition. Say so plainly — this is not a caller error.
    return refuse('PLAYBOOK_UNKNOWN',
      `worker ${short(sessionId)} is bound to playbook '${subject.playbook}', which is no longer loaded — ` +
      'its definition was removed or renamed while this worker was live. Playbook definitions are not pinned ' +
      'to a running worker. Retire the worker, or restore the definition. ' +
      `Known playbooks: ${[...playbooks.keys()].sort().join(', ') || '(none)'}.`,
      { playbook: subject.playbook, stage: subject.stage, transitions: [] });
  }
  const currentStage = playbook.stages[subject.stage];
  if (!currentStage) {
    return refuse('STAGE_UNKNOWN',
      `worker ${short(sessionId)} is in stage '${subject.stage}', which no longer exists in playbook ` +
      `'${playbook.id}' — the definition was edited while this worker was live, and playbooks are not pinned ` +
      `to a running worker. This is not a problem with your call. Stages now: ` +
      `${Object.keys(playbook.stages).join(', ')}. Retire the worker, or restore the stage.`,
      { playbook: playbook.id, stage: subject.stage, transitions: [] });
  }

  // ── SCOPE RULE 1: permission from the CURRENT stage ──
  const policy = resolvePolicy(currentStage, toolName);
  if (policy === 'deny') {
    return refuse('TOOL_DENIED_IN_STAGE',
      `${toolName} is denied for a worker in stage '${subject.stage}' of playbook '${playbook.id}'.`,
      legalMovesFrom(playbook, subject.stage));
  }

  const moved = resolveMove({ toolName, args, playbook, currentStage: subject.stage });
  if (moved.illegal) {
    return refuse(moved.illegal.code,
      `worker ${short(sessionId)} is in stage '${subject.stage}': ${moved.illegal.reason}`,
      legalMovesFrom(playbook, subject.stage));
  }

  // ── SCOPE RULE 2: needs + require from the RESULTING stage ──
  const resultingName = moved.resultingStage as string;
  const resulting = playbook.stages[resultingName];
  const move: Move =
    moved.kind === 'transition'
      ? { kind: 'transition', from: subject.stage, to: resultingName, via: moved.via }
      : { kind: moved.kind };

  // A self-edge does NOT re-run the stage's `needs` (and neither does a call
  // that moves nothing) — only an ENTRY into a stage does.
  if (moved.kind === 'transition') {
    const suppliedNeeds: Record<string, string> = {};
    if (isRecord(args.needs)) {
      for (const [s, sid] of Object.entries(args.needs)) if (typeof sid === 'string') suppliedNeeds[s] = sid;
    }
    const needsRefusal = checkNeeds({
      playbook, stage: resulting, stageName: resultingName, suppliedNeeds, projection, subject: sessionId,
    });
    if (needsRefusal) return needsRefusal;

    if (resulting.workers === 'one' && liveInStage(projection, sessionId, resultingName) >= 1) {
      return refuse('STAGE_AT_CAPACITY',
        `stage '${resultingName}' declares workers:"one" and this run already has a live worker in it.`,
        legalMovesFrom(playbook, subject.stage));
    }
  }

  return applyRequire({ stage: resulting, stageName: resultingName, playbook, toolName, args, move });
}

// `needs` — WORKER PROVENANCE (not argument values; that is `require`). The
// caller passes {stage: sessionId}; each named worker must be in the run and in
// the named stage, per `at`.
function checkNeeds(
  { playbook, stage, stageName, suppliedNeeds, projection, subject }:
  { playbook: Playbook; stage: Stage; stageName: string; suppliedNeeds: Record<string, string>;
    projection: Projection; subject: string | null },
): Decision | null {
  const moves = legalMovesFrom(playbook, stageName);
  for (const need of stage.needs) {
    const sid = suppliedNeeds[need.stage];
    if (!sid) {
      return refuse('NEEDS_UNSATISFIED',
        `stage '${stageName}' of playbook '${playbook.id}' requires a worker ${need.at === 'ever' ? 'that has passed through' : 'currently in'} ` +
        `stage '${need.stage}': pass needs: { "${need.stage}": "<sessionId>" }. ` +
        '(`needs` names another WORKER — it is not the same as `require`, which pins argument values.)',
        moves);
    }
    const target = projection.bySession.get(sid);
    if (!target) {
      return refuse('NEEDS_UNSATISFIED',
        `needs.${need.stage} names sessionId '${sid}', which is not a playbook-tracked worker.`, moves);
    }
    if (target.playbook !== playbook.id) {
      return refuse('PLAYBOOK_MISMATCH',
        `needs.${need.stage} names a worker on playbook '${target.playbook}', not '${playbook.id}'.`, moves);
    }
    if (need.at === 'current') {
      if (!target.live || target.stage !== need.stage) {
        return refuse('NEEDS_UNSATISFIED',
          `needs.${need.stage} requires worker ${short(sid)} to be in stage '${need.stage}' right now, but it is ` +
          `${target.live ? `in '${target.stage}'` : `retired (last in '${target.stage}')`}. ` +
          `A stage that should accept a worker which has merely PASSED THROUGH '${need.stage}' must declare ` +
          'needs.at:"ever".',
          moves);
      }
    } else if (!hasEverBeen(projection, sid, need.stage)) {
      return refuse('NEEDS_UNSATISFIED',
        `needs.${need.stage} requires worker ${short(sid)} to have passed through stage '${need.stage}', but its ` +
        `history is: ${target.stageHistory.join(' -> ')}.`, moves);
    }
    // Run scoping. On a TRANSITION the subject already belongs to a run, so a
    // worker from another run cannot satisfy its entry conditions — this is what
    // keeps two concurrent runs of the same playbook independent. On a SPAWN the
    // `needs` edges are what DEFINE the run, so there is nothing to compare
    // against yet; instead every named worker must already share one component,
    // or the new worker's run would be ambiguous.
    const anchor = subject ?? Object.values(suppliedNeeds)[0];
    if (anchor && anchor !== sid && runRootOf(projection, anchor) !== null && !sameRun(projection, anchor, sid)) {
      return refuse('NEEDS_UNSATISFIED',
        `needs.${need.stage} names worker ${short(sid)}, which belongs to a different run than ` +
        `${short(anchor)}. \`needs\` is scoped to one run — a worker from another run cannot satisfy it.`,
        moves);
    }
  }
  return null;
}

// `require` — ARGUMENT VALUES (not worker provenance; that is `needs`). Omitted
// by the caller ⇒ filled in; supplied and mismatched ⇒ refused. A hard
// constraint, never an overridable default.
function applyRequire(
  { stage, stageName, playbook, toolName, args, move }:
  { stage: Stage; stageName: string; playbook: Playbook; toolName: string;
    args: Record<string, unknown>; move: Move },
): Decision {
  const policy = resolvePolicy(stage, toolName);
  if (typeof policy === 'string') return { ok: true, patchedArgs: args, move };
  const patched: Record<string, unknown> = { ...args };
  for (const [arg, want] of Object.entries(policy.require)) {
    if (!(arg in args) || args[arg] === undefined) {
      patched[arg] = want;
      continue;
    }
    if (args[arg] !== want) {
      return refuse('ARG_REQUIRE_CONFLICT',
        `stage '${stageName}' of playbook '${playbook.id}' requires ${toolName} to be called with ` +
        `${arg}=${JSON.stringify(want)}, but ${JSON.stringify(args[arg])} was supplied. This is a hard ` +
        'constraint, not a default — omit the argument and it will be filled in.',
        legalMovesFrom(playbook, stageName));
    }
  }
  return { ok: true, patchedArgs: patched, move };
}

function refuse(code: RefusalCode, reason: string, legalMoves: LegalMoves): Decision {
  return { ok: false, code, reason, legalMoves };
}

function short(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function asRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
