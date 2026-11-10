// The half of code mode the child process loads: the `cc` object a run_code
// program sees, and the serialization of its outcome. The child must pull in no
// server module: only limits.ts and Node built-ins.

import { pathToFileURL } from 'node:url';
import { RUN_RESULT_CAP, RUN_ERROR_MESSAGE_CAP, RUN_ERROR_FIELD_CAP, cutChars, cutResult } from './limits.ts';

// The run's token travels in this header on every call and on the result
// delivery; the server revokes it when the run's process settles.
export const RUN_TOKEN_HEADER = 'x-cc-run-token';
export const RUN_URL_ENV = 'CC_RUN_URL';
export const RUN_TOKEN_ENV = 'CC_RUN_TOKEN';

// Names on `cc` that are not tools: a plugin namespace spelled one of these is
// reached with `cc.call('<id>__<tool>', args)`.
export const RESERVED_METHODS: readonly string[] = ['call', 'describe_tools', 'then'];

// The member reserved in every plugin namespace: `cc.<ns>.import(name?)` loads
// the plugin's run_code module. A plugin tool may not be named this.
export const NAMESPACE_IMPORT = 'import';

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
}

export type CallFn = (name: string, args?: unknown) => Promise<unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// `cc.<tool>(args)`, `cc.<plugin_ns>.<tool>(args)`, `cc.call(name, args)`,
// `cc.describe_tools(args)` and `cc.<plugin_ns>.import(name?)`. Dispatch needs no listing: the server's live
// registry resolves every name.
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
  const call: CallFn = async (name, args = {}) => settle(await doFetch(`${opts.url}/tools/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [RUN_TOKEN_HEADER]: opts.token },
    body: JSON.stringify(args ?? {}),
  }));
  const describe = async (args: unknown = {}) => (await call('describe_tools', args) as { tools: unknown }).tools;

  // `cc.<ns>.import(name?)`: a plugin's module. Node evaluates the entry file
  // once per plugin (Node caches the evaluation by URL, a failed one included, so
  // a failure there stays failed for every name), and the factory runs once per (plugin, name) (`modules`, which
  // memoizes a failure only for its own name). docs/code-mode.md → Plugin modules.
  const loadModule = async (id: string, name: string | undefined): Promise<unknown> => {
    const info = await settle(await doFetch(`${opts.url}/run-modules/${encodeURIComponent(id)}`, {
      headers: { [RUN_TOKEN_HEADER]: opts.token },
    }));
    if (!isRecord(info) || typeof info.path !== 'string') {
      throw new ConductorError('MODULE_LOAD_FAILED', `${id}: the server's module lookup answered an unexpected body`, 500);
    }
    const loadFailed = (e: unknown) => {
      const rec = isRecord(e) ? e : {};
      const label = typeof rec.name === 'string' ? rec.name : 'Error';
      const message = typeof rec.message === 'string' ? rec.message : String(e);
      const err = new ConductorError('MODULE_LOAD_FAILED', cutChars(`${id}: ${label}: ${message}`, RUN_ERROR_MESSAGE_CAP), 500);
      err.cause = e;
      return err;
    };
    let factory: unknown;
    try {
      const mod = await import(pathToFileURL(info.path).href) as { default?: unknown }; // server-imports: external
      if (typeof mod.default !== 'function') throw new TypeError("the module's default export is not a function");
      factory = mod.default;
    } catch (e) { throw loadFailed(e); }
    try {
      return await (factory as (ctx: unknown) => unknown)({ pluginId: id, baseUrl: info.baseUrl ?? null, caller: info.caller, cc, module: name ?? null });
    } catch (e) {
      // The plugin's own routing refused the name: the program sees it as such.
      if (isRecord(e) && e.code === 'MODULE_UNKNOWN') {
        const err = new ConductorError('MODULE_UNKNOWN', String(e.message ?? ''), 404);
        err.cause = e;
        throw err;
      }
      throw loadFailed(e);
    }
  };
  const modules = new Map<string, Promise<unknown>>();
  const importModule = async (id: string, name?: unknown): Promise<unknown> => {
    if (name !== undefined && (typeof name !== 'string' || name === '')) {
      throw new ConductorError('ARGS_INVALID', `the module name passed to import must be a non-empty string when given, got ${typeof name === 'string' ? "''" : typeof name}`, 400);
    }
    const key = `${id}\0${name ?? ''}`;
    let p = modules.get(key);
    if (!p) { p = loadModule(id, name); modules.set(key, p); }
    return p;
  };

  const member = (x: string) => new Proxy((args?: unknown) => call(x, args), {
    get(_t, y) {
      if (typeof y !== 'string' || y === 'then') return undefined;
      if (y === NAMESPACE_IMPORT) return (name?: unknown) => importModule(x.replaceAll('_', '-'), name);
      return (args?: unknown) => call(`${x.replaceAll('_', '-')}__${y}`, args);
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
