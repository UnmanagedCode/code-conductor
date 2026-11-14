import express from 'express';
import { PLAYBOOK_ENFORCEMENT_MODES, DEFAULT_PLAYBOOK_ID } from '../playbooks.ts';
import { getCatalog as getProjectConventionsCatalog, addCustomConvention as addProjectConvention, updateCustomConvention as updateProjectConvention, deleteCustomConvention as deleteProjectConvention } from '../projectConventions.ts';
import { regenerateAllProjectConventions } from '../projectClaudeMd.ts';
import {
  CORE_META as CONDUCT_CORE_META, getCatalog as getConductorConventionsCatalog, getSelection as getConductorSelection, setSelection as setConductorSelection, addCustomConvention as addConductorConvention, updateCustomConvention as updateConductorConvention, deleteCustomConvention as deleteConductorConvention, getDefaultPlaybookSelection, defaultPlaybookMissing, setDefaultPlaybook, getDefaultPlaybookEnforcement, setDefaultPlaybookEnforcement, type DefaultPlaybookSelection,
} from '../conductorConventions.ts';
// `listPlaybooks` is the catalog read the Settings picker lists, imported
// rather than reimplemented per surface.
import { listPlaybooks } from '../mcp/handlers.ts';
import {
  CORE_META as WORKSPACE_CORE_META, getCatalog as getWorkspaceConventionsCatalog, getSelection as getWorkspaceSelection, setSelection as setWorkspaceSelection, addCustomConvention as addWorkspaceConvention, updateCustomConvention as updateWorkspaceConvention, deleteCustomConvention as deleteWorkspaceConvention,
} from '../workspaceConventions.ts';
import { httpError } from '../httpError.ts';
import { jsonBody } from './shared.ts';

export function mountWorkspaceConventions(r: express.Router): void {
  // Settings → Conventions → Workspace block — an always-on core + toggleable
  // conventions, under ONE installation-wide selection. The composed text is
  // delivered per project (folded into each project's in-tree CONVENTIONS.md,
  // and into `.conduct/CONVENTIONS.md` before every conductor spawn), so every
  // mutation fans out over all projects to take effect immediately.
  r.get('/settings/conventions/workspace', async (_req, res, next) => {
    try {
      const [conventions, enabled] = await Promise.all([getWorkspaceConventionsCatalog(), getWorkspaceSelection()]);
      res.json({ core: WORKSPACE_CORE_META, conventions, enabled });
    } catch (e) { next(e); }
  });

  // Literal /selection must precede the /:slug route below so it isn't
  // swallowed as a slug.
  r.put('/settings/conventions/workspace/selection', async (req, res, next) => {
    try {
      const enabled = jsonBody(req).enabled as string[];
      const saved = await setWorkspaceSelection(enabled);
      await regenerateAllProjectConventions({ log: console });
      res.json({ enabled: saved });
    } catch (e) { next(e); }
  });

  r.post('/settings/conventions/workspace', async (req, res, next) => {
    try {
      const body = jsonBody(req);
      const { slug, name, description, body: text, scaffold } = body;
      const convention = await addWorkspaceConvention({
        slug: slug as string, name: name as string, description: description as string, body: text, scaffold,
      });
      await regenerateAllProjectConventions({ log: console });
      res.status(201).json({ convention });
    } catch (e) { next(e); }
  });

  r.put('/settings/conventions/workspace/:slug', async (req, res, next) => {
    try {
      const { slug } = req.params;
      const body = jsonBody(req);
      const { name, description, body: text, scaffold } = body;
      const convention = await updateWorkspaceConvention(slug, { name, description, body: text, scaffold });
      await regenerateAllProjectConventions({ log: console });
      res.json({ convention });
    } catch (e) { next(e); }
  });

  r.delete('/settings/conventions/workspace/:slug', async (req, res, next) => {
    try {
      const { slug } = req.params;
      const result = await deleteWorkspaceConvention(slug);
      await regenerateAllProjectConventions({ log: console });
      res.json(result);
    } catch (e) { next(e); }
  });
}

