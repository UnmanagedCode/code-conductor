import * as React from 'react';
import { CheckIcon, CopyIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Clipboard write with the textarea fallback Android WebViews / insecure contexts need. */
export function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok ? Promise.resolve() : Promise.reject(new Error('execCommand failed'));
  } catch (e) {
    return Promise.reject(e);
  }
}

export function CopyButton({ getText, label = 'Copy', className }: { getText: () => string; label?: string; className?: string }) {
  const [state, setState] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    copyToClipboard(getText())
      .then(() => setState('copied'))
      .catch(() => setState('failed'))
      .finally(() => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setState('idle'), 1200);
      });
  };
  const Icon = state === 'copied' ? CheckIcon : state === 'failed' ? XIcon : CopyIcon;
  const outcome = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : '';
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            onClick={onClick}
            className={cn('size-7 text-muted-foreground', state === 'copied' && 'text-success', state === 'failed' && 'text-destructive', className)}
          >
            <Icon className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{outcome || label}</TooltipContent>
      </Tooltip>
      {/* Announces how the copy went while the button keeps naming its action. A live
          region, not a status role: a panel reading its own status line must find only that. */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">{outcome}</span>
    </>
  );
}
