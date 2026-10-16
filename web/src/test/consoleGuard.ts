import rawConsole from 'node:console';

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
