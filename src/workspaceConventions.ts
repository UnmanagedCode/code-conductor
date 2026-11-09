// Workspace conventions — the "applies to every project" sections, composed
// alongside the always-on core into one text with no destination of its own.
//
// CORE (conventions/workspace/core.md) is always present. The built-in
// conventions (SEED_CONVENTIONS; bodies in conventions/workspace/<slug>.md) and
// any user-defined custom conventions are toggled via a single GLOBAL selection
// — installation-wide by design, so it can never drift per project — persisted
// at <orchStoreRoot>/conventions/workspace.json as { disabled: [...], rules: [...] }.
//
// Delivery is per destination, and every destination is app-owned + fully
// overwritten: src/projectClaudeMd.ts folds this text into each project's
// in-tree CONVENTIONS.md (on boot and after every workspace-settings change),
// and src/conduct.ts prepends it to the conductor role doc it materializes into
// `.conduct/CONVENTIONS.md` before every conductor spawn.

import path from 'node:path';
import { orchStoreRoot } from './projects.ts';
import { createFragmentCatalog, readCoreFragment, type ConventionSkill } from './fragmentCatalog.ts';
import { createSelectionStore } from './conventionSelection.ts';
import { conventionsDir } from './conventionsDir.ts';

// Always-on core (conventions/workspace/core.md) — surfaced to the settings UI
// as a non-toggleable row so users see what can't be turned off.
export const CORE_META = {
  name: 'Core (always on)',
  description: 'Intro + the per-project CONVENTIONS.md delivery contract',
};

// Built-in convention metadata (order = order they appear in the composed doc).
// Bodies live in conventions/workspace/<slug>.md.
export const SEED_CONVENTIONS: Array<{ slug: string; name: string; description: string }> = [
  { slug: 'git-hygiene', name: 'Git hygiene',
    description: 'Init repo; git identity; commit-per-turn; .gitignore; no push; no hook bypass' },
  { slug: 'readme-maintenance', name: 'README maintenance',
    description: 'Read README before touching a project; create/update it; keep functional + technical in sync; write reference docs for retrieval and split before sprawl' },
  { slug: 'durable-content', name: 'Durable content',
    description: 'Tracked files carry no dev history, unresolvable pointers or machine-specific content; cite names; never restate the code' },
  { slug: 'system-prompt-docs', name: 'System-prompt docs',
    description: 'CLAUDE.md + the conductor role doc cost tokens every session — cut color, keep behavior-changing instruction' },
  { slug: 'opening-urls', name: 'Opening URLs',
    description: 'Render actionable URLs as tappable ▶ buttons; never open them yourself; use sparingly' },
  { slug: 'answering-questions', name: 'Answering questions',
    description: 'Answer a question before acting on it; name the implied work and wait for the go-ahead' },
];

const catalog = createFragmentCatalog({
  seeds: SEED_CONVENTIONS,
  seedDir: () => conventionsDir('workspace'),
  skillParts: true,
  storeFile: () => path.join(orchStoreRoot(), 'conventions', 'workspace.json'),
  noun: 'convention',
});

// ── Fragment read (core is always-on, read per call) ─────────────────────────
//
// Not memoised, for the reason seedEntry isn't (src/fragmentCatalog.ts): every
// destination this text reaches is overwritten from it, so a body frozen at
// first read reverts an edit instead of merely aging.

function getCore(): Promise<{ inline: string; skill?: ConventionSkill }> {
  return readCoreFragment(path.join(conventionsDir('workspace'), 'core.md'), SEED_CONVENTIONS.map(s => s.slug));
}

// ── Catalog + CRUD (delegated to the shared helper) ──────────────────────────

export const getCatalog = catalog.getCatalog;
export const addCustomConvention = catalog.addCustom;
export const updateCustomConvention = catalog.updateCustom;
export const validateSlug = catalog.validateSlug;

// ── Global selection (the shared collaborator, no overrides) ────────────────
//
// Plain selection: the persisted `disabled` deny-list is the whole story, and
// every built-in and custom convention it does not name is composed — so a
// fresh install (no store at all) composes the equivalent of the pre-carve
// bundled canonical, and so does an install that has saved its settings.
// Deleting a custom convention also prunes it from that array.

const selection = createSelectionStore({ catalog, seeds: SEED_CONVENTIONS, noun: 'convention' });

export const getSelection = selection.getSelection;
export const setSelection = selection.setSelection;
export const deleteCustomConvention = selection.deleteCustom;

// ── Compose ───────────────────────────────────────────────────────────────────

// core + enabled convention bodies (catalog order), with the skills the same
// selection delivers (the core's first) — both off one compose, so the text and
// the skills can never come from two different selections.
export async function composeWorkspaceParts(enabledSlugs: string[]): Promise<{ text: string; skills: ConventionSkill[] }> {
  const core = await getCore();
  const { text, skills } = await catalog.composeWithMeta(enabledSlugs);
  const mods = text.trim();
  return {
    text: [core.inline, ...(mods ? [mods] : [])].join('\n\n') + '\n',
    skills: [...(core.skill ? [core.skill] : []), ...skills],
  };
}

export async function composeCurrentWorkspaceParts(): Promise<{ text: string; skills: ConventionSkill[] }> {
  return composeWorkspaceParts(await getSelection());
}

export async function composeWorkspace(enabledSlugs: string[]): Promise<string> {
  return (await composeWorkspaceParts(enabledSlugs)).text;
}

export async function composeCurrentWorkspace(): Promise<string> {
  return (await composeCurrentWorkspaceParts()).text;
}

