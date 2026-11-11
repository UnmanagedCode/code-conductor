// The half of code mode the child process loads: the `cc` object a run_code
// program sees, and the serialization of its outcome. The child must pull in no
// server module: only the leaf modules limits.ts and ../mcp/argValidation.ts,
// and Node built-ins.

import { pathToFileURL } from 'node:url';
import { validateArgs } from '../mcp/argValidation.ts';
import { RUN_RESULT_CAP, RUN_ERROR_MESSAGE_CAP, RUN_ERROR_FIELD_CAP, cutChars, cutResult } from './limits.ts';

// The run's token travels in this header on every call and on the result
// delivery; the server revokes it when the run's process settles.
export const RUN_TOKEN_HEADER = 'x-cc-run-token';
export const RUN_URL_ENV = 'CC_RUN_URL';
export const RUN_TOKEN_ENV = 'CC_RUN_TOKEN';

// Names on `cc` that are not tools: a plugin namespace spelled one of these is
// reached with `cc.call('<id>__<tool>', args)`.
export const RESERVED_METHODS: readonly string[] = ['call', 'describe_tools', 'then'];

// The run's plugin-provided names, `{id: [names]}` as JSON: sync routing in the
// child needs them before any lookup (schemas and the module path come from the
// server's lookup route, on the first call into a namespace).
export const RUN_MEMBERS_ENV = 'CC_RUN_MEMBERS';

// A call a tool refused or that failed. `status` 200 is a soft refusal (the
// tool answered `{ok:false, code, …}`); 400 and above is a fault (unknown
// tool, bad arguments, a server error).
export class ConductorError extends Error {
  code: string;
  reason: string;
  status: number;
  details?: unknown;
  constructor(code: string, reason: string, status: number, details?: unknown) {
    super(`${code}: ${reason}`);
    this.name = 'ConductorError';
    this.code = code;
    this.reason = reason;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export interface CcOptions {
  // `<server>/mcp/<sessionId>`
  url: string;
  token: string;
  fetch?: typeof fetch;
  // Plugin id → the member names it provides to this run. A Map, so an id like
  // `constructor` never reaches Object.prototype.
  members?: ReadonlyMap<string, ReadonlySet<string>>;
}

export type CallFn = (name: string, args?: unknown) => Promise<unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const PLUGIN_SEP = '__';

// `cc.<tool>(args)`, `cc.<plugin_ns>.<tool>(args)`, `cc.call(name, args)` and
// `cc.describe_tools(args)`. `call` is the one dispatcher: a `<id>__<m>` the run
// snapshot lists as a plugin member runs the member path (callMember); any
// other name is a REST-alias POST, which the server's live registry resolves.
export function createCc(opts: CcOptions): unknown {
  const doFetch = opts.fetch ?? fetch;
  // The server's answer, or the ConductorError a refusal or fault maps to.
  const settle = async (res: Response): Promise<unknown> => {
    const text = await res.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* reported below */ }
    if (res.status >= 400 || (isRecord(body) && body.ok === false)) {
      if (isRecord(body) && typeof body.code === 'string') {
        throw new ConductorError(body.code, String(body.reason ?? ''), res.status, body.details);
      }
      throw new ConductorError(`HTTP_${res.status}`, text.slice(0, 500), res.status);
    }
    return body;
  };
  const post = async (name: string, args: unknown) => settle(await doFetch(`${opts.url}/tools/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [RUN_TOKEN_HEADER]: opts.token },
    body: JSON.stringify(args ?? {}),
  }));
  const describe = async (args: unknown = {}) => (await post('describe_tools', args) as { tools: unknown }).tools;

  // Per namespace and run: the server's lookup, then the module load. Each is
  // memoized, a failure included, so a load failure fails every member of the
  // namespace. docs/plugins.md → `runCode`.
  interface Info { path: string; baseUrl: unknown; caller: unknown; members: Array<{ name: string; inputSchema: unknown }> }
  const lookups = new Map<string, Promise<Info>>();
  const loads = new Map<string, Promise<Record<string, unknown>>>();
  const lookup = (id: string, wire: string): Promise<Info> => {
    let p = lookups.get(id);
    if (!p) {
      p = (async () => {
        let body: unknown;
        try {
          body = await settle(await doFetch(`${opts.url}/run-modules/${encodeURIComponent(id)}`, { headers: { [RUN_TOKEN_HEADER]: opts.token } }));
        } catch (e) {
          // The plugin no longer provides the member: refused as an unknown tool is.
          if (e instanceof ConductorError && e.code === 'TOOL_UNKNOWN') throw new ConductorError('TOOL_UNKNOWN', `unknown tool: ${wire} — ${e.reason}`, e.status);
          throw e;
        }
        if (!isRecord(body) || typeof body.path !== 'string' || !Array.isArray(body.members)) {
          throw new ConductorError('PLUGIN_LOAD_FAILED', `${id}: the server's member lookup answered an unexpected body`, 500);
        }
        return body as unknown as Info;
      })();
      lookups.set(id, p);
    }
    return p;
  };
  const loadFailed = (id: string, e: unknown) => {
    const rec = isRecord(e) ? e : {};
    const label = typeof rec.name === 'string' ? rec.name : 'Error';
    const message = typeof rec.message === 'string' ? rec.message : String(e);
    const err = new ConductorError('PLUGIN_LOAD_FAILED', cutChars(`${id}: ${label}: ${message}`, RUN_ERROR_MESSAGE_CAP), 500);
    err.cause = e;
    return err;
  };
  const load = (id: string, info: Info): Promise<Record<string, unknown>> => {
    let p = loads.get(id);
    if (!p) {
      p = (async () => {
        try {
          const mod = await import(pathToFileURL(info.path).href) as { default?: unknown }; // server-imports: external
          if (typeof mod.default !== 'function') throw new TypeError("the module's default export is not a function");
          const obj = await (mod.default as (ctx: unknown) => unknown)({ pluginId: id, baseUrl: info.baseUrl ?? null, caller: info.caller, cc });
          if (!isRecord(obj) && typeof obj !== 'function') throw new TypeError('the factory did not return an object');
          return obj as Record<string, unknown>;
        } catch (e) { throw loadFailed(id, e); }
      })();
      loads.set(id, p);
    }
    return p;
  };
  const callMember = async (id: string, m: string, args: unknown): Promise<unknown> => {
    const wire = `${id}${PLUGIN_SEP}${m}`;
    const info = await lookup(id, wire);
    const decl = info.members.find(x => x.name === m);
    if (!decl) throw new ConductorError('TOOL_UNKNOWN', `unknown tool: ${wire} — plugin '${id}' no longer provides '${m}'`, 404);
    const bad = validateArgs(decl.inputSchema, args, wire);
    if (bad) throw new ConductorError('ARGS_INVALID', bad, 400);
    const obj = await load(id, info);
    const fn = obj[m];
    if (typeof fn !== 'function') throw loadFailed(id, new TypeError(`the loaded module has no function '${m}'`));
    return Reflect.apply(fn, obj, [args ?? {}]);
  };

  const call: CallFn = async (name, args = {}) => {
    const sep = name.indexOf(PLUGIN_SEP);
    if (sep > 0) {
      const id = name.slice(0, sep);
      const m = name.slice(sep + PLUGIN_SEP.length);
      if (opts.members?.get(id)?.has(m)) return callMember(id, m, args);
    }
    return post(name, args);
  };

  const member = (x: string) => new Proxy((args?: unknown) => call(x, args), {
    get(_t, y) {
      if (typeof y !== 'string' || y === 'then') return undefined;
      return (args?: unknown) => call(`${x.replaceAll('_', '-')}${PLUGIN_SEP}${y}`, args);
    },
  });
  const cc: unknown = new Proxy(function cc() {}, {
    get(_t, x) {
      if (typeof x !== 'string' || x === 'then') return undefined;
      if (x === 'call') return call;
      if (x === 'describe_tools') return describe;
      return member(x);
    },
  });
  return cc;
}

