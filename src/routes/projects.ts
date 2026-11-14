import express from 'express';
import {
  listProjects, adoptProject, summarizeSessions, deleteProject, getProjectForDelete, tryResolveProject, setProjectRemote, setProjectWorkspace, validateName, placeOf,
} from '../projects.ts';
import { suggestAdoptableDirs } from '../projectSuggestions.ts';
import {
  isGitRepo, isGitOwnershipRefusal, hasUnbornHead, listWorktrees, removeAllWorktreesForProject, getWorktreeMergeStatus, getProjectUpstreamStatus,
} from '../worktrees.ts';
import { isSystemRefusal, projectPlacement } from '../systems/registry.ts';
import { getOrCompute, invalidate, projectCacheKey } from '../projectsCache.ts';
import { projectsOperation } from '../projectsChanged.ts';
import { ensureConductProject, CONDUCT_PROJECT_NAME } from '../conduct.ts';
import { getCatalog as getProjectConventionsCatalog } from '../projectConventions.ts';
import {
  readProjectSelection, selectionInput, setProjectConventions, slugsOf, type ProjectConventionSelection,
} from '../projectClaudeMd.ts';
// `createProject` is the whole create sequence `POST /projects` delegates to
// (compose the document, compose the scaffold, create, warn on a degraded
// catalog — card 2026-0282). Note `createProject` here is the HANDLER, not
// `src/projects.ts`'s filesystem-level one it wraps.
import { createProject } from '../mcp/handlers.ts';
import { remotePlacementRefused, capabilitySoftRefusal } from '../capabilities.ts';
import { listDirectories } from '../dirListing.ts';
import { type PlatformCapabilities } from '../platform/index.ts';
import type { InstanceManagerLike } from '../instanceTypes.ts';
import { httpError, errMessage } from '../httpError.ts';
import { jsonBody } from './shared.ts';