export function mountProjectConventions(r: express.Router): void {
  // Settings → Conventions → Project block — catalog read + custom CRUD.
  // Selection is per-project (recorded in each project's in-tree CONVENTIONS.md
  // marker at creation, and changed by PUT /projects/:name/conventions); there
  // is no global selection. Each mutation to a custom
  // convention's body fans out to regenerate every project that selected it —
  // a since-deleted slug becomes unresolvable: the project's other, resolvable
  // conventions still refresh, and the missing one is named in the file (see
  // `src/projectClaudeMd.ts`); `{ log: console }` also surfaces every declined-
  // write case in the server log (docs/components/web.md).
  //
  // This route deliberately does NOT carry the catalog's `degraded` flag — the
  // MCP `list_project_conventions` / `list_conductor_conventions` tools do
  // (card 2026-0282). `res.json` is a `JSON.stringify`, which drops a
  // CatalogList's own `degraded` property just as `.map()` does, so the flag
  // does not reach the new-project dialog and the dialog therefore renders a
  // short catalog exactly like a complete one. The fix on this surface is a
  // dialog affordance for a human picker rather than a bare field, and is
  // carded separately.
  r.get('/settings/conventions/project', async (_req, res, next) => {
    try { res.json({ conventions: await getProjectConventionsCatalog() }); } catch (e) { next(e); }
  });

  r.post('/settings/conventions/project', async (req, res, next) => {
    try {
      const body = jsonBody(req);
      const { slug, name, description, body: text, scaffold } = body;
      const convention = await addProjectConvention({
        slug: slug as string, name: name as string, description: description as string, body: text, scaffold,
      });
      await regenerateAllProjectConventions({ log: console });
      res.status(201).json({ convention });
    } catch (e) { next(e); }
  });

  r.put('/settings/conventions/project/:slug', async (req, res, next) => {
    try {
      const { slug } = req.params;
      const body = jsonBody(req);
      const { name, description, body: text, scaffold } = body;
      const convention = await updateProjectConvention(slug, { name, description, body: text, scaffold });
      await regenerateAllProjectConventions({ log: console });
      res.json({ convention });
    } catch (e) { next(e); }
  });

  r.delete('/settings/conventions/project/:slug', async (req, res, next) => {
    try {
      const { slug } = req.params;
      const result = await deleteProjectConvention(slug);
      await regenerateAllProjectConventions({ log: console });
      res.json(result);
    } catch (e) { next(e); }
  });
}

