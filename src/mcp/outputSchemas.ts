// The JSON-format contract: one outputSchema per core MCP tool, describing the
// SUCCESS shape of its `structuredContent` (docs/mcp-applications.md). A soft
// refusal or an error is `isError:true` and carries REFUSAL_SCHEMA instead.
//
// Hand-written, with small builders, because cc runs TypeScript by type
// stripping — there is no build step to generate them from types. Objects are
// CLOSED (`additionalProperties:false`) unless built with `open()`, so a handler
// that adds a field fails tests/mcp-json-conformance.test.mjs until its schema
// learns it. `open()` is reserved for pass-through data cc does not own the
// shape of here: transcript events, tool-call inputs, and event-log history
// rows (versioned, with their own contract in docs/event-log.md).
//
// The vocabulary is the subset src/mcp/jsonSchemaSubset.ts validates: type
// (incl. unions), properties, required, additionalProperties, items, enum,
// const, anyOf, description. Use nothing else.

import { CONDUCTOR_VIEW_KEYS, LIST_ONLY_KEYS } from './handlers.ts';

type Schema = Record<string, unknown>;

const str: Schema = { type: 'string' };
const int: Schema = { type: 'integer' };
const num: Schema = { type: 'number' };
const bool: Schema = { type: 'boolean' };
const strArr: Schema = { type: 'array', items: str };
const any = (description: string): Schema => ({ description });

function obj(props: Record<string, Schema>, { optional = [] as string[] } = {}): Schema {
  for (const k of optional) if (!(k in props)) throw new Error(`outputSchemas: optional key '${k}' is not a property`);
  return {
    type: 'object',
    properties: props,
    required: Object.keys(props).filter(k => !optional.includes(k)),
    additionalProperties: false,
  };
}
// A map keyed by data (stage names, tool names): every value is `value`.
function mapOf(value: Schema): Schema {
  return { type: 'object', additionalProperties: value };
}
function open(description: string): Schema {
  return { type: 'object', additionalProperties: true, description };
}
function arr(item: Schema): Schema {
  return { type: 'array', items: item };
}
// `s` or null. `s` must carry a single string `type`.
function nullable(s: Schema): Schema {
  if (typeof s.type !== 'string') throw new Error('outputSchemas: nullable() needs a single-type schema');
  return { ...s, type: [s.type, 'null'] };
}
function lit(v: string | number | boolean | null): Schema {
  return { const: v };
}
function oneOf(...values: Array<string | number | boolean | null>): Schema {
  return { enum: values };
}
// An object that is exactly one of `variants`. Each variant is a closed obj(),
// so the union is closed even though the wrapper itself admits any property.
function variants(...vs: Schema[]): Schema {
  return { type: 'object', additionalProperties: true, anyOf: vs };
}
function extend(base: Schema, props: Record<string, Schema>, { optional = [] as string[] } = {}): Schema {
  const baseProps = base.properties as Record<string, Schema>;
  const baseOptional = Object.keys(baseProps).filter(k => !(base.required as string[]).includes(k));
  return obj({ ...baseProps, ...props }, { optional: [...baseOptional, ...optional] });
}

// ---------- shared fragments ----------

// The refusal every isError:true structuredContent carries: a soft refusal's
// own fields ride along (sessionId, matches, dependents, …), so it is open. A
// plugin refusal's `details`, when present, is an object.
export const REFUSAL_SCHEMA: Schema = {
  type: 'object',
  properties: {
    ok: lit(false), code: str, reason: str, statusCode: int, truncated: lit(true),
    details: open("A plugin refusal's own machine-readable fields, passed through untouched."),
  },
  required: ['ok', 'code'],
  additionalProperties: true,
};

const MERGE_STATUS = obj({ ahead: nullable(int), behind: nullable(int) });
const SESSION_SUMMARY = obj({ count: int, archivedCount: int, handCount: int, lastActivity: num });
const EXIT = obj({ code: nullable(int), signal: nullable(str), stderrTail: nullable(str) });
const AWAITING_USER = oneOf('question', 'plan', null);
const AWAITING_USER_SOURCE = oneOf('tool', 'text', null);

