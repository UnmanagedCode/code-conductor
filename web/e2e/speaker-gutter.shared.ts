// Where a finished text block's read-aloud sits, measured in a real browser on the fake engine's
// speaker scenario (fixtures/scenario-speaker-gutter.json): at `md` and up, every block but the
// bubble's first holds it in the avatar gutter, level with the block's first line; below `md`, and
// for the first block, it sits after the block's last word and adds no line, unless the block ends
// in a code block, which keeps it on a row of its own. Its icon keeps one size everywhere.
// The bodies are shared by the per-project spec files; this module declares no tests.
import type { Locator, Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { createProject } from './harness/api.ts';
import { next } from './flows/ui.ts';
import { speechSeam } from './conversation-bubbles.shared.ts';

type Args = { page: Page; cc: Cc };

/** One bubble of five text blocks, each but the last followed by a Bash call. */
const LAYOUT = 'SPEAK-LAYOUT';
/** One bubble whose first block is a code block, then a one-line block. */
const CODE_FIRST = 'SPEAK-CODE-FIRST';
/** Each of the layout bubble's blocks, by a phrase only it holds. */
const A = 'Checking the layout now.';
const B = 'One short line.';
const C = 'First paragraph of the wrapping segment.';
const L = 'Next steps:';
const D = 'Here is the command:';

/** Edges match within EDGE px, centres within MID px. */
const EDGE = 2;
const MID = 3;

const fakeOnly = (cc: Cc) => test.skip(cc.engine === 'live', "the flows drive the fake engine's speaker scenario");
const isDesktop = () => test.info().project.name === 'desktop';

const block = (page: Page, phrase: string) => next.transcript(page).locator('[data-item=assistant] [data-text-block]').filter({ hasText: phrase });
const speakerIn = (b: Locator) => b.getByRole('button', { name: /^(Read aloud|Stop reading)$/ });

/** Starts a session in a new project named for `what`, with a read-aloud voice, and runs `prompt`'s turn to its end. */
async function run(page: Page, cc: Cc, what: string, prompt: string): Promise<void> {
  const project = `speaker-${what}-${test.info().project.name}`;
  await createProject(cc, project);
  // Read-aloud needs a Piper voice installed; the page is told one is.
  await page.route('**/api/tts/status', (route) => route.fulfill({ json: { available: true } }));
  await next.open(page);
  await next.startSessionIn(page, project);
  await next.sendPrompt(page, prompt);
  await expect(next.turnEnds(page), 'fixture check: the turn ran to its end').toHaveCount(1);
}

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };
type Measure = {
  end: string | null;
  gutter: boolean;
  block: Box;
  inset: Box;
  body: Box;
  avatar: Box | null;
  button: Box;
  svg: Box;
  lineHeight: number;
  /** The first text line of the block's first markdown element. */
  firstLine: Box;
  /** The element the inline slot sits in, and its own text lines; null when the control has no inline slot. */
  host: { box: Box; lines: Box[] } | null;
  /** The block's last code block, if any. */
  codeWrap: Box | null;
  /** The control is what a tap at its centre lands on. */
  hit: boolean;
};

/** Scrolls the block's control to the middle of the viewport and measures the block, its control and its lines. */
async function measure(b: Locator): Promise<Measure> {
  await expect(speakerIn(b), 'fixture check: the block holds one read-aloud').toHaveCount(1);
  return b.evaluate((el): Measure => {
    const box = (r: DOMRect): Box => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height });
    const button = [...el.querySelectorAll('button')].find((x) => /^(Read aloud|Stop reading)$/.test(x.getAttribute('aria-label') ?? ''))!;
    button.scrollIntoView({ block: 'center' });
    /** Text lines of `host`, the control excluded: its text nodes' rects, merged per line. */
    const lines = (host: Element): Box[] => {
      const rects: DOMRect[] = [];
      const walk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (button.contains(n) || !n.textContent!.trim()) continue;
        const r = document.createRange();
        r.selectNodeContents(n);
        rects.push(...r.getClientRects());
      }
      const out: Box[] = [];
      for (const r of rects.sort((p, q) => p.top - q.top)) {
        const line = out.find((l) => Math.abs(l.top - r.top) < 4);
        if (!line) { out.push(box(r)); continue; }
        line.left = Math.min(line.left, r.left);
        line.right = Math.max(line.right, r.right);
        line.bottom = Math.max(line.bottom, r.bottom);
        line.width = line.right - line.left;
        line.height = line.bottom - line.top;
      }
      return out;
    };
    const bubble = el.closest('[data-item=assistant]')!;
    const md = el.querySelector('.md')!;
    const host = button.closest('span[data-speak-slot]')?.parentElement ?? null;
    const codeWraps = el.querySelectorAll('.md-code-wrap');
    const b = button.getBoundingClientRect();
    const at = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
    const avatar = bubble.querySelector(':scope > [data-assistant-avatar]');
    return {
      end: el.getAttribute('data-speak-end'),
      gutter: el.hasAttribute('data-speak-gutter'),
      block: box(el.getBoundingClientRect()),
      inset: box(el.firstElementChild!.getBoundingClientRect()),
      body: box(bubble.querySelector(':scope > [data-assistant-body]')!.getBoundingClientRect()),
      avatar: avatar ? box(avatar.getBoundingClientRect()) : null,
      button: box(b),
      svg: box(button.querySelector('svg')!.getBoundingClientRect()),
      lineHeight: parseFloat(getComputedStyle(md).lineHeight),
      firstLine: lines(md.firstElementChild!)[0],
      host: host ? { box: box(host.getBoundingClientRect()), lines: lines(host) } : null,
      codeWrap: codeWraps.length ? box(codeWraps[codeWraps.length - 1].getBoundingClientRect()) : null,
      hit: !!at && button.contains(at),
    };
  });
}

