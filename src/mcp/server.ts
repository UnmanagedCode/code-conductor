// MCP (Model Context Protocol) server, mounted at /mcp on the orchestrator's
// existing http server. Streamable HTTP transport, JSON-RPC 2.0 over POST,
// no SSE — every tool result fits in a single application/json response.
//
// Exposes the orchestrator's verbs (spawn / list / send_prompt / read
// transcript / worktree ops) as MCP tools, to applications and agents alike.
// The URL contract (docs/mcp-applications.md): identity is the PATH
// (`/mcp/<sessionId>`, absent = anonymous), presentation the QUERY
// (`?format=json`, the default, or `?format=text` — the agent view a Claude
// session reads, e.g. `claude mcp add --transport http code-conductor
// 'http://127.0.0.1:8787/mcp?format=text'`). A REST alias
// (`POST /mcp[/<sessionId>]/tools/<name>`) runs the same call core.

import express from 'express';
import { capableTools } from './tools.ts';
import { isTextPayload, isTextResult, isDual, codeForStatus, MCP_RESULT_CHAR_BUDGET } from './content.ts';
import { validateArgs } from './argValidation.ts';
import { SESSION_PREFIX_MIN } from '../instances.ts';
import { validateProjectRef } from '../projects.ts';
import type { PlaybookGate } from './playbookGate.ts';
import type { InstanceManagerLike } from '../instanceTypes.ts';
import { hostPlatform, type PlatformCapabilities } from '../platform/index.ts';
import { TEXT_LIMITS, JSON_ECHO_CAP, JSON_LIMITS, limitsFor, type FormatLimits, type McpFormat } from './limits.ts';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'code-conductor';
const SERVER_VERSION = '0.1.0';
const JSONRPC = '2.0';

interface JsonRpcResponse {
  jsonrpc: string;
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// The per-request context handed to every tool handler: `tools` is the
// per-request composition (core tools + this caller's plugin tools) that both
// tools/list and tools/call read; `instances`/`callerId` are the caller-
// resolved handles the handlers consume.
interface McpCtx {
  instances?: InstanceManagerLike | null;
  tools: McpTool[];
  // The core tools (buildTools()), the ones boundResult guards. Plugin bridge
  // tools are not in it.
  coreTools: ReadonlySet<McpTool>;
  // Plugin tools left out of `tools` because this format cannot serve them (a
  // tool with no outputSchema, in json) — named so a call to one is refused
  // TOOL_UNAVAILABLE_IN_FORMAT rather than TOOL_UNKNOWN.
  textOnlyTools: ReadonlySet<string>;
  callerId: string | null;
  playbookGate: PlaybookGate;
  capabilities: PlatformCapabilities;
  // The output format this request asked for (`?format=`), and its caps
  // (src/mcp/limits.ts). Handlers read `limits`; only the serializers read
  // `format`.
  format: McpFormat;
  limits: FormatLimits;
}

// The tool shape the transport itself needs — deliberately broader than the
// registry's `Tool` (tools.ts) so BOTH core tools (inputSchema typed as a
// Record, handler ctx `ToolCtx`) and plugin tools (inputSchema: unknown,
// handler ctx narrowed to `{callerId, format}`) satisfy it without a cast. `handler`'s
// ctx is McpCtx (a supertype of both) so the assignment is contravariantly
// sound in each direction.
interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  handler(args: unknown, ctx: McpCtx): Promise<unknown>;
  annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean; destructiveHint?: boolean };
}

// The plugin-host surface this module composes tools from — `init` + `toolsFor`
// are the only two members the per-request composition touches. Structural:
// the real createPluginHost return satisfies it.
interface McpPluginHostLike {
  init(): Promise<void>;
  toolsFor(): Array<{
    name: string;
    description: string;
    inputSchema: unknown;
    outputSchema?: unknown;
    handler: (args: unknown, ctx: { callerId: string | null; format: McpFormat }) => Promise<unknown>;
  }>;
}

function rpcResult(id: unknown, result: unknown): JsonRpcResponse {
  return { jsonrpc: JSONRPC, id, result };
}
// Every JSON-RPC error goes through here, and its message can echo the caller
// (`method not found: <method>`, an internal error's message), so the message
// is capped at the boundary the same way a tools/call echo is.
function rpcError(id: unknown, code: number, message: string, data?: unknown, cap = ECHO_CAP): JsonRpcResponse {
  const capped = capEcho(message, cap);
  if (capped !== message) console.error(`mcp: JSON-RPC error message of ${message.length} chars cut to fit the MCP result budget`);
  const err: { code: number; message: string; data?: unknown } = { code, message: capped };
  if (data !== undefined) err.data = data;
  return { jsonrpc: JSONRPC, id, error: err };
}

// The one narrowing predicate for every wire-boundary value this module reads
// (msg, args, params, schema sub-fields): a non-null, non-array object.
function isJsonRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// The record-shaped view of an unknown value, `{}` for anything else — the
// wire boundary is `unknown`, so every optional-field read goes through this
// (or isJsonRecord) rather than a cast.
function asRecord(v: unknown): Record<string, unknown> {
  return isJsonRecord(v) ? v : {};
}

// The numeric HTTP-ish statusCode on a thrown value, or null — the narrowing
// point for the tools/call error envelope (catch variables are `unknown`
// under strict).
function errStatus(e: unknown): number | null {
  if (typeof e !== 'object' || e === null) return null;
  const sc = (e as { statusCode?: unknown }).statusCode;
  return typeof sc === 'number' ? sc : null;
}

