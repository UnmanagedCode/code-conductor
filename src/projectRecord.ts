// The project record's stored shape and its one reader. `src/projects.ts` owns
// every write (`registerProject` / `writeProjectRecord`). A leaf below
// `src/systems/registry.ts`, which reads records through it.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { httpError } from './httpError.ts';
import { projectStoreDir } from './storeRoot.ts';
import { errCode, errMsg } from '../shared/basics.ts';

export const NAME_RE = /^[a-zA-Z0-9._-]+$/;

export function validateName(name: string): string {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw httpError(400, 'invalid project name (must match ^[a-zA-Z0-9._-]+$)');
  }
  // `.` and `..` pass NAME_RE (it has no positional rules) but they are PATH
  // TRAVERSAL, not names: `path.join(projectsRoot(), '..')` escapes the root
  // entirely, and every caller that follows treats what it gets back as a
  // project directory it may write into or REMOVE — deleteProject would
  // recursively delete the projects root's parent. Refused here, in the one
  // function every name-taking entry point already funnels through, rather
  // than at each of them. Dot-LEADING names stay legal: `.conduct` is one.
  if (name === '.' || name === '..') {
    throw httpError(400, `invalid project name '${name}' (a dot-only name is a path traversal, not a project)`);
  }
  return name;
}

// WHERE A PROJECT LIVES — the one stored answer, and the presence of it in
// `<store>/projects/<name>/project.json` IS the registration. There is no
// second artefact (no in-root directory, no symlink) for any kind of project.
export type ProjectLocation =
  | { kind: 'local'; path: string }
  | { kind: 'remote'; system: string; remoteId: string | null; path: string };

export interface ProjectRecord {
  workspace: string | null;
  location: ProjectLocation;
}

export function recordFile(name: string): string {
  return path.join(projectStoreDir(name), 'project.json');
}

export function malformed(file: string, why: string): Error {
  return httpError(500, `project record ${file} is malformed: ${why} — repair the file, or remove the project's store directory to unregister it.`);
}

// Read the project's record. `null` means NOT REGISTERED (no file).
//
// A file that exists and cannot be understood THROWS. Degrading it to an empty
// record — which is what this did when an in-root directory registered a
// project independently — would now silently unregister a live project, so the
// refusal is loud and its status is 500, never 404.
export async function readProjectRecord(name: string): Promise<ProjectRecord | null> {
  validateName(name);
  const file = recordFile(name);
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (e) {
    if (errCode(e) === 'ENOENT') return null;
    throw malformed(file, errMsg(e));
  }
  let obj: unknown;
  try { obj = JSON.parse(raw); }
  catch (e) { throw malformed(file, errMsg(e)); }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw malformed(file, 'the record is not a JSON object');
  }
  const rec = obj as { workspace?: unknown; location?: unknown };
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const loc = rec.location;
  if (typeof loc !== 'object' || loc === null || Array.isArray(loc)) {
    throw malformed(file, 'it has no `location`');
  }
  const l = loc as { kind?: unknown; system?: unknown; remoteId?: unknown; path?: unknown };
  const p = str(l.path);
  if (!p) throw malformed(file, 'its `location` has no `path`');
  if (l.kind === 'local') {
    return { workspace: str(rec.workspace), location: { kind: 'local', path: p } };
  }
  if (l.kind === 'remote') {
    const system = str(l.system);
    if (!system) throw malformed(file, 'a remote `location` names no `system`');
    return {
      workspace: str(rec.workspace),
      location: { kind: 'remote', system, remoteId: str(l.remoteId), path: p },
    };
  }
  throw malformed(file, `unknown location kind ${JSON.stringify(l.kind)}`);
}
