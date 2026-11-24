// @vitest-environment node
// The landing assembly's data and its stylesheet agree. A separate file from logoArt.test.tsx,
// which mocks MARK: these read the real art and the real index.css.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { knockoutTree, MARK } from './logoArt';

const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

/** `[data-logo-part='x'] { animation: … }` rules → part → its animation entries (name, delay + duration in s). */
function assemblyRules() {
  const rules = new Map<string, { name: string; end: number }[]>();
  for (const m of css.matchAll(/\[data-logo-part='([a-z0-9]+)'\]\s*\{\s*animation:([^;]+);/g)) {
    const entries = m[2].split(/,(?![^(]*\))/).map((raw) => {
      const tokens = raw.trim().split(/\s+/);
      const [duration = 0, delay = 0] = tokens.filter((t) => /^[\d.]+s$/.test(t)).map(parseFloat);
      return { name: tokens[0], end: duration + delay };
    });
    expect(rules.has(m[1]), `one animation rule for ${m[1]}`).toBe(false);
    rules.set(m[1], entries);
  }
  return rules;
}

describe('the landing assembly', () => {
  it('every MARK element names a part, and each knockout belongs to the part of the next painted element', () => {
    // Invariant: the tags cover the whole art, and a cut carries the part of the shape drawn right after it, so each mask moves with its part.
    expect(MARK.elements.filter((e) => !e.part)).toEqual([]);
    MARK.elements.forEach((el, i) => {
      if (!el.ko) return;
      const next = MARK.elements.slice(i + 1).find((e) => !e.ko);
      expect(el.part, `knockout ${i}`).toBe(next!.part);
    });
    // The tree's masks keep their tags (the renderer reads them off the same elements).
    expect(knockoutTree(MARK.elements).masks.every((m) => m.part)).toBe(true);
  });

  it('no MARK element carries a transform attribute', () => {
    // Invariant: the assembly's CSS transform replaces a transform attribute, so the art must have none.
    expect(MARK.elements.filter((e) => 'transform' in e.attrs)).toEqual([]);
  });

  it('index.css has one animation rule per part, and the baton lift is the last animation to end, in the baton rule alone', () => {
    // Invariant: the tags and the choreography agree; the hand-over (logo-baton-lift's end) never cuts another animation short.
    const rules = assemblyRules();
    const parts = [...new Set(MARK.elements.map((e) => e.part!))];
    expect([...rules.keys()].sort()).toEqual([...parts].sort());
    const lifts = [...rules].filter(([, entries]) => entries.some((e) => e.name === 'logo-baton-lift'));
    expect(lifts.map(([part]) => part)).toEqual(['baton']);
    const lift = rules.get('baton')!.find((e) => e.name === 'logo-baton-lift')!.end;
    const latest = Math.max(...[...rules.values()].flat().map((e) => e.end));
    expect(lift).toBe(latest);
  });
});
