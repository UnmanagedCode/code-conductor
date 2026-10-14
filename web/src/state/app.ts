import { createStore } from './createStore';
import type { Instance, Project, SessionRow } from './types';
import type { SpawnedProject } from '@shared/conductors';

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
  conductorSpawns: Record<string, SpawnedProject[]>;
  instances: Instance[];
  /** The pristine conductor this tab started and no list carries yet (app/pristine.ts); never rendered by a list. */
  pristine: Instance | null;
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
  pristine: null,
  activeId: null,
  sidebarStatus: null,
});

/** A listed instance, else the pristine slot's. */
export const findInstance = (s: AppState, id: string): Instance | null =>
  s.instances.find((i) => i.id === id) ?? (s.pristine?.id === id ? s.pristine : null);

export const activeInstance = (s: AppState): Instance | null =>
  (s.activeId && findInstance(s, s.activeId)) || null;
