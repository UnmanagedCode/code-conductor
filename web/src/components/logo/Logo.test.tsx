// The logo's renderers on the real arts: only a blinking mark animates, and only
// its cursor; no variant (the lockup included) ships a <style>; the pictures are named. Knockout
// structure is pinned on a synthetic art in logoArt.test.tsx.
import { afterEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { LogoLockup, LogoMark, LogoSmall, LogoTile, Wordmark } from './Logo';

/** Every element under `root` (itself included) whose class names an animation. */
const animated = (root: Element) => [root, ...root.querySelectorAll('*')].filter((e) => /\banimate-/.test(e.getAttribute('class') ?? ''));
const VARIANTS = [
  ['a still mark', <LogoMark />], ['the tile', <LogoTile />], ['the small mark', <LogoSmall />], ['the wordmark', <Wordmark />], ['the lockup', <LogoLockup />],
] as const;
/** The app's fixed coral and deep, and the theme ink every picture's dark parts follow. */
const CORAL = '#f07456';
const DEEP = '#c8482c';
const INK = 'var(--logo-ink)';

describe('Logo', () => {
  it('a blinking mark animates its cursor alone, and stills it under reduced motion', () => {
    // Invariant: blink puts the blink animation and its motion-reduce off-switch on the cursor element, and on nothing else.
    const { container } = render(<LogoMark blink />);
    const svg = container.querySelector('svg[data-logo="mark"]')!;
    const cursor = svg.querySelector('[data-logo-cursor]')!;
    expect(cursor.classList.contains('animate-cursor-blink')).toBe(true);
    expect(cursor.classList.contains('motion-reduce:animate-none')).toBe(true);
    expect(animated(svg)).toEqual([cursor]);
  });

  it.each(VARIANTS)('%s carries no animation class anywhere', (_, el) => {
    // Invariant: a static placement has no animation at all, not one that reduced motion switches off.
    const { container } = render(el);
    expect(container.querySelector('svg[data-logo]'), 'fixture check: the variant renders').not.toBeNull();
    expect(animated(container)).toEqual([]);
  });

  it('no variant carries a <style> element', () => {
    // Invariant: the keyframes live in index.css; an SVG's own <style> would apply page-wide.
    const { container } = render(<>{VARIANTS.map(([name, el]) => <div key={name}>{el}</div>)}<LogoMark blink /></>);
    expect(container.querySelectorAll('svg[data-logo]').length, 'fixture check: every variant renders').toBe(VARIANTS.length + 1);
    expect(container.querySelectorAll('style').length).toBe(0);
  });

  describe('the terminal face', () => {
    afterEach(() => document.documentElement.classList.remove('dark'));

    /** The shapes a picture paints: the knockout masks' shapes are never drawn. */
    const painted = (svg: Element) => [...svg.querySelectorAll('path, rect')].filter((e) => !e.closest('mask'));
    const white = (svg: Element) => painted(svg).filter((e) => e.getAttribute('fill') === '#ffffff');

    it.each(['light', 'dark'])('is white in the sidebar tile and the 16px small mark, and the theme ink in the mark and lockup, in %s mode', (theme) => {
      // Invariant: the tile and the small mark each draw one white shape, the face, in the same geometry; the mark and the lockup draw that face in the theme's ink and nothing in white, whatever the theme.
      if (theme === 'dark') document.documentElement.classList.add('dark');
      const { container } = render(<><LogoTile /><LogoMark /><LogoLockup /><LogoSmall /></>);
      const picture = (name: string) => container.querySelector(`svg[data-logo="${name}"]`)!;
      for (const name of ['tile', 'small']) {
        expect(white(picture(name)).length, `fixture check: the ${name} draws one white shape, its face`).toBe(1);
      }
      const [tileFace] = white(picture('tile'));
      const [smallFace] = white(picture('small'));
      expect(smallFace.getAttribute('d'), "the small mark wears the tile's face").toBe(tileFace.getAttribute('d'));
      const d = tileFace.getAttribute('d');
      for (const name of ['mark', 'lockup']) {
        expect(white(picture(name)), `${name} draws nothing white`).toEqual([]);
        const drawn = picture(name).querySelectorAll(`path[d="${d}"]`);
        expect(drawn.length, `${name} draws the face once`).toBe(1);
        expect(drawn[0].getAttribute('fill'), name).toBe('var(--logo-ink)');
      }
    });

    it.each(['light', 'dark'])("the small mark's shapes keep their inks: the face is white, the rest coral, deep or the theme ink, in %s mode", (theme) => {
      // Invariant: the 16px small mark paints its legs as strokes and everything else as fills; its coral and deep are fixed hex and its baton follows the theme's ink through var(--logo-ink), in either theme.
      if (theme === 'dark') document.documentElement.classList.add('dark');
      const { container } = render(<LogoSmall />);
      // A stroked leg's colour is its stroke; its fill is none.
      const fills = painted(container.querySelector('svg[data-logo="small"]')!).map((e) => (e.getAttribute('fill') === 'none' ? e.getAttribute('stroke') : e.getAttribute('fill')));
      const face = fills.indexOf('#ffffff');
      expect(face, 'fixture check: the small mark draws one white face').toBeGreaterThan(-1);
      // Document order: the legs (a deep curl then a coral leg per side, then the deep centre leg), the body and the over-screen coral (the glyphs, cursor, arm), the baton (ink).
      expect(fills.filter((_, i) => i !== face)).toEqual([DEEP, CORAL, DEEP, CORAL, DEEP, ...Array<string>(5).fill(CORAL), INK]);
    });
  });

  it('each picture is an image named Code Conductor; the wordmark is decorative', () => {
    // Invariant: the mark, tile, small mark and lockup are role=img named "Code Conductor"; the wordmark is hidden, its container carrying the text.
    const { container } = render(<><LogoMark /><LogoTile /><LogoSmall /><LogoLockup /><Wordmark /></>);
    for (const name of ['mark', 'tile', 'small', 'lockup']) {
      const svg = container.querySelector(`svg[data-logo="${name}"]`)!;
      expect(svg.getAttribute('role'), name).toBe('img');
      expect(svg.getAttribute('aria-label'), name).toBe('Code Conductor');
    }
    const wordmark = container.querySelector('svg[data-logo="wordmark"]')!;
    expect(wordmark.getAttribute('aria-hidden')).toBe('true');
    expect(wordmark.getAttribute('role')).toBeNull();
  });
});
