// Playbooks — the definition catalog, the load-time graph validator, and the
// pure policy decision `decide()`.
//
// A playbook is a JSON graph of STAGES. Workers are bound to a stage; the
// conductor states its intent on the calls that create or move workers; this
// module verifies the move against the graph. Playbooks govern only the
// CONDUCTOR's tool calls — worker-side calls keep their existing recursion rules.
//
// The two entry conditions a stage can declare:
//   • `needs` — WORKER PROVENANCE: which other worker must exist, in which
//               stage. Supplied at the call site as `provenance`.
//   • `pin`   — ARGUMENT VALUES: what one tool call's arguments must be.
//
// GOVERNABLE SURFACE (targeted-only policy scope). A tool is governable iff its
// inputSchema declares a `sessionId` — it names a worker — plus `spawn_instance`,
// which is governed by the stage being ENTERED. A tool declaring no `sessionId`
// names no worker for policy to be read from, so it is ungoverned by construction
// and can never appear in a stage's `tools` map. That gap is accepted. The
// membership of that class is not restated anywhere: governableToolNames()
// computes it from buildTools(), and a hand-maintained copy would drift.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { orchStoreRoot } from './projects.ts';
import { createFragmentCatalog, validateSlug, type ExtraEntry } from './fragmentCatalog.ts';
import {
  type Projection, type WorkerState, hasEverBeen, liveSessionsInStage, runRootOf, sameRun,
} from './playbookLedger.ts';

const PLAYBOOKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'playbooks');

// The ids of the built-in playbooks. Bodies live in playbooks/<id>.json, and
// each body owns its own `name`/`description` — restating them here would be a
// second source that drifts, so the catalog seeds carry the id only and
// getPlaybooks() reads the metadata from the parsed body.
export const SEED_PLAYBOOK_IDS = ['solo', 'relay', 'freeform'] as const;

// The playbook an unset Settings selection resolves to (see
// resolveDefaultPlaybookId in conductorConventions.ts). Typed to the seed union
// so a typo is a compile error rather than a silently empty prompt section.
export const DEFAULT_PLAYBOOK_ID: typeof SEED_PLAYBOOK_IDS[number] = 'relay';

export const TOOL_NAME_PREFIX = 'mcp__code-conductor__';

// The registered server-side tool name, with the MCP namespace prefix stripped.
// A conductor may name either form; policy maps are written bare.
export function normalizeToolName(name: string): string {
  return name.startsWith(TOOL_NAME_PREFIX) ? name.slice(TOOL_NAME_PREFIX.length) : name;
}

// `pin` may never constrain the policy layer's OWN inputs — constraining
// their value is meaningless or actively harmful.
export const PIN_FORBIDDEN_KEYS = ['sessionId', 'stage', 'playbook', 'provenance'] as const;

export const WILDCARD = '*';

// Per-conductor-session enforcement level. The single home for the allow-list:
//   • 'warn'    — the refusal is ledgered and the call PROCEEDS anyway.
//   • 'enforce' — the refusal is returned to the caller.
// Both levels check, patch and ledger; neither is inert. DEFAULT_ is the
// fallback for the persisted Settings default (getDefaultPlaybookEnforcement in
// conductorConventions.ts), which is what a new conductor is born at.
export const PLAYBOOK_ENFORCEMENT_MODES = ['warn', 'enforce'] as const;
export type PlaybookEnforcement = typeof PLAYBOOK_ENFORCEMENT_MODES[number];
export const DEFAULT_PLAYBOOK_ENFORCEMENT: PlaybookEnforcement = 'enforce';

export function isPlaybookEnforcement(v: unknown): v is PlaybookEnforcement {
  return typeof v === 'string' && (PLAYBOOK_ENFORCEMENT_MODES as readonly string[]).includes(v);
}

// Absorbs the retired 'off' level off a value that predates the two-level model.
// Read-time tolerance is warranted for exactly one store — pending-resume.json,
// written by the previous build during a graceful drain and consumed once at the
// next boot — so there is no durable state left for a migration to rewrite.
//
// 'off' always lands on 'warn', never on DEFAULT_PLAYBOOK_ENFORCEMENT: bringing a
// session that was running unenforced back as enforced is a silent UPGRADE, the
// mirror of the silent downgrade src/resumeRestart.ts carries this field to
// avoid. This must hold regardless of what the shipped default currently is.
export function normalizePlaybookEnforcement(v: unknown): PlaybookEnforcement {
  if (v === 'off') return 'warn';
  return isPlaybookEnforcement(v) ? v : DEFAULT_PLAYBOOK_ENFORCEMENT;
}

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

export type PinLiteral = string | number | boolean | null;
export type ToolPolicy = 'allow' | 'deny' | { pin: Record<string, PinLiteral> };

export interface NeedsEntry {
  // ANCHOR. Two jobs, deliberately one field: the stage the named worker must
  // have PASSED THROUGH (provenance, from stageHistory), and the key the caller
  // supplies its sessionId under (`provenance: {"<stage>": "<sessionId>"}`).
  stage: string;
  // Acceptable CURRENT stages, defaulting to [stage] — the strict handoff. A
  // longer list is the loosening, and it is legible: a reader can check it
  // against the graph, which a quantifier like "ever" does not allow. ["*"]
  // drops the check entirely, leaving provenance as the only constraint.
  position: string[];
  // "live" (default) — the worker is still running.
  // "retired"        — it is gone: an enforced handoff, not advice.
  // "any"            — no liveness check.
  // Answered from InstanceManager.isSessionLive (the `isLive` DecideInput
  // parameter) — THE liveness authority, never a ledger-side projection.
  liveness: 'live' | 'retired' | 'any';
}