export interface SerializedOutcome {
  result: string | null;
  resultChars: number;
  truncated: boolean;
  error?: { name: string; message: string; code?: string; status?: number };
}

export function serializeError(e: unknown): NonNullable<SerializedOutcome['error']> {
  const rec = isRecord(e) ? e : {};
  const err: NonNullable<SerializedOutcome['error']> = {
    name: cutChars(typeof rec.name === 'string' ? rec.name : 'Error', RUN_ERROR_FIELD_CAP),
    message: cutChars(typeof rec.message === 'string' ? rec.message : String(e), RUN_ERROR_MESSAGE_CAP),
  };
  if (typeof rec.code === 'string') err.code = cutChars(rec.code, RUN_ERROR_FIELD_CAP);
  if (typeof rec.status === 'number' && Number.isInteger(rec.status)) err.status = rec.status;
  return err;
}

// The function's return value (or what it threw) as the run-result body. A
// value that is not JSON-serializable is the run's error, not a crash.
export function serializeOutcome(o: { value: unknown } | { thrown: unknown }): SerializedOutcome {
  if ('thrown' in o) return { result: null, resultChars: 0, truncated: false, error: serializeError(o.thrown) };
  let text: string | undefined;
  try { text = JSON.stringify(o.value); } catch (e) {
    return { result: null, resultChars: 0, truncated: false, error: serializeError(e) };
  }
  if (text === undefined) return { result: null, resultChars: 0, truncated: false };
  if (text.length <= RUN_RESULT_CAP) return { result: text, resultChars: text.length, truncated: false };
  return {
    result: cutResult(text, text.length),
    resultChars: text.length,
    truncated: true,
  };
}
