import * as React from 'react';
import { ListChecksIcon, LoaderCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useStore } from '@/state/createStore';
import type { Project } from '@/state/types';
import { apiFetch } from '@shared/http';
import { refreshProjects } from '@/app/controller';
import { closeDialog, dialogStore } from './api';
import { ConventionChecklist, groupConventions, type Convention } from './ConventionChecklist';
import { FormError } from './FormError';
import { useOpenKey } from './useOpenKey';

const UNAVAILABLE_NOTE = 'Not available on this install. Kept selected; its text returns when it is available again.';

function EditConventionsBody({ project }: { project: Project }) {
  const initial = React.useMemo(
    () => (project.conventions && 'selected' in project.conventions ? project.conventions.selected : []),
    [project],
  );
  const [catalog, setCatalog] = React.useState<Convention[] | null>(null);
  const [picked, setPicked] = React.useState<Set<string>>(() => new Set(initial));
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
  const changed = picked.size !== initial.length || initial.some((s) => !picked.has(s));

  async function save() {
    setBusy(true);
    setError('');
    const slugs = [...initial.filter((s) => picked.has(s)), ...added.map((c) => c.slug)];
    try {
      await apiFetch(`/api/projects/${encodeURIComponent(project.name)}/conventions`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slugs, expected: initial }),
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
    <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><ListChecksIcon className="size-5 text-primary" /> Conventions of {project.name}</DialogTitle>
        <DialogDescription>
          Saving rewrites <code className="font-mono">CONVENTIONS.md</code> in this project's tree and leaves it as an uncommitted change.
        </DialogDescription>
      </DialogHeader>
      {!catalog && !error && <p className="text-sm text-muted-foreground">Loading conventions…</p>}
      <ConventionChecklist
        groups={groups}
        picked={picked}
        onToggle={(slug, on) => setPicked((s) => { const n = new Set(s); if (on) n.add(slug); else n.delete(slug); return n; })}
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
      {slot && <DialogContent className="sm:max-w-lg" data-dialog="edit-conventions"><EditConventionsBody key={key} project={slot.project} /></DialogContent>}
    </Dialog>
  );
}