export interface Stage {
  needs: NeedsEntry[];
  workers: 'one' | 'many';
  tools: Record<string, ToolPolicy>;
  // The conductor's MOVE at this stage — what it does and what it expects back.
  // Never a restatement of `tools`/`needs`/the graph: those are enforced here and
  // reported by describe_playbook, so a paraphrase is duplication that can drift.
  // ABSENT unless authored (see readDescription).
  description?: string;
}

export interface Transition {
  from: string;
  to: string;
  // A declared `on` names the tool that drives this edge — and THAT TOOL ONLY,
  // so send_prompt cannot sneak a worker past it. An edge with no `on` is driven
  // by send_prompt (which always carries `stage`).
  on?: string;
  // Reserved for the rare edge whose conductor move is not already implied by the
  // destination stage's `description` + `needs`. `on`'s semantics arrive via that
  // tool's own schema, so most edges need nothing here.
  description?: string;
}

export interface Playbook {
  id: string;
  name: string;
  description: string;
  entryStages: string[];
  stages: Record<string, Stage>;
  transitions: Transition[];
}

// The validator's allowlists. EXPORTED FOR SCHEMA-BINDING IN TESTS — do not
// re-privatise them: tests/mcp-text-render.test.mjs reads them to assert that
// describe_playbook's rendering carries every field the schema admits, so a
// field added here fails loudly instead of vanishing from that tool's output.
export const STAGE_KEYS = new Set(['needs', 'workers', 'tools', 'description']);
export const PLAYBOOK_KEYS = new Set(['id', 'name', 'description', 'entryStages', 'stages', 'transitions']);
export const TRANSITION_KEYS = new Set(['from', 'to', 'on', 'description']);
// Exported for the same reason, and it matters more here: `needs` is rendered as
// a composed cell rather than field-by-field, so a new axis silently dropping
// out of describe_playbook's text is exactly the failure that binding catches.
export const NEEDS_KEYS = new Set(['stage', 'position', 'liveness']);
const WORKERS_VALUES = new Set(['one', 'many']);
const LIVENESS_VALUES = new Set(['live', 'retired', 'any']);

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
        const liveness = nU.liveness === undefined ? 'live' : nU.liveness;
        if (typeof liveness !== 'string' || !LIVENESS_VALUES.has(liveness)) {
          err(`stage '${name}': needs.liveness must be one of ${[...LIVENESS_VALUES].join(' | ')} ` +
              `(got ${JSON.stringify(nU.liveness)})`);
          continue;
        }
        // `position` defaults to the anchor alone — the strict handoff. A
        // loosening must be written out, so the exception is visible where it
        // applies rather than inherited from a word.
        const position = validatePosition({ stage: name, raw: nU.position, anchor: target, stageNames, err });
        if (!position) continue;
        needs.push({ stage: target, position, liveness: liveness as NeedsEntry['liveness'] });
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

    const description = readDescription(rawStage.description, `stage '${name}'`, err);

    stages[name] = { needs, workers, tools, ...(description !== undefined && { description }) };
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
      // After the from/to check, so the message can name the edge it is about.
      const description = readDescription(tU.description, `transition ${edge}`, err);
      if (description !== undefined) t.description = description;
      if (tU.on !== undefined) {
        const on = tU.on;
        if (typeof on !== 'string' || !index.has(on)) {
          err(`transition ${edge}: on names '${String(on)}', which is not a governable tool ` +
              `(governable: ${governableToolNames(index).join(', ')})`);
        } else if (on === 'spawn_instance') {
          err(`transition ${edge}: on cannot be spawn_instance — spawn_instance enters a stage, it does not move a worker between stages`);
        } else if (on === 'send_prompt') {
          err(`transition ${edge}: on cannot be send_prompt — send_prompt is the DEFAULT driver for an edge with no \`on\`, so declaring it is an ambiguous no-op`);
        } else if (from === to) {
          // A self-loop exists ONLY to make the move ledgered; resolveMove
          // answers a self-edge before it ever looks at drivers. An `on` here
          // would also match the driver branch, giving one edge two
          // contradictory paths — one gated, one not.
          err(`transition ${edge}: a self-loop cannot declare \`on\` — it exists only to make the self-edge ` +
              'ledgered, and a driver would make the same edge resolve two different ways');
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
    // A self-loop is not an arrival: it cannot carry a worker INTO the stage, so
    // it must not satisfy reachability the way a real inbound edge does.
    if (transitions.some(t => t.to === name && t.from !== name)) continue;
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

// The optional conductor-facing `description` on a stage or a transition.
//
// No length limit — the gate on what belongs here is editorial, not mechanical.
// But a present-and-blank value is rejected like any other malformed one: it
// would load clean and then render as a dead line wherever descriptions are
// surfaced. Between that rejection and returning `undefined` for an omitted one,
// the field is only ever ABSENT or a non-empty string — so a consumer tests for
// the key rather than comparing against a sentinel, and there is no empty value
// for a renderer to have to special-case.
function readDescription(raw: unknown, where: string, err: (m: string) => void): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !raw.trim()) {
    err(`${where}: description must be a non-empty string (got ${JSON.stringify(raw)})`);
    return undefined;
  }
  return raw;
}

