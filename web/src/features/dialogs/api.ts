// Every modal dialog is opened through here. A dialog's component (rendered
// by <DialogsHost/>) reads its slot from `dialogStore`; callers only ever call
// the open* functions, so the sidebar, header and conversation never import a
// dialog component.
import { createStore } from '@/state/createStore';
import type { Project } from '@/state/types';

export type SpawnDialogOptions = {
  /** Pre-select a worktree of the project (the sidebar's per-worktree "+"). */
  worktree?: string | null;
};

export type DialogState = {
  spawn: { project: string; opts: SpawnDialogOptions } | null;
  newProject: boolean;
  adoptProject: boolean;
  deleteProject: { project: Project; instanceCount: number } | null;
  projectRemote: { project: Project } | null;
  editConventions: { project: Project } | null;
  /** null name = create a new workspace. */
  workspace: { name: string | null } | null;
  summary: { sessionId: string } | null;
  stats: { sessionId: string } | null;
  prune: { instanceId: string } | null;
  rename: { sessionId: string; current: string } | null;
};

export const dialogStore = createStore<DialogState>({
  spawn: null,
  newProject: false,
  adoptProject: false,
  deleteProject: null,
  projectRemote: null,
  editConventions: null,
  workspace: null,
  summary: null,
  stats: null,
  prune: null,
  rename: null,
});

export const closeDialog = (name: keyof DialogState) => dialogStore.set({ [name]: name === 'newProject' || name === 'adoptProject' ? false : null } as Partial<DialogState>);

export const openSpawnDialog = (project: string, opts: SpawnDialogOptions = {}) => dialogStore.set({ spawn: { project, opts } });
export const openNewProjectDialog = () => dialogStore.set({ newProject: true });
export const openAdoptProjectDialog = () => dialogStore.set({ adoptProject: true });
export const openDeleteProjectDialog = (project: Project, instanceCount: number) => dialogStore.set({ deleteProject: { project, instanceCount } });
export const openProjectRemoteDialog = (project: Project) => dialogStore.set({ projectRemote: { project } });
export const openEditConventionsDialog = (project: Project) => dialogStore.set({ editConventions: { project } });
export const openWorkspaceDialog = (name: string | null) => dialogStore.set({ workspace: { name } });
export const openSummaryDialog = (sessionId: string) => dialogStore.set({ summary: { sessionId } });
export const openStatsDialog = (sessionId: string) => dialogStore.set({ stats: { sessionId } });
export const openPruneDialog = (instanceId: string) => dialogStore.set({ prune: { instanceId } });
export const openRenameDialog = (sessionId: string, current: string) => dialogStore.set({ rename: { sessionId, current } });
