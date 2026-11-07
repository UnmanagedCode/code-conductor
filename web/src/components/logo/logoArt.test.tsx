// The knockout contract, on a synthetic art rather than the logo's drawing, for
// both renderers (the static-file builder and the React components): painter's
// order is kept, each knockout masks exactly what was drawn before it, a leading
// knockout is dropped, the mask region is the art's viewBox, and the base layer
// is drawn first, outside every mask. Also: the builder emits nothing animated.
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { Art, LogoElement } from './logoArt';

// Painted elements and knockouts are tagged by id (`e-<name>`) so the output can be read back.
const { FIXTURE } = vi.hoisted(() => {
  const shape = (id: string): LogoElement => ({ tag: 'rect', attrs: { id, width: '1', height: '1' }, ink: 'coral' });
  const ko = (id: string): LogoElement => ({ tag: 'rect', attrs: { id, width: '1', height: '1' }, ko: true });
  const art: Art = {
    viewBox: '3 4 50 60',
    base: [shape('e-base')],
    elements: [ko('e-lead'), shape('e-a'), shape('e-b'), ko('e-x'), shape('e-c'), ko('e-y'), shape('e-d')],
  };
  return { FIXTURE: art };
});
vi.mock('./logoArt', async (importOriginal) => ({ ...await importOriginal<typeof import('./logoArt')>(), MARK: FIXTURE }));

const { artToSvgString, iconSvg, lockupSvg, pwaIconSvg, PWA_ICONS } = await vi.importActual<typeof import('./logoArt')>('./logoArt');
const { LogoMark } = await import('./Logo');

