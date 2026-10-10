import { createStore } from './createStore';
import type { Instance, Project, SessionRow } from './types';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting';

export type AppState = {
  connection: ConnectionState;
  /** True once the socket has dropped at least once after the first open. */
  everDropped: boolean;
  projects: Project[];
  workspaces: string[];
  /** `.conduct` sessions on disk (the Conductors lens). */
  conductSessions: SessionRow[];
  /** GET /api/conductors/projects. */
  conductorSpawns: Record<string, { project: string; lastSpawnAt: number; worktrees?: string[] }[]>;
  instances: Instance[];
  activeId: string | null;
  /** One-line status in the sidebar footer (resume / restart progress). */
  sidebarStatus: { text: string; warn: boolean } | null;
};

export const appStore = createStore<AppState>({
  connection: 'connecting',
  everDropped: false,
  projects: [],
  workspaces: [],
  conductSessions: [],
  conductorSpawns: {},
  instances: [],
  activeId: null,
  sidebarStatus: null,
});

export const activeInstance = (s: AppState): Instance | null =>
  (s.activeId && s.instances.find((i) => i.id === s.activeId)) || null;
