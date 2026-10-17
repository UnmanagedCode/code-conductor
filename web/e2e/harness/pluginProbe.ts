// The keep-alive probe plugin (fixtures/keepalive-plugin) installed under any id,
// and its page's live counters read through page.frames(), shown or hidden: a
// per-load nonce (a reload makes a new one), interval ticks, WebSocket messages,
// requestAnimationFrame callbacks and, once its Start button ran, the microphone;
// the theme its page shows (readTheme) and its session width (readWidth).
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

export type FrameTheme = { dark: boolean; attr: string | null; atParse: string | null; bg: string; geist: boolean };

/** Plugin `id`'s theme as its page sees it: `.dark` and `data-cc-theme` on its <html>, the attribute when its head was parsed, its body's computed background, and whether the host-served Geist face loads; null while no frame serves it. */
export async function readTheme(page: Page, id: string): Promise<FrameTheme | null> {
  const f = probeFrame(page, id);
  if (!f) return null;
  return f.evaluate(async () => {
    const root = document.documentElement;
    const faces = await document.fonts.load('16px "Geist Variable"');
    return {
      dark: root.classList.contains('dark'),
      attr: root.getAttribute('data-cc-theme'),
      atParse: (window as unknown as { __themeAtParse?: string | null }).__themeAtParse ?? null,
      bg: getComputedStyle(document.body).backgroundColor,
      geist: faces.length > 0,
    };
  });
}

export type FrameWidth = { atParse: string | null; computed: string };

/** Plugin `id`'s `--cc-session-width` as its page sees it: the value on its <html> when its head was parsed, and the computed value now; null while no frame serves it. */
export async function readWidth(page: Page, id: string): Promise<FrameWidth | null> {
  const f = probeFrame(page, id);
  if (!f) return null;
  return f.evaluate(() => ({
    atParse: (window as unknown as { __widthAtParse?: string | null }).__widthAtParse ?? null,
    computed: getComputedStyle(document.documentElement).getPropertyValue('--cc-session-width').trim(),
  }));
}