const HOOK_RESULT = obj({
  ran: bool,
  skipped: oneOf('disabled', 'STORE_HOOK_LOCAL_ONLY'),
  source: nullable(str),
  exitCode: nullable(int),
  durationMs: num,
  output: str,
  truncated: bool,
  timedOut: bool,
  descendantsMaySurvive: lit(true),
  error: bool,
}, { optional: ['skipped', 'source', 'exitCode', 'durationMs', 'output', 'truncated', 'timedOut', 'descendantsMaySurvive', 'error'] });

// WorktreeMeta (src/worktrees.ts), with the internal `worktreeName` key named
// `worktree` at the MCP boundary (toMcpWorktree).
const WORKTREE_PROPS = {
  parentProject: str, parentPath: str, worktree: str, worktreePath: str,
  branch: str, baseBranch: str, baseSha: str, baseWorktree: str, locked: lit(true), createdAt: str,
};
const WORKTREE_OPTIONAL = ['baseWorktree', 'locked'];
export const WORKTREE_VIEW = obj(WORKTREE_PROPS, { optional: WORKTREE_OPTIONAL });
// The same metadata under its internal key, as list_projects carries it.
const { worktree: _w, ...WORKTREE_META_REST } = WORKTREE_PROPS;
const WORKTREE_META_PROPS = { ...WORKTREE_META_REST, worktreeName: str };

// The instance's own projection of its worktree (Instance.summary()).
const INSTANCE_WORKTREE = {
  type: ['object', 'null'],
  properties: { worktreeName: str, branch: str, baseBranch: str, baseSha: str, postWorktreeCreate: { ...HOOK_RESULT, type: ['object', 'null'] } },
  required: ['worktreeName', 'branch', 'baseBranch', 'baseSha', 'postWorktreeCreate'],
  additionalProperties: false,
};

// One schema per CONDUCTOR_VIEW_KEYS entry. The key list has its one home in
// handlers.ts; a key added there without a schema here fails at load.
const CONDUCTOR_VIEW_TYPES: Record<string, Schema> = {
  project: str,
  cwd: str,
  sessionId: nullable(str),
  status: str,
  displayStatus: str,
  activeAgentTasks: int,
  backgroundJobs: arr(obj({ title: str, startedAt: num })),
  mode: str,
  effort: nullable(str),
  thinking: str,
  backend: str,
  model: nullable(str),
  contextTokens: nullable(int),
  contextWindowTokens: nullable(int),
  pid: nullable(int),
  worktree: INSTANCE_WORKTREE,
  temp: bool,
  conducted: bool,
  debug: bool,
  firstPrompt: nullable(str),
  title: nullable(str),
  createdAt: num,
  lastResponseAt: nullable(num),
  lastRotatedAt: nullable(num),
  rotationReason: oneOf('renew', 'prune', null),
  segmentCount: int,
  queuedCount: int,
  autoResumeAt: nullable(num),
  overageActive: bool,
  overageResetsAt: nullable(num),
  ownerSessionId: nullable(str),
  awaitingUser: AWAITING_USER,
  awaitingUserSource: AWAITING_USER_SOURCE,
};
const LIST_ONLY_TYPES: Record<string, Schema> = {
  awaitingWake: bool,
  playbook: nullable(str),
  stage: nullable(str),
};
function keyed(keys: readonly string[], types: Record<string, Schema>, what: string): Record<string, Schema> {
  const extra = Object.keys(types).filter(k => !keys.includes(k));
  const missing = keys.filter(k => !(k in types));
  if (extra.length || missing.length) {
    throw new Error(`outputSchemas: ${what} drifted from its key list — missing ${missing.join(', ') || 'none'}, extra ${extra.join(', ') || 'none'}`);
  }
  return Object.fromEntries(keys.map(k => [k, types[k]]));
}
const CONDUCTOR_VIEW = obj(keyed(CONDUCTOR_VIEW_KEYS, CONDUCTOR_VIEW_TYPES, 'CONDUCTOR_VIEW'));
const ROW_VIEW = extend(CONDUCTOR_VIEW, keyed(LIST_ONLY_KEYS, LIST_ONLY_TYPES, 'LIST_ONLY'));

