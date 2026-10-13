// The keep-alive probe plugin (fixtures/keepalive-plugin) installed under any id,
// and its page's live counters read through page.frames(), shown or hidden: a
// per-load nonce (a reload makes a new one), interval ticks, WebSocket messages,
// requestAnimationFrame callbacks and, once its Start button ran, the microphone.
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Frame, type Page } from '@playwright/test';
import { api } from './api.ts';
import { FIXTURES, type Cc } from './boot.ts';

export type Mic = { readyState: string; ctxState: string; currentTime: number; rmsNonZero: number; polls: number };
export type Probe = { nonce: string; ticks: number; ws: number; raf: number; mic: Mic | null };
export type ProbePlugin = { id: string; name: string; keepAlive: boolean };

const FIXTURE = path.join(FIXTURES, 'keepalive-plugin');

/** Copies the probe plugin into the projects root as project `id` under this id, name and keep-alive, adopts it in place, rescans and enables it. */
export async function installProbePlugin(cc: Pick<Cc, 'url' | 'dirs'>, { id, name, keepAlive }: ProbePlugin): Promise<void> {
  const dir = path.join(cc.dirs.projects, id);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const mfPath = path.join(dir, 'conductor.plugin.json');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  Object.assign(mf, { id, name, frontend: { navLabel: name, keepAlive } });
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));
  const adopt = await api(cc, 'POST', '/api/projects/external', { name: id, path: dir });
  expect(adopt.body?.ok, `adopt ${id}: ${JSON.stringify(adopt.body)}`).toBeTruthy();
  await api(cc, 'POST', '/api/plugins/rescan');
  const enable = await api(cc, 'POST', `/api/plugins/${id}/enable`);
  expect(enable.status, `enable ${id}: ${JSON.stringify(enable.body)}`).toBeLessThan(300);
}

/** The frame serving plugin `id`, wherever it sits in the page. */
export const probeFrame = (page: Page, id: string): Frame | undefined => page.frames().find((f) => {
  try { return new URL(f.url()).pathname.startsWith(`/plugins/${id}/`); } catch { return false; }
});

/** Plugin `id`'s counters, or null while no frame serves it. */
export async function readProbe(page: Page, id: string): Promise<Probe | null> {
  const f = probeFrame(page, id);
  if (!f) return null;
  return f.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __probe?: Probe }).__probe ?? null)));
}
