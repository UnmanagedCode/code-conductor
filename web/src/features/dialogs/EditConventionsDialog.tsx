import * as React from 'react';
import { ListChecksIcon, LoaderCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useStore } from '@/state/createStore';
import type { Project, ProjectConventionSelection } from '@/state/types';
import { apiFetch } from '@shared/http';
import { refreshProjects } from '@/app/controller';
import { closeDialog, dialogStore } from './api';
import { ConventionChecklist, NoConventionsChoice, groupConventions, useConventionPicks, type Convention } from './ConventionChecklist';
import { FormError } from './FormError';
import { useOpenKey } from './useOpenKey';

const UNAVAILABLE_NOTE = 'Not available on this install. Kept selected; its text returns when it is available again.';

function EditConventionsBody({ project }: { project: Project }) {
  // `recorded` is the marker's selection verbatim, sent back as `expected`; `initial`
  // counts a slug the marker repeats once, keeping the first occurrence and the order.
  const recorded = React.useMemo((): ProjectConventionSelection => {
    const c = project.conventions;
    if (!c || 'error' in c) return { mode: 'unset' };
    return c.mode === 'selected' ? { mode: 'selected', slugs: c.slugs } : { mode: c.mode };
  }, [project]);
  const initial = React.useMemo(() => [...new Set(recorded.mode === 'selected' ? recorded.slugs : [])], [recorded]);
  const [catalog, setCatalog] = React.useState<Convention[] | null>(null);
  const { picked, none, chooseNone, togglePick } = useConventionPicks(initial, recorded.mode === 'none');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    apiFetch<{ conventions?: Convention[] } | null>('/api/settings/conventions/project')
      .then((d) => setCatalog(d?.conventions ?? []))
      .catch((e) => setError(`Could not load the conventions: ${e.message}`));
  }, []);

  const groups = catalog ? groupConventions(catalog) : [];
  const known = new Set((catalog ?? []).map((c) => c.slug));
  const unavailable = catalog ? initial.filter((s) => !known.has(s)) : [];
  if (unavailable.length) {
    groups.push({ label: 'Unavailable', items: unavailable.map((slug) => ({ slug, name: slug, description: UNAVAILABLE_NOTE })) });
  }
  const shown = groups.flatMap((g) => g.items);
  const added = shown.filter((c) => picked.has(c.slug) && !initial.includes(c.slug));
  const changed = none !== (recorded.mode === 'none') || picked.size !== initial.length || initial.some((s) => !picked.has(s));

  async function save() {
    setBusy(true);
    setError('');
    // Nothing ticked without the none choice is unset, not a choice of none.
    const selection: ProjectConventionSelection = none ? { mode: 'none' }
      : picked.size ? { mode: 'selected', slugs: [...initial.filter((s) => picked.has(s)), ...added.map((c) => c.slug)] }
      : { mode: 'unset' };
    try {
      await apiFetch(`/api/projects/${encodeURIComponent(project.name)}/conventions`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selection, expected: recorded }),
      });
    } catch (e: any) {
      setBusy(false);
      setError(e.message);
      return;
    }
    setBusy(false);
    try { await refreshProjects(); } catch (e: any) { setError(e.message); return; }
    closeDialog('editConventions');
  }

  return (
    <form className="flex min-h-0 flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><ListChecksIcon className="size-5 text-primary" /> Conventions of {project.name}</DialogTitle>
        <DialogDescription>
          Saving rewrites <code className="font-mono">CONVENTIONS.md</code> in this project's tree and leaves it as an uncommitted change.
        </DialogDescription>
      </DialogHeader>
      <NoConventionsChoice checked={none} onChange={chooseNone} idPrefix="ec" />
      {!catalog && !error && <p className="text-sm text-muted-foreground">Loading conventions…</p>}
      <ConventionChecklist
        groups={groups}
        picked={picked}
        onToggle={togglePick}
        idPrefix="ec"
      />
      {added.filter((c) => !!c.scaffold).map((c) => (
        <p key={c.slug} className="text-xs text-muted-foreground" data-scaffold-note>
          {c.name} has a one-time setup step that only runs when a project is created; adding it here does not run it.
        </p>
      ))}
      <FormError>{error}</FormError>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => closeDialog('editConventions')}>Cancel</Button>
        <Button type="submit" disabled={busy || !catalog || !changed}>
          {busy && <LoaderCircleIcon className="animate-spin" />}Save
        </Button>
      </DialogFooter>
    </form>
  );
}

export function EditConventionsDialog() {
  const slot = useStore(dialogStore, (s) => s.editConventions);
  const key = useOpenKey(slot);
  return (
    <Dialog open={!!slot} onOpenChange={(o) => { if (!o) closeDialog('editConventions'); }}>
      {slot && <DialogContent className="flex flex-col sm:max-w-lg" data-dialog="edit-conventions"><EditConventionsBody key={key} project={slot.project} /></DialogContent>}
    </Dialog>
  );
}
