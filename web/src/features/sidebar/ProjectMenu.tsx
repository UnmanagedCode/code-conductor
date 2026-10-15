import * as React from 'react';
import { ListChecksIcon, MoreVerticalIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { Project } from '@/state/types';
import { openDeleteProjectDialog, openEditConventionsDialog, openSpawnDialog } from '@/features/dialogs/api';
import { conventionsNotice } from './conventionsNotice';
import { Hint, REVEAL, ROW_ACTION } from './rows';

const ATTENTION_DOT = 'size-2 rounded-full bg-warning ring-2 ring-sidebar';

/** A project row's ⋮: New session, Edit conventions…, Delete…, with a dot when its convention selection needs attention. */
export function ProjectMenu({ project: p, instanceCount }: { project: Project; instanceCount: number }) {
  const unreachable = (p.systemUnreachable as string | null) || null;
  const notice = conventionsNotice(p);
  const readError = p.conventions && 'error' in p.conventions ? p.conventions.error : null;
  const editRefusal = unreachable ?? readError;
  const noticeId = React.useId();
  return (
    <DropdownMenu modal={false}>
      <span className="relative flex shrink-0">
        <Hint label={notice ?? 'Project menu'}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Project menu"
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
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem disabled={!!unreachable} title={unreachable ?? undefined} onSelect={() => openSpawnDialog(p.name)}>
          <PlusIcon />New session
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!!editRefusal}
          title={editRefusal ?? undefined}
          data-attention={notice ? '' : undefined}
          onSelect={() => openEditConventionsDialog(p)}
        >
          <ListChecksIcon />Edit conventions…
          {notice && <span aria-hidden className={cn('ml-auto', ATTENTION_DOT)} />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => openDeleteProjectDialog(p, instanceCount)}>
          <Trash2Icon />Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