export function mountConductorConventions(r: express.Router): void {
  // Settings → Conventions → Conductor block — global (singleton conductor)
  // selection + custom-convention CRUD. Mutations only update the convention
  // stores; the conductor doc is recomposed and rewritten to
  // `.conduct/CONVENTIONS.md` on the next conductor spawn/resume (see
  // Instance.launch in src/instances.ts), so there is nothing to regenerate here.
  //
  // The response also carries the playbook catalog and the current selection,
  // which the same page's Preferred-playbook picker consumes: the selected
  // playbook is rendered into the conductor's prompt as a generated convention
  // (src/playbookConvention.ts).
  //
  // Like its project-scope twin above, this route deliberately does NOT carry
  // the catalog's `degraded` flag — the MCP `list_conductor_conventions` tool
  // does (card 2026-0282). `res.json` is a `JSON.stringify`, which drops a
  // CatalogList's own `degraded` property, so the Settings panel renders a
  // catalog missing an unreachable plugin's conventions exactly like a complete
  // one. Deferred by decision and carded separately: this is a read-only view
  // and nothing is committed from it.
  r.get('/settings/conventions/conductor', async (_req, res, next) => {
    try {
      const [conventions, enabled, catalog, defaultPlaybook, defaultPlaybookEnforcement, missing] = await Promise.all([
        getConductorConventionsCatalog(), getConductorSelection(), listPlaybooks(), getDefaultPlaybookSelection(),
        getDefaultPlaybookEnforcement(), defaultPlaybookMissing(),
      ]);
      res.json({
        core: CONDUCT_CORE_META, conventions, enabled,
        playbooks: catalog.playbooks, playbookErrors: catalog.errors, defaultPlaybook,
        // The stored selection when no loaded definition backs it, with the
        // reason (naming the owning plugin for a plugin playbook), so the picker
        // keeps showing it rather than going blank. Null otherwise.
        defaultPlaybookMissing: missing,
        // What `{mode:'unset'}` resolves to, so the picker labels that row from
        // the shipped constant instead of a second copy of the id.
        defaultPlaybookFallback: DEFAULT_PLAYBOOK_ID,
        // The level a newly spawned conductor starts at, plus the allow-list the
        // enforcement picker builds its rows from — the constant stays server-side.
        defaultPlaybookEnforcement,
        playbookEnforcementModes: PLAYBOOK_ENFORCEMENT_MODES,
      });
    } catch (e) { next(e); }
  });

  // The literal paths (/selection, /default-playbook, /default-playbook-enforcement)
  // must precede the /:slug route below so they aren't swallowed as slugs.
  r.put('/settings/conventions/conductor/selection', async (req, res, next) => {
    try {
      const enabled = jsonBody(req).enabled as string[];
      const saved = await setConductorSelection(enabled);
      res.json({ enabled: saved });
    } catch (e) { next(e); }
  });

  r.put('/settings/conventions/conductor/default-playbook', async (req, res, next) => {
    try {
      // `defaultPlaybook` must be PRESENT. A body-less PUT is a malformed
      // request, and treating it as any of the three states discards the
      // selection silently.
      const body = jsonBody(req);
      if (!('defaultPlaybook' in body)) {
        throw httpError(400, "defaultPlaybook is required, e.g. {\"defaultPlaybook\":{\"mode\":\"none\"}}");
      }
      const saved = await setDefaultPlaybook(body.defaultPlaybook as DefaultPlaybookSelection);
      res.json({ defaultPlaybook: saved });
    } catch (e) { next(e); }
  });

  r.put('/settings/conventions/conductor/default-playbook-enforcement', async (req, res, next) => {
    try {
      // `mode` must be PRESENT, for the same reason default-playbook's key is:
      // a body-less PUT is malformed, not a request to pick a level.
      const body = jsonBody(req);
      if (!('mode' in body)) {
        throw Object.assign(
          new Error("mode is required, e.g. {\"mode\":\"warn\"}"),
          { statusCode: 400 },
        );
      }
      const saved = await setDefaultPlaybookEnforcement(body.mode);
      res.json({ defaultPlaybookEnforcement: saved });
    } catch (e) { next(e); }
  });

  r.post('/settings/conventions/conductor', async (req, res, next) => {
    try {
      const body = jsonBody(req);
      const { slug, name, description, body: text, scaffold } = body;
      const convention = await addConductorConvention({
        slug: slug as string, name: name as string, description: description as string, body: text, scaffold,
      });
      res.status(201).json({ convention });
    } catch (e) { next(e); }
  });

  r.put('/settings/conventions/conductor/:slug', async (req, res, next) => {
    try {
      const { slug } = req.params;
      const body = jsonBody(req);
      const { name, description, body: text, scaffold } = body;
      const convention = await updateConductorConvention(slug, { name, description, body: text, scaffold });
      res.json({ convention });
    } catch (e) { next(e); }
  });

  r.delete('/settings/conventions/conductor/:slug', async (req, res, next) => {
    try {
      const { slug } = req.params;
      const result = await deleteConductorConvention(slug);
      res.json(result);
    } catch (e) { next(e); }
  });
}