// The `code` on a thrown value (handlers throw Object.assign(new Error, {code})),
// or undefined — same idiom as routes.ts / handlers.ts.
function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const c = (e as { code?: unknown }).code;
  return typeof c === 'string' ? c : undefined;
}

// The message prose for the tools/call error envelope: a thrown value's
// `message` when it has one (Error or not), else its String() coercion —
// matches the original `e?.message ?? String(e)` reading.
function errMsg(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    if (m !== undefined && m !== null) return String(m);
  }
  return String(e);
}

// A string `message` on a thrown value, or undefined — the dispatch-level
// fallback feeds 'internal error' (original `e?.message ?? 'internal error'`).
function errMessage(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    return typeof m === 'string' ? m : undefined;
  }
  return undefined;
}

// The id of a non-JSON-RPC request (used only for the -32600 error reply).
function rpcRequestId(msg: unknown): unknown {
  return isJsonRecord(msg) ? msg.id : undefined;
}

// True when a tool's inputSchema declares `prop` with a truthy value — the
// schema gate for the prefix-resolution chokepoint below. Driven off the schema
// so a future tool declaring `provenance` is resolved without another edit here.
function hasSchemaProperty(schema: unknown, prop: string): boolean {
  if (!isJsonRecord(schema)) return false;
  const props = schema.properties;
  if (!isJsonRecord(props)) return false;
  return prop in props && !!props[prop];
}

// The SESSION_AMBIGUOUS soft refusal, shared by every prefix-resolution site
// below so the wording has one home. `where` names the argument the ambiguous
// prefix came from; `sessionId` echoes the input verbatim whatever argument that
// was.
//
// `matches` carries public ids WHOLE, never a slice. A public id is 8 chars only
// until a mint-time collision extends it to 13 or to the full backing id
// (PUBLIC_ID_LEN_EXTENDED, src/sessionLineage.ts) — and two 13-char ids share
// their first 8, so slicing would print the same candidate twice and tell the
// caller to disambiguate between two identical strings. For the ordinary 8-char
// id this is byte-identical to what a slice produced.
function ambiguousRefusal(
  ref: { ambiguous: string[]; tooShort: boolean }, input: string, where: string,
): Record<string, unknown> {
  const matches = ref.ambiguous;
  const reason = ref.tooShort
    ? `session prefix "${input}" (${where}) is too short — pass at least ${SESSION_PREFIX_MIN} characters or a full sessionId. Candidates: ${matches.join(', ')}.`
    : `session prefix "${input}" (${where}) matches ${ref.ambiguous.length} sessions — pass more characters or a full sessionId. Candidates: ${matches.join(', ')}.`;
  return { ok: false, code: 'SESSION_AMBIGUOUS', sessionId: input, reason, matches };
}

type TextContent = Array<{ type: 'text'; text: string }>;

// THE BACKSTOP for MCP_RESULT_CHAR_BUDGET. Every core tool bounds its own
// result (paging, caps, flags); this catches one that does not — a cc defect —
// before the harness rejects it, replacing the content with a logged soft
// refusal that says so. `completed` tells the caller whether the call already
// took effect: a tool that is not read-only (bash included) ran, and re-running
// it blindly could repeat what it did.
export function boundResult(
  tool: { name: string; annotations?: { readOnlyHint?: boolean } },
  content: TextContent,
): TextContent {
  let chars = 0;
  for (const c of content) chars += c.text.length;
  if (chars <= MCP_RESULT_CHAR_BUDGET) return content;
  const completed = !tool.annotations?.readOnlyHint;
  const budget = MCP_RESULT_CHAR_BUDGET;
  const reason = completed
    ? `${tool.name} completed, but its result (${chars} chars) is over the MCP result budget and was withheld — do not re-run it blindly`
    : `${tool.name} produced ${chars} chars, over the ${budget}-char MCP result budget — a cc defect; narrow the call (a filter, a smaller count/limit/maxBytes, a paths scope) and retry`;
  console.error(`mcp: RESULT_OVER_BUDGET — ${tool.name} produced ${chars} chars (budget ${budget})`);
  return [{ type: 'text', text: JSON.stringify({ ok: false, code: 'RESULT_OVER_BUDGET', tool: tool.name, chars, budget, completed, reason }) }];
}

// Echoed caller strings — a tool name, an argument key, a `stage`, a path in an
// error message, a JSON-RPC method — are the one thing in a refusal or an error
// that can grow without bound. ECHO_CAP is where the response boundary cuts
// one: the head plus a tail of at most ECHO_TAIL chars — a quarter of a smaller
// cap — so an error's "(HTTP 404)" suffix survives, joined by an in-band marker
// carrying the full length.
const ECHO_CAP = TEXT_LIMITS.echoCap;
const ECHO_TAIL = 64;
export function capEcho(s: string, cap = ECHO_CAP): string {
  if (s.length <= cap) return s;
  const tail = Math.min(ECHO_TAIL, Math.floor(cap / 4));
  // slice(s.length - tail), not slice(-tail): a zero tail (cap <= 3) must keep
  // nothing, and slice(-0) is the whole string.
  return `${s.slice(0, cap - tail)} … [cut: ${s.length} chars] … ${s.slice(s.length - tail)}`;
}

function contentChars(content: TextContent): number {
  let n = 0;
  for (const c of content) n += c.text.length;
  return n;
}

// Cap every string in one text block: a JSON object/array block has each string
// VALUE capped (keys and every short field — `ok`, `code`, `statusCode` — stay
// intact, and the block still parses); any other block is capped as one string.
function capEchoesIn(text: string, cap: number): string {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return capEcho(text, cap); }
  if (!parsed || typeof parsed !== 'object') return capEcho(text, cap);
  const walk = (v: unknown): unknown => typeof v === 'string' ? capEcho(v, cap)
    : Array.isArray(v) ? v.map(walk)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    : v;
  return JSON.stringify(walk(parsed));
}

