// The statusCode-bearing Error the REST and MCP surfaces consume.
//
// `err.statusCode` is what the express error handler (routes.ts) reads to pick
// a response code, and what `codeForStatus` (mcp/server.ts) maps to a JSON-RPC
// code. `extra` merges arbitrary fields onto the error for handlers that render
// more than a message — the plugin routes attach `{ status, tail, retryAfter }`
// so a 503 body can explain a crashed/backed-off child.
//
// One home for the construction; every module that needs it imports from here
// rather than declaring its own copy.
export function httpError(
  statusCode: number,
  message: string,
  extra: Record<string, unknown> = {},
): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode }, extra);
}

// The message a REST error body carries — the trailing error middleware's and a
// streamed result line's (src/ndjsonAction.ts). `e` may be any thrown value;
// one without a string `message` reads 'internal error'.
export function errMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return 'internal error';
}