// A stopped session's row (SessionRow, src/projects.ts) plus its playbook binding.
const SESSION_ROW = obj({
  sessionId: str, firstPrompt: nullable(str), title: nullable(str), conducted: bool,
  turnEndSeq: int, viewedSeq: int, temp: bool, archived: bool, lastActivity: num, size: num,
  resumeMode: str, awaitingUser: AWAITING_USER, awaitingUserSource: AWAITING_USER_SOURCE,
  playbook: nullable(str), stage: nullable(str),
});

const HUMAN_PROMPTS = strArr;
const SENT = obj({ sessionId: nullable(str), mode: str, sentText: str, humanPrompts: HUMAN_PROMPTS }, { optional: ['humanPrompts'] });

const SYNC_BASE = { ok: lit(true), ahead: int, behind: int };

const ENFORCEMENT = { type: ['object', 'null'], properties: { conductorSessionId: str, mode: str }, required: ['conductorSessionId', 'mode'], additionalProperties: false };
const RUN_MEMBER = obj({ sessionId: str, playbook: str, stage: str, live: bool });
const NEXT_MOVE = obj({ to: str, via: str, ok: bool, code: str, reason: str }, { optional: ['code', 'reason'] });
const EVENT_ROW = open('an event-log `call`, `session` or `config` row, passed through as stored (docs/event-log.md)');

const TOOL_POLICY: Schema = {
  anyOf: [oneOf('allow', 'deny'), obj({ pin: mapOf({ type: ['string', 'number', 'boolean', 'null'] }) })],
};
const PLAYBOOK_DETAIL = obj({
  id: str, name: str, description: str, entryStages: strArr,
  stages: mapOf(obj({
    needs: arr(obj({ stage: str, position: strArr, liveness: oneOf('live', 'retired', 'any') })),
    workers: oneOf('one', 'many'),
    tools: mapOf(TOOL_POLICY),
    spawnable: bool,
    description: str,
  }, { optional: ['description'] })),
  transitions: arr(obj({ from: str, to: str, via: str, description: str }, { optional: ['description'] })),
});

const RECENT_BLOCK = variants(
  obj({ type: lit('tool_use'), name: nullable(str), toolUseId: nullable(str), input: any('the tool call input, verbatim'), inputTruncated: bool },
    { optional: ['name', 'toolUseId'] }),
  obj({ type: lit('thinking'), text: str, inputTruncated: bool }),
);
const RECENT_MESSAGE = obj({
  index: int, msgId: str, hasToolUse: bool, textChars: int, textTruncated: bool,
  promptedBy: lit('human'), narrationChars: int, narrationTruncated: bool,
  hasPlan: lit(true), planTruncated: lit(true), planPath: str,
  questionCount: int, questionsTruncated: lit(true), blocks: arr(RECENT_BLOCK),
  text: str,
}, { optional: ['promptedBy', 'narrationChars', 'narrationTruncated', 'hasPlan', 'planTruncated', 'planPath', 'questionCount', 'questionsTruncated', 'blocks'] });

const DIFF_FILE = obj({ path: str, status: str, additions: int, deletions: int, binary: bool, oldPath: str }, { optional: ['oldPath'] });
const DIFF_TOTALS = obj({ files: int, additions: int, deletions: int });
const DIFF_HEAD = { project: str, worktree: str, baseRef: str, head: nullable(str), ahead: nullable(int) };

