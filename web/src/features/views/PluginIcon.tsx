import { GitBranchIcon, MessageSquareCodeIcon, PackageIcon, PlugIcon, SquareKanbanIcon, SquareTerminalIcon, type LucideIcon } from 'lucide-react';
import type { PluginIconName } from '@shared/pluginIcons';

const ICONS: Record<PluginIconName, LucideIcon> = {
  'git-branch': GitBranchIcon,
  'message-square-code': MessageSquareCodeIcon,
  package: PackageIcon,
  'square-kanban': SquareKanbanIcon,
  'square-terminal': SquareTerminalIcon,
};

/** A plugin's `icon` (the row field), else the generic plug. */
export function PluginIcon({ icon }: { icon?: string | null }) {
  const Icon = icon && Object.hasOwn(ICONS, icon) ? ICONS[icon as PluginIconName] : PlugIcon;
  return <Icon />;
}
