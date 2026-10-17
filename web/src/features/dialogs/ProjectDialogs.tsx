import * as React from 'react';
import { FolderGit2Icon, FolderPlusIcon, LoaderCircleIcon, Trash2Icon, CheckIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useStore } from '@/state/createStore';
import { appStore } from '@/state/app';
import type { Project } from '@/state/types';
import { ApiError, apiFetch } from '@shared/http';
import { refreshProjects } from '@/app/controller';
import { performProjectDelete } from '@/app/sessionActions';
import { confirmDialog } from '@/ui/feedback';
import { cn } from '@/lib/utils';
import { closeDialog, dialogStore } from './api';
import { FormError } from './FormError';
import { PathInput } from './PathInput';
import { PlacementFields, usePlacement } from './placement';
import { messageFor } from './adoptMessages';
import { useOpenKey } from './useOpenKey';
import { ConventionChecklist, NoConventionsChoice, groupConventions, type Convention } from './ConventionChecklist';

const NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

function Field({ id, label, children, hint }: { id?: string; label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SubmitButton({ busy, children, ...rest }: React.ComponentProps<typeof Button> & { busy: boolean }) {
  return (
    <Button type="submit" disabled={busy || rest.disabled} {...rest}>
      {busy && <LoaderCircleIcon className="animate-spin" />}
      {children}
    </Button>
  );
}

// ── New project ──────────────────────────────────────────────────────────

function NewProjectBody() {
  const p = usePlacement();
  const [name, setName] = React.useState('');
  const [systemPath, setSystemPath] = React.useState('');
  const [conventions, setConventions] = React.useState<Convention[]>([]);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [none, setNone] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [created, setCreated] = React.useState<{ scaffold?: string; gitSkipped?: string } | null>(null);

  React.useEffect(() => {
    void p.loadSystems();
    apiFetch<{ conventions?: Convention[] } | null>('/api/settings/conventions/project')
      .then((d) => setConventions(d?.conventions ?? []))
      .catch(() => { /* no catalog: offer nothing */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const system = p.chosenSystem;
  const preview = !system
    ? `~/project/${name || '<name>'}`
    : `${systemPath || '<path>'} on ${p.describe()}`;

  async function submit() {
    const n = name.trim();
    if (!n) { setError('A project name is required.'); return; }
    if (!NAME_PATTERN.test(n)) { setError('Use letters, digits, dots, dashes and underscores only.'); return; }
    const sp = systemPath.trim();
    const placementError = !system ? null
      : !sp ? `A path on '${system}' is required. cc has no default location on another machine.`
      : !sp.startsWith('/') ? `The path on '${system}' must be absolute.`
      : p.remoteError();
    if (placementError) { setError(placementError); return; }
    setBusy(true);
    setError('');
    try {
      const body: Record<string, unknown> = { name: n };
      // Nothing ticked and no explicit none sends neither, which records unset.
      if (none) body.noProjectConventions = true;
      else if (picked.size) body.conventions = [...picked];
      if (system) {
        body.system = system;
        body.systemPath = sp;
        if (p.chosenRemote) body.remoteId = p.chosenRemote;
      }
      const res = await apiFetch<{ scaffold?: string; gitSkipped?: string }>('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      await refreshProjects();
      if (res.scaffold || res.gitSkipped) setCreated({ scaffold: res.scaffold, gitSkipped: res.gitSkipped });
      else closeDialog('newProject');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="grid gap-4" data-step="confirm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><CheckIcon className="size-5 text-success" /> Project created</DialogTitle>
        </DialogHeader>
        {created.gitSkipped && <p className="text-sm text-muted-foreground" data-git-skipped>{created.gitSkipped}</p>}
        {created.scaffold && (
          <div className="grid gap-2">
            <p className="text-sm text-muted-foreground">
              This project was created with scaffolding steps. The conductor folds them into the first worker's brief automatically; a copy is shown here so it isn't lost:
            </p>
            <Textarea readOnly rows={8} value={created.scaffold} className="font-mono text-xs" data-scaffold />
          </div>
        )}
        <DialogFooter><Button onClick={() => closeDialog('newProject')} autoFocus>Done</Button></DialogFooter>
      </div>
    );
  }

  const groups = groupConventions(conventions);
  return (
    <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><FolderPlusIcon className="size-5 text-primary" /> New project</DialogTitle>
        <DialogDescription>Creates a project directory with git and the workspace conventions.</DialogDescription>
      </DialogHeader>
      <Field id="np-name" label="Name">
        <Input id="np-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="my-project" aria-invalid={!!name && !NAME_PATTERN.test(name.trim())} />
      </Field>
      <PlacementFields p={p} idPrefix="np" />
      {system && (
        <Field id="np-system-path" label="Path on that system">
          <PathInput id="np-system-path" value={systemPath} onChange={setSystemPath} placement={{ system, remoteId: p.chosenRemote }} resetKey={p.key} placeholder="/srv/myproject" />
        </Field>
      )}
      <p className="text-xs text-muted-foreground">Creates <code className="rounded bg-muted px-1 py-0.5 font-mono" data-preview>{preview}</code></p>
      <NoConventionsChoice checked={none} onChange={(on) => { setNone(on); if (on) setPicked(new Set()); }} idPrefix="np" />
      <ConventionChecklist
        groups={groups}
        picked={picked}
        onToggle={(slug, on) => {
          if (on) setNone(false);
          setPicked((s) => { const n = new Set(s); if (on) n.add(slug); else n.delete(slug); return n; });
        }}
        idPrefix="np"
      />
      <FormError>{error}</FormError>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => closeDialog('newProject')}>Cancel</Button>
        <SubmitButton busy={busy}>Create project</SubmitButton>
      </DialogFooter>
    </form>
  );
}

export function NewProjectDialog() {
  const open = useStore(dialogStore, (s) => s.newProject);
  const key = useOpenKey(open);
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) closeDialog('newProject'); }}>
      {open && <DialogContent className="sm:max-w-lg" data-dialog="new-project"><NewProjectBody key={key} /></DialogContent>}
    </Dialog>
  );
}

// ── Add (adopt) an existing directory ───────────────────────────────────

type Scan = { root: string; maxDepth: number; truncated?: boolean; unreadable?: number; candidates?: { path: string; relPath: string; suggestedName?: string; isGitRepo?: boolean }[] };

export function scanNote(scan: Scan) {
  const n = (scan.candidates ?? []).length;
  const parts = [n === 0
    ? `No unregistered directories found under ${scan.root}. Type a path below to add one from anywhere.`
    : `${n} unregistered ${n === 1 ? 'directory' : 'directories'} under ${scan.root}, ${scan.maxDepth} levels deep. Anywhere else: type the path below.`];
  if (scan.truncated) parts.push('The scan was truncated, so there may be more.');
  if ((scan.unreadable ?? 0) > 0) parts.push(`${scan.unreadable} director${scan.unreadable === 1 ? 'y' : 'ies'} could not be read.`);
  return parts.join(' ');
}

type Target = { name: string; path: string; system: string | null; remoteId: string | null };

function AdoptBody() {
  const p = usePlacement();
  const [name, setName] = React.useState('');
  const [path, setPath] = React.useState('');
  const [scan, setScan] = React.useState<Scan | null>(null);
  const [localNote, setLocalNote] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [stale, setStale] = React.useState<{ target: Target; summary: string; discards: Record<string, number> | null; error: string } | null>(null);

  React.useEffect(() => {
    void p.loadSystems();
    apiFetch<Scan>('/api/projects/suggestions')
      .then((s) => { setScan(s); setLocalNote(scanNote(s)); })
      .catch((e) => setLocalNote(`Could not scan for directories (${e.message}). Type a path below.`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Moving the placement clears the path (it names a directory on the old placement) and its error.
  const firstPlacement = React.useRef(true);
  React.useEffect(() => {
    if (firstPlacement.current) { firstPlacement.current = false; return; }
    setPath('');
    setError('');
  }, [p.system]);

  const system = p.chosenSystem;

  async function submit(target: Target, onStaleRecord: 'relocate' | 'replace' | null) {
    setBusy(true);
    setError('');
    const body: Record<string, unknown> = { name: target.name, path: target.path };
    if (target.system) {
      body.system = target.system;
      if (target.remoteId) body.remoteId = target.remoteId;
    }
    if (onStaleRecord) body.onStaleRecord = onStaleRecord;
    let data: any;
    try {
      data = await apiFetch('/api/projects/external', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e: any) {
      setStale(null); setError(e.message); setBusy(false); return;
    }
    setBusy(false);
    if (data?.ok === true) {
      try { await refreshProjects(); } catch (e: any) { setError(e.message); return; }
      closeDialog('adoptProject');
      return;
    }
    if (data?.code === 'PROJECT_EXISTS_STALE') {
      setStale({
        target,
        summary: `Project '${target.name}' is registered at ${data.heldPath}, which no longer exists. Relocate repoints that record at ${target.path} and keeps its stored state; Replace discards the state below and registers ${target.path} afresh.`,
        discards: data.discards ?? {},
        error: '',
      });
      return;
    }
    if (data?.code === 'PROJECT_PLACEMENT_IN_USE') {
      setStale((s) => ({ target, summary: s?.summary ?? '', discards: s?.discards ?? null, error: messageFor(data) }));
      return;
    }
    setStale(null);
    setError(messageFor(data));
  }

  function onAdopt() {
    const target: Target = { name: name.trim(), path: path.trim(), system, remoteId: p.chosenRemote };
    if (!target.name) { setError('A project name is required.'); return; }
    if (!target.path) { setError('A directory is required.'); return; }
    const bad = target.system && !target.path.startsWith('/') ? `The path on '${target.system}' must be absolute.` : p.remoteError();
    if (bad) { setError(bad); return; }
    void submit(target, null);
  }

  if (stale) {
    const d = stale.discards ?? {};
    const rows: [number, string][] = [[d.attachments ?? 0, 'attachment'], [d.debug ?? 0, 'debug capture'], [d.worktrees ?? 0, 'worktree registration']];
    return (
      <div className="grid gap-4" data-step="stale">
        <DialogHeader>
          <DialogTitle>That name is registered elsewhere</DialogTitle>
          {stale.summary && <DialogDescription data-stale-summary>{stale.summary}</DialogDescription>}
        </DialogHeader>
        {stale.discards && (
          <div className="grid gap-1.5">
            <p className="text-sm text-muted-foreground">Replace discards:</p>
            <ul className="grid gap-1 text-sm" data-discards>
              {rows.map(([count, noun]) => <li key={noun} className="flex items-center gap-2"><span className="w-6 text-right font-medium tabular-nums">{count}</span>{noun}{count === 1 ? '' : 's'}</li>)}
            </ul>
          </div>
        )}
        <FormError>{stale.error}</FormError>
        <DialogFooter>
          <Button variant="ghost" onClick={() => closeDialog('adoptProject')}>Cancel</Button>
          <Button variant="outline" disabled={busy} onClick={() => void submit(stale.target, 'replace')}>Replace</Button>
          <Button disabled={busy} autoFocus onClick={() => void submit(stale.target, 'relocate')}>
            {busy && <LoaderCircleIcon className="animate-spin" />}Relocate
          </Button>
        </DialogFooter>
      </div>
    );
  }

  const candidates = scan?.candidates ?? [];
  return (
    <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); onAdopt(); }} noValidate>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><FolderGit2Icon className="size-5 text-primary" /> Add a project</DialogTitle>
        <DialogDescription>Registers a directory that already exists. Nothing is copied or moved.</DialogDescription>
      </DialogHeader>
      <Field id="apd-name" label="Name">
        <Input id="apd-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="my-project" />
      </Field>
      <PlacementFields p={p} idPrefix="apd" />
      <Field id="apd-path" label="Directory">
        <PathInput id="apd-path" value={path} onChange={setPath} placement={{ system, remoteId: p.chosenRemote }} resetKey={p.key} placeholder="/absolute/path/to/directory" />
      </Field>
      {!system && candidates.length > 0 && (
        <ul className="grid max-h-48 gap-1 overflow-y-auto rounded-xl border p-1" data-suggestions>
          {candidates.map((c) => (
            <li key={c.path}>
              <button
                type="button"
                onClick={() => { setPath(c.path); setName(c.suggestedName ?? ''); }}
                className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted', path === c.path && 'bg-accent')}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{c.relPath}</span>
                {c.isGitRepo && <Badge variant="secondary" className="font-normal">git</Badge>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground" data-scan-note>{system ? `Type an absolute path on ${p.describe()}.` : localNote}</p>
      <FormError>{error}</FormError>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => closeDialog('adoptProject')}>Cancel</Button>
        <SubmitButton busy={busy}>Add project</SubmitButton>
      </DialogFooter>
    </form>
  );
}

export function AdoptProjectDialog() {
  const open = useStore(dialogStore, (s) => s.adoptProject);
  const key = useOpenKey(open);
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) closeDialog('adoptProject'); }}>
      {open && <DialogContent className="sm:max-w-lg" data-dialog="adopt-project"><AdoptBody key={key} /></DialogContent>}
    </Dialog>
  );
}

// ── Delete project ───────────────────────────────────────────────────────

export function deleteEffects(project: Project, instanceCount: number) {
  const remote = project.system && project.system !== 'local' ? project.system : null;
  const wts = project.worktrees ?? [];
  return [
    `Kill ${instanceCount} running session${instanceCount === 1 ? '' : 's'}`,
    remote
      ? `Unregister ${wts.length} worktree${wts.length === 1 ? '' : 's'} (their directories and branches are left in place)`
      : `Remove ${wts.length} worktree${wts.length === 1 ? '' : 's'} (directory and branch); refused if any is dirty or has dependents`,
    'Deregister the project',
    'Your ~/.claude/projects/ session history is left in place.',
  ];
}

function DeleteBody({ project, instanceCount }: { project: Project; instanceCount: number }) {
  const remote = project.system && project.system !== 'local' ? project.system : null;
  const where = remote ? `${project.path} on ${project.remoteId ? `target '${project.remoteId}' of ` : ''}system '${remote}'` : project.path;
  const [confirm, setConfirm] = React.useState('');
  const [deleteDir, setDeleteDir] = React.useState(false);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    if (confirm !== project.name) { setError('The name does not match. Nothing was deleted.'); return; }
    setBusy(true);
    setError('');
    try {
      await performProjectDelete({ name: project.name, deleteDirectory: !remote && deleteDir });
      closeDialog('deleteProject');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><Trash2Icon className="size-5 text-destructive" /> {remote ? 'Unregister' : 'Delete'} project {project.name}?</DialogTitle>
        <DialogDescription className="font-mono text-xs break-all">{where}</DialogDescription>
      </DialogHeader>
      <ul className="grid gap-1.5 text-sm" data-effects>
        {deleteEffects(project, instanceCount).map((t, i, all) => (
          <li key={t} className={cn('flex gap-2', i === all.length - 1 && 'text-muted-foreground')}>
            <span className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />{t}
          </li>
        ))}
      </ul>
      {!remote && (
        <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3">
          <Checkbox id="dpd-delete-dir" checked={deleteDir} onCheckedChange={(v) => setDeleteDir(v === true)} className="mt-0.5" />
          <Label htmlFor="dpd-delete-dir" className="font-normal leading-snug">Also delete the directory <code className="font-mono text-xs break-all">{project.path}</code></Label>
        </div>
      )}
      <Field id="dpd-confirm" label="Type the project name to confirm">
        <Input id="dpd-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" autoFocus placeholder={project.name} />
      </Field>
      <FormError>{error}</FormError>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => closeDialog('deleteProject')}>Cancel</Button>
        <SubmitButton busy={busy} variant="destructive" disabled={confirm !== project.name}>{remote ? 'Unregister' : 'Delete'}</SubmitButton>
      </DialogFooter>
    </form>
  );
}

export function DeleteProjectDialog() {
  const slot = useStore(dialogStore, (s) => s.deleteProject);
  const key = useOpenKey(slot);
  return (
    <Dialog open={!!slot} onOpenChange={(o) => { if (!o) closeDialog('deleteProject'); }}>
      {slot && <DialogContent className="sm:max-w-lg" data-dialog="delete-project"><DeleteBody key={key} project={slot.project} instanceCount={slot.instanceCount} /></DialogContent>}
    </Dialog>
  );
}

// ── Change a project's target ────────────────────────────────────────────

function RemoteBody({ project }: { project: Project }) {
  const [remote, setRemote] = React.useState(project.remoteId ?? '');
  const [error, setError] = React.useState('');
  const [blockers, setBlockers] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);

  async function save() {
    setBusy(true);
    setError('');
    setBlockers([]);
    try {
      await apiFetch(`/api/projects/${encodeURIComponent(project.name)}/remote`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ remoteId: remote.trim() || null }),
      });
    } catch (e: any) {
      setBusy(false);
      setError(e.message);
      const body: any = e instanceof ApiError ? e.body : null;
      if (body?.code === 'PROJECT_PLACEMENT_IN_USE') {
        setBlockers([
          ...(Array.isArray(body.instances) ? body.instances : []).map((id: string) => `Session ${id}: stop it`),
          ...(Array.isArray(body.worktrees) ? body.worktrees : []).map((n: string) => `Worktree ${n}: delete it`),
        ]);
      }
      return;
    }
    setBusy(false);
    try { await refreshProjects(); } catch (e: any) { setError(e.message); return; }
    closeDialog('projectRemote');
  }

  return (
    <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <DialogHeader>
        <DialogTitle>Change target</DialogTitle>
        <DialogDescription>
          One system can serve many named targets. This moves <code className="font-mono">{project.name}</code> to a different one. It does not move the project to another system or path.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="pr-system" label="System"><Input id="pr-system" value={project.system ?? ''} readOnly className="bg-muted/50" /></Field>
        <Field id="pr-path" label="Path on that system"><Input id="pr-path" value={project.path ?? ''} readOnly className="bg-muted/50 font-mono text-xs" /></Field>
      </div>
      <Field id="pr-remote" label="Target">
        <Input id="pr-remote" value={remote} onChange={(e) => setRemote(e.target.value)} autoFocus placeholder="Container, host or VM id; blank for the system's default" />
      </Field>
      <FormError>{error}</FormError>
      {blockers.length > 0 && (
        <ul className="grid gap-1 rounded-xl border p-3 text-sm" data-blockers>
          {blockers.map((b) => <li key={b}>{b}</li>)}
        </ul>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => closeDialog('projectRemote')}>Cancel</Button>
        <SubmitButton busy={busy}>Save</SubmitButton>
      </DialogFooter>
    </form>
  );
}

export function ProjectRemoteDialog() {
  const slot = useStore(dialogStore, (s) => s.projectRemote);
  const key = useOpenKey(slot);
  return (
    <Dialog open={!!slot} onOpenChange={(o) => { if (!o) closeDialog('projectRemote'); }}>
      {slot && <DialogContent className="sm:max-w-lg" data-dialog="project-remote"><RemoteBody key={key} project={slot.project} /></DialogContent>}
    </Dialog>
  );
}

// ── Workspace (new / edit) ───────────────────────────────────────────────

async function call(url: string, method: string, body?: unknown) {
  await apiFetch(url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
}

/** The requests saving a workspace makes: rename, then add/remove members (or create an empty one). */
export async function saveWorkspace({ original, name, originalMembers, ticked }: { original: string | null; name: string; originalMembers: Set<string>; ticked: Set<string> }) {
  if (original && name !== original) await call(`/api/workspaces/${encodeURIComponent(original)}`, 'PUT', { name });
  if (!original && ticked.size === 0) { await call('/api/workspaces', 'POST', { name }); return; }
  const updates: Promise<void>[] = [];
  const setWs = (project: string, workspace: string | null) =>
    call(`/api/projects/${encodeURIComponent(project)}/workspace`, 'PUT', { workspace }).catch((e) => { throw new Error(`${project}: ${e.message}`); });
  for (const p of ticked) if (!originalMembers.has(p)) updates.push(setWs(p, name));
  for (const p of originalMembers) if (!ticked.has(p)) updates.push(setWs(p, null));
  await Promise.all(updates);
}

function WorkspaceBody({ original }: { original: string | null }) {
  const projects = useStore(appStore, (s) => s.projects);
  const originalMembers = React.useMemo(
    () => new Set(original ? appStore.get().projects.filter((p) => (p.workspace ?? '').trim() === original).map((p) => p.name) : []),
    [original],
  );
  const [name, setName] = React.useState(original ?? '');
  const [ticked, setTicked] = React.useState<Set<string>>(() => new Set(originalMembers));
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function save() {
    const n = name.trim();
    if (!n) { setError('A workspace name is required.'); return; }
    setBusy(true);
    setError('');
    try {
      await saveWorkspace({ original, name: n, originalMembers, ticked });
      await refreshProjects();
      closeDialog('workspace');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!original) return;
    const ok = await confirmDialog({
      title: `Delete workspace ${original}?`,
      description: 'Its projects move back to unassigned. No project data is removed.',
      confirmLabel: 'Delete workspace',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      await call(`/api/workspaces/${encodeURIComponent(original)}`, 'DELETE');
      await refreshProjects();
      closeDialog('workspace');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <DialogHeader>
        <DialogTitle>{original ? `Edit workspace ${original}` : 'New workspace'}</DialogTitle>
        <DialogDescription>
          Each project belongs to at most one workspace. Ticking a project moves it out of any other. Saving with nothing ticked creates an empty workspace.
        </DialogDescription>
      </DialogHeader>
      <Field id="gd-name" label="Workspace name">
        <Input id="gd-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Work, Side, client-X" />
      </Field>
      <fieldset className="grid gap-2">
        <legend className="mb-1.5 text-sm font-medium">Projects</legend>
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-empty-hint>No projects yet. Create one first.</p>
        ) : (
          // Positioned: Radix's hidden form inputs stay in this list and scroll with it instead of extending the dialog.
          <ul className="relative grid max-h-64 gap-0.5 overflow-y-auto rounded-xl border p-1" data-project-list>
            {projects.map((p) => {
              const current = typeof p.workspace === 'string' && p.workspace.trim() ? p.workspace.trim() : null;
              const id = `gd-p-${p.name}`;
              return (
                <li key={p.name} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/60">
                  <Checkbox
                    id={id}
                    data-project={p.name}
                    checked={ticked.has(p.name)}
                    onCheckedChange={(v) => setTicked((s) => { const n = new Set(s); if (v === true) n.add(p.name); else n.delete(p.name); return n; })}
                  />
                  <Label htmlFor={id} className="min-w-0 flex-1 truncate font-normal">{p.name}</Label>
                  {current && current !== original && (
                    <span className="shrink-0 text-xs text-muted-foreground" title={`Ticking this project moves it out of ${current}.`}>in {current}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>
      <FormError>{error}</FormError>
      <DialogFooter className="sm:justify-between">
        {original ? <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy} onClick={() => void remove()}><Trash2Icon />Delete workspace</Button> : <span />}
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="ghost" onClick={() => closeDialog('workspace')}>Cancel</Button>
          <SubmitButton busy={busy}>{original ? 'Save' : 'Create'}</SubmitButton>
        </div>
      </DialogFooter>
    </form>
  );
}

export function WorkspaceDialog() {
  const slot = useStore(dialogStore, (s) => s.workspace);
  const key = useOpenKey(slot);
  return (
    <Dialog open={!!slot} onOpenChange={(o) => { if (!o) closeDialog('workspace'); }}>
      {slot && <DialogContent className="sm:max-w-lg" data-dialog="workspace"><WorkspaceBody key={key} original={slot.name} /></DialogContent>}
    </Dialog>
  );
}
