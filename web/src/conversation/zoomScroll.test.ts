import { describe, expect, it } from 'vitest';
import { tapFraction, zoomScroll } from './zoomScroll';

describe('zoomScroll', () => {
  it('keeps the tapped spot under the pointer on an image that overflows both axes', () => {
    // Invariant: scroll = fraction × natural − pointer; neither top-left (0) nor centred (1000, 600).
    const out = zoomScroll({ fx: 0.8, fy: 0.25 }, { naturalWidth: 3000, naturalHeight: 2000 }, { x: 700, y: 100 }, { clientWidth: 1000, clientHeight: 800 });
    expect(out).toEqual({ left: 1700, top: 400 });
  });

  it('clamps to the scrollable range at both ends', () => {
    // Invariant: a tap near the far edge cannot scroll past natural − viewport, and a tap near the start with a large pointer offset cannot go negative.
    const natural = { naturalWidth: 3000, naturalHeight: 2000 };
    const viewport = { clientWidth: 1000, clientHeight: 800 };
    expect(zoomScroll({ fx: 1, fy: 1 }, natural, { x: 10, y: 10 }, viewport)).toEqual({ left: 2000, top: 1200 });
    expect(zoomScroll({ fx: 0.05, fy: 0.05 }, natural, { x: 900, y: 700 }, viewport)).toEqual({ left: 0, top: 0 });
  });

  it('gives 0 on an axis that does not overflow, whatever the fraction', () => {
    // Invariant: only an overflowing axis scrolls; the mixed case scrolls y alone.
    const natural = { naturalWidth: 300, naturalHeight: 2400 };
    const viewport = { clientWidth: 300, clientHeight: 800 };
    expect(zoomScroll({ fx: 0.9, fy: 0.5 }, natural, { x: 10, y: 300 }, viewport)).toEqual({ left: 0, top: 900 });
    expect(zoomScroll({ fx: 0.9, fy: 0.9 }, { naturalWidth: 200, naturalHeight: 100 }, { x: 0, y: 0 }, { clientWidth: 500, clientHeight: 500 })).toEqual({ left: 0, top: 0 });
  });
});

describe('tapFraction', () => {
  const natural = { naturalWidth: 2000, naturalHeight: 1000 };

  it('maps a tap in the letterbox band to the painted image edge and the box centre to 0.5', () => {
    // Invariant: a wide image in a tall box is letterboxed top and bottom; taps in the bands clamp to 0 / 1.
    const box = { width: 400, height: 400 }; // painted 400×200, inset y = 100
    expect(tapFraction({ x: 200, y: 200 }, box, natural)).toEqual({ fx: 0.5, fy: 0.5 });
    expect(tapFraction({ x: 100, y: 20 }, box, natural)).toEqual({ fx: 0.25, fy: 0 });
    expect(tapFraction({ x: 100, y: 390 }, box, natural)).toEqual({ fx: 0.25, fy: 1 });
  });

  it('maps a tap at a known painted point to its exact fraction, not tap / box', () => {
    // Invariant: the fraction is relative to the painted image, not the element box.
    const f = tapFraction({ x: 300, y: 150 }, { width: 400, height: 400 }, natural); // y: (150-100)/200
    expect(f).toEqual({ fx: 0.75, fy: 0.25 });
    expect(f.fy).not.toBe(150 / 400);
  });
});
