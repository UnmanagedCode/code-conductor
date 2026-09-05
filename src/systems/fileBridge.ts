// Pull-then-push: how one hooked file tool crosses the machine boundary.
//
// IT IS NOT PATH REWRITING, and that is the whole design. The Claude CLI runs
// Read/Write/Edit itself, on cc's machine, so a rewritten `/app/...` is a local
// ENOENT — and `Edit`'s `old_string` is validated against the PRE-hook path
// before `PreToolUse` fires at all, so a rewriting build fails with the hook
// never running. Measured, both of them.
//
// So the bridge materialises the system's bytes at the local path the CLI is
// about to open (PULL, in PreToolUse), lets the tool run unmodified, and writes
// the local result back afterwards (PUSH, in PostToolUse).
//
// PULL BEFORE EVERY FILE OP, INCLUDING EDIT. That is what makes the mixed case
// safe — a worker that runs `sed -i` through Bash and then Edits the same file
// is the normal case, not the exotic one — and it is why there is no read cache
// here to go stale: one round trip per file op, always fresh, is both simpler
// and cheaper than a cache plus the per-turn stat sweep needed to trust it.
//
// A FAILED PUSH IS LOUD AND STICKY. The local file then holds content the
// system does not, and the worker has no way to see that. The path is marked
// diverged and the layer above refuses later writes to it, naming the file, so
// the divergence surfaces as a refusal instead of as a wrong belief.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SessionPathMap } from './sessionRoot.ts';
import type { System } from './system.ts';

// A hooked file op carries whole-file content across the wire in both
// directions, so the cap is about a cross-machine round trip, not about disk.
// Over it the tool is REFUSED rather than truncated: a truncated pull would let
// the following Edit push a file back with its tail cut off.
export const SESSION_FILE_CAP_BYTES = 1024 * 1024;

export type PullOutcome =
  | { kind: 'pulled'; localPath: string }
  // The system does not have this path. A VALUE, not an error: it is how a
  // Write to a new file, and a Read of something genuinely missing, both look.
  | { kind: 'absent' }
  | { kind: 'refused'; reason: string };

export class FileBridge {
  readonly #system: System;
  #map: SessionPathMap;
  // Local path → why it diverged. Set by a failed push, cleared by a pull that
  // resyncs the local copy from the system.
  readonly #diverged = new Map<string, string>();
  // Local path → the mode its system counterpart had at the last pull, so a
  // push can put it back. An atomic write ends in a rename, which would
  // otherwise hand an edited script a fresh 0644 and strip its executable bit.
  readonly #modes = new Map<string, number>();

  constructor(system: System, map: SessionPathMap) {
    this.#system = system;
    this.#map = map;
  }

  isDirty(localPath: string): boolean { return this.#diverged.has(localPath); }
  dirtyReason(localPath: string): string | null { return this.#diverged.get(localPath) ?? null; }

  // THE GEOMETRY MOVED. Every key in the two maps below is a LOCAL path, and a
  // mirror advertisement that moves changes every one of them — so a retarget
  // that only swapped the map would silently forget a "your write never landed"
  // refusal and let the next Write through. Keys are carried across through the
  // SYSTEM path, which is what did not move: old local → system → new local.
  //
  // An entry the new geometry does not address is DROPPED rather than kept under
  // a stale key: a marker no `classify` can ever reach again is a leak that
  // grows for the life of the session.
  //
  // NOT a claim that the local bytes survived — `resetRoot` deleted the whole
  // image root before this runs. What survives is the REFUSAL, which is the part
  // the worker needs (card 2026-0279).
  retarget(next: SessionPathMap, prev: SessionPathMap): void {
    const move = <T>(m: Map<string, T>): void => {
      const out = new Map<string, T>();
      for (const [local, v] of m) {
        const sys = prev.toSystem(local);
        const to = sys === null ? null : next.toLocal(sys);
        if (to !== null) out.set(to, v);
      }
      m.clear();
      for (const [k, v] of out) m.set(k, v);
    };
    move(this.#diverged);
    move(this.#modes);
    this.#map = next;
  }

  // Materialise the system's copy at `localPath`. Absence DELETES any local
  // copy: a stale one is the boundary leak that makes Read answer about a file
  // Bash says is gone.
  async pull(localPath: string): Promise<PullOutcome> {
    const remote = this.#require(localPath, 'pull');
    const st = await this.#system.stat(remote);
    if (st === null || st.kind === 'dir') {
      await fs.rm(localPath, { force: true });
      this.#modes.delete(localPath);
      this.#diverged.delete(localPath);
      return { kind: 'absent' };
    }
    if (st.size > SESSION_FILE_CAP_BYTES) {
      return { kind: 'refused', reason: `${remote} is ${st.size} bytes, over the ${SESSION_FILE_CAP_BYTES}-byte cap for a file carried across the system boundary` };
    }
    const buf = await this.#system.readFileBytes(remote);
    // A NUL byte is the same test `grep -I` and git use, and it is the one that
    // matters here: the push side carries UTF-8 text, so anything that is not
    // text would come back mangled.
    if (buf.includes(0)) {
      return { kind: 'refused', reason: `${remote} is binary, and cc carries only text across the system boundary` };
    }
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, buf);
    this.#modes.set(localPath, st.mode);
    // The local copy now IS the system's copy, so whatever diverged is gone.
    this.#diverged.delete(localPath);
    return { kind: 'pulled', localPath };
  }

  // Write the local result back to the system. Throws on failure, having marked
  // the path diverged first — the caller turns that into a visible error, and
  // every later write to the path is refused until a pull resyncs it.
  async push(localPath: string): Promise<void> {
    const remote = this.#require(localPath, 'push');
    try {
      const buf = await fs.readFile(localPath);
      if (buf.length > SESSION_FILE_CAP_BYTES) {
        throw new Error(`${buf.length} bytes is over the ${SESSION_FILE_CAP_BYTES}-byte cap for a file carried across the system boundary`);
      }
      const mode = this.#modes.get(localPath);
      // `atomic` is not only about torn reads here: a rename replaces a symlink
      // rather than writing through it, which is what keeps a write to a linked
      // path from landing on whatever it points at.
      await this.#system.writeFile(remote, buf.toString('utf8'), { atomic: true, ...(mode === undefined ? {} : { mode }) });
    } catch (e) {
      const why = `the edit to ${localPath} did not reach ${remote}: ${e instanceof Error ? e.message : String(e)}`;
      this.#diverged.set(localPath, why);
      throw new Error(why, { cause: e });
    }
  }

  #require(localPath: string, op: string): string {
    const v = this.#map.classify(localPath);
    // BOTH are cc's own bug, never a worker's: the layer above decides what is
    // mapped and refuses everything else by name, so reaching here means it let
    // through a path with no counterpart or one the provider said not to carry.
    if (v.kind === 'outside') {
      throw new Error(`fileBridge.${op}: ${localPath} is outside the session root ${this.#map.root}`);
    }
    if (v.kind === 'excluded') {
      throw new Error(`fileBridge.${op}: ${v.systemPath} is under '${v.excludedBy}', which this system excludes from file mirroring`);
    }
    return v.systemPath;
  }
}
