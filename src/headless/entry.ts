// The headless process: what `node server.ts` does when its argv carries a
// headless flag (src/headless/args.ts). Logs go to stderr — stdout carries the
// result in the requested --output-format (src/headless/result.ts), preceded
// under `stream-json` by the live CLI lines (src/headless/stream.ts) — then cc
// boots as usual minus the web build and the dependency sync, runs one
// New-conductor session to quiescence (src/headless/runner.ts), writes the
// result and exits with its code. Nothing is torn down: state is left as a
// normal cc death leaves it.

import os from 'node:os';
import { readHeadlessPrompt, HEADLESS_SYNOPSIS, type HeadlessArgs } from './args.ts';
import { runHeadless, type RunFacts, type RunHandle } from './runner.ts';
import { EXIT_CODES, bareResult, renderResult, signalExitCode, type HeadlessResult } from './result.ts';
import { createHeadlessStream, type HeadlessStream } from './stream.ts';
import { RootLockHeldError, RootLockUnreadableError } from '../rootLock.ts';
import type { InstanceManagerLike } from '../instanceTypes.ts';
import { errMsg } from '../../shared/basics.ts';
import type { HealthFocus } from '../../shared/focus.ts';
import { recordHeadlessRun } from './lastRun.ts';

export interface HeadlessBoot {
  instances: InstanceManagerLike | null;
  host: string;
  port: number;
  // The session GET /api/health tells the UI to focus on (server.ts); set when the root spawns.
  focus: HealthFocus | null;
}

export interface HeadlessEntryDeps {
  // server.ts's start(), already given the entry's options plus `headless`.
  start: () => Promise<HeadlessBoot>;
}

// The stderr lines naming where the run's web UI answers: the bound address, or
// for a wildcard bind every non-internal IPv4 (in a container, its own IP).
export function headlessUiLines(host: string, port: number, nets: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const hosts = host === '0.0.0.0' || host === '::'
    ? Object.values(nets).flatMap((list) => list ?? []).filter((n) => n.family === 'IPv4' && !n.internal).map((n) => n.address)
    : [host];
  return hosts.map((h) => `headless: UI at http://${h.includes(':') ? `[${h}]` : h}:${port}`);
}

