// Renders every modal dialog; each one shows itself from its dialogStore slot.
// (The restart dialog belongs to the sidebar's restart flow.)
import { SpawnDialog } from './SpawnDialog';
import { EditConventionsDialog } from './EditConventionsDialog';
import { AdoptProjectDialog, DeleteProjectDialog, NewProjectDialog, ProjectRemoteDialog, WorkspaceDialog } from './ProjectDialogs';
import { PruneDialog, RenameDialog, StatsDialog, SummaryDialog } from './SessionDialogs';

export function DialogsHost() {
  return (
    <>
      <SpawnDialog />
      <NewProjectDialog />
      <AdoptProjectDialog />
      <DeleteProjectDialog />
      <ProjectRemoteDialog />
      <EditConventionsDialog />
      <WorkspaceDialog />
      <SummaryDialog />
      <StatsDialog />
      <PruneDialog />
      <RenameDialog />
    </>
  );
}