// THE RESPONSE BOUNDARY for MCP_RESULT_CHAR_BUDGET: every tools/call response
// passes through here, whichever branch built it, so no echo can overflow it.
//   - a handler RESULT over budget is withheld, never cut — cutting would change
//     its data silently: a core tool's becomes boundResult's RESULT_OVER_BUDGET;
//     a plugin tool's own result is outside cc's budget and passes as it is.
//   - a REFUSAL or an ERROR carries its meaning in its code; what overflows is an
//     echoed caller string, so every string in it is capped (capEcho), halving
//     the cap until it fits, and logged. Should even the smallest cap not fit,
//     it becomes RESULT_OVER_BUDGET.
export function boundToolCall(call: ToolCall, coreTools: ReadonlySet<McpTool>): ToolCall['result'] {
  const { result, tool, outcome } = call;
  const chars = contentChars(result.content);
  if (chars <= MCP_RESULT_CHAR_BUDGET) return result;
  if (outcome === 'result') {
    return tool && coreTools.has(tool) ? { ...result, content: boundResult(tool, result.content) } : result;
  }
  const name = tool?.name ?? '(unknown tool)';
  console.error(`mcp: ${name} ${outcome === 'error' ? 'error' : 'refusal'} of ${chars} chars — echoed strings cut to fit the MCP result budget`);
  for (let cap = ECHO_CAP; cap >= ECHO_TAIL; cap = Math.floor(cap / 2)) {
    const content = result.content.map(c => ({ type: 'text' as const, text: capEchoesIn(c.text, cap) }));
    if (contentChars(content) <= MCP_RESULT_CHAR_BUDGET) return { ...result, content };
  }
  return {
    ...result,
    content: [{ type: 'text', text: JSON.stringify({
      ok: false, code: 'RESULT_OVER_BUDGET', tool: name, chars, budget: MCP_RESULT_CHAR_BUDGET,
      completed: outcome === 'error' && !!tool && !tool.annotations?.readOnlyHint,
      reason: `${name}'s ${outcome === 'error' ? 'error' : 'refusal'} (${chars} chars) is over the MCP result budget even with every echoed string cut`,
    }) }],
  };
}

// A text-format tools/call result on its way through the response boundary,
// with how the call ended — boundToolCall reads `outcome` to bound it.
interface ToolCall {
  result: { content: TextContent; isError?: boolean };
  tool: McpTool | null;
  outcome: 'refused' | 'result' | 'error';
}

// One tools/call, up to (not including) the response: how it ended, in a
// format-neutral shape both serializers (and the REST alias) read.
//   - fault:   refused before anything ran because the CALL is malformed —
//              no such tool, a plugin tool this format does not serve, or
//              arguments its inputSchema refuses;
//   - refused: refused before the handler, as a soft refusal (prefix
//              ambiguity, playbook policy);
//   - result:  the handler's own return, a soft refusal ({ok:false}) included;
//   - error:   the handler threw;
//   - internal: a step BEFORE the handler threw (session-ref resolution, the
//              playbook gate) — a cc fault, not the tool's answer.
type Outcome =
  | { kind: 'fault'; code: 'TOOL_UNKNOWN' | 'TOOL_UNAVAILABLE_IN_FORMAT' | 'ARGS_INVALID'; reason: string; tool: McpTool | null }
  | { kind: 'refused'; body: Record<string, unknown>; tool: McpTool }
  | { kind: 'result'; value: unknown; tool: McpTool }
  | { kind: 'error'; error: unknown; tool: McpTool }
  | { kind: 'internal'; error: unknown; tool: McpTool | null };

// THE tools/call core: lookup → argument validation → the four prefix-
// resolution passes → playbook policy → project-ref validation → handler →
// event-log commit. Shared by JSON-RPC tools/call and the REST alias, so both run
// one validation, one gate and one handler path. TOTAL: it never rejects —
// every way a call can end is an Outcome, so neither transport has a path
// where a throw escapes it.
async function runTool(name: unknown, rawArgs: unknown, ctx: McpCtx): Promise<Outcome> {
  const tool = ctx.tools.find(t => t.name === name) ?? null;
  try {
    return await runToolSteps(name, rawArgs, ctx);
  } catch (e) {
    console.error(`mcp: ${String(name)} failed before its handler ran:`, errMessage(e) ?? e);
    return { kind: 'internal', error: e, tool };
  }
}

