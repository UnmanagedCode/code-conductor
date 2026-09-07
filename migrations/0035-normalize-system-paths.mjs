// `systemPath` used to be stored exactly as the caller typed it — trimmed, and
// checked absolute, but never normalised. So `/srv/app/`, `/srv/app` and
// `/srv/./app` were three records for one directory.
//
// That is not cosmetic. The stored string IS the CLI's working directory for a
// worker on that project, and the transcript-directory guard compares
// `encodeCwd(cwd)` — so two spellings of one directory encoded differently, did
// not collide, and both got registered. Their sessions then interleave in one
// `~/.claude/projects/<...>` directory with nothing able to tell them apart.
// The adopt-side duplicate check had the same hole from the other side: it
// compares the stored raw string against a `realpath`-normalised one.
//
// The write path is fixed (`normalizeSystemPath`, src/projects.ts). This closes
// the rows written before it, rather than grandfathering them into silent
// transcript sharing.
//
// IT DOES NOT MERGE ANYTHING. If normalising makes two records collide, they
// are ALREADY sharing a transcript directory — the migration is what makes that
// visible. Both are normalised and the pair is NAMED in the log, because
// picking which project to re-register is the operator's call and not a
// migration's.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const name = '0035-normalize-system-paths';

const STORE = '.code-conductor';

// POSIX, always: this is a path on the SYSTEM's filesystem, which the protocol
// fixes at `/`. Kept literal here rather than imported — a migration must stay
// faithful to the world it was written for.
function normalize(p) {
  const n = path.posix.normalize(p);
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

// The CLI's transcript-directory name. Same collapse cc's `encodeCwd` performs;
// duplicated on purpose, for the same reason as `normalize`.
function encodeCwd(abs) {
  return abs.replace(/[^A-Za-z0-9-]/g, '-');
}

export async function run({ root, log = console.log }) {
  const projectsDir = path.join(root, STORE, 'projects');
  let names;
  try {
    names = (await fs.readdir(projectsDir, { withFileTypes: true }))
      .filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return { applied: false };   // no project records at all
  }

  const changed = [];
  const byEncoded = new Map();
  for (const project of names.sort()) {
    const file = path.join(projectsDir, project, 'project.json');
    let rec;
    try { rec = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch { continue; }          // absent or unparsable is not this migration's business
    if (!rec || typeof rec !== 'object' || typeof rec.systemPath !== 'string') continue;

    const next = normalize(rec.systemPath);
    if (next !== rec.systemPath) {
      // PER RECORD, AND IT MUST NOT ABORT THE BOOT. A migration that throws
      // stops cc from starting at all — `runMigrations` has no try/catch and
      // `server.ts` awaits it unguarded — so a `chmod 500` project directory, a
      // full disk or a read-only mount would leave a user with an orchestrator
      // that will not come up and a log line to decipher. The record is NAMED
      // and the sweep continues; the row keeps its old spelling and is caught
      // the next time this runs. Same rule as 0033's own move loop.
      try {
        // tmp + rename, so a crash mid-write cannot leave a half-written record
        // where a readable one was.
        const tmp = `${file}.tmp.${process.pid}`;
        await fs.writeFile(tmp, JSON.stringify({ ...rec, systemPath: next }, null, 2));
        await fs.rename(tmp, file);
        changed.push({ project, from: rec.systemPath, to: next });
      } catch (e) {
        log(`migration ${name}: could not normalise ${project}'s systemPath `
          + `('${rec.systemPath}' -> '${next}'): ${e.message}`);
        continue;
      }
    }
    // KEYED ON THE ENCODED PATH ALONE, NOT ON (system, path). The Claude CLI
    // names its transcript directory from the working directory and NOTHING
    // ELSE, so the directory does not belong to a system: `/srv/app` on two
    // different systems, or on two targets of one system, is exactly the pair
    // that shares one directory from the first spawn after this upgrade.
    // Keying by system put those in separate buckets and never named them,
    // leaving the migration silent about the only sharing an upgrading user
    // ALREADY has. The record carries the system id so the report can name both
    // sides of the pair.
    const key = encodeCwd(next);
    byEncoded.set(key, [...(byEncoded.get(key) ?? []), `${project} (on '${rec.system ?? 'local'}')`]);
  }

  // Reported, never resolved. A pair here was already sharing one transcript
  // directory before this ran; normalising only stopped it being invisible.
  const shared = [...byEncoded.values()].filter(v => v.length > 1);
  for (const group of shared) {
    log(`migration ${name}: projects ${group.join(', ')} share one Claude CLI transcript directory. `
      + 'Their sessions interleave in it and cannot be told apart. Re-register one of them at a '
      + 'different path; cc will not pick for you.');
  }

  if (changed.length === 0 && shared.length === 0) return { applied: false };
  if (changed.length) {
    log(`migration ${name}: normalised ${changed.length} systemPath record(s) — `
      + changed.map(c => `${c.project}: '${c.from}' → '${c.to}'`).join('; '));
  }
  return { applied: true, summary: { normalized: changed.length, sharing: shared.length } };
}
