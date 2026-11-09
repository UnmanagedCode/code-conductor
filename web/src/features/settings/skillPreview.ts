// How a custom convention's body splits, for the Settings editor's preview.
// Parses with the server's own grammar (shared/skillPart.ts), so the preview
// shows what a save would store and deliver.

import { splitSkillPart } from '@shared/skillPart';
import type { ConventionScope } from './ConventionsSection';

export type SkillPreview =
  | { inline: string; skill?: { invocation: string; description: string; body: string } }
  | { error: string };

export function previewSkillPart(body: string, scope: ConventionScope, slug: string): SkillPreview {
  try {
    const split = splitSkillPart(body);
    if (!split.skill) return { inline: split.inline };
    return { inline: split.inline, skill: { invocation: `cc-custom-${scope}:${slug}`, description: split.skill.description, body: split.skill.body } };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
