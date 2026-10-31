import * as React from 'react';
import { MoreVerticalIcon } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { Hint, REVEAL, ROW_ACTION } from './rows';

export const ATTENTION_DOT = 'size-2 rounded-full bg-warning ring-2 ring-sidebar';

/**
 * The ⋮ every sidebar row menu shares; a menu's items are its children, so a section is appended as more children.
 * A `notice` keeps the trigger shown, dots it, and becomes its tooltip and description.
 */
export function RowMenu({ label, notice = null, children }: { label: string; notice?: string | null; children: React.ReactNode }) {
  const noticeId = React.useId();
  return (
    <DropdownMenu modal={false}>
      <span className="relative flex shrink-0">
        <Hint label={notice ?? label}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={label}
              aria-describedby={notice ? noticeId : undefined}
              className={cn(ROW_ACTION, !notice && REVEAL)}
              onClick={(e) => e.stopPropagation()}
            >
              <MoreVerticalIcon className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
        </Hint>
        {notice && (
          <>
            <span aria-hidden className={cn('pointer-events-none absolute top-0.5 right-0.5', ATTENTION_DOT)} data-conventions-attention />
            <span id={noticeId} className="sr-only">{notice}</span>
          </>
        )}
      </span>
      <DropdownMenuContent align="end" className="w-52">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}
