import type { StaleList } from '@/state/app';

export const STALE_LIST_LABELS: Record<StaleList, string> = {
  workspaces: 'workspaces',
  conductSessions: 'conductor sessions',
  conductorSpawns: 'conductor projects',
};

export const staleListsWarning = (lists: StaleList[]): string =>
  `Couldn't refresh ${lists.map((l) => STALE_LIST_LABELS[l]).join(', ')} — showing the last loaded`;
