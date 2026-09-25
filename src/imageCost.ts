// Image header sniffing and Anthropic's vision token cost.
//
// The cost rule is Anthropic's: an image is charged one visual token per
// 28×28-px patch, after an aspect-preserving downscale that keeps both padded
// edges within a pixel limit and the patch count within a token budget.
//   https://platform.claude.com/docs/en/build-with-claude/vision
//   https://platform.claude.com/docs/en/build-with-claude/vision-coordinates
//     ("How Claude resizes and pads images")
//
// The HIGH-RES tier's limits are used deliberately, with no per-session model
// detection: they are the limits of every current default model. An older
// (standard-tier) model is over-estimated, and only for an image above that
// tier's smaller budget.

export const IMAGE_PATCH_PX = 28;
export const IMAGE_MAX_EDGE_PX = 2576;
export const IMAGE_MAX_TOKENS = 4784;

const patches = (px: number): number => Math.ceil(px / IMAGE_PATCH_PX);
const tokens = (w: number, h: number): number => patches(w) * patches(h);
const fits = (w: number, h: number): boolean =>
  patches(w) * IMAGE_PATCH_PX <= IMAGE_MAX_EDGE_PX
  && patches(h) * IMAGE_PATCH_PX <= IMAGE_MAX_EDGE_PX
  && tokens(w, h) <= IMAGE_MAX_TOKENS;

// Python's `round`, which the reference resize search uses: an exact .5 goes
// to the even neighbour.
function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

// Visual tokens for a width × height image. The cost is symmetric under a
// width/height swap, so the search runs on (long, short).
export function imageTokenCost(width: number, height: number): number {
  if (fits(width, height)) return tokens(width, height);
  const long = Math.max(width, height);
  const aspect = long / Math.min(width, height);
  const shortFor = (l: number): number => Math.max(roundHalfEven(l / aspect), 1);
  // Largest long edge that fits; `lo` always fits (a 1-px edge is one patch).
  let lo = 1;
  let hi = long;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid, shortFor(mid))) lo = mid;
    else hi = mid - 1;
  }
  return tokens(lo, shortFor(lo));
}

// Pixel dimensions from an image's own header, identified by its SIGNATURE
// (never a declared media type). PNG, GIF, WebP and JPEG — the formats the API
// accepts. Null on an unknown signature, a truncated header or a zero size.
export function imageDimensions(bytes: Buffer): { width: number; height: number } | null {
  const dims = sniff(bytes);
  return dims && dims.width > 0 && dims.height > 0 ? dims : null;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniff(b: Buffer): { width: number; height: number } | null {
  const has = (n: number): boolean => b.length >= n;
  const ascii = (at: number, s: string): boolean => has(at + s.length) && b.toString('latin1', at, at + s.length) === s;

  if (has(24) && b.subarray(0, 8).equals(PNG_SIG)) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) {
    return has(10) ? { width: b.readUInt16LE(6), height: b.readUInt16LE(8) } : null;
  }
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return webp(b);
  if (has(2) && b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  return null;
}

function webp(b: Buffer): { width: number; height: number } | null {
  const fourcc = b.length >= 16 ? b.toString('latin1', 12, 16) : '';
  if (fourcc === 'VP8 ') {
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === 'VP8L') {
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const [b0, b1, b2, b3] = [b[21], b[22], b[23], b[24]];
    return {
      width: 1 + (b0 | ((b1 & 0x3f) << 8)),
      height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)),
    };
  }
  if (fourcc === 'VP8X') {
    if (b.length < 30) return null;
    return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  return null;
}

// Start-of-frame markers: every SOFn except DHT (C4), JPG (C8) and DAC (CC).
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpeg(b: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    while (i < b.length && b[i] === 0xff) i++;   // fill bytes
    if (i >= b.length) return null;
    const marker = b[i++];
    // Standalone markers carry no length.
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xd8) continue;
    // End of image, or scan data before any frame header.
    if (marker === 0xd9 || marker === 0xda) return null;
    if (i + 2 > b.length) return null;
    if (JPEG_SOF.has(marker)) {
      if (i + 7 > b.length) return null;
      return { width: b.readUInt16BE(i + 5), height: b.readUInt16BE(i + 3) };
    }
    i += b.readUInt16BE(i);
  }
  return null;
}