export function mountProjects(r: express.Router, { instances, capabilities }: { instances?: InstanceManagerLike | null; capabilities: PlatformCapabilities }): void {
  // Compute the tree facts for one project — its git state and its recorded
  // convention selection. Called via getOrCompute() so
  // results are cached for TTL_MS and concurrent callers share one in-flight
  // execution. Does NOT include sessionIds or session counts — those are cheap
  // and always computed fresh so they stay live across status changes.
  async function computeGitFacts(p: { name: string; path: string }) {
    // tryResolveProject, not resolveProjectDir: this runs once per project inside
    // the listing's Promise.all, so a throw here would break the WHOLE list for
    // one project cc cannot resolve. An unresolved project degrades ITS OWN git
    // facts to unknown and says why. The whole PROJECT, not just its system: a
    // record naming a reachable system but carrying no path resolves its system
    // fine and still has no tree to measure.
    const { system, unreachable } = await tryResolveProject(p.name);
    // Worktree REGISTRATIONS are store-derived and need no System, so they are
    // still listed for an unreachable project — only their divergence, which is
    // measured with git on the tree, goes unknown.
    const worktrees = await listWorktrees(p.name).catch(() => []);
    const worktreesWithMerge = await Promise.all(worktrees.map(async (w) => ({
      ...w,
      mergeStatus: system
        ? await getWorktreeMergeStatus(system, w).catch(() => ({ ahead: null, behind: null }))
        : { ahead: null, behind: null },
    })));
    // undefined, not false: "we could not look" must not render as the positive
    // claim "not a git repo". The key is simply absent from the response, which
    // every client already reads as falsy, and `systemUnreachable` carries the
    // reason so absence is never ambiguous.
    //
    // The try covers a system that dies DURING the listing rather than at
    // resolution: `runGit` throws a system refusal now, and one project's
    // mid-listing death must degrade its own row rather than reject the
    // Promise.all and take the whole page down with it.
    //
    // Git refusing the repo on ownership is the same "could not look", but the
    // system answered: it gets its own `gitRefusal` so the row names that cause
    // and its fix rather than calling a reachable system unreachable.
    let projIsGitRepo: boolean | undefined;
    let unborn = false;
    let deadMidListing: string | null = null;
    let gitRefusal: string | null = null;
    if (system) {
      // BOTH probes inside one try. A death in the window between them used to
      // invent `unbornHead: false` — a measured-looking fact — on a row that
      // then carried no reason for its other facts being absent.
      try {
        projIsGitRepo = await isGitRepo(system, p.path);
        if (projIsGitRepo) unborn = await hasUnbornHead(system, p.path);
      } catch (e) {
        if (!isSystemRefusal(e)) throw e;
        if (isGitOwnershipRefusal(e)) gitRefusal = e.message;
        else deadMidListing = e.message;
        projIsGitRepo = undefined;
      }
    }
    // The selection line 1 of the project's CONVENTIONS.md records. A failed
    // read is this row's value, never the list's failure; undefined when the
    // project could not be resolved, which `systemUnreachable` explains.
    const selection: ProjectConventionSelection | { error: string } | undefined = system
      ? await readProjectSelection(system, p.path).catch((e: unknown) => ({ error: errMessage(e) }))
      : undefined;
    return {
      selection,
      systemUnreachable: unreachable ?? deadMidListing,
      gitRefusal,
      isGitRepo: projIsGitRepo,
      // Guarded on projIsGitRepo — hasUnbornHead() cannot tell "no repo" from
      // "no commits", so a non-repo reports false and isGitRepo carries it.
      unbornHead: unborn,
      worktrees: worktreesWithMerge,
      mergeStatus: system && projIsGitRepo
        ? await getProjectUpstreamStatus(system, p.path).catch(() => ({ ahead: null, behind: null, upstream: null }))
        : { ahead: null, behind: null, upstream: null },
    };
  }

  r.get('/projects', async (_req, res, next) => {
    try {
      const projects = await listProjects();
      // One catalog read per request, so a slug the catalog has lost reads as
      // unresolved on the next list read, cache or not.
      const catalogSlugs = new Set((await getProjectConventionsCatalog()).map(e => e.slug));
      const enriched = await Promise.all(projects.map(async (p) => {
        // Git facts are cached for TTL_MS; concurrent requests coalesce.
        // Keyed on the PLACEMENT, not the name: git facts are measured on the
        // project's system, so an entry cached before a project moved between
        // systems would be served as facts about the wrong machine.
        const gitFacts = await getOrCompute(projectCacheKey(p.system, p.name), () => computeGitFacts(p));
        // Attach a lightweight session count + last-active timestamp to
        // each worktree too, so the sidebar can decide whether to show
        // its "Sessions (N)" subnode without an extra fetch.
        const worktreesWithSessions = await Promise.all(gitFacts.worktrees.map(async (w) => {
          const wtPlace = placeOf(p, w.worktreePath);
          const wtNormalSids = instances ? instances.normalSessionIdsForPlace(wtPlace) : null;
          return {
            ...w,
            sessions: await summarizeSessions(wtPlace, wtNormalSids).catch(() => ({ count: 0, archivedCount: 0, handCount: 0, lastActivity: 0 })),
          };
        }));
        const projPlace = placeOf(p, p.path);
        const projNormalSids = instances ? instances.normalSessionIdsForPlace(projPlace) : null;
        return {
          ...p,
          sessionIds: instances ? instances.sessionIdsForProject(p.name) : [],
          // null on a healthy project; the refusal's message when this project's
          // System could not be resolved, in which case the git facts beside it
          // are unknown rather than measured.
          systemUnreachable: gitFacts.systemUnreachable,
          // null, or git's ownership refusal carrying its `safe.directory` fix;
          // set, `isGitRepo` is absent for the same reason as above.
          gitRefusal: gitFacts.gitRefusal,
          isGitRepo: gitFacts.isGitRepo,
          unbornHead: gitFacts.unbornHead,
          worktrees: worktreesWithSessions,
          sessions: await summarizeSessions(projPlace, projNormalSids).catch(() => ({ count: 0, archivedCount: 0, handCount: 0, lastActivity: 0 })),
          mergeStatus: gitFacts.mergeStatus,
          // The selection ({mode, slugs?}) plus `unresolved`, its slugs the
          // catalog lacks, in marker order; {error} when the file could not be
          // read; absent when the project could not be resolved.
          conventions: gitFacts.selection === undefined || 'error' in gitFacts.selection ? gitFacts.selection
            : { ...gitFacts.selection, unresolved: slugsOf(gitFacts.selection).filter(s => !catalogSlugs.has(s)) },
        };
      }));
      res.json(enriched);
    } catch (e) { next(e); }
  });

  r.post('/projects', async (req, res, next) => {
    try {
      const body = jsonBody(req);
      const { name, conventions, noProjectConventions, system, remoteId, systemPath } = body;
      // Validate the regex first so callers that hit BOTH conditions
      // (e.g. "../escape" — starts with "." AND contains "/") get the
      // canonical "invalid project name" error rather than the dot-prefix
      // one. Then refuse dot-prefixed names that *did* pass the regex —
      // those are reserved for orchestrator-managed hidden projects
      // (currently just `.conduct`).
      const validName = validateName(name as string);
      if (validName.startsWith('.')) {
        throw Object.assign(
          new Error('invalid project name (cannot start with "." — reserved for orchestrator-managed projects)'),
          { statusCode: 400 },
        );
      }
      // ONE implementation of the create sequence, shared with the MCP tool
      // (card 2026-0282). It composes the conventions document — seeded with
      // the placement disclosure when the project is being created ON a system,
      // so its first worker's prompt carries it without waiting for a
      // regeneration sweep — composes the scaffold directive, creates the
      // project, and then, ON SUCCESS ONLY, warns the operator once when the
      // convention catalog was degraded. The two name refusals above stay HERE and stay FIRST: they
      // are the web surface's own contract, and `validateName` returns its
      // argument unchanged so `validName === name`. The 201 body is the
      // handler's return verbatim, as it was before the delegation.
      //
      // Scaffold directive is returned (not persisted) — the caller folds it
      // into the first worker brief. See create_project's description.
      const created = await createProject({
        name: validName, conventions, noProjectConventions, system, remoteId, systemPath,
      }, { capabilities });
      res.status(201).json(created);
    } catch (e) { next(e); }
  });

  // Directories under the projects root that are NOT registered — what the
  // Adopt dialog offers instead of making the user type a path. Mounted here
  // for the same reason `/projects/external` is: before the `/projects/:name`
  // param routes, so `suggestions` cannot be read as a project name.
  //
  // No query parameters and no soft-refusal envelope: there is nothing here to
  // refuse, and a missing or unreachable root is an empty list rather than an
  // error. A genuine throw becomes the router's standard {error}.
  r.get('/projects/suggestions', async (_req, res, next) => {
    try { res.json(await suggestAdoptableDirs()); }
    catch (e) { next(e); }
  });

  // Subdirectory names of one absolute path on one system — the path
  // autocomplete in the Adopt and New-project dialogs. Soft refusals return 200
  // with {ok:false, code, reason}, like POST /projects/external. Contract and
  // limits: src/dirListing.ts, docs/protocol.md.
  r.get('/fs/dirs', async (req, res, next) => {
    try {
      const { path: p, system, remoteId } = req.query;
      if (remotePlacementRefused(capabilities, system)) return void res.json(capabilitySoftRefusal('remoteSystems'));
      res.json(await listDirectories({ system, remoteId, path: p }));
    } catch (e) { next(e); }
  });

  // Adopt an existing directory as a project.
  // Body: {name, path, system?, remoteId?, onStaleRecord?}.
  // Mounted before the `/projects/:name` param routes so `external` can't be
  // read as a project name. Soft refusals return 200 with {ok:false, code,
  // reason} — same contract as POST /projects/:name/worktrees/:wt/merge — so a caller can
  // render the reason inline instead of parsing a 4xx body. The `projects`
  // hint comes from adoptProject itself (src/projectsChanged.ts).
  r.post('/projects/external', async (req, res, next) => {
    try {
      const { name, path: targetPath, system, remoteId, onStaleRecord } = jsonBody(req);
      if (remotePlacementRefused(capabilities, system)) return void res.json(capabilitySoftRefusal('remoteSystems'));
      const result = await adoptProject(name, targetPath, { system, remoteId, onStaleRecord });
      res.status(result.ok ? 201 : 200).json(result);
    } catch (e) { next(e); }
  });

  // Lazy-create the hidden `.conduct` project that hosts Conduct sessions.
  // Mounted at a literal path so the regular /projects/:name guards don't
  // need to special-case the name and so curl-ing this never spawns a
  // visible project. Idempotent — second call is a fast no-op.
  r.post('/projects/.conduct/ensure', async (_req, res, next) => {
    try {
      const result = await ensureConductProject();
      res.json({ ok: true, ...result });
    } catch (e) { next(e); }
  });

  // Replace a project's convention selection (the sidebar's Edit
  // conventions…). Body: {selection, expected}, both tagged selections
  // ({mode: 'unset' | 'none'} or {mode: 'selected', slugs}); `expected` is the
  // selection the caller showed. Body checks are selectionInput's, refusals
  // and the write setProjectConventions' (src/projectClaudeMd.ts), whose write
  // signals the `projects` hint itself.
  r.put('/projects/:name/conventions', async (req, res, next) => {
    try {
      const body = jsonBody(req);
      const selection = selectionInput(body.selection, 'selection', { allowRepeats: false });
      const expected = selectionInput(body.expected, 'expected', { allowRepeats: true });
      res.json(await setProjectConventions(req.params.name, selection, expected, { log: console }));
    } catch (e) { next(e); }
  });

  // Delete a project + all attached state. Cascade:
  //   1. validate the project exists,
  //   2. kill every running instance attached to it (including any
  //      inside worktrees of this project),
  //   3. remove every worktree — and PROPAGATE its refusals: a dirty,
  //      dirty-unknown or depended-on worktree 409s the whole delete rather
  //      than being force-removed under the user,
  //   4. deregister the project. The TREE stays unless `deleteDirectory` is
  //      ticked, and for a project on a system there is no such tick.
  // Step 3 must precede step 4: everything after getProjectForDelete uses
  // proj.NAME, never a path, and unregistering first would turn listWorktrees
  // into a 404 and orphan both the worktree dirs and the registrations.
  // Sessions under ~/.claude/projects/<encoded>/ are intentionally
  // left alone — they belong to the user's claude CLI history and
  // may still be referenced outside the orchestrator.
  r.delete('/projects/:name', async (req, res, next) => {
    try {
      if (req.params.name === CONDUCT_PROJECT_NAME) {
        throw Object.assign(
          new Error('the .conduct project is managed by the orchestrator and cannot be deleted via this endpoint'),
          { statusCode: 400 },
        );
      }
      // getProjectForDelete, NOT getProject: unregistering must never depend on
      // reaching the system. getProject resolves it, which made deleteProject's
      // remote branch — written so a project on a down system is never stranded
      // — unreachable from this route, and deadlocked the pair (the project
      // could not be deleted, and removeSystem then refused 409 because that
      // project still named the system).
      const proj = await getProjectForDelete(req.params.name);
      const deleteDirectory = jsonBody(req).deleteDirectory === true;
      let killed = 0;
      if (instances) killed = await instances.removeAllForProject(proj.name, { actor: { type: 'human' } });
      // One `projects` signal for the whole cascade, every worktree included.
      const deleted = await projectsOperation(async () => {
        await removeAllWorktreesForProject(proj.name);
        return deleteProject(proj.name, { deleteDirectory });
      });
      invalidate(proj.name);
      // `directoryDeleted` repeats after the click what the confirm dialog
      // stated before it: deleting a project deregisters it, and the tree goes
      // only when the caller asked for it.
      res.json({
        ok: true, project: proj.name, killedInstances: killed,
        system: deleted.system, remoteId: deleted.remoteId, path: deleted.path,
        directoryDeleted: deleted.directoryDeleted,
      });
    } catch (e) { next(e); }
  });

  // Assign or clear the project's workspace. Body: {workspace: string|null}.
  // setProjectWorkspace (projects.ts) is the implementation, shared with MCP
  // set_project_workspace: "" clears, a new name is auto-registered, `.conduct`
  // is refused, and the change sends one `projects` hint.
  r.put('/projects/:name/workspace', async (req, res, next) => {
    try {
      const result = await setProjectWorkspace(req.params.name, jsonBody(req).workspace);
      res.json({ ok: true, ...result });
    } catch (e) { next(e); }
  });

  // Change which TARGET of its system a project is on. Body: {remoteId:
  // string|null}; null (or "") clears it back to the provider's own default.
  //
  // Modelled on PUT /projects/:name/workspace, and like it the work is in
  // src/projects.ts rather than here — setProjectRemote owns the guard, so the
  // MCP twin (set_project_remote) inherits it rather than reimplementing it.
  // `liveInstanceIds` comes from the injected manager: this route is one of the
  // two callers that owe that contract.
  r.put('/projects/:name/remote', async (req, res, next) => {
    try {
      const body = jsonBody(req);
      // OMISSION IS NOT CLEARING. A body with no `remoteId` at all is the shape
      // a caller reaches by accident, and reading it as "unbind this project"
      // is the most destructive reading available — so it is refused by name.
      // Clearing stays explicit, which is what this tool's description promises.
      // The MCP twin gets the same rule structurally, from `required` in its
      // schema (src/mcp/tools.ts).
      if (!('remoteId' in body)) {
        throw httpError(400, `remoteId is required — pass null (or "") to clear the target, `
          + `which is the only way to put the project back on its system's default`);
      }
      const raw = body.remoteId;
      const result = await setProjectRemote(
        req.params.name,
        raw === '' || raw === undefined ? null : raw,
        { liveInstanceIds: () => (instances ? instances.sessionIdsForProject(req.params.name) : []) },
      );
      invalidate(req.params.name);
      res.json({ ok: true, ...result });
    } catch (e) {
      // The 409 is RENDERED HERE rather than handed to the shared error
      // handler, which sends `{error}` alone: the whole value of this refusal is
      // the list of sessions and worktrees to clear, and a message the client
      // has to parse back into a list is not that list.
      const err = e as { statusCode?: number; code?: string; instances?: unknown; worktrees?: unknown };
      if (err?.code === 'PROJECT_PLACEMENT_IN_USE') {
        return res.status(409).json({
          error: errMessage(e), code: err.code,
          instances: err.instances, worktrees: err.worktrees,
        });
      }
      next(e);
    }
  });

  // Where a project lives, read off its stored record ALONE: runs nothing on
  // any system, so a caller that needs only the placement need not pay for the
  // git facts GET /projects computes for every project.
  r.get('/projects/:name/location', async (req, res, next) => {
    try {
      const name = req.params.name;
      try { validateName(name); }
      catch (e) { throw Object.assign(e as Error, { code: 'INVALID_ARGUMENT' }); }
      const placement = await projectPlacement(name);
      if (!placement) throw httpError(404, `project '${name}' not found`, { code: 'PROJECT_UNKNOWN' });
      res.json({ name, ...placement });
    } catch (e) { next(e); }
  });
}
