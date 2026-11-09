// The skill-part grammar of a convention fragment file — pure and import-free,
// so both the fragment catalog (src/fragmentCatalog.ts) and plugin manifest
// validation (src/plugins/manifest.ts) parse with the one definition.
//
// A fragment FILE may hand part of its text to a Claude Code skill: one marker
// line splits it into an inline part (above, composed into the system-prompt
// doc as before) and a skill body (below, delivered as a generated SKILL.md —
// src/conventionSkills.ts). Grammar and read sites: docs/architecture.md →
// "Convention skill parts".
//
//   <!-- cc:skill <description> -->          seed / plugin fragment (name = slug)
//   <!-- cc:skill:<name> <description> -->   a scope's core (name required)
//
// Any line opening `<!-- cc:skill` followed by a space, `:` or `-->` is a marker
// attempt, so a malformed one is an error rather than inline text.
const SKILL_MARKER_START_RE = /^<!-- cc:skill(?=[ :]|-->)/;
const SKILL_MARKER_RE = /^<!-- cc:skill(?::(\S*))?(?: (.*?))? ?-->$/;
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface SkillPart {
  description: string;
  body: string;
}

export interface SplitFragment {
  inline: string;
  skill?: SkillPart & { name?: string };
}

// Split a fragment file's text into its inline part and its optional skill
// part. `explicitName`: 'forbidden' for a seed or plugin fragment (its slug is
// the skill name), 'required' for a core. Throws on a malformed marker, a
// second marker, an empty description or an empty skill body. Without a marker
// the result is exactly `{ inline: text.replace(/\s+$/, '') }`.
export function splitSkillPart(text: string, { explicitName = 'forbidden' }: { explicitName?: 'forbidden' | 'required' } = {}): SplitFragment {
  const lines = text.split('\n');
  const at = lines.findIndex(l => SKILL_MARKER_START_RE.test(l));
  if (at === -1) return { inline: text.replace(/\s+$/, '') };
  const markerLine = lines[at].replace(/\s+$/, '');
  const m = SKILL_MARKER_RE.exec(markerLine);
  if (!m) throw new Error(`malformed skill marker '${markerLine}' (expected '<!-- cc:skill[:<name>] <description> -->')`);
  const rest = lines.slice(at + 1);
  const again = rest.find(l => SKILL_MARKER_START_RE.test(l));
  if (again !== undefined) throw new Error(`a second skill marker '${again.replace(/\s+$/, '')}' (one skill per fragment)`);
  const name = m[1];
  const description = (m[2] ?? '').trim();
  if (!description) throw new Error(`skill marker '${markerLine}' has an empty description`);
  if (name !== undefined && !SKILL_NAME_RE.test(name)) {
    throw new Error(`skill marker '${markerLine}': name '${name}' must match ${SKILL_NAME_RE.source}`);
  }
  if (explicitName === 'forbidden' && name !== undefined) {
    throw new Error(`skill marker '${markerLine}' names its skill, but only a core may — a fragment's skill is named by its slug`);
  }
  if (explicitName === 'required' && name === undefined) {
    throw new Error(`skill marker '${markerLine}' on a core must name its skill ('<!-- cc:skill:<name> <description> -->')`);
  }
  const body = rest.join('\n').replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
  if (!body) throw new Error(`skill marker '${markerLine}' is followed by an empty skill body`);
  const inline = lines.slice(0, at).join('\n').replace(/\s+$/, '');
  return { inline, skill: { ...(name !== undefined ? { name } : {}), description, body } };
}
