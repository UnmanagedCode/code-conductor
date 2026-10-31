import { PlusIcon, Trash2Icon } from 'lucide-react';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import type { Project } from '@/state/types';
import { removeWorktree } from '@/app/sessionActions';
import { openSpawnDialog } from '@/features/dialogs/api';
import { PluginMenuItems } from '@/features/views/PluginMenuItems';
import { RowMenu } from './RowMenu';

/** A worktree row's ⋮: New session in this worktree, a group per plugin with worktree-scope `menuItems`, then Remove worktree…. */
export function WorktreeMenu({ project: p, worktree }: { project: Project; worktree: string }) {
  const unreachable = (p.systemUnreachable as string | null) || null;
  return (
    <RowMenu label="Worktree menu">
      <DropdownMenuItem disabled={!!unreachable} title={unreachable ?? undefined} onSelect={() => openSpawnDialog(p.name, { worktree })}>
        <PlusIcon />New session in this worktree
      </DropdownMenuItem>
      <PluginMenuItems scope="worktree" project={p.name} worktree={worktree} />
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onSelect={() => void removeWorktree(p.name, worktree)}>
        <Trash2Icon />Remove worktree…
      </DropdownMenuItem>
    </RowMenu>
  );
}