// `needs[].position` — the acceptable CURRENT stages. Absent ⇒ [anchor], the
// strict handoff; every loosening is written out. `["*"]` drops the check.
//
// Returns null (after recording an error) rather than a partial list, so a
// malformed entry never loads as a silently weaker gate than its author wrote.
function validatePosition(
  { stage, raw, anchor, stageNames, err }:
  { stage: string; raw: unknown; anchor: string; stageNames: Set<string>; err: (m: string) => void },
): string[] | null {
  if (raw === undefined) return [anchor];
  if (!Array.isArray(raw)) {
    err(`stage '${stage}': needs.position must be an array of stage names (got ${JSON.stringify(raw)})`);
    return null;
  }
  if (raw.length === 0) {
    err(`stage '${stage}': needs.position must name at least one stage — omit it for the default ` +
        `["${anchor}"], or use ["${WILDCARD}"] to accept any stage`);
    return null;
  }
  const out: string[] = [];
  for (const m of raw) {
    if (typeof m !== 'string') {
      err(`stage '${stage}': needs.position entries must be strings (got ${JSON.stringify(m)})`);
      return null;
    }
    if (m !== WILDCARD && !stageNames.has(m)) {
      err(`stage '${stage}': needs.position names unknown stage '${m}'`);
      return null;
    }
    if (out.includes(m)) {
      err(`stage '${stage}': needs.position lists '${m}' twice`);
      return null;
    }
    out.push(m);
  }
  // A mixed list reads as if the named stages narrowed something, when "*"
  // already accepts everything — so which the author meant is unknowable.
  if (out.includes(WILDCARD) && out.length > 1) {
    err(`stage '${stage}': needs.position cannot mix "${WILDCARD}" with named stages — "${WILDCARD}" already ` +
        'accepts any stage, so the named ones would be dead');
    return null;
  }
  return out;
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
  if (!isRecord(policy) || !('pin' in policy) || Object.keys(policy).length !== 1) {
    err(`stage '${stage}': tools.${toolName} must be "allow", "deny", or { "pin": {...} } (got ${JSON.stringify(policy)})`);
    return null;
  }
  if (toolName === WILDCARD) {
    err(`stage '${stage}': the "${WILDCARD}" fallback entry cannot carry \`pin\` — there is no single tool ` +
        'schema to validate the argument names against. Name the tool explicitly.');
    return null;
  }
  if (!isRecord(policy.pin) || Object.keys(policy.pin).length === 0) {
    err(`stage '${stage}': tools.${toolName}.pin must be a non-empty object of argument -> literal value`);
    return null;
  }
  const props = index.get(toolName) as Set<string>;
  const out: Record<string, PinLiteral> = {};
  for (const [arg, val] of Object.entries(policy.pin)) {
    // ORDER IS LOAD-BEARING: the forbidden-key check must precede the
    // exists-in-inputSchema check, so a `pin` on a policy-layer input always
    // reports as one rather than as a typo. WHICH of PIN_FORBIDDEN_KEYS a given
    // tool declares varies — spawn_instance declares `playbook`/`stage`/
    // `provenance` but no `sessionId`; set_mode is the reverse, declaring
    // `sessionId` alone — so exists-first would report a `pin` on `sessionId` as an
    // unknown argument of spawn_instance, and would keep changing its message as
    // tool schemas gain or lose those properties. A test pins this precedence.
    if ((PIN_FORBIDDEN_KEYS as readonly string[]).includes(arg)) {
      err(`stage '${stage}': tools.${toolName}.pin cannot constrain '${arg}' — it is a policy-layer ` +
          'input (the stage/playbook/worker this call is about), not an ordinary tool argument.');
      continue;
    }
    if (!props.has(arg)) {
      err(`stage '${stage}': tools.${toolName}.pin names '${arg}', which is not an argument of ` +
          `${toolName} (arguments: ${[...props].sort().join(', ')})`);
      continue;
    }
    if (val !== null && typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean') {
      err(`stage '${stage}': tools.${toolName}.pin.${arg} must be a literal string, number, boolean or null ` +
          '(there is no expression language)');
      continue;
    }
    out[arg] = val;
  }
  return { pin: out };
}

// A stage is spawnable iff it EXPLICITLY declares spawn_instance as "allow" or
// {pin:…}. Deliberately NOT resolvePolicy(): a `"*"` wildcard must never
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
// spawn_instance's `pin` constraints once a stage IS spawnable.
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
  | 'NEEDS_UNSATISFIED' | 'NEEDS_WORKER_GONE' | 'ARG_PIN_CONFLICT' | 'TOOL_DENIED_IN_STAGE' | 'STAGE_AT_CAPACITY'
  | 'PLAYBOOK_MISMATCH' | 'FORWARD_DENIED_IN_STAGE';

export interface LegalMoves {
  playbook: string | null;
  stage: string | null;
  // Every edge out of `stage`, with the tool that drives it.
  transitions: Array<{ to: string; via: string }>;
}

// What the call DID to the graph, so the enforcement gate knows what to ledger.
// A self-edge ('self') and an ordinary governed call ('none') move nothing.
export interface Move {
  // 'resume' — spawn_instance({resume}) bringing a playbook-tracked worker back.
  // It carries `to` + `playbook` like a 'spawn', both read off the SESSION RECORD
  // rather than the arguments, but it is a distinct kind because it enters no
  // stage: see decideResume.
  kind: 'spawn' | 'resume' | 'transition' | 'self' | 'none';
  from?: string;
  to?: string;
  via?: string;
  // Set on a 'spawn' only: the playbook the new worker is bound to, which on a
  // non-root spawn is INHERITED from the `provenance` ancestors rather than supplied.
  // Carried here so the gate can write the `spawn` ledger event without
  // re-deriving that inheritance.
  playbook?: string;
  // Set on a 'self' only, when the playbook declares a from===to edge: the gate
  // ledgers this move. Legality is identical either way.
  recorded?: true;
}

