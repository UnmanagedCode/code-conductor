// A render crash stays in the region that crashed. React reports every caught error itself (one console.error
// naming this class), so the boundary logs nothing of its own.
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Props = {
  /** A new value (by Object.is) clears a shown fallback and renders the children again. */
  resetKey?: unknown;
  fallback: (error: Error, reset: () => void) => React.ReactNode;
  children: React.ReactNode;
};
type State = { error: Error | null; resetKey: unknown };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };
  static getDerivedStateFromProps(props: Props, state: State) {
    return Object.is(props.resetKey, state.resetKey) ? null : { error: null, resetKey: props.resetKey };
  }
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  reset = () => this.setState({ error: null });
  render() {
    return this.state.error ? this.props.fallback(this.state.error, this.reset) : this.props.children;
  }
}

/** The panel a crashed region shows: the error's message and one action. `region` is exposed as data-error-region. */
export function RegionFallback({ region, error, onRetry, retryLabel = 'Try again', className }: {
  region: string; error: Error; onRetry: () => void; retryLabel?: string; className?: string;
}) {
  return (
    <div role="alert" data-error-region={region} className={cn('flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground', className)}>
      <p>This part of the page hit an error.</p>
      <code className="max-w-full break-words text-xs">{error.message}</code>
      <Button variant="outline" size="sm" onClick={onRetry}>{retryLabel}</Button>
    </div>
  );
}