async function runToolSteps(name: unknown, rawArgs: unknown, ctx: McpCtx): Promise<Outcome> {
  let args: unknown = rawArgs ?? {};
  const tool = ctx.tools.find(t => t.name === name);
  if (!tool) {
    if (typeof name === 'string' && ctx.textOnlyTools.has(name)) {
      return { kind: 'fault', code: 'TOOL_UNAVAILABLE_IN_FORMAT', tool: null,
        reason: `'${name}' is a plugin tool with no outputSchema, so it is served in text format only — call it over JSON-RPC at /mcp?format=text` };
    }
    return { kind: 'fault', code: 'TOOL_UNKNOWN', reason: `unknown tool: ${name}`, tool: null };
  }
  const v = validateArgs(tool.inputSchema, args, name);
  if (v) return { kind: 'fault', code: 'ARGS_INVALID', reason: v, tool };
  // sessionId prefix resolution — the single, uniform chokepoint for every
  // worker-addressing tool. Accept any unambiguous prefix of a sessionId in
  // place of the full 36-char UUID, resolved to the canonical full id before
  // the handler touches the registry. Non-destructive: only rewrites on a
  // confident prefix→full resolution; exact ids and no-matches pass through
  // unchanged so the handler's existing SESSION_NOT_LIVE / SESSION_UNKNOWN /
  // on-disk lookup paths still run. The only new outcome is SESSION_AMBIGUOUS,
  // serialized exactly like a handler soft-refusal (no isError).
  if (ctx.instances?.resolveSessionRef
      && hasSchemaProperty(tool.inputSchema, 'sessionId')
      && isJsonRecord(args)
      && typeof args.sessionId === 'string' && args.sessionId) {
    const ref = ctx.instances.resolveSessionRef(args.sessionId);
    if (ref && 'ambiguous' in ref) {
      return { kind: 'refused', body: ambiguousRefusal(ref, args.sessionId, 'sessionId'), tool };
    }
    if (ref?.sessionId && ref.sessionId !== args.sessionId) {
      args = { ...args, sessionId: ref.sessionId };
    }
  }
  // `provenance` values are sessionIds too (the {stage: sessionId} map — see
  // src/playbooks.ts), so they get the SAME prefix treatment. Without this
  // the conductor would have to pass full 36-char UUIDs there while every
  // other worker reference takes 8 chars.
  // Ordering is load-bearing: this must run before the policy checkpoint
  // below, which compares these values against the projection's full ids.
  if (ctx.instances?.resolveSessionRef
      && hasSchemaProperty(tool.inputSchema, 'provenance')
      && isJsonRecord(args) && isJsonRecord(args.provenance)) {
    const resolved: Record<string, unknown> = { ...args.provenance };
    for (const [stage, value] of Object.entries(args.provenance)) {
      if (typeof value !== 'string' || !value) continue;
      const ref = ctx.instances.resolveSessionRef(value);
      if (ref && 'ambiguous' in ref) {
        return { kind: 'refused', body: ambiguousRefusal(ref, value, `provenance.${stage}`), tool };
      }
      if (ref?.sessionId) resolved[stage] = ref.sessionId;
    }
    args = { ...args, provenance: resolved };
  }
  // `forward.sessionId` (send_prompt) is a worker handle too, nested one
  // level deep, so the top-level chokepoint above misses it. Mirrors the
  // `provenance` loop; NOT generalised into one loop with the others — the
  // four sites differ in shape (scalar, map, nested, and `resume`'s
  // two-answer resolver) and the ordering comment above is load-bearing for
  // `provenance`.
  if (ctx.instances?.resolveSessionRef
      && hasSchemaProperty(tool.inputSchema, 'forward')
      && isJsonRecord(args) && isJsonRecord(args.forward)
      && typeof args.forward.sessionId === 'string' && args.forward.sessionId) {
    const ref = ctx.instances.resolveSessionRef(args.forward.sessionId);
    if (ref && 'ambiguous' in ref) {
      return { kind: 'refused', body: ambiguousRefusal(ref, args.forward.sessionId, 'forward.sessionId'), tool };
    }
    if (ref?.sessionId) args = { ...args, forward: { ...args.forward, sessionId: ref.sessionId } };
  }
  // `resume` (spawn_instance) is a worker handle too — it just declares
  // `resume` rather than `sessionId`, so the top-level block above misses it.
  // TWO differences from the three sites above, both explained at
  // InstanceManager.resolveResumeRef:
  //   • it resolves over `byId` UNION the lineage store, because the ordinary
  //     resume target — a killed conductor worker, or any worker after an
  //     orchestrator restart — is not in `byId` at all;
  //   • it REWRITES THE ARG ONLY FOR A PREFIX. An exact segment id is left
  //     verbatim, because `resume` feeds create(), and create() opens the
  //     segment it is named; the public id the policy gate needs travels
  //     BESIDE it (`resumeHandle`) rather than in its place. Overwriting it
  //     would silently redirect the resume to the session's newest transcript.
  // Async, which is free here: this arm already awaits the gate and the
  // handler below.
  let resumeHandle: string | undefined;
  if (ctx.instances?.resolveResumeRef
      && hasSchemaProperty(tool.inputSchema, 'resume')
      && isJsonRecord(args)
      && typeof args.resume === 'string' && args.resume) {
    const ref = await ctx.instances.resolveResumeRef(args.resume);
    if (ref && 'ambiguous' in ref) {
      return { kind: 'refused', body: ambiguousRefusal(ref, args.resume, 'resume'), tool };
    }
    if (ref) {
      resumeHandle = ref.handle;
      if (ref.resume !== args.resume) args = { ...args, resume: ref.resume };
    }
  }
  // Playbook policy — the ONE enforcement point, deliberately AFTER
  // validateArgs and after EVERY prefix-resolution pass above, and BEFORE
  // the handler. Inert unless the caller is a conductor with enforcement on;
  // see src/mcp/playbookGate.ts.
  const gate = await ctx.playbookGate.check({ toolName: name, args, callerId: ctx.callerId, resumeHandle });
  if ('refusal' in gate) return { kind: 'refused', body: { ...gate.refusal }, tool };
  args = gate.args;
  // Set once the handler returned, so a later throw (rendering) is not
  // recorded as the call failing after commit() recorded it.
  let handled = false;
  try {
    // Every core tool's `project` names an existing project (creation takes
    // `name`), so a malformed one — most often a path — is refused here with
    // the addressing guidance, through the same error envelope. An empty
    // string is no path: it is left to each handler's own refusal
    // (list_sessions answers it PROJECT_UNKNOWN).
    if (ctx.coreTools.has(tool) && isJsonRecord(args) && typeof args.project === 'string' && args.project !== '') {
      validateProjectRef(args.project);
    }
    const value = await tool.handler(args, ctx);
    handled = true;
    // Record the call only now that it has actually happened: commit() writes
    // its row (an `ok:false` result as failed), and a throw is recorded by
    // fail() in the catch below — one row either way. The gate reads the
    // data, never a rendering, so every format records the same row once.
    if (gate.commit) await gate.commit(isDual(value) ? value.json : value);
    return { kind: 'result', value, tool };
  } catch (e) {
    if (!handled && gate.fail) await gate.fail(e);
    return { kind: 'error', error: e, tool };
  }
}

