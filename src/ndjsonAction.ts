import type express from 'express';
import { errMessage } from './httpError.ts';

// Runs a long action that reports progress via onChunk and flips into
// streaming mode via onValidated — the plugin library's install/update
// (src/plugins/api.ts), cc's self-update and the Claude CLI update
// (src/routes.ts).
// Before onValidated fires, a rejection is a normal thrown error — routed to
// the shared trailing error middleware via `next`, same as every other route
// (preserves the 404/409/400 status codes of validation failures).
// After onValidated fires, response bytes are already committed as 200
// NDJSON, so both success and failure resolve into a single terminal
// {type:'result', ...} line instead of an HTTP status.
export function streamNdjsonAction(res: express.Response, next: express.NextFunction, run: (onChunk: (phase: string, text: string) => void, onValidated: () => void) => Promise<unknown>): void {
  let streaming = false;
  const write = (obj: unknown) => { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`); };
  const onValidated = () => {
    streaming = true;
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-store');
    res.flushHeaders();
  };
  const onChunk = (phase: string, text: string) => write({ type: 'chunk', phase, text });
  run(onChunk, onValidated).then(
    (result) => {
      if (streaming) { write({ type: 'result', ok: true, result }); res.end(); }
      else res.json(result);
    },
    (e) => {
      if (streaming) { write({ type: 'result', ok: false, error: errMessage(e), tail: (e as { tail?: unknown } | null)?.tail }); res.end(); }
      else next(e);
    },
  );
}