export async function headlessMain(args: Exclude<HeadlessArgs, { kind: 'none' | 'view' }>, { start }: HeadlessEntryDeps): Promise<void> {
  // Before anything can log: every console line goes to stderr, and the result
  // (and any streamed line) goes out through the real stdout.
  const format = args.format;
  const writeOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  let written = false;
  let resultExitCode = 0;
  let exited = false;
  const exitOnce = (code: number): void => {
    if (exited) return;
    exited = true;
    process.exit(code);
  };
  let stream: HeadlessStream | null = null;
  const finish = (r: HeadlessResult): void => {
    if (written) return;
    written = true;
    // Node suppresses a signal's default action while any listener exists; once
    // the result is out, a signal must kill the process again, so none of the
    // entry's may outlive this (the runner removes its own when it delivers).
    for (const s of ['SIGINT', 'SIGTERM'] as const) { process.off(s, recordSignal); process.off(s, onEarlySignal); }
    resultExitCode = r.exitCode;
    stream?.close();
    const o = renderResult(r, format);
    if (o.stderr) process.stderr.write(o.stderr);
    // Writes are ordered, so every streamed line is flushed before the result,
    // and the exit waits for the result's own flush. On a closed or destroyed
    // stdout the callback still fires, with an error, and names it on stderr —
    // the only trace an undelivered result leaves.
    writeOut(o.stdout, (err?: Error | null) => {
      if (err) process.stderr.write(`headless: the result was not delivered: stdout closed (${(err as NodeJS.ErrnoException).code ?? errMsg(err)})\n`);
      exitOnce(r.exitCode);
    });
  };

  // Nothing reads stdout any more (EPIPE, or any other write error). Never
  // throws and never reaches the catch-all: streaming stops, and the run ends
  // as a conductor_error — or, once the result is being written, the process
  // exits with that result's code.
  function onStdoutError(e: NodeJS.ErrnoException): void {
    const code = e.code ?? errMsg(e);
    stream?.close();
    if (written) { exitOnce(resultExitCode); return; }
    if (run) {
      console.error(`headless: stdout closed (${code}); ending the run`);
      run.fail(`stdout closed (${code}): nothing is reading the output`);
      return;
    }
    finish(running
      ? bareResult('conductor_error', `stdout closed (${code})`, EXIT_CODES.conductor_error)
      : bareResult('boot_failed', `stdout closed (${code})`, EXIT_CODES.boot_failed));
  }
  process.stdout.on('error', onStdoutError);

  // How far the run got, for the catch-all below: the first signal seen (the
  // runner handles signals itself once it runs; this only records), and
  // whether the runner has started.
  let signalSeen: NodeJS.Signals | null = null;
  let running = false;
  let run: RunHandle | null = null;
  function recordSignal(signal: NodeJS.Signals): void { signalSeen ??= signal; }
  // Until the runner takes over, a signal ends the run with no root to interrupt.
  function onEarlySignal(signal: NodeJS.Signals): void {
    finish(bareResult('signal', `interrupted by ${signal}`, signalExitCode(signal)));
  }
  for (const s of ['SIGINT', 'SIGTERM'] as const) { process.on(s, recordSignal); process.on(s, onEarlySignal); }

  // The one catch-all that owns the output: whatever throws or rejects, from
  // here or from anything else in the process, still writes one result object.
  // Once the root exists the result keeps its session facts (costUsd stays
  // null: the read is async and the run is already failing).
  const fail = (e: unknown): void => {
    console.error('headless: unexpected failure:', e);
    const why = errMsg(e);
    let r: HeadlessResult;
    if (signalSeen) r = bareResult('signal', `interrupted by ${signalSeen}; then: ${why}`, signalExitCode(signalSeen));
    else if (running) r = bareResult('conductor_error', `the headless run failed: ${why}`, EXIT_CODES.conductor_error);
    else r = bareResult('boot_failed', `failed to start: ${why}`, EXIT_CODES.boot_failed);
    let facts: RunFacts | null = null;
    try { facts = run?.facts() ?? null; } catch { /* the facts are best-effort here */ }
    try { run?.detach(); } catch { /* finish removes the entry's own listeners regardless */ }
    finish(facts ? { ...r, ...facts } : r);
  };
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);

  try {
    await main();
  } catch (e) {
    fail(e);
  }

  async function main(): Promise<void> {
    const usage = (message: string): void => {
      process.stderr.write(`${message}\n${HEADLESS_SYNOPSIS}\n`);
      finish(bareResult('usage_error', message, EXIT_CODES.usage_error));
    };
    if (args.kind === 'usage') { usage(args.message); return; }
    if ('file' in args.source && args.source.file === '-') console.error('headless: reading the prompt from stdin');
    const prompt = await readHeadlessPrompt(args.source);
    if (written) return;
    if (prompt.kind === 'usage') { usage(prompt.message); return; }

    let boot: HeadlessBoot;
    try {
      boot = await start();
    } catch (e) {
      if (e instanceof RootLockHeldError || e instanceof RootLockUnreadableError) {
        console.error(e.message);
        finish(bareResult('root_held', e.message, EXIT_CODES.root_held));
      } else {
        console.error('failed to start:', e);
        finish(bareResult('boot_failed', `failed to start: ${errMsg(e)}`, EXIT_CODES.boot_failed));
      }
      return;
    }
    if (written) return;
    console.log(`code-conductor listening on http://${boot.host}:${boot.port}`);
    for (const line of headlessUiLines(boot.host, boot.port)) console.log(line);
    if (!boot.instances) { finish(bareResult('boot_failed', 'the server booted without an instance manager', EXIT_CODES.boot_failed)); return; }
    const focus = boot.focus;
    if (!focus) { finish(bareResult('boot_failed', 'the server booted without a focus cell', EXIT_CODES.boot_failed)); return; }
    for (const s of ['SIGINT', 'SIGTERM'] as const) process.off(s, onEarlySignal);
    running = true;
    if (format === 'stream-json') {
      stream = createHeadlessStream({
        instances: boot.instances,
        includeWorkers: args.includeWorkers,
        // writableLength is the real stream's getter; only `write` is redirected.
        sink: { write: (chunk) => writeOut(chunk), buffered: () => process.stdout.writableLength },
        // `run` is exposed before the spawn; a stream failure follows a write, which follows setRoot.
        onFail: (message) => run?.fail(message),
      });
    }
    finish(await runHeadless({
      instances: boot.instances, prompt: prompt.text, mode: args.mode,
      expose: (h) => { run = h; },
      onRoot: (root) => {
        stream?.setRoot(root);
        if (!root.sessionId) return;
        focus.sessionId = root.sessionId;
        void recordHeadlessRun(root.sessionId).catch((e) => console.error('headless: recording the run\'s session failed:', errMsg(e)));
      },
    }));
  }
}
