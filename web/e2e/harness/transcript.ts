// Gives a live session an on-disk transcript, so cc lists it as a disk row.
// fake-claude writes no transcript of its own.

import fs from 'node:fs/promises';
import path from 'node:path';
import { api } from './api.ts';
import type { Cc } from './boot.ts';

/**
 * Appends one user line to instance `instanceId`'s session jsonl, where cc reads its on-disk session list from
 * (Claude Code's cwd encoding). The file is named by the backing Claude session id, which the API withholds; the
 * store's sessions.json maps the public id to it (`.sessions[publicId].current`).
 */
export async function seedTranscript(cc: Pick<Cc, 'url' | 'dirs'>, instanceId: string, text: string): Promise<void> {
  const inst = ((await api<{ id: string; sessionId: string; cwd: string }[]>(cc, 'GET', '/api/instances')).body)
    .find((i) => i.id === instanceId);
  if (!inst) throw new Error(`no instance ${instanceId}`);
  const store = JSON.parse(await fs.readFile(path.join(cc.dirs.projects, '.code-conductor', 'sessions.json'), 'utf8'));
  const backing = store.sessions?.[inst.sessionId]?.current;
  if (!backing) throw new Error(`no backing id recorded for session ${inst.sessionId}`);
  const dir = path.join(cc.dirs.claudeProjects, inst.cwd.replace(/[^A-Za-z0-9-]/g, '-'));
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, `${backing}.jsonl`), JSON.stringify({
    type: 'user', message: { role: 'user', content: text }, sessionId: backing, timestamp: new Date().toISOString(),
  }) + '\n');
}