const midY = (r: Box) => (r.top + r.bottom) / 2;
const midX = (r: Box) => (r.left + r.right) / 2;
/** `actual` is within `tol` px of `expected`. */
const expectNear = (actual: number, expected: number, tol: number, msg: string) =>
  expect(Math.abs(actual - expected), `${msg}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tol);
const intersects = (p: Box, q: Box) => p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom;

/** The control sits after the host's last word, inside its last line, and the host is exactly as tall as its text lines. */
function expectAfterLastWord(m: Measure, what: string) {
  expect(m.end, `${what}: ends inline`).toBe('inline');
  expect(m.host, `${what}: the control has an inline slot`).not.toBeNull();
  const last = m.host!.lines.at(-1)!;
  expect(m.button.left, `${what}: the control starts right after the last word`).toBeGreaterThanOrEqual(last.right - EDGE);
  expect(m.button.left, `${what}: the control starts right after the last word`).toBeLessThanOrEqual(last.right + 10);
  expect(midY(m.button), `${what}: the control is inside the last line`).toBeGreaterThanOrEqual(last.top - MID);
  expect(midY(m.button), `${what}: the control is inside the last line`).toBeLessThanOrEqual(last.bottom + MID);
  expectNear(m.host!.box.height, m.host!.lines.length * m.lineHeight, EDGE, `${what}: the control adds no line (${m.host!.lines.length} text lines)`);
}

/** The control is centred on the avatar's centre line, clear of the body, level with the block's first line, and adds no row. */
function expectInGutter(m: Measure, what: string) {
  expect(m.gutter, `${what}: marked for the gutter`).toBe(true);
  expect(m.avatar, 'fixture check: the bubble has an avatar').not.toBeNull();
  expectNear(midX(m.button), midX(m.avatar!), 1, `${what}: centred on the avatar's centre`);
  expect(m.button.right, `${what}: clear of the body`).toBeLessThanOrEqual(m.body.left);
  expectNear(midY(m.button), midY(m.firstLine), MID, `${what}: level with the first line`);
  expectNear(m.block.height, m.inset.height, EDGE, `${what}: the block is as tall as its prose`);
  expect(m.hit, `${what}: a tap at the control's centre lands on it`).toBe(true);
}

async function screenshot(page: Page, name: string) {
  await test.info().attach(name, { body: await page.screenshot({ fullPage: false }), contentType: 'image/png' });
}

export async function gutterFlow({ page, cc }: Args): Promise<void> {
  // Invariant: at md and up, every block but the bubble's first holds its read-aloud centred on the avatar, level with its first line and adding no row, whatever the block ends in (prose, a wrapped paragraph, a list, a code block); the first block holds it after its last word, clear of the avatar; Tab from the call before a block reaches that block's control, with a visible focus.
  test.skip(!isDesktop(), 'the gutter exists only at md and up');
  fakeOnly(cc);
  await run(page, cc, 'gutter', LAYOUT);

  for (const phrase of [B, C, L, D]) {
    const m = await measure(block(page, phrase));
    expectInGutter(m, phrase);
    if (phrase === C) {
      const last = m.host!.lines.at(-1)!;
      expect(m.host!.lines.length, 'fixture check: the wrapping paragraph wraps').toBeGreaterThanOrEqual(3);
      expect(m.button.bottom, 'the control is level with the first line, above the last').toBeLessThanOrEqual(last.top);
    }
  }
  expect((await measure(block(page, D))).end, 'fixture check: the code-ending block is on a row').toBe('row');

  const a = await measure(block(page, A));
  expect(a.gutter, 'the first block stays out of the gutter').toBe(false);
  expect(intersects(a.button, a.avatar!), 'the first block\'s control clears the avatar').toBe(false);
  expectAfterLastWord(a, A);
  expectNear(a.block.height, a.lineHeight, EDGE, 'the one-line first block is one line tall');
  expect(a.hit, 'a tap at the first block\'s control lands on it').toBe(true);

  const bubble = next.transcript(page).locator('[data-item=assistant]').filter({ hasText: C });
  await bubble.locator('[data-group-trigger]').nth(1).focus();
  await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    return { label: el.getAttribute('aria-label'), block: el.closest('[data-text-block]')?.textContent ?? '', visible: el.matches(':focus-visible') };
  });
  expect(focus.label, 'Tab from the call before the wrapping block reaches a read-aloud').toBe('Read aloud');
  expect(focus.block, 'it is that block\'s').toContain(C);
  expect(focus.visible, 'its focus is visible').toBe(true);
  await screenshot(page, 'speaker-gutter-desktop');
}

