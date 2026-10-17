import rawConsole from 'node:console';
import { setImmediate as realSetImmediate } from 'node:timers';
import { format } from 'node:util';
import { afterAll, afterEach, beforeEach, vi } from 'vitest';

type ErrorSink = { error: (...args: any[]) => void };

// happy-dom logs this to its page console under `disableIframePageLoading`,
// unconditionally. That console is Node's raw one, captured before Vitest swaps
// `globalThis.console`, so no spy or reporter setting reaches it. The setting
// stays on because the quiet alternative, `navigation.disableChildFrameNavigation`,
// fires the frame's `load` itself, and those tests dispatch `load` by hand.
const IFRAME_DISABLED = /^Failed to load iframe page "[^"]*"\. Iframe page loading is disabled\.$/;

export function isHappyDomIframeDisabledNotice(args: unknown[]): boolean {
  if (args.length !== 1) return false;
  const err = args[0] as { name?: unknown; message?: unknown } | null;
  return typeof err === 'object' && err !== null
    && err.name === 'NotSupportedError'
    && typeof err.message === 'string' && IFRAME_DISABLED.test(err.message);
}

// Plain assignment, not vi.spyOn: vi.restoreAllMocks() must not remove it.
export function dropFromError(target: ErrorSink, drop: (args: unknown[]) => boolean) {
  const original = target.error.bind(target);
  target.error = (...args: unknown[]) => {
    if (!drop(args)) original(...args);
  };
}

export function installConsoleFilter() {
  dropFromError(rawConsole as unknown as ErrorSink, isHappyDomIframeDisabledNotice);
}

const LEVELS = ['error', 'warn'] as const;

// Fails the test whose window a console.error / console.warn lands in, and the
// file for one outside every window. The window closes one real turn after the
// test, so a log the test queued for the next turn still counts against it; a
// later one (a timer or promise outliving its test) lands on whatever window is
// open when it fires, and its failure carries the log call's stack. A log after
// the file's last hook is printed, not raised.
// An opt-out is `vi.spyOn(console, level).mockImplementation(...)` plus an
// assertion on it; a spy left installed is restored after its test, or before
// the next one when an earlier afterEach threw and cut the guard's short. That
// test's logs then fail the file.
export function installConsoleGuard() {
  let inTest = false;
  const inTestLogs: string[] = [];
  const outsideLogs: string[] = [];
  const own = {} as Record<(typeof LEVELS)[number], (...args: unknown[]) => void>;
  for (const level of LEVELS) {
    const forward = console[level].bind(console);
    // Plain assignment, not vi.spyOn: vi.restoreAllMocks() must not remove it.
    own[level] = (...args: unknown[]) => {
      const site = (new Error().stack ?? '').split('\n').slice(2).join('\n');
      (inTest ? inTestLogs : outsideLogs).push(`console.${level}: ${format(...args)}\n${site}`);
      forward(...args);
    };
    console[level] = own[level];
  }
  const restoreSpies = () => {
    for (const level of LEVELS) {
      while ((console[level] as unknown) !== own[level]) {
        const current: unknown = console[level];
        if (!vi.isMockFunction(current)) throw new Error(`console.${level} was replaced and not restored`);
        current.mockRestore();
        if ((console[level] as unknown) === current) throw new Error(`console.${level}: mockRestore did not restore it`);
      }
    }
  };
  // Logs of a test whose guard afterEach never ran (an earlier afterEach threw).
  const skippedLogs: string[] = [];
  beforeEach(() => {
    // The guard's afterEach runs last, so a throwing one upstream skips it:
    // restore any leftover spy here, and keep that test's logs for afterAll.
    skippedLogs.push(...inTestLogs.splice(0));
    restoreSpies();
    inTest = true;
  });
  afterEach(async () => {
    // node:timers' own setImmediate: a test that left fake timers installed cannot stall it.
    await new Promise((r) => realSetImmediate(r));
    inTest = false;
    restoreSpies();
    if (inTestLogs.length) throw new Error(`unexpected console output in this test:\n${inTestLogs.splice(0).join('\n')}`);
  });
  afterAll(async () => {
    // One real turn, as afterEach yields: a log the last test queued for the next turn lands first.
    await new Promise((r) => realSetImmediate(r));
    // The last test has no next beforeEach to collect its stranded logs.
    const skipped = [...skippedLogs.splice(0), ...inTestLogs.splice(0)];
    const outside = outsideLogs.splice(0);
    const sections = [
      skipped.length && `unexpected console output in a test whose afterEach hooks were cut short:\n${skipped.join('\n')}`,
      outside.length && `unexpected console output outside any test:\n${outside.join('\n')}`,
    ].filter(Boolean);
    if (sections.length) throw new Error(sections.join('\n\n'));
  });
}
