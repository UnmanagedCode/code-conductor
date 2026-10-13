// Seeds a session's lineage on disk — one jsonl per backing segment plus the
// session's row in the store's sessions.json — and resumes it, so cc serves a
// real multi-segment walk. The fake engine writes no transcript of its own.

import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { api, LIVE_WORKER_MODEL } from './api.ts';
import type { Cc } from './boot.ts';

export type SeedRecord = Record<string, unknown>;
export type SeedSegment = {
  id: string;
  reason: 'initial' | 'renew' | 'prune';
  records: SeedRecord[];
  /** A tombstone: the row keeps the entry, the walk marks its content gone. */
  dropped?: boolean;
};

/** `n` prompt/reply turns: user `<tag> prompt <i>`, assistant `<tag> reply <i>`. */
export function seedTurns(tag: string, n: number): SeedRecord[] {
  const out: SeedRecord[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ type: 'user', uuid: `${tag}-u${i}`, message: { role: 'user', content: `${tag} prompt ${i}` } });
    out.push({ type: 'assistant', uuid: `${tag}-a${i}`, message: { id: `${tag}-m${i}`, role: 'assistant', content: [{ type: 'text', text: `${tag} reply ${i}` }] } });
  }
  return out;
}

/**
 * Writes `segments` (oldest first; the newest live one is current) as session `publicId` of `project`, then
 * resumes it. Returns the resumed instance.
 */
export async function resumeSeeded(
  cc: Pick<Cc, 'url' | 'dirs' | 'engine'>, project: string, publicId: string, segments: SeedSegment[],
): Promise<{ id: string; sessionId: string }> {
  // Claude Code's cwd encoding, as harness/transcript.ts writes it.
  const cwd = fs.realpathSync(path.join(cc.dirs.projects, project));
  const dir = path.join(cc.dirs.claudeProjects, cwd.replace(/[^A-Za-z0-9-]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  for (const s of segments) {
    fs.writeFileSync(path.join(dir, `${s.id}.jsonl`), s.records.map((r) => JSON.stringify({ sessionId: s.id, ...r })).join('\n') + '\n');
  }
  const store = path.join(cc.dirs.projects, '.code-conductor', 'sessions.json');
  const sessions = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')).sessions ?? {} : {};
  const live = segments.filter((s) => !s.dropped);
  sessions[publicId] = {
    current: live[live.length - 1].id,
    segments: segments.map((s, i) => ({ id: s.id, reason: s.reason, at: new Date(Date.UTC(2026, 8, 1 + i)).toISOString(), ...(s.dropped ? { dropped: true } : {}) })),
  };
  fs.mkdirSync(path.dirname(store), { recursive: true });
  // A rename, so the store's stat-validated cache sees one whole write.
  fs.writeFileSync(`${store}.seed`, JSON.stringify({ sessions }, null, 2) + '\n');
  fs.renameSync(`${store}.seed`, store);
  const r = await api(cc, 'POST', '/api/instances', {
    project, mode: 'bypassPermissions', resume: publicId, ...(cc.engine === 'live' ? { model: LIVE_WORKER_MODEL } : {}),
  });
  expect(r.status, `resume ${publicId}: ${JSON.stringify(r.body)}`).toBe(201);
  return r.body as { id: string; sessionId: string };
}
