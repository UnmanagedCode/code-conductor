// How one tools/call answers: a plain JSON response, or — when the client
// accepts it — a Server-Sent Events stream carrying `notifications/progress`
// before the final JSON-RPC response (MCP Streamable HTTP). The stream opens
// lazily, on the handler's first progress(), so every call that never reports
// progress answers exactly as it always did.

import type express from 'express';

export interface CallStream {
  progress(progress: number, message: string): void;
  send(response: unknown): void;
}

export function createCallStream(
  res: express.Response,
  { sse, progressToken }: { sse: boolean; progressToken: string | number | undefined },
): CallStream {
  let open = false;
  const write = (data: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: message\ndata: ${JSON.stringify(data)}\n\n`);
  };
  return {
    progress(progress, message) {
      if (!sse || res.writableEnded || res.destroyed) return;
      if (!open) {
        open = true;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.flushHeaders();
      }
      if (progressToken === undefined) return;
      write({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress, message } });
    },
    send(response) {
      if (res.writableEnded || res.destroyed) return;
      if (!open) { res.json(response); return; }
      write(response);
      res.end();
    },
  };
}
