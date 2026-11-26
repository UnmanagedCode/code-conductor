import * as React from 'react';
import { TextSelectIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ContextChip as ChipRow } from '@shared/wireRows';
import { clearContextChip } from './contextChipStore';

/** How much of the chip's data its preview shows. */
export const CHIP_PREVIEW_CHARS = 2000;

export const clipPreview = (data: string): string => (data.length > CHIP_PREVIEW_CHARS ? `${data.slice(0, CHIP_PREVIEW_CHARS)}…` : data);

/** The composer's pending context: its title (the data on hover, focus or tap) and a × that removes it. */
export function ContextChip({ chip, sessionId }: { chip: ChipRow; sessionId: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div data-context-chip className="flex max-w-full min-w-0 items-center gap-1 rounded-lg border bg-muted/40 py-0.5 pr-0.5 pl-1.5 text-xs">
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 items-center gap-1.5 text-left"
            // A tap opens the data where hover and focus do not exist; preventDefault keeps Radix's own click-close.
            onClick={(e) => { e.preventDefault(); setOpen((o) => !o); }}
          >
            <TextSelectIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{chip.title}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-h-60 max-w-[min(32rem,90vw)] overflow-auto text-left whitespace-pre-wrap break-words font-mono">
          {clipPreview(chip.data)}
        </TooltipContent>
      </Tooltip>
      <Button variant="ghost" size="icon-sm" className="size-6 shrink-0" aria-label={`Remove context ${chip.title}`} data-context-chip-remove onClick={() => void clearContextChip(sessionId, chip.rev)}>
        <XIcon className="size-3" />
      </Button>
    </div>
  );
}