export async function codeFirstFlow({ page, cc }: Args): Promise<void> {
  // Invariant: a bubble's first block ending in a code block keeps its read-aloud on a row of its own under the code, inside the body, never in the gutter.
  fakeOnly(cc);
  await run(page, cc, 'code-first', CODE_FIRST);
  const m = await measure(block(page, 'npm test'));
  expect(m.end, 'the code-ending first block is on a row').toBe('row');
  expect(m.gutter, 'the first block stays out of the gutter').toBe(false);
  expect(m.codeWrap, 'fixture check: the block renders its code').not.toBeNull();
  expect(m.button.top, 'the row is under the code').toBeGreaterThanOrEqual(m.codeWrap!.bottom - EDGE);
  expect(m.button.left, 'the row is inside the body').toBeGreaterThanOrEqual(m.body.left - EDGE);
}

export async function inlineEndFlow({ page, cc }: Args): Promise<void> {
  // Invariant: below md every block ending in prose (a line, a wrapped paragraph, a list) holds its read-aloud after its last word, inside the body, adding no line; a block ending in code keeps a row under it; a tap on the wrapping block's control reads that block.
  test.skip(isDesktop(), 'below md only');
  fakeOnly(cc);
  const bodies = await speechSeam(page);
  await run(page, cc, 'inline-end', LAYOUT);

  for (const phrase of [A, B]) {
    const m = await measure(block(page, phrase));
    expectAfterLastWord(m, phrase);
    expectNear(m.block.height, m.lineHeight, EDGE, `${phrase}: the one-line block is one line tall`);
    expect(m.button.left, `${phrase}: inside the body`).toBeGreaterThanOrEqual(m.body.left);
  }
  const c = await measure(block(page, C));
  expect(c.host!.lines.length, 'fixture check: the last paragraph wraps').toBeGreaterThanOrEqual(2);
  expectAfterLastWord(c, C);
  expect(c.button.left, 'the wrapping block\'s control is inside the body').toBeGreaterThanOrEqual(c.body.left);
  const l = await measure(block(page, L));
  expectAfterLastWord(l, L);
  expect(l.button.left, 'the list block\'s control is inside the body').toBeGreaterThanOrEqual(l.body.left);
  const d = await measure(block(page, D));
  expect(d.end, 'the code-ending block is on a row').toBe('row');
  expect(d.button.top, 'the row is under the code').toBeGreaterThanOrEqual(d.codeWrap!.bottom - EDGE);
  await screenshot(page, `speaker-inline-${test.info().project.name}`);

  await speakerIn(block(page, C)).click();
  await expect.poll(() => bodies.length, { message: 'the tap reached the speech seam' }).toBe(1);
  expect(bodies[0], 'it reads the wrapping block').toMatch(/wrapping segment/);
  expect(bodies[0], 'and not the block before it').not.toMatch(/One short line/);
}

export async function iconSizeFlow({ page, cc }: Args): Promise<void> {
  // Invariant: every read-aloud keeps one visual size wherever it sits: a 14px icon on a 28px button.
  fakeOnly(cc);
  await run(page, cc, 'icon-size', LAYOUT);
  for (const phrase of [A, B, C, L, D]) {
    const m = await measure(block(page, phrase));
    for (const [side, px] of [['width', m.svg.width], ['height', m.svg.height]] as const) expectNear(px, 14, 0.5, `${phrase}: the icon's ${side}`);
    for (const [side, px] of [['width', m.button.width], ['height', m.button.height]] as const) expectNear(px, 28, 0.5, `${phrase}: the button's ${side}`);
  }
}