// A handler's return as text-format content blocks — the agent view.
function textContent(value: unknown): TextContent {
  const v = isDual(value) ? value.text() : value;
  if (isTextResult(v)) {
    // The rendering IS the whole result — one raw block, no metadata
    // block to parse (src/mcp/content.ts).
    return [{ type: 'text', text: v.text }];
  }
  if (isTextPayload(v)) {
    // Multi-block: compact-JSON metadata block, then one raw text block
    // per body, in order. Lets the LLM read file/diff/message bodies
    // un-escaped while still parsing structured metadata from content[0].
    const content: TextContent = [{ type: 'text', text: JSON.stringify(v.meta ?? null) }];
    for (const b of v.bodies) content.push({ type: 'text', text: String(b) });
    return content;
  }
  return [{ type: 'text', text: JSON.stringify(v ?? null) }];
}

// The text-format tools/call result, byte-identical to what the agent view has
// always been, then bounded by the response boundary (boundToolCall).
function serializeText(o: Exclude<Outcome, { kind: 'internal' }>, ctx: McpCtx): ToolCall['result'] {
  let call: ToolCall;
  if (o.kind === 'fault') {
    call = { result: { content: [{ type: 'text', text: o.reason }], isError: true }, tool: o.tool, outcome: 'refused' };
  } else if (o.kind === 'refused') {
    call = { result: { content: [{ type: 'text', text: JSON.stringify(o.body) }] }, tool: o.tool, outcome: 'refused' };
  } else if (o.kind === 'result') {
    call = { result: { content: textContent(o.value) }, tool: o.tool, outcome: 'result' };
  } else {
    // Errors read best as prose for an LLM (content[0]); a structured
    // {error, code, statusCode} block follows for machine handling.
    const sc = errStatus(o.error);
    const code = errCode(o.error) ?? codeForStatus(sc);
    const msg = errMsg(o.error);
    call = {
      result: {
        content: [
          { type: 'text', text: sc ? `${msg} (HTTP ${sc})` : msg },
          { type: 'text', text: JSON.stringify({ error: msg, ...(code ? { code } : {}), ...(sc ? { statusCode: sc } : {}) }) },
        ],
        isError: true,
      },
      tool: o.tool,
      outcome: 'error',
    };
  }
  return boundToolCall(call, ctx.coreTools);
}

// Cap every echoed string in a refusal/error body at the JSON echo ceiling;
// `truncated:true` says one was cut.
function capRefusal(body: Record<string, unknown>, cap: number): Record<string, unknown> {
  let cut = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const c = capEcho(v, cap);
      if (c !== v) cut = true;
      return c;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isJsonRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(body) as Record<string, unknown>;
  if (cut) console.error(`mcp: a refusal's echoed strings were cut at the JSON echo cap (${cap} chars)`);
  return cut ? { ...out, truncated: true } : out;
}

// The refusal body for a soft refusal: its own fields, with a `code` always.
// A handler refusal with none (sync_worktree's system-refusal and git-status
// arms) is REFUSED.
function refusalBody(v: Record<string, unknown>, cap: number): Record<string, unknown> {
  return capRefusal(typeof v.code === 'string' ? v : { ...v, code: 'REFUSED' }, cap);
}

// A thrown handler error as the refusal schema: the same code the text view's
// {error, code, statusCode} block carries, else TOOL_ERROR.
function errorBody(e: unknown, cap: number): Record<string, unknown> {
  const sc = errStatus(e);
  return capRefusal({
    ok: false,
    code: errCode(e) ?? codeForStatus(sc) ?? 'TOOL_ERROR',
    reason: errMsg(e),
    ...(sc ? { statusCode: sc } : {}),
  }, cap);
}

// The JSON-format view of a non-fault outcome: the structured value, and
// whether it is a refusal. Every tool reaching it has an outputSchema — core,
// or a typed plugin tool whose bridge already validated its reply — so a
// result that is not an object is a cc defect: `internal` carries why.
type JsonView =
  | { structured: Record<string, unknown>; isError: boolean }
  | { structured: null; internal: string };
function jsonView(o: Exclude<Outcome, { kind: 'fault' | 'internal' }>, ctx: McpCtx): JsonView {
  const cap = ctx.limits.echoCap;
  if (o.kind === 'refused') return { structured: refusalBody(o.body, cap), isError: true };
  if (o.kind === 'error') return { structured: errorBody(o.error, cap), isError: true };
  const value = isDual(o.value) ? o.value.json : o.value;
  if (!isJsonRecord(value)) {
    // Every tool returns an object in JSON format; anything else is a cc
    // defect, surfaced rather than reshaped.
    const internal = `${o.tool.name} returned a non-object JSON result`;
    console.error(`mcp: ${internal}`);
    return { structured: null, internal };
  }
  if (value.ok === false) return { structured: refusalBody(value, cap), isError: true };
  return { structured: value, isError: false };
}

// A tools/call fault as a JSON-RPC error carrying the refusal shape.
function faultError(id: unknown, o: Extract<Outcome, { kind: 'fault' }>): JsonRpcResponse {
  const body = capRefusal({ ok: false, code: o.code, reason: o.reason }, JSON_ECHO_CAP);
  return rpcError(id, -32602, body.reason as string, body, JSON_ECHO_CAP);
}

