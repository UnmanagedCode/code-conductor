// The pixel self-checks scripts/build-icons.mjs runs on every PNG it writes.

/** How far from the centre a maskable icon's ink may reach, as a fraction of its size. Past the maskable spec's 0.4 safe zone for a larger glyph, yet tight enough that a typical round launcher mask keeps the whole mark, baton tip included (launchers crop differently; this is a margin, not a guarantee). It bounds the art: a larger art box fails. */
export const MASKABLE_INK_RADIUS = 0.44;

/** What is wrong with the `size`² RGBA `px` for `check`, drawn on `plate` ([r, g, b]), or [] when nothing is. */
export function problems(check, size, px, plate) {
  const at = (x, y) => px.slice((y * size + x) * 4, (y * size + x) * 4 + 4);
  const out = [];
  if (check === 'favicon') {
    for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
      // Opaque, not merely inked: the art may reach a corner, a plate fills all four.
      if (at(x, y)[3] === 255) out.push(`corner ${x},${y} is opaque`);
    }
  }
  if (check === 'maskable') {
    const r = size * MASKABLE_INK_RADIUS;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const [R, G, B, A] = at(x, y);
        const plain = R === plate[0] && G === plate[1] && B === plate[2] && A === 255;
        if (!plain && Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) > r) out.push(`pixel ${x},${y} outside the safe zone`);
      }
    }
  }
  return out;
}