const BASH_RESULT = { exitCode: nullable(int), durationMs: num, truncated: lit(true), timedOut: lit(true), descendantsMaySurvive: lit(true), outputMayBeIncomplete: lit(true), output: str };
const BASH_RESULT_OPTIONAL = ['truncated', 'timedOut', 'descendantsMaySurvive', 'outputMayBeIncomplete'];
const BASH_SPAWN_ERROR = { exitCode: lit(null), durationMs: num, error: lit(true), output: str };
function bashSchema(place: Record<string, Schema>): Schema {
  return variants(
    obj({ ...place, ...BASH_RESULT }, { optional: BASH_RESULT_OPTIONAL }),
    obj({ ...place, ...BASH_SPAWN_ERROR }),
  );
}

const READ_BASE = { path: str, size: int, truncated: bool, body: str };
const TRANSFER_END = obj({ system: str, remoteId: nullable(str), path: str });
const REMOTE_ENUMERATION = variants(
  obj({ system: str, label: str, state: lit('listed'), remoteIds: strArr }),
  obj({ system: str, label: str, state: lit('not-enumerable'), reason: str }),
  obj({ system: str, label: str, state: lit('failed'), reason: str, code: str }, { optional: ['code'] }),
);

// ---------- per tool ----------

export const OUTPUT_SCHEMAS: Record<string, Schema> = {
  list_projects: obj({
    projects: arr(obj({
      name: str, path: str, workspace: nullable(str), system: str, remoteId: nullable(str), degraded: str,
      liveCount: int, systemUnreachable: nullable(str), gitRefusal: nullable(str), isGitRepo: bool, unbornHead: bool,
      worktrees: arr(obj({ ...WORKTREE_META_PROPS, sessions: SESSION_SUMMARY, mergeStatus: MERGE_STATUS }, { optional: WORKTREE_OPTIONAL })),
      sessions: SESSION_SUMMARY,
    }, { optional: ['degraded', 'isGitRepo'] })),
  }),
  list_sessions: obj({
    groups: arr(obj({
      project: str, worktree: nullable(str), path: str, branch: nullable(str),
      mergeStatus: { ...MERGE_STATUS, type: ['object', 'null'] },
      live: arr(ROW_VIEW), inactive: arr(SESSION_ROW), archivedCount: int,
    })),
  }),
  describe_session: variants(
    obj({ sessionId: str, live: ROW_VIEW }),
    obj({ sessionId: str, project: str, worktree: nullable(str), path: str, retired: SESSION_ROW, exit: { ...EXIT, type: ['object', 'null'] } }),
  ),
  list_worktrees: obj({ worktrees: arr(WORKTREE_VIEW) }),
  get_transcript: obj({
    status: str, sessionId: nullable(str), source: oneOf('ring', 'disk'),
    events: arr(open('a transcript event (the UI event union, shared/uiEvent.ts), passed through')),
    lastSeq: int, trimmedBefore: int, hasMore: bool, nextFrom: int,
  }),
  spawn_instance: extend(CONDUCTOR_VIEW, { titleNudge: str }, { optional: ['titleNudge'] }),
  send_prompt: obj({ sessionId: nullable(str), status: str, forwarded: int, humanPrompts: HUMAN_PROMPTS }, { optional: ['forwarded', 'humanPrompts'] }),
  set_mode: obj({ sessionId: nullable(str), mode: str }),
  approve_plan: SENT,
  reject_plan: SENT,
  answer_question: SENT,
  set_idle_timeout: obj({ sessionId: str, armed: bool }),
  set_session_title: obj({ sessionId: str, title: nullable(str) }),
  run_code: obj({
    result: nullable(str), logs: str, exitCode: nullable(int), timedOut: bool, truncated: bool, durationMs: num,
    resultChars: int, logsTruncated: lit(true),
    error: obj({ name: str, message: str, code: str, status: int }, { optional: ['code', 'status'] }),
  }, { optional: ['resultChars', 'logsTruncated', 'error'] }),
  renew_session: variants(
    obj({ ok: lit(true), sessionId: str, willClearAtTurnEnd: lit(true), message: str }),
    obj({ requested: lit(true), sessionId: nullable(str), note: str }),
  ),
  prune_session: obj({
    ok: lit(true), sessionId: nullable(str), keptTurns: int, prunedTurns: int,
    saved: obj({ thinking: int, toolInputs: int, toolOutputs: int }), contextTokensBefore: nullable(int),
  }),
  interrupt_turn: obj({ sessionId: nullable(str), status: str, interrupting: bool }),
  kill_instance: obj({ sessionId: str }),
  create_worktree: obj({ ...WORKTREE_PROPS, postWorktreeCreate: HOOK_RESULT }, { optional: WORKTREE_OPTIONAL }),
  delete_worktree: obj({ project: str, worktree: str, renewNudge: str }, { optional: ['renewNudge'] }),
  sync_worktree: variants(
    obj({ ...SYNC_BASE, action: lit('already-in-sync') }),
    obj({ ...SYNC_BASE, action: lit('fast-forwarded'), newSha: str }),
    obj({ ...SYNC_BASE, action: lit('rebased'), newSha: str }),
    obj({ ...SYNC_BASE, action: oneOf('commit-required', 'rebase-conflict'), branch: str, baseBranch: str, baseSha: str, rebasePrompt: str }),
  ),
  merge_worktree: obj({ ok: lit(true), output: str, newSha: str, worktreeFastForwarded: bool, postWorktreeMerge: HOOK_RESULT }),
  list_workspaces: obj({ workspaces: arr(obj({ name: str, projectCount: int })) }),
  enumerate_remotes: obj({ remotes: arr(REMOTE_ENUMERATION) }),
  create_workspace: obj({ added: bool, name: str }),
  delete_workspace: obj({ removed: bool, name: str, clearedProjects: strArr }),
  rename_workspace: obj({ renamed: bool, name: str, movedProjects: strArr }),
  set_project_workspace: obj({ project: str, workspace: nullable(str) }),
  set_project_remote: obj({ name: str, system: str, remoteId: nullable(str), systemPath: nullable(str) }),
  create_project: obj({ name: str, path: str, system: str, remoteId: nullable(str), gitSkipped: str, scaffold: str }, { optional: ['gitSkipped', 'scaffold'] }),
  adopt_project: obj({ ok: lit(true), name: str, path: str, system: str, remoteId: nullable(str) }),
  list_project_conventions: obj({
    conventions: arr(obj({ slug: str, name: str, description: str, builtin: bool, hasScaffold: bool })),
    incomplete: str,
  }, { optional: ['incomplete'] }),
  list_conductor_conventions: obj({
    conventions: arr(obj({ slug: str, name: str, description: str, builtin: bool, enabled: bool })),
    incomplete: str,
  }, { optional: ['incomplete'] }),
  list_playbooks: obj({
    playbooks: arr(obj({ id: str, name: str, description: str, entryStages: strArr, spawnableStages: strArr, plugin: str }, { optional: ['plugin'] })),
    errors: arr(obj({ id: str, message: str })),
  }),
  describe_playbook: PLAYBOOK_DETAIL,
  playbook_state: variants(
    obj({ tracked: lit(false), runs: arr(obj({ root: str, members: arr(RUN_MEMBER) })), enforcement: ENFORCEMENT }),
    obj({
      tracked: lit(false), worker: lit(null), run: lit(null), nextMoves: arr(NEXT_MOVE), history: arr(EVENT_ROW),
      historyTruncated: lit(false), enforcement: ENFORCEMENT, reason: str,
    }),
    obj({
      tracked: lit(true),
      worker: obj({
        sessionId: str, playbook: str, stage: str, stageHistory: strArr, provenance: mapOf(str),
        live: bool, runRoot: str, project: str, worktree: str,
      }, { optional: ['project', 'worktree'] }),
      run: open('the run the worker belongs to: {root, members}'),
      nextMoves: arr(NEXT_MOVE), playbookMissing: str, reason: str,
      history: arr(EVENT_ROW), historyTruncated: bool, enforcement: ENFORCEMENT,
    }, { optional: ['playbookMissing', 'reason'] }),
  ),
  get_recent_messages: obj({
    sessionId: str, messages: arr(RECENT_MESSAGE), source: oneOf('ring', 'disk'), omittedToolOnly: int,
    retained: obj({ firstSeq: int, lastSeq: int, trimmed: bool }), hint: str,
  }, { optional: ['hint'] }),
  project_status: obj({
    project: str, worktree: nullable(str), cwd: str,
    files: arr(obj({ name: str, kind: oneOf('dir', 'file', 'other') })),
    isGitRepo: bool, gitRefusal: str, unbornHead: bool, branch: nullable(str),
    head: { type: ['object', 'null'], properties: { sha: nullable(str), subject: nullable(str) }, required: ['sha', 'subject'], additionalProperties: false },
    dirty: strArr, dirtyUnknown: lit(true), dirtyTotal: int, dirtyTruncated: bool, recentCommits: strArr,
    baseBranch: str, baseSha: str, mergeStatus: MERGE_STATUS, diffStat: str,
  }, { optional: ['isGitRepo', 'gitRefusal', 'branch', 'head', 'dirty', 'dirtyUnknown', 'dirtyTotal', 'dirtyTruncated', 'recentCommits', 'baseBranch', 'baseSha', 'mergeStatus', 'diffStat'] }),
  project_diff: variants(
    obj({
      ...DIFF_HEAD, summary: lit(true), totals: DIFF_TOTALS, offset: int, truncated: bool, nextOffset: nullable(int),
      files: arr(DIFF_FILE),
      uncommitted: variants(
        obj({ unknown: lit(true), reason: str }),
        obj({
          totals: DIFF_TOTALS, files: arr(DIFF_FILE), untracked: strArr,
          filesTruncated: lit(true), filesTotal: int, untrackedTruncated: lit(true), untrackedTotal: int,
        }, { optional: ['filesTruncated', 'filesTotal', 'untrackedTruncated', 'untrackedTotal'] }),
      ),
    }),
    obj({
      ...DIFF_HEAD, contextLines: int, offset: int, truncated: bool, nextOffset: nullable(int),
      totalLines: int, totalBytes: int, hasUncommittedChanges: bool,
      untracked: strArr, untrackedTruncated: lit(true), untrackedTotal: int, lineTruncated: lit(true),
      includedFiles: strArr, includedFilesTruncated: lit(true), includedFilesTotal: int,
      omittedFiles: strArr, omittedFilesTruncated: lit(true), omittedFilesTotal: int,
      body: str,
    }, { optional: ['untrackedTruncated', 'untrackedTotal', 'lineTruncated', 'includedFiles', 'includedFilesTruncated', 'includedFilesTotal', 'omittedFiles', 'omittedFilesTruncated', 'omittedFilesTotal'] }),
  ),
  project_bash: bashSchema({ project: str, worktree: nullable(str), cwd: str }),
  system_bash: bashSchema({ system: str, remoteId: nullable(str), cwd: str }),
  system_transfer: obj({ from: TRANSFER_END, to: TRANSFER_END, bytes: int, mode: str, moved: bool }),
  project_read: variants(
    obj({ ...READ_BASE, encoding: lit('base64') }),
    obj({ ...READ_BASE, encoding: lit('utf8'), lineCount: int, lineCountExact: bool }),
    obj({ ...READ_BASE, encoding: lit('utf8'), lineCount: int, lineCountExact: lit(true), lineTruncated: lit(true), startLine: int, endLine: int },
      { optional: ['lineTruncated', 'startLine', 'endLine'] }),
  ),
};
