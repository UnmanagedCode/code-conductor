import type { Project } from '@/state/types';

/** Why a project's convention selection needs the user's attention, or null when it doesn't (or can't be read). */
export function conventionsNotice(p: Project): string | null {
  const c = p.conventions;
  if (!c || 'error' in c) return null;
  if (c.mode === 'unset') return 'No project conventions chosen yet.';
  if (c.unresolved.length > 0) return `Selected conventions no longer available: ${c.unresolved.join(', ')}.`;
  return null;
}
