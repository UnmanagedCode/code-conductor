import express from 'express';
import type { InstanceManagerLike } from '../instanceTypes.ts';
import type { PlaybookGate } from '../mcp/playbookGate.ts';
import { WORKER_TOOLS_POLICY } from '../settings.ts';
import { workerToolsHookBody } from '../hookBroker.ts';

export function mountInstanceHooks(r: express.Router, { instances, playbookGate }: { instances: InstanceManagerLike; playbookGate?: PlaybookGate | null }): void {
  // Tool-hook http callback: delegates to the instance's HookBroker; an
  // unknown instance gets 200 + deny. The `?policy=worker-tools` entry
  // (src/settings.ts) is answered here instead, from the playbook gate's
  // worker-tools check — `deny` or `{}`, never `allow` — and never reaches the
  // broker, so no existing handler runs twice.
  r.post('/instances/:id/hook-callback', (req, res) => {
    const inst = instances.get(req.params.id);
    if (inst && req.query.policy === WORKER_TOOLS_POLICY) {
      const body = (req.body ?? {}) as { hook_event_name?: unknown; tool_name?: unknown };
      if (!playbookGate || body.hook_event_name !== 'PreToolUse' || typeof body.tool_name !== 'string') {
        res.status(200).json(workerToolsHookBody(null));
        return;
      }
      void playbookGate.checkWorkerTool({
        sessionId: inst.sessionId, parentSessionId: inst.parentSessionId, toolName: body.tool_name,
      }).then(({ deny }) => { res.status(200).json(workerToolsHookBody(deny)); });
      return;
    }
    if (!inst) {
      // The CLI is the instance's own subprocess so this branch is
      // theoretical, but reply deterministically: 200 + deny body so
      // the CLI doesn't fall into its non-blocking-error path.
      res.status(200).json({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'orchestrator: instance not found',
        },
      });
      return;
    }
    // req.body is the raw CLI envelope (express.json already parsed it);
    // kept as `req.body ?? {}` exactly as before — the handler narrows.
    inst.handleHookCallback(req.body ?? {}, res);
  });

  // THE REDIRECTED BASH. A worker on a remote system has its Bash command
  // rewritten into an invocation of src/systems/bashForwarder.ts, which posts
  // the ORIGINAL command here; cc runs it on the system as its own `exec` and
  // STREAMS the result back, which the forwarder replays as its own
  // stdout/stderr/exit code.
  //
  // NDJSON, one frame per line, not a single JSON object: a build or a test
  // run has to reach the worker while it is still running, and an object
  // cannot be parsed until its last byte. `application/x-ndjson` +
  // `flushHeaders()` is the same streaming shape the plugin-library routes use
  // (src/plugins/api.ts). The frames are `{t:'notice'|'out'|'err', text}` and
  // a terminal `{t:'exit', code}`; the two output streams are separate frames
  // because the forwarder writes each to a different file descriptor.
  //
  // The socket closing is load-bearing, not incidental: the CLI kills the
  // forwarder when the worker interrupts or stops a background task, and that
  // abort is cc's only signal to stop the command on the far side. At a plain
  // tool TIMEOUT it detaches instead, and NO ABORT REACHES THIS ROUTE —
  // measured at CLI 2.1.258, the socket stayed open and was still accepting
  // frame writes long past the timeout while the command ran on. What DOES
  // close it — an interrupt, or the worker stopping the background task —
  // was measured reaching the `close` handler below (card 2026-0310 §1).
  r.post('/instances/:id/bash-forward', async (req, res) => {
    // A REFUSAL IS FRAMED TOO. The forwarder reads frames and ignores anything
    // else, so a refusal written in some other shape would reach the worker as
    // an unexplained failure instead of as its reason.
    const refuse = (status: number, why: string) => {
      res.status(status).type('application/x-ndjson')
        .send(`${JSON.stringify({ t: 'err', text: `cc: ${why}\n` })}\n${JSON.stringify({ t: 'exit', code: 1 })}\n`);
    };
    const inst = instances.get(req.params.id);
    const redirect = inst?._redirect;
    if (!redirect) { refuse(404, 'this session is not redirected to a system'); return; }
    const body = (req.body ?? {}) as { command?: unknown };
    const command = typeof body.command === 'string' ? body.command : '';
    if (!command) { refuse(400, 'the forwarder sent no command'); return; }
    const abort = new AbortController();
    // Unchanged by streaming: `close` fires both on a normal end and on a
    // client disconnect, and `writableEnded` is what tells them apart.
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-store');
    res.flushHeaders();
    const write = (frame: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`${JSON.stringify(frame)}\n`);
    };
    // runForwarded never rejects: every failure comes back as a non-zero exit
    // with its reason streamed on `err`, which is the channel the worker reads.
    const result = await redirect.runForwarded(command, {
      signal: abort.signal,
      sink: {
        notice: (text) => write({ t: 'notice', text }),
        out: (text) => write({ t: 'out', text }),
        err: (text) => write({ t: 'err', text }),
      },
    });
    // ONLY the code: the text has already gone out through the sink, and
    // writing the aggregate here would deliver every byte twice.
    write({ t: 'exit', code: result.code });
    if (!res.writableEnded) res.end();
  });
}
