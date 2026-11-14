import express from 'express';
import { EXEC_BODY_LIMIT, runHostExec } from '../hostExec.ts';
import { type PlatformCapabilities } from '../platform/index.ts';

export function mountExec(r: express.Router, { capabilities }: { capabilities: PlatformCapabilities }): void {
  // Plugin-facing command execution (src/hostExec.ts). Mounted AHEAD of the
  // router-wide 1mb parser, which would otherwise refuse a large stdin 413
  // first, and outside the remoteSystems gate: `local` works on every platform,
  // and hostExec refuses a non-local system itself.
  r.post('/exec', express.json({ limit: EXEC_BODY_LIMIT }), async (req, res, next) => {
    // A caller that goes away KILLS the command rather than leaving it to run
    // to its deadline with nobody to read the answer.
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      const { status, body } = await runHostExec(req.body, { capabilities, signal: ac.signal });
      if (!ac.signal.aborted) res.status(status).json(body);
    } catch (e) { next(e); }
  });
}