// The JSON-format tools/call reply: structuredContent + one text block holding
// its JSON. No result budget and no backstop — JSON's ceilings are its own
// (src/mcp/limits.ts).
function serializeJson(id: unknown, o: Exclude<Outcome, { kind: 'internal' }>, ctx: McpCtx): JsonRpcResponse {
  if (o.kind === 'fault') return faultError(id, o);
  const view = jsonView(o, ctx);
  if ('internal' in view) return internalReply(id, view.internal, ctx);
  return rpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify(view.structured) }],
    structuredContent: view.structured,
    ...(view.isError ? { isError: true } : {}),
  });
}

// The -32603 reply for a fault outside any tool's own answer. Text format
// carries no `data` (its reply is what it always was); JSON adds the refusal
// shape, code INTERNAL.
function internalReply(id: unknown, reason: string, ctx: McpCtx): JsonRpcResponse {
  const cap = ctx.limits.echoCap;
  return rpcError(id, -32603, reason, ctx.format === 'json' ? { ok: false, code: 'INTERNAL', reason: capEcho(reason, cap) } : undefined, cap);
}

async function dispatch(msg: unknown, ctx: McpCtx): Promise<JsonRpcResponse | null> {
  const json = ctx.format === 'json';
  if (!isJsonRecord(msg) || msg.jsonrpc !== JSONRPC) {
    const reason = 'invalid JSON-RPC request';
    return rpcError(rpcRequestId(msg) ?? null, -32600, reason, json ? { ok: false, code: 'REQUEST_INVALID', reason } : undefined, ctx.limits.echoCap);
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  // Methods that are notifications-only (no response per spec).
  if (method === 'notifications/initialized' || method === 'initialized') {
    return null;
  }

  try {
    if (method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    if (method === 'ping') {
      return rpcResult(id, {});
    }
    if (method === 'tools/list') {
      const tools = ctx.tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(json && t.outputSchema ? { outputSchema: t.outputSchema } : {}),
        ...(t.annotations ? { annotations: t.annotations } : {}),
      }));
      return rpcResult(id, { tools });
    }
    if (method === 'tools/call') {
      const p = asRecord(params);
      const outcome = await runTool(p.name, p.arguments, ctx);
      if (outcome.kind === 'internal') return isNotification ? null : internalReply(id, errMessage(outcome.error) ?? 'internal error', ctx);
      return json ? serializeJson(id, outcome, ctx) : rpcResult(id, serializeText(outcome, ctx));
    }
    if (isNotification) return null;
    const reason = `method not found: ${method}`;
    const cap = ctx.limits.echoCap;
    return rpcError(id, -32601, reason, json ? { ok: false, code: 'METHOD_UNKNOWN', reason: capEcho(reason, cap) } : undefined, cap);
  } catch (e) {
    if (isNotification) return null;
    return internalReply(id, errMessage(e) ?? 'internal error', ctx);
  }
}

// A URL-level fault: the request is refused before anything is dispatched, as
// one JSON-RPC error object whatever the body held.
interface UrlFault { code: string; rpcCode: number; reason: string }

// The only query parameter /mcp accepts. Identity is in the path, never the
// query: anything else is refused rather than ignored, so a stale spelling
// (`?caller=`) fails loudly instead of degrading to anonymous.
const ACCEPTED_QUERY = new Set(['format']);

// Every echoed URL fragment in a URL-level fault is cut to this.
export const URL_ECHO_CAP = 256;

// The largest request body /mcp parses (express.json's `limit`); a larger one
// is refused PAYLOAD_TOO_LARGE.
export const MCP_REQUEST_BODY_LIMIT = '8mb';

// The request preamble every /mcp route shares: the output format, from the
// query string only (never Accept or Content-Type), then the caller from the
// path.
function resolveFormat(query: Record<string, unknown>): McpFormat | UrlFault {
  for (const k of Object.keys(query)) {
    if (!ACCEPTED_QUERY.has(k)) {
      return { code: 'QUERY_PARAM_UNKNOWN', rpcCode: -32600,
        reason: `unknown query parameter '${capEcho(k, URL_ECHO_CAP)}' — /mcp accepts only ?format=; the caller is the /mcp/<sessionId> path` };
    }
  }
  const f = query.format;
  if (f === undefined) return 'json';
  if (f === 'text' || f === 'json') return f;
  return { code: 'FORMAT_INVALID', rpcCode: -32600,
    reason: `format must be 'json' or 'text', got ${capEcho(JSON.stringify(f) ?? String(f), URL_ECHO_CAP)}` };
}

function resolveCaller(instances: InstanceManagerLike | null | undefined, sid: string | undefined): string | null | UrlFault {
  if (sid === undefined) return null;
  const callerId = instances ? instances.liveCallerForPublicId(sid) : null;
  if (callerId) return callerId;
  return { code: 'CALLER_UNKNOWN', rpcCode: -32001,
    reason: `no live session '${capEcho(sid, URL_ECHO_CAP)}' — the /mcp/<sessionId> path takes the exact public sessionId of a running session` };
}

// A URL-level fault's REST status: an unknown caller names a resource that is
// not there; a bad query is a bad request.
function urlFaultStatus(fault: UrlFault): number {
  return fault.code === 'CALLER_UNKNOWN' ? 404 : 400;
}

function isUrlFault(v: unknown): v is UrlFault {
  return isJsonRecord(v) && typeof v.code === 'string' && typeof v.rpcCode === 'number';
}

