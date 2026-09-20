// Delete-project confirmation. DELETING A PROJECT DEREGISTERS IT: the record
// goes, the tree stays — unless the user ticks the opt-in below, which is
// off by default and absent entirely for a project on another machine (cc
// removes its record of a tree it does not own, never the tree).
//
// It is a dialog rather than `window.prompt` because a prompt cannot hold a
// checkbox, and the tick is the one moment the user authorises a removal.
//
// THE DIALOG NAMES THE LITERAL PATH IT WOULD REMOVE, and warns that it may be
// the user's own tree. One delete behaviour for every project is the design;
// it is safe only because the confirm states exactly what the tick is about to
// touch. The warning is unconditional rather than conditioned on "was this
// adopted?": a project row carries no kind flag — its path is the only thing
// that differs — so cc would be guessing, and a guess is worse here than a
// sentence that is always true.
//
// Follows the installX({...}) pattern. Injected interface:
//   - dom:               the dialog's elements.
//   - deleteProject({name, deleteDirectory}): performs the DELETE and the
//                        post-delete refresh (stays in sessionActions — it owns
//                        the active-instance bookkeeping).
export function installDeleteProjectDialog({ dom, deleteProject }) {
  let current = null;

  function open(project, { instanceCount = 0 } = {}) {
    current = project;
    const remoteSystem = project.system && project.system !== 'local' ? project.system : null;
    // One system can serve many targets, so "on prod-box" would not say which
    // machine is being left alone — the whole point of the sentence.
    const where = remoteSystem
      ? `${project.path} on ${project.remoteId ? `remote '${project.remoteId}' of ` : ''}system '${remoteSystem}'`
      : project.path;
    const wts = project.worktrees ?? [];

    dom.title.textContent = `Delete project '${project.name}'?`;
    dom.summary.textContent = `Path: ${where}`;
    dom.effects.innerHTML = '';
    const effects = [
      `kill ${instanceCount} running instance${instanceCount === 1 ? '' : 's'}`,
      remoteSystem
        ? `unregister ${wts.length} worktree${wts.length === 1 ? '' : 's'} (their directories and branches are left in place)`
        : `remove ${wts.length} worktree${wts.length === 1 ? '' : 's'} (dir + branch) — refused if any is dirty or has dependents`,
      `deregister the project`,
      `(Your ~/.claude/projects/ session history is left in place.)`,
    ];
    for (const text of effects) {
      const li = document.createElement('li');
      li.textContent = text;
      dom.effects.appendChild(li);
    }

    // No tick for a remote project: there is no directory of cc's to delete.
    dom.dirRow.hidden = !!remoteSystem;
    dom.deleteDir.checked = false;
    dom.dirLabel.textContent =
      `Also delete the directory ${project.path} — if you added this project from an existing directory, that is your own tree.`;

    dom.confirm.value = '';
    dom.error.textContent = '';
    dom.dialog.showModal();
    setTimeout(() => dom.confirm.focus(), 0);
  }

  dom.dialog.addEventListener('close', async () => {
    if (dom.dialog.returnValue !== 'delete' || !current) return;
    const project = current;
    if (dom.confirm.value !== project.name) {
      dom.error.textContent = 'Name mismatch — nothing deleted.';
      dom.dialog.showModal();
      return;
    }
    const deleteDirectory = !dom.dirRow.hidden && dom.deleteDir.checked;
    try {
      await deleteProject({ name: project.name, deleteDirectory });
      current = null;
    } catch (e) {
      dom.error.textContent = e.message;
      dom.dialog.showModal();
    }
  });

  return { open };
}
