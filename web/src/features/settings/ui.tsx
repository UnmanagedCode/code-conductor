import * as React from 'react';
import { CircleAlertIcon, CircleCheckIcon } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** A section's heading + intro paragraph. */
export function SectionIntro({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {children && <div className="max-w-[70ch] text-sm leading-relaxed text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.85em] [&_strong]:font-medium [&_strong]:text-foreground">{children}</div>}
    </div>
  );
}

export function SettingsCard({ title, description, action, children, className }: {
  title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; children?: React.ReactNode; className?: string;
}) {
  return (
    <Card className={cn('gap-4', className)}>
      <CardHeader className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription className="max-w-[70ch] leading-relaxed [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.85em] [&_strong]:font-medium [&_strong]:text-foreground">{description}</CardDescription>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </CardHeader>
      {children !== undefined && <CardContent className="space-y-4">{children}</CardContent>}
    </Card>
  );
}

/** A one-line status: neutral, ok or error. `null`/'' renders nothing. */
export function Status({ text, tone = 'muted', className }: { text?: React.ReactNode; tone?: 'muted' | 'ok' | 'error'; className?: string }) {
  if (!text) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('flex items-start gap-1.5 text-sm', tone === 'muted' && 'text-muted-foreground', tone === 'ok' && 'text-success', tone === 'error' && 'text-destructive', className)}
    >
      {tone === 'ok' && <CircleCheckIcon className="mt-0.5 size-4 shrink-0" />}
      {tone === 'error' && <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />}
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
}

/** A captioned control (label above). */
export function Field({ label, htmlFor, hint, children, className }: { label: React.ReactNode; htmlFor?: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('grid min-w-0 content-start gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** A scroll-pinned monospace log (install / update output). */
export function LogBox({ text, className }: { text: string; className?: string }) {
  const ref = React.useRef<HTMLPreElement>(null);
  React.useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  if (!text) return null;
  return (
    <pre ref={ref} aria-live="polite" className={cn('max-h-64 overflow-auto rounded-lg bg-muted/60 px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap', className)}>
      {text}
    </pre>
  );
}

/** A labelled range slider with its value readout. */
export function RangeField({ id, label, min, max, step, value, format, onInput, onCommit, disabled }: {
  id: string; label: string; min: number; max: number; step: number; value: number; format: (v: number) => string;
  onInput: (v: number) => void; onCommit?: (v: number) => void; disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label htmlFor={id} className="text-sm text-muted-foreground">{label}</label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onInput(Number(e.target.value))}
        onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
        className="h-2 min-w-32 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed"
      />
      <span className="w-14 text-right text-sm font-medium tabular-nums">{format(value)}</span>
    </div>
  );
}
