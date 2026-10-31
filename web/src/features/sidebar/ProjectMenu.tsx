import { ListChecksIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { Project } from '@/state/types';
import { openDeleteProjectDialog, openEditConventionsDialog, openSpawnDialog } from '@/features/dialogs/api';
import { conventionsNotice } from './conventionsNotice';
import { ATTENTION_DOT, RowMenu } from './RowMenu';

/** A project row's ⋮: New session, Edit conventions…, Delete…, with a dot when its convention selection needs attention. */
export function ProjectMenu({ project: p, instanceCount }: { project: Project; instanceCount: number }) {
  const unreachable = (p.systemUnreachable as string | null) || null;
  const notice = conventionsNotice(p);
  const readError = p.conventions && 'error' in p.conventions ? p.conventions.error : null;
  const editRefusal = unreachable ?? readError;
  return (
    <RowMenu label="Project menu" notice={notice}>
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
    </RowMenu>
  );
}