// One error object for the whole request — a batch or a notification is
// refused once, with a null id.
function urlFaultReply(body: unknown, fault: UrlFault): JsonRpcResponse {
  const id = isJsonRecord(body) && body.id !== undefined ? body.id : null;
  return rpcError(id, fault.rpcCode, fault.reason, { ok: false, code: fault.code, reason: fault.reason });
}

// A request body express.json refused (body-parser marks its errors with a
// `type`): bad JSON, too large, or a charset/encoding/length it cannot read.
function bodyParserFault(err: unknown): { status: number; rpcCode: number; code: string; reason: string } | null {
  if (!isJsonRecord(err) || typeof err.type !== 'string') return null;
  if (err.type === 'entity.parse.failed') {
    return { status: 400, rpcCode: -32700, code: 'PARSE_ERROR', reason: 'request body is not valid JSON' };
  }
  if (err.type === 'entity.too.large') {
    return { status: 413, rpcCode: -32600, code: 'PAYLOAD_TOO_LARGE', reason: `request body is over the ${MCP_REQUEST_BODY_LIMIT} limit` };
  }
  const status = typeof err.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 400;
  return { status, rpcCode: -32600, code: 'REQUEST_INVALID', reason: `request body could not be read (${capEcho(err.type, URL_ECHO_CAP)})` };
}

