// A conductor's colour, derived from its sessionId alone: FNV-1a over the id
// plus a finaliser, reduced to one of HUE_SLOTS hues spaced evenly round the
// wheel at a fixed saturation and lightness tuned for the dark --panel. A free
// 0–360 hue collides visibly between neighbouring ids far sooner than slots do.
// The only colour source for conductor ownership.
const HUE_SLOTS = 12;

export function conductorColor(sessionId) {
  let h = 0x811c9dc5;
  for (const ch of String(sessionId)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return `hsl(${((h >>> 0) % HUE_SLOTS) * (360 / HUE_SLOTS)} 70% 64%)`;
}
