export type Size = { width: number; height: number };
export type Natural = { naturalWidth: number; naturalHeight: number };
export type Point = { x: number; y: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Where a tap on the fit `<img>` lands on the painted image, as fractions of the image itself.
 * `ImageZoom` sizes that box to the painted image, so the letterbox inset this allows for is 0;
 * a tap past an edge clamps to that edge.
 */
export function tapFraction(tap: Point, box: Size, natural: Natural): { fx: number; fy: number } {
  const scale = Math.min(box.width / natural.naturalWidth, box.height / natural.naturalHeight);
  const pw = natural.naturalWidth * scale;
  const ph = natural.naturalHeight * scale;
  return {
    fx: clamp((tap.x - (box.width - pw) / 2) / pw, 0, 1),
    fy: clamp((tap.y - (box.height - ph) / 2) / ph, 0, 1),
  };
}

/**
 * The scroll offset that keeps the tapped spot (a fraction of the 1:1 image) under the pointer
 * (an offset within the scroller), clamped to the scrollable range; an axis that does not
 * overflow gives 0.
 */
export function zoomScroll(
  f: { fx: number; fy: number }, natural: Natural, pointer: Point, viewport: { clientWidth: number; clientHeight: number },
): { left: number; top: number } {
  return {
    left: clamp(f.fx * natural.naturalWidth - pointer.x, 0, Math.max(0, natural.naturalWidth - viewport.clientWidth)),
    top: clamp(f.fy * natural.naturalHeight - pointer.y, 0, Math.max(0, natural.naturalHeight - viewport.clientHeight)),
  };
}
