// A temp copy of the shipped `conventions/` tree for CC_CONVENTIONS_DIR
// (src/conventionsDir.ts), so a test can put skill parts into fragments without
// a fixture shipping in the repo.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './tmpRegistry.mjs';
import { splitSkillPart } from '../shared/skillPart.ts';

export const SHIPPED_CONVENTIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'conventions');
export const SCOPES = ['conductor', 'workspace', 'project'];

// The fragment files of one scope dir, by kind. `footer.md` is conductor-only
// and never split.
export async function scopeFiles(root, scope) {
  return (await fs.readdir(path.join(root, scope))).filter(f => f.endsWith('.md')).sort();
}

// Copy the shipped tree. `{ stripSkills: true }` rewrites every fragment that
// carries a skill part to its inline part alone, so a test that needs "no skill
// in force" holds whatever markers the shipped tree comes to carry.
export async function copyConventions({ stripSkills = false } = {}) {
  const root = path.join(await mkdtemp('cc-conventions-'), 'conventions');
  await fs.cp(SHIPPED_CONVENTIONS, root, { recursive: true });
  if (stripSkills) {
    for (const scope of SCOPES) {
      for (const f of await scopeFiles(root, scope)) {
        if (f === 'footer.md') continue;
        const file = path.join(root, scope, f);
        const raw = await fs.readFile(file, 'utf8');
        const split = splitSkillPart(raw, { explicitName: f === 'core.md' ? 'required' : 'forbidden' });
        if (split.skill) await fs.writeFile(file, `${split.inline}\n`);
      }
    }
  }
  return root;
}

// Append a skill part to one fragment of a copied tree. `name` only for a core.
export async function addSkill(root, scope, file, { name, description, body }) {
  const target = path.join(root, scope, file);
  const marker = `<!-- cc:skill${name ? `:${name}` : ''} ${description} -->`;
  await fs.appendFile(target, `\n${marker}\n\n${body}\n`);
}

// Point the scope modules at `root` until the returned restore runs.
export function useConventionsDir(root) {
  const prev = process.env.CC_CONVENTIONS_DIR;
  process.env.CC_CONVENTIONS_DIR = root;
  return () => {
    if (prev === undefined) delete process.env.CC_CONVENTIONS_DIR;
    else process.env.CC_CONVENTIONS_DIR = prev;
  };
}