/** The painted (non-mask) tagged elements under `svg`, in document order. */
const painted = (svg: Element) => [...svg.querySelectorAll('[id^="e-"]')].filter((e) => !e.closest('mask'));
/** The `<mask>` a `url(#id)` reference names, looked up inside `svg` only. */
const maskOf = (svg: Element, ref: string | null) => {
  const id = ref?.match(/^url\(#(.+)\)$/)?.[1];
  return [...svg.querySelectorAll('mask')].find((m) => m.id === id) ?? null;
};
/** The knockouts whose masked groups contain `el`, by tag, sorted. */
const knockoutsOver = (svg: Element, el: Element) => {
  const out: string[] = [];
  for (let a = el.parentElement; a && a !== svg.parentElement; a = a.parentElement) {
    if (!a.hasAttribute('mask')) continue;
    const mask = maskOf(svg, a.getAttribute('mask'));
    expect(mask, `${a.getAttribute('mask')} resolves inside its own SVG`).not.toBeNull();
    out.push(mask!.querySelector('[id^="e-"]')!.id);
  }
  return out.sort();
};

/** The knockout contract on one rendered `svg` of FIXTURE. */
function expectKnockouts(svg: Element) {
  // Painter's order, with the base first.
  expect(painted(svg).map((e) => e.id)).toEqual(['e-base', 'e-a', 'e-b', 'e-c', 'e-d']);
  // Each knockout masks exactly what was drawn before it; what follows draws unmasked on top.
  expect(Object.fromEntries(painted(svg).map((e) => [e.id, knockoutsOver(svg, e)]))).toEqual({
    'e-base': [], 'e-a': ['e-x', 'e-y'], 'e-b': ['e-x', 'e-y'], 'e-c': ['e-y'], 'e-d': [],
  });
  // A leading knockout cuts nothing and is dropped.
  expect(svg.querySelector('[id="e-lead"]')).toBeNull();
  // Each mask covers the art's viewBox, in user space.
  const masks = [...svg.querySelectorAll('mask')];
  expect(masks.map((m) => m.querySelector('[id^="e-"]')!.id).sort()).toEqual(['e-x', 'e-y']);
  const box = { x: '3', y: '4', width: '50', height: '60' };
  for (const m of masks) {
    expect(m.getAttribute('maskUnits')).toBe('userSpaceOnUse');
    const region = [...m.querySelectorAll('rect')].find((r) => !r.id)!;
    for (const el of [m, region]) {
      expect(Object.fromEntries(Object.keys(box).map((k) => [k, el.getAttribute(k)])), `${m.id} region`).toEqual(box);
    }
  }
}

const parse = (text: string) => {
  const host = document.createElement('div');
  host.innerHTML = text;
  return host;
};

describe('knockouts', () => {
  it('the static builder keeps painter\'s order, masks what precedes each knockout over the viewBox, drops a leading one and draws the base first', () => {
    // Invariant: artToSvgString's output follows the knockout contract, with or without a plate.
    expectKnockouts(parse(artToSvgString(FIXTURE, { palette: 'light', size: 10 })).querySelector('svg')!);
    const plated = parse(artToSvgString(FIXTURE, { palette: 'dark', size: 10, plate: { fill: '#000', art: 0.5, radius: 0.2 } }));
    expectKnockouts(plated.querySelector('svg svg')!);
  });

  it('the React renderer keeps painter\'s order, masks what precedes each knockout over the viewBox, drops a leading one and draws the base first', () => {
    // Invariant: Logo.tsx's output follows the same knockout contract as the builder.
    const { container } = render(<LogoMark />);
    expectKnockouts(container.querySelector('svg[data-logo]')!);
  });

  it('two logos on one page use disjoint mask ids, each reference resolving inside its own SVG', () => {
    // Invariant: React mask ids are per instance, so a second logo never borrows (or breaks) the first one's gaps.
    const { container } = render(<><LogoMark /><LogoMark blink /></>);
    const svgs = [...container.querySelectorAll('svg[data-logo]')];
    expect(svgs.length).toBe(2);
    for (const svg of svgs) expectKnockouts(svg);
    const ids = svgs.flatMap((svg) => [...svg.querySelectorAll('mask')].map((m) => m.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the static builder', () => {
  it('emits no <style> and nothing animated, for every art, palette and plate, and for every PWA icon', async () => {
    // Invariant: a static icon file is static whatever it draws, the blinking cursor included.
    const real = await vi.importActual<Record<string, unknown>>('./logoArt');
    const arts = Object.values(real).filter((v): v is Art => !!v && typeof v === 'object' && 'viewBox' in v && 'elements' in v);
    expect(arts.length, 'fixture check: the module exports arts').toBeGreaterThan(0);
    const texts = arts.flatMap((art) => (['light', 'dark'] as const).flatMap((palette) => [
      artToSvgString(art, { palette, size: 32 }),
      artToSvgString(art, { palette, size: 32, plate: { fill: '#000', art: 0.8, radius: 0.2 } }),
    ]));
    texts.push(iconSvg(), lockupSvg('light'), lockupSvg('dark'), ...Object.keys(PWA_ICONS).map((kind) => pwaIconSvg(kind as keyof typeof PWA_ICONS, 64)));
    for (const text of texts) {
      expect(text).not.toMatch(/<style/i);
      expect(text).not.toMatch(/animat/i);
    }
  });

  it('the favicons draw their face white, and the larger static art keeps the theme ink', async () => {
    // Invariant: FAV16 and FAV32_FAVICON each draw one white shape, the terminal face; FAV32, the PWA icons' art, draws nothing white.
    const { FAV16, FAV32, FAV32_FAVICON } = await vi.importActual<typeof import('./logoArt')>('./logoArt');
    // In the light palette the screen (#ffffff) and the ink (#15171c) differ, so a white shape is the screen face.
    const white = (art: Art) => [...parse(artToSvgString(art, { palette: 'light', size: 32 })).querySelectorAll('path, rect')]
      .filter((e) => !e.closest('mask') && e.getAttribute('fill') === '#ffffff');
    expect(white(FAV16).length, 'the 16px favicon draws one white shape, its face').toBe(1);
    expect(white(FAV32_FAVICON).length, 'the 32px favicon draws one white shape, its face').toBe(1);
    expect(white(FAV32), 'the PWA icon art draws nothing white').toEqual([]);
  });
});