export type Decision =
  | { ok: true; patchedArgs: Record<string, unknown>; move: Move }
  | { ok: false; code: RefusalCode; reason: string; legalMoves: LegalMoves };

export interface DecideInput {
  toolName: string;
  args: Record<string, unknown>;
  projection: Projection;
  playbooks: Map<string, Playbook>;
  // THE liveness oracle (InstanceManager.isSessionLive) — REQUIRED, not
  // defaulted: a default reading the projection would be the second liveness
  // authority this module exists to eliminate. Every call site must supply one.
  isLive: (sessionId: string) => boolean;
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
//   • ENTRY CONDITIONS (`needs`, `pin`) are read from the RESULTING stage —
//     the entered stage for a spawn, the destination for a transition, the
//     current stage otherwise. "What must a worker in this stage look like?"
// resolveMove is what makes the split inspectable; implementing it backwards is
// easy, so both directions have their own test.
export interface ResolvedMove {
  currentStage: string | null;
  resultingStage: string | null;
  kind: Move['kind'];
  via?: string;
  // Self-edge only: the playbook DECLARES a from===to edge, so the move is
  // ledgered. Legality is unaffected — see the self-edge branch in resolveMove.
  recorded?: true;
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
      // SELF-EDGE. Implicitly legal and never checked against the edge set, and
      // it does NOT re-run the stage's `needs`. Load-bearing: every ordinary
      // follow-up prompt is a self-edge, so without this rule every one of them
      // is refused. (The current stage's `tools` permission and its `pin`
      // still apply — the resulting stage IS the current stage.)
      //
      // A DECLARED self-loop changes one thing and one thing only: the move is
      // ledgered, so a review/refine round becomes countable. It is NOT routed
      // through the transition branch below — gating it would refuse the
      // follow-up prompts this rule exists to permit.
      const declared = playbook.transitions.some(t => t.from === currentStage && t.to === currentStage);
      return { currentStage, resultingStage: currentStage, kind: 'self', ...(declared && { recorded: true }) };
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
          reason: `the ${currentStage} -> ${target} transition has via:'${edge.on}' — that tool drives it and ` +
                  `nothing else can, so send_prompt cannot. Call ${edge.on} instead.`,
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

export function decide({ toolName: rawToolName, args, projection, playbooks, isLive }: DecideInput): Decision {
  const toolName = normalizeToolName(rawToolName);
  return toolName === 'spawn_instance'
    ? decideSpawn({ args, projection, playbooks, isLive })
    : decideTargeted({ toolName, args, projection, playbooks, isLive });
}

// spawn_instance is governed by the stage being ENTERED: there is no "current"
// worker (the conductor itself is in no stage), so that one stage supplies both
// the permission (is it spawnable?) and the entry conditions (needs, pin).
function decideSpawn(
  { args, projection, playbooks, isLive }:
  { args: Record<string, unknown>; projection: Projection; playbooks: Map<string, Playbook>;
    isLive: (sessionId: string) => boolean },
): Decision {
  const provenanceArg = isRecord(args.provenance) ? args.provenance : {};
  const suppliedProvenance: Record<string, string> = {};
  for (const [stage, sid] of Object.entries(provenanceArg)) {
    if (typeof sid === 'string') suppliedProvenance[stage] = sid;
  }
  const noMoves: LegalMoves = { playbook: null, stage: null, transitions: [] };

  // A RESUME OF A TRACKED WORKER IS NOT A SPAWN. The binding is already on the
  // session record, so it is read from there rather than demanded again — which
  // is what makes the bare spawn_instance({resume}) the SESSION_NOT_LIVE refusal
  // names actually work. A `resume` naming no tracked worker falls through to the
  // run-root logic below, so adopting a loose session by naming playbook + stage
  // is unchanged.
  const resumeId = typeof args.resume === 'string' ? args.resume : '';
  const recorded = resumeId ? projection.bySession.get(resumeId) : undefined;
  if (recorded) return decideResume({ args, resumeId, recorded, playbooks });

  // Playbook binding: declared at the run root, inherited along `needs` edges.
  let playbookId: string | null = null;
  const ancestors = Object.values(suppliedProvenance);
  if (ancestors.length > 0) {
    const seen = new Set<string>();
    for (const sid of ancestors) {
      const st = projection.bySession.get(sid);
      if (!st) {
        return refuse('NEEDS_UNSATISFIED',
          `provenance names sessionId '${sid}', which is not a playbook-tracked worker — its playbook and stage ` +
          'are unknown, so it cannot satisfy a `needs` entry.', noMoves);
      }
      seen.add(st.playbook);
    }
    if (seen.size > 1) {
      return refuse('PLAYBOOK_MISMATCH',
        `the workers named in \`provenance\` disagree about their playbook (${[...seen].sort().join(', ')}) — ` +
        'a spawn inherits one playbook along its `needs` edges.', noMoves);
    }
    playbookId = [...seen][0];
    if (typeof args.playbook === 'string' && args.playbook && args.playbook !== playbookId) {
      return refuse('PLAYBOOK_MISMATCH',
        `playbook '${args.playbook}' was supplied, but this spawn inherits '${playbookId}' from the workers ` +
        'named in `provenance`. Omit `playbook` on a non-root spawn, or name the inherited one.', noMoves);
    }
  } else if (typeof args.playbook === 'string' && args.playbook) {
    playbookId = args.playbook;
  } else if (resumeId) {
    // Reached only when `resume` names a session the ledger holds nothing for —
    // the tracked case returned above. Naming the case matters: the remedy for an
    // untracked session (declare a binding) is not the remedy for a mistyped id
    // (re-send a good one).
    return refuse('PLAYBOOK_UNKNOWN',
      `session ${short(resumeId)} is not playbook-tracked — the ledger holds no playbook/stage for it, ` +
      'so resuming it starts a new run and must name a `playbook` and a `stage`. ' +
      `Known playbooks: ${knownPlaybooksHint(playbooks)}.`, noMoves);
  } else {
    return refuse('PLAYBOOK_UNKNOWN',
      'this spawn has no `provenance`, so it starts a new run and must name a `playbook` and a `stage`. ' +
      `Known playbooks: ${knownPlaybooksHint(playbooks)}.`, noMoves);
  }

  const playbook = playbooks.get(playbookId);
  if (!playbook) {
    return refuse('PLAYBOOK_UNKNOWN',
      `no playbook '${playbookId}'. Known playbooks: ${knownPlaybooksHint(playbooks)}.`,
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
  const needsRefusal = checkNeeds({ playbook, stage, stageName, suppliedProvenance, projection, subject: null, isLive });
  if (needsRefusal) return needsRefusal;

  // Capacity is scoped to the RUN (the connected component), not globally. Only
  // a non-root spawn joins an existing run, so a root spawn always has room.
  if (stage.workers === 'one' && ancestors.length > 0) {
    const anchor = ancestors[0];
    const blockers = liveSessionsInStage(projection, anchor, stageName, isLive);
    if (blockers.length > 0) {
      return refuse('STAGE_AT_CAPACITY',
        capacityReason(stageName, blockers[0]),
        legalMovesFrom(playbook, stageName));
    }
  }

  return applyPin({
    stage, stageName, playbook, toolName: 'spawn_instance', args,
    move: { kind: 'spawn', to: stageName, playbook: playbook.id },
    // ADOPTION — `resume` naming a session the ledger holds nothing for. It
    // genuinely declares a new binding (hence the `spawn` move), but it creates
    // no process, so the spawn-shape half of the pin has no subject. Same rule as
    // decideResume's, stated there.
    ...(resumeId ? { skipPins: SPAWN_SHAPE_PINS } : {}),
  });
}

// spawn_instance({resume}) where the resumed session IS playbook-tracked.
//
// A RESUME IS NOT A STAGE ENTRY — one principle, and it decides every check at
// once: no spawnability, no `needs`, no capacity count. The worker is already
// bound to this stage and already belongs to this run; it is coming back to where
// it was, not arriving. One of those follows necessarily rather than as a
// preference: spawnability — a worker that transitioned into a transition-only
// stage (say solo's `implement`) and then died must still be resumable, and
// isSpawnable is false for exactly those stages.
//
// `pin` SPLITS, and it is the one check a resume does not skip wholesale:
//   • SPAWN-SHAPE keys (SPAWN_SHAPE_PINS, above applyPin) are dropped. relay's
//     `plan` pins createWorktree, and injecting it would hand a resumed session a
//     brand-new worktree — a cwd that by construction holds none of its history.
//   • POLICY keys — `mode`, above all — still apply, filled or refused exactly as
//     on a spawn. Skipping them would be a WIDENING, not a simplification: with
//     no pinned mode and none supplied, _doCreateResolved falls back to
//     effectiveResumeMode(null) = DEFAULT_RESUME_MODE, i.e. bypassPermissions
//     (src/sessionModes.ts) — inside a stage that asked for something narrower.
//     A resume never grants; it re-asserts what the stage declared.
// So `patchedArgs` is the caller's own `args` object whenever the policy
// remainder is empty, which is the common case.
//
// The binding therefore comes off the record, and a supplied one is checked
// against it rather than applied: MATCH-OR-REFUSE, the same rule (and the same
// PLAYBOOK_MISMATCH code) a non-root spawn already uses for an inherited playbook
// — "omit it, or name the recorded one". `playbook` and `stage` are checked
// INDEPENDENTLY: a matching playbook with a differing stage is still a conflict.
function decideResume(
  { args, resumeId, recorded, playbooks }:
  { args: Record<string, unknown>; resumeId: string; recorded: WorkerState; playbooks: Map<string, Playbook> },
): Decision {
  const playbook = playbooks.get(recorded.playbook) ?? null;
  const bound = `'${recorded.playbook}'/'${recorded.stage}'`;
  const moves = legalMovesFrom(playbook, recorded.stage);

  // Same fact as decideTargeted's: definitions are not pinned to a run, so a
  // worker can outlive its own. Refused here rather than resumed into nothing.
  // A recorded STAGE that no longer exists is deliberately not checked — nothing
  // on this path reads the stage object, and the next send_prompt gets
  // decideTargeted's STAGE_UNKNOWN, which explains the same cause.
  if (!playbook) {
    return refuse('PLAYBOOK_UNKNOWN',
      `session ${short(resumeId)} is bound to playbook '${recorded.playbook}', which is no longer loaded — its ` +
      'definition was removed or renamed. Playbook definitions are not pinned to a worker. ' +
      `Known playbooks: ${knownPlaybooksHint(playbooks)}.`, moves);
  }

  if (isRecord(args.provenance) && Object.keys(args.provenance).length > 0) {
    return refuse('PLAYBOOK_MISMATCH',
      `spawn_instance({resume:"${short(resumeId)}"}) restores a worker already bound to ${bound}; a resume enters ` +
      'no stage, so it satisfies no `needs` and takes no `provenance`. Drop `provenance` to resume it, or omit ' +
      '`resume` to spawn a new worker into that stage.', moves);
  }

  const suppliedPlaybook = typeof args.playbook === 'string' && args.playbook ? args.playbook : null;
  const suppliedStage = typeof args.stage === 'string' && args.stage ? args.stage : null;
  if ((suppliedPlaybook !== null && suppliedPlaybook !== recorded.playbook)
      || (suppliedStage !== null && suppliedStage !== recorded.stage)) {
    // BOTH pairs are printed. One refusal has to be enough to retry legally —
    // the same standard the run-root PLAYBOOK_UNKNOWN meets by listing every
    // playbook with its entry stages.
    return refuse('PLAYBOOK_MISMATCH',
      `spawn_instance({resume:"${short(resumeId)}"}) restores a worker already bound to ${bound}, but this call ` +
      `names '${suppliedPlaybook ?? recorded.playbook}'/'${suppliedStage ?? recorded.stage}'. A resume inherits ` +
      'its binding from the session record — omit `playbook`/`stage`, or name the recorded pair.', moves);
  }

  const move: Move = { kind: 'resume', to: recorded.stage, playbook: recorded.playbook };
  // A recorded stage that no longer exists is deliberately not an error here (see
  // the header) — and with no stage object there is simply no pin to read. The
  // resume goes through; the next send_prompt reports STAGE_UNKNOWN.
  const stage = playbook.stages[recorded.stage];
  if (!stage) return { ok: true, patchedArgs: args, move };
  return applyPin({
    stage, stageName: recorded.stage, playbook, toolName: 'spawn_instance', args, move,
    skipPins: SPAWN_SHAPE_PINS,
  });
}

function decideTargeted(
  { toolName, args, projection, playbooks, isLive }:
  { toolName: string; args: Record<string, unknown>; projection: Projection; playbooks: Map<string, Playbook>;
    isLive: (sessionId: string) => boolean },
): Decision {
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
  const subject = sessionId ? projection.bySession.get(sessionId) : undefined;

  // ONE EVALUATION, TWO CONSUMPTION POINTS. The forward source is a second
  // subject of this call (see checkForwardSource), and the ordering is
  // load-bearing in both directions:
  //   • The TARGET's own permission wins when the target is tracked — "you may
  //     not call send_prompt on this worker at all" subsumes any argument-level
  //     objection, and reporting it first costs one round-trip instead of two.
  //   • The source check still fires when the target is UNTRACKED, which is why
  //     it cannot live inside the tracked-subject branch below.
  const forwardRefusal = checkForwardSource({ args, projection, playbooks, subject });

  // Not a playbook-tracked worker (not conducted at all, or spawned before this
  // process began tracking the run) — ungoverned, nothing to check.
  if (!subject) return forwardRefusal ?? { ok: true, patchedArgs: args, move: { kind: 'none' } };

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
  if (forwardRefusal) return forwardRefusal;

  const moved = resolveMove({ toolName, args, playbook, currentStage: subject.stage });
  if (moved.illegal) {
    return refuse(moved.illegal.code,
      `worker ${short(sessionId)} is in stage '${subject.stage}': ${moved.illegal.reason}`,
      legalMovesFrom(playbook, subject.stage));
  }

  // ── SCOPE RULE 2: needs + pin from the RESULTING stage ──
  const resultingName = moved.resultingStage as string;
  const resulting = playbook.stages[resultingName];
  const move: Move =
    moved.kind === 'transition'
      ? { kind: 'transition', from: subject.stage, to: resultingName, via: moved.via }
      : moved.recorded
        ? { kind: 'self', from: subject.stage, to: resultingName, via: 'send_prompt', recorded: true }
        : { kind: moved.kind };

  // A self-edge does NOT re-run the stage's `needs` (and neither does a call
  // that moves nothing) — only an ENTRY into a stage does.
  if (moved.kind === 'transition') {
    const suppliedProvenance: Record<string, string> = {};
    if (isRecord(args.provenance)) {
      for (const [s, sid] of Object.entries(args.provenance)) if (typeof sid === 'string') suppliedProvenance[s] = sid;
    }
    const needsRefusal = checkNeeds({
      playbook, stage: resulting, stageName: resultingName, suppliedProvenance, projection, subject: sessionId, isLive,
    });
    if (needsRefusal) return needsRefusal;

    if (resulting.workers === 'one') {
      const blockers = liveSessionsInStage(projection, sessionId, resultingName, isLive);
      if (blockers.length > 0) {
        return refuse('STAGE_AT_CAPACITY',
          capacityReason(resultingName, blockers[0]),
          legalMovesFrom(playbook, subject.stage));
      }
    }
  }

  return applyPin({ stage: resulting, stageName: resultingName, playbook, toolName, args, move });
}

// `needs` — WORKER PROVENANCE (not argument values; that is `pin`). The
// caller passes {stage: sessionId}; each named worker must be in the run, must
// have passed through the anchor stage, and must satisfy the entry's `liveness`
// and `position`.
//
// LIVENESS IS CHECKED BEFORE POSITION, deliberately: a worker that is both gone
// and moved on should report the gone-ness, which is the more actionable fact
// and the one that subsumes the other. A test pins the order.
// The prose form of one entry, for the "you did not pass it" refusal. The
// strict default renders as plainly as it reads in the definition.
function describeNeed(need: NeedsEntry): string {
  const who = need.liveness === 'live' ? 'live worker'
    : need.liveness === 'retired' ? 'RETIRED worker'
    : 'worker';
  if (need.position.includes(WILDCARD)) return `${who} that has passed through stage '${need.stage}'`;
  const where = need.position.map(s => `'${s}'`).join(' or ');
  return need.position.length === 1 && need.position[0] === need.stage
    ? `${who} in stage ${where}`
    : `${who} that has passed through stage '${need.stage}' and is now in ${where}`;
}

function checkNeeds(
  { playbook, stage, stageName, suppliedProvenance, projection, subject, isLive }:
  { playbook: Playbook; stage: Stage; stageName: string; suppliedProvenance: Record<string, string>;
    projection: Projection; subject: string | null; isLive: (sessionId: string) => boolean },
): Decision | null {
  const moves = legalMovesFrom(playbook, stageName);
  for (const need of stage.needs) {
    const sid = suppliedProvenance[need.stage];
    if (!sid) {
      return refuse('NEEDS_UNSATISFIED',
        `stage '${stageName}' of playbook '${playbook.id}' requires a ${describeNeed(need)}: ` +
        `pass provenance: { "${need.stage}": "<sessionId>" }.`,
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
    // PROVENANCE — the anchor. Always required; it is what the `needs` key means.
    if (!hasEverBeen(projection, sid, need.stage)) {
      return refuse('NEEDS_UNSATISFIED',
        `needs.${need.stage} requires worker ${short(sid)} to have passed through stage '${need.stage}', but its ` +
        `history is: ${target.stageHistory.join(' -> ')}.`, moves);
    }
    // LIVENESS — before position (see the header).
    if (need.liveness === 'live' && !isLive(sid)) {
      return refuse('NEEDS_WORKER_GONE',
        `needs.${need.stage} requires worker ${short(sid)} to still be running, but it has no running process ` +
        `(last known stage '${target.stage}'). This is not a wiring mistake: the worker you named is gone. Spawn ` +
        `a replacement and name that one, or use a stage whose needs declare liveness:"any".`,
        moves);
    }
    if (need.liveness === 'retired' && isLive(sid)) {
      return refuse('NEEDS_UNSATISFIED',
        `needs.${need.stage} requires worker ${short(sid)} to be RETIRED before this stage is entered, but it is ` +
        `still running (in '${target.stage}'). Retire it first: kill_instance({sessionId: "${short(sid)}"}).`,
        moves);
    }
    // POSITION — the acceptable current stages.
    if (!need.position.includes(WILDCARD) && !need.position.includes(target.stage)) {
      return refuse('NEEDS_UNSATISFIED',
        `needs.${need.stage} accepts worker ${short(sid)} only in ${need.position.map(s => `'${s}'`).join(' or ')}, ` +
        `but it is in '${target.stage}'. If '${target.stage}' should be acceptable here, add it to that stage's ` +
        'needs.position.',
        moves);
    }
    // Run scoping. On a TRANSITION the subject already belongs to a run, so a
    // worker from another run cannot satisfy its entry conditions — this is what
    // keeps two concurrent runs of the same playbook independent. On a SPAWN the
    // `needs` edges are what DEFINE the run, so there is nothing to compare
    // against yet; instead every named worker must already share one component,
    // or the new worker's run would be ambiguous.
    const anchor = subject ?? Object.values(suppliedProvenance)[0];
    if (anchor && anchor !== sid && runRootOf(projection, anchor) !== null && !sameRun(projection, anchor, sid)) {
      return refuse('NEEDS_UNSATISFIED',
        `needs.${need.stage} names worker ${short(sid)}, which belongs to a different run than ` +
        `${short(anchor)}. \`needs\` is scoped to one run — a worker from another run cannot satisfy it.`,
        moves);
    }
  }
  return null;
}

// The FORWARD SOURCE — send_prompt's second subject. A forward READS that
// worker's recent output (selectRecentMessages, src/mcp/handlers.ts), so the
// source is checked for `get_recent_messages` against ITS OWN current stage.
// PERMISSION ONLY: `stage`/`provenance` on this call belong to the TARGET, so
// running the target's move against the source would refuse relay's own
// implement<-plan forward as a TRANSITION_ILLEGAL plan -> refine.
//
// Only the deny/allow axis is read. A `pin` names argument values of a CALL,
// and a forward makes no get_recent_messages call to constrain.
//
// Run membership is deliberately NOT checked — see protocol.md's known
// limitations. freeform declares no `needs`, so its workers are each their own
// run root and a same-run rule would refuse the fan-out that stage invites.
//
// `legalMoves` is the TARGET's: it answers "where can the worker you are
// driving go", and edges out of the source's stage are noise.
function checkForwardSource(
  { args, projection, playbooks, subject }:
  { args: Record<string, unknown>; projection: Projection; playbooks: Map<string, Playbook>;
    subject: WorkerState | undefined },
): Decision | null {
  // Malformed `forward` is the handler's case (FORWARD_SESSION_UNKNOWN); policy
  // does not duplicate an argument check.
  const forward = asRecord(args.forward);
  const sourceId = typeof forward.sessionId === 'string' ? forward.sessionId : '';
  if (!sourceId) return null;

  // Not playbook-tracked ⇒ ungoverned, the same rule an untracked TARGET gets.
  const source = projection.bySession.get(sourceId);
  if (!source) return null;

  // Definition drift on the source passes: resolvePolicy defaults to `allow`, so
  // an unresolvable stage lands where an unauthored one does, and the source's
  // own next call already reports the drift with its existing codes.
  const sourcePlaybook = playbooks.get(source.playbook);
  const sourceStage = sourcePlaybook?.stages[source.stage];
  if (!sourceStage) return null;

  if (resolvePolicy(sourceStage, 'get_recent_messages') !== 'deny') return null;

  const targetPlaybook = subject ? playbooks.get(subject.playbook) ?? null : null;
  return refuse('FORWARD_DENIED_IN_STAGE',
    `forward names worker ${short(sourceId)} as the source, but get_recent_messages is denied for a worker in ` +
    `stage '${source.stage}' of playbook '${source.playbook}' — a forward READS that worker's recent output, so ` +
    'the source needs that permission. Drop `forward`, or forward from a worker whose stage permits the read.',
    legalMovesFrom(targetPlaybook, subject?.stage ?? null));
}

// The pinned args a RESUME drops: every one describes how to CREATE a process,
// and a resume's subject already exists. `createWorktree` is the damaging one —
// injecting it hands a resumed session a brand-new worktree, at a cwd that by
// construction holds none of its history — and `model` is merely moot, since
// readLastSessionModel recovers it.
//
// ENUMERATING WHAT TO STRIP, not what to keep, is the fail-safe direction: a
// future pinned key stays enforced by default rather than being silently
// dropped. Everything not listed is POLICY and still applies — see decideResume.
const SPAWN_SHAPE_PINS: ReadonlySet<string> = new Set(['createWorktree', 'baseWorktree', 'name', 'model']);

// `pin` — ARGUMENT VALUES (not worker provenance; that is `needs`). Omitted
// by the caller ⇒ filled in; supplied and mismatched ⇒ refused. A hard
// constraint, never an overridable default.
//
// `skipPins` names keys to leave alone entirely — neither filled nor checked.
// Only the resume paths pass it, and only SPAWN_SHAPE_PINS.
function applyPin(
  { stage, stageName, playbook, toolName, args, move, skipPins }:
  { stage: Stage; stageName: string; playbook: Playbook; toolName: string;
    args: Record<string, unknown>; move: Move; skipPins?: ReadonlySet<string> },
): Decision {
  const policy = resolvePolicy(stage, toolName);
  if (typeof policy === 'string') return { ok: true, patchedArgs: args, move };
  // Copied only if something is actually filled in, so a call with nothing left
  // to pin hands back the caller's OWN object — which is what makes "a resume's
  // args pass through unchanged" an identity claim rather than a deep-equal one.
  let patched: Record<string, unknown> | null = null;
  for (const [arg, want] of Object.entries(policy.pin)) {
    if (skipPins?.has(arg)) continue;
    if (!(arg in args) || args[arg] === undefined) {
      (patched ??= { ...args })[arg] = want;
      continue;
    }
    if (args[arg] !== want) {
      return refuse('ARG_PIN_CONFLICT',
        `stage '${stageName}' of playbook '${playbook.id}' requires ${toolName} to be called with ` +
        `${arg}=${JSON.stringify(want)}, but ${JSON.stringify(args[arg])} was supplied. This is a hard ` +
        'constraint, not a default — omit the argument and it will be filled in.',
        legalMovesFrom(playbook, stageName));
    }
  }
  return { ok: true, patchedArgs: patched ?? args, move };
}

function refuse(code: RefusalCode, reason: string, legalMoves: LegalMoves): Decision {
  return { ok: false, code, reason, legalMoves };
}

// Every playbook with the stages it can actually be entered at, e.g.
// "solo (enter at: plan), freeform (enter at: freeform)".
//
// Under `enforce` a conductor's FIRST spawn is refused unless it already names a
// playbook — and it has no way to know one without asking. Naming
// the entry stages here, not just the playbook ids, is what makes that refusal
// recoverable in one round-trip instead of two (name, then stage). `legalMoves`
// cannot carry this: it describes edges out of ONE known stage, and there is no
// stage yet. Spawnable-only, since a transition-only entry stage would be a dead
// end (isSpawnable is the same predicate the spawn check below uses).
function knownPlaybooksHint(playbooks: Map<string, Playbook>): string {
  const ids = [...playbooks.keys()].sort();
  if (ids.length === 0) return '(none)';
  return ids.map(id => {
    const pb = playbooks.get(id) as Playbook;
    const entries = pb.entryStages.filter(s => isSpawnable(pb.stages[s]));
    return `${id} (${entries.length > 0 ? `enter at: ${entries.join(', ')}` : 'no spawnable entry stage'})`;
  }).join(', ');
}

function short(sessionId: string): string {
  return sessionId.slice(0, 8);
}

// The STAGE_AT_CAPACITY reason, shared by the spawn and transition sites: names
// the blocking worker (both in the narrative and in the copy-pasteable call —
// sessionId args are prefix-resolved at the MCP boundary, so the shortened id
// works) and offers the `workers:"many"` alternative. Capacity counts LIVE
// processes (InstanceManager.isSessionLive), so a session the orchestrator no
// longer knows about (e.g. after a host reboot) holds no slot at all — there is
// nothing to reconcile and no wedge to recover from.
function capacityReason(stageName: string, blockingSessionId: string): string {
  return `stage '${stageName}' declares workers:"one" and this run already has a live worker in it: ` +
    `${short(blockingSessionId)}. Retire it (kill_instance({sessionId: "${short(blockingSessionId)}"})) to free ` +
    'the slot, or use a playbook whose stage declares workers:"many".';
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