export function buildMcpRouter(
  { instances, pluginHost, playbookGate, capabilities = hostPlatform.capabilities }:
  { instances?: InstanceManagerLike | null; pluginHost?: McpPluginHostLike | null; playbookGate: PlaybookGate; capabilities?: PlatformCapabilities },
): express.Router {
  const r = express.Router();
  r.use(express.json({ limit: MCP_REQUEST_BODY_LIMIT }));

  // One core registry per format: they differ in the limits baked into an
  // input schema (project_read's maxBytes) and in each description's result
  // clause, and tools/list shows the outputSchema in JSON only.
  const registry = (format: McpFormat) => {
    const tools: McpTool[] = capableTools(format, capabilities);
    return { tools, set: new Set<McpTool>(tools) as ReadonlySet<McpTool> };
  };
  const registries: Record<McpFormat, { tools: McpTool[]; set: ReadonlySet<McpTool> }> = {
    text: registry('text'),
    json: registry('json'),
  };

  // Per-request tool composition: core tools + the plugin tools visible to
  // this caller that the format serves — in json, only plugin tools with an
  // outputSchema; the others are named in `textOnly`. init() is memoized —
  // after the first request it's a resolved promise. A plugin-subsystem
  // failure must never take the core tools down with it.
  const NONE: ReadonlySet<string> = new Set();
  async function composeTools(format: McpFormat): Promise<{ tools: McpTool[]; textOnly: ReadonlySet<string> }> {
    const core = registries[format].tools;
    if (!pluginHost) return { tools: core, textOnly: NONE };
    try {
      await pluginHost.init();
      const plugin = pluginHost.toolsFor();
      if (format === 'text') return { tools: [...core, ...plugin], textOnly: NONE };
      return {
        tools: [...core, ...plugin.filter(t => t.outputSchema)],
        textOnly: new Set(plugin.filter(t => !t.outputSchema).map(t => t.name)),
      };
    } catch (e) {
      console.warn('mcp: plugin tool composition failed:', errMessage(e) || e);
      return { tools: core, textOnly: NONE };
    }
  }

  // JSON-RPC over POST, as `sid` (the caller's public sessionId from the path)
  // or anonymously. URL-level faults short-circuit before anything dispatches:
  // a caller that does not resolve is refused, never served anonymously.
  async function rpcRoute(req: express.Request, res: express.Response, sid: string | undefined) {
    const format = resolveFormat(req.query as Record<string, unknown>);
    if (isUrlFault(format)) { res.json(urlFaultReply(req.body, format)); return; }
    const callerId = resolveCaller(instances, sid);
    if (isUrlFault(callerId)) { res.json(urlFaultReply(req.body, callerId)); return; }
    const { tools, textOnly } = await composeTools(format);
    const ctx: McpCtx = { instances, tools, coreTools: registries[format].set, textOnlyTools: textOnly, callerId, playbookGate, capabilities, format, limits: limitsFor(format) };
    const body: unknown = req.body;
    // Batch: array of requests → array of responses (notifications dropped).
    if (Array.isArray(body)) {
      const out: JsonRpcResponse[] = [];
      for (const msg of body) {
        const r1 = await dispatch(msg, ctx);
        if (r1) out.push(r1);
      }
      if (out.length === 0) {
        res.status(202).end();
        return;
      }
      res.json(out);
      return;
    }
    const r1 = await dispatch(body, ctx);
    if (!r1) {
      res.status(202).end();
      return;
    }
    res.json(r1);
  }

  // ---- the REST alias (docs/mcp-applications.md) ----
  //
  // POST /mcp[/<sid>]/tools/<name> with the arguments as the JSON body: the same
  // runTool as tools/call (one validation, one gate, one handler), answered as
  // plain HTTP — the structuredContent object itself on success, the refusal
  // schema on a refusal, an HTTP status for a fault. JSON only.
  const restFault = (res: express.Response, status: number, code: string, reason: string) => {
    res.status(status).json({ ok: false, code, reason: capEcho(reason, JSON_ECHO_CAP) });
  };
  // The alias preamble: format (absent or json only), then the caller.
  function restPreamble(req: express.Request, res: express.Response, sid: string | undefined): { callerId: string | null } | null {
    const format = resolveFormat(req.query as Record<string, unknown>);
    if (isUrlFault(format)) { restFault(res, urlFaultStatus(format), format.code, format.reason); return null; }
    if (format !== 'json') {
      restFault(res, 400, 'FORMAT_INVALID', "the REST alias serves JSON only — drop ?format=text, or use JSON-RPC at /mcp?format=text");
      return null;
    }
    const callerId = resolveCaller(instances, sid);
    if (isUrlFault(callerId)) { restFault(res, urlFaultStatus(callerId), callerId.code, callerId.reason); return null; }
    return { callerId };
  }

  async function restCall(req: express.Request, res: express.Response, sid: string | undefined, name: string | undefined) {
    // Checked before anything else, an empty body included: only a JSON body is
    // parsed, and a cross-site "simple" POST cannot send one.
    if (!req.is('application/json')) {
      restFault(res, 415, 'CONTENT_TYPE_UNSUPPORTED', 'the REST alias takes a JSON body — send content-type: application/json');
      return;
    }
    const pre = restPreamble(req, res, sid);
    if (!pre) return;
    if (!name) { restFault(res, 404, 'TOOL_UNKNOWN', 'no tool named — POST /mcp/tools/<name>'); return; }
    const args: unknown = req.body;
    if (!isJsonRecord(args)) { restFault(res, 400, 'ARGS_INVALID', 'the request body must be a JSON object of the tool\'s arguments'); return; }
    const { tools, textOnly } = await composeTools('json');
    const ctx: McpCtx = { instances, tools, coreTools: registries.json.set, textOnlyTools: textOnly, callerId: pre.callerId, playbookGate, capabilities, format: 'json', limits: JSON_LIMITS };
    const outcome = await runTool(name, args, ctx);
    if (outcome.kind === 'fault') {
      // A text-only plugin tool is absent from this alias's own listing: a
      // 404 like an unknown tool, told apart by its code.
      restFault(res, outcome.code === 'ARGS_INVALID' ? 400 : 404, outcome.code, outcome.reason);
      return;
    }
    if (outcome.kind === 'internal') {
      restFault(res, 500, 'INTERNAL', errMessage(outcome.error) ?? 'internal error');
      return;
    }
    const view = jsonView(outcome, ctx);
    if ('internal' in view) { restFault(res, 500, 'INTERNAL', view.internal); return; }
    res.status(200).json(view.structured);
  }

  // GET /mcp[/<sid>]/tools: the JSON registry plus the typed plugin tools this
  // caller sees — every listed tool has an outputSchema.
  async function restListing(req: express.Request, res: express.Response, sid: string | undefined) {
    if (!restPreamble(req, res, sid)) return;
    const { tools } = await composeTools('json');
    res.json(tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
    })));
  }

  // GET would be the SSE long-poll channel for server→client notifications.
  // We don't emit any, so reject explicitly rather than hanging the client.
  const getRejected = (_req: express.Request, res: express.Response) => {
    res.status(405).json({ error: 'GET /mcp not supported (no server notifications in v1)' });
  };

  // Express 4 does not catch a rejected async handler: an escaped rejection
  // would be unhandled and take the process down. Every async route goes
  // through this, so a stray one reaches the error middleware below instead.
  const safe = (fn: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler =>
    (req, res, next) => { fn(req, res).catch(next); };

  // The literal `tools` routes come first: a public sessionId is hex, so it is
  // never the word `tools`.
  r.post('/', safe((req, res) => rpcRoute(req, res, undefined)));
  r.get('/', getRejected);
  r.get('/tools', safe((req, res) => restListing(req, res, undefined)));
  r.post('/tools', safe((req, res) => restCall(req, res, undefined, undefined)));
  r.post('/tools/:name', safe((req, res) => restCall(req, res, undefined, req.params.name)));
  r.post('/:sid', safe((req, res) => rpcRoute(req, res, req.params.sid)));
  r.get('/:sid', getRejected);
  r.get('/:sid/tools', safe((req, res) => restListing(req, res, req.params.sid)));
  r.post('/:sid/tools', safe((req, res) => restCall(req, res, req.params.sid, undefined)));
  r.post('/:sid/tools/:name', safe((req, res) => restCall(req, res, req.params.sid, req.params.name)));

  // Nothing under /mcp falls through to the web UI's HTML.
  r.all('*', (req, res) => {
    res.status(404).json({ ok: false, code: 'ROUTE_UNKNOWN', reason: `no MCP route ${req.method} ${capEcho(req.path, URL_ECHO_CAP)}` });
  });

  // Every error that reaches the router: a body express.json refused before
  // any route ran, or a stray rejection from an async route. Answered in the
  // shape of the route asked — the alias's REST body, or one JSON-RPC error —
  // never Express's HTML page.
  r.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) { next(err); return; }
    const rest = /^\/(?:[^/]+\/)?tools(?:\/|$)/.test(req.path);
    const fault = bodyParserFault(err);
    if (fault) {
      if (rest) { restFault(res, fault.status, fault.code, fault.reason); return; }
      res.status(fault.status).json(rpcError(null, fault.rpcCode, fault.reason, { ok: false, code: fault.code, reason: fault.reason }));
      return;
    }
    const reason = errMessage(err) ?? 'internal error';
    console.error(`mcp: ${req.method} ${req.path} failed:`, reason);
    if (rest) { restFault(res, 500, 'INTERNAL', reason); return; }
    // The text format's -32603 carries no data, as dispatch's does.
    const json = req.query.format !== 'text';
    res.status(500).json(rpcError(null, -32603, reason,
      json ? { ok: false, code: 'INTERNAL', reason: capEcho(reason, JSON_ECHO_CAP) } : undefined,
      json ? JSON_ECHO_CAP : ECHO_CAP));
  });

  return r;
}
