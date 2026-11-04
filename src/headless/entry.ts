// The headless process: what `node server.ts` does when its argv carries a
// headless flag (src/headless/args.ts). Logs go to stderr — stdout carries
// exactly one result object (src/headless/result.ts) — then cc boots as usual
// minus the web build and the dependency sync, runs one New-conductor session
// to quiescence (src/headless/runner.ts), writes the result and exits with its
// code. Nothing is torn down: state is left as a normal cc death leaves it.

import os from 'node:os';
import { readHeadlessPrompt, HEADLESS_SYNOPSIS, type HeadlessArgs } from './args.ts';
import { runHeadless } from './runner.ts';
import { EXIT_CODES, formatResult, signalExitCode, unspawnedResult, type HeadlessResult } from './result.ts';
import { RootLockHeldError, RootLockUnreadableError } from '../rootLock.ts';
import type { InstanceManagerLike } from '../instanceTypes.ts';

export interface HeadlessBoot {
  instances: InstanceManagerLike | null;
  host: string;
  port: number;
}

export interface HeadlessEntryDeps {
  // server.ts's start(), already given the entry's options plus `headless`.
  start: () => Promise<HeadlessBoot>;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// The stderr lines naming where the run's web UI answers: the bound address, or
// for a wildcard bind every non-internal IPv4 (in a container, its own IP).
export function headlessUiLines(host: string, port: number, nets: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const hosts = host === '0.0.0.0' || host === '::'
    ? Object.values(nets).flatMap((list) => list ?? []).filter((n) => n.family === 'IPv4' && !n.internal).map((n) => n.address)
    : [host];
  return hosts.map((h) => `headless: UI at http://${h.includes(':') ? `[${h}]` : h}:${port}`);
}

export async function headlessMain(args: Exclude<HeadlessArgs, { kind: 'none' }>, { start }: HeadlessEntryDeps): Promise<void> {
  // Before anything can log: every console line goes to stderr, and the one
  // result object goes out through the real stdout.
  const writeOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  let written = false;
  const finish = (r: HeadlessResult): void => {
    if (written) return;
    written = true;
    writeOut(formatResult(r), () => process.exit(r.exitCode));
  };
  const usage = (message: string): void => {
    process.stderr.write(`${message}\n${HEADLESS_SYNOPSIS}\n`);
    finish(unspawnedResult('usage_error', message, EXIT_CODES.usage_error));
  };

  if (args.kind === 'usage') { usage(args.message); return; }
  const prompt = await readHeadlessPrompt(args.source);
  if (prompt.kind === 'usage') { usage(prompt.message); return; }

  // A signal during boot ends the run with no root to interrupt.
  const onBootSignal = (signal: NodeJS.Signals): void => {
    finish(unspawnedResult('signal', `interrupted by ${signal}`, signalExitCode(signal)));
  };
  process.on('SIGINT', onBootSignal);
  process.on('SIGTERM', onBootSignal);

  let boot: HeadlessBoot;
  try {
    boot = await start();
  } catch (e) {
    if (e instanceof RootLockHeldError || e instanceof RootLockUnreadableError) {
      console.error(e.message);
      finish(unspawnedResult('root_held', e.message, EXIT_CODES.root_held));
    } else {
      console.error('failed to start:', e);
      finish(unspawnedResult('boot_failed', `failed to start: ${errText(e)}`, EXIT_CODES.boot_failed));
    }
    return;
  }
  if (written) return;
  console.log(`code-conductor listening on http://${boot.host}:${boot.port}`);
  for (const line of headlessUiLines(boot.host, boot.port)) console.log(line);
  process.off('SIGINT', onBootSignal);
  process.off('SIGTERM', onBootSignal);
  if (!boot.instances) { finish(unspawnedResult('boot_failed', 'the server booted without an instance manager', EXIT_CODES.boot_failed)); return; }
  finish(await runHeadless({ instances: boot.instances, prompt: prompt.text, mode: args.mode }));
}
