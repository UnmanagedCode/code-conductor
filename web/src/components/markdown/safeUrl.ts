// The one URL gate of rendered markdown, passed to react-markdown as its `urlTransform`: it sees every URL-valued
// property after entity decoding and URI normalization, and a refused one is removed before any component renders.

/** Link schemes markdown may navigate to. */
const SAFE_URL = /^(https?:\/\/|\/|#|mailto:)/i;
/** Image sources markdown may load: the link set without mailto:, plus file:// for local images. */
const SAFE_IMG_SRC = /^(https?:\/\/|file:\/\/|\/|#)/i;

/** `url` when its scheme is allowed for the property `key` (`src` takes the image set), otherwise null. */
export function safeUrl(url: string, key: string): string | null {
  return (key === 'src' ? SAFE_IMG_SRC : SAFE_URL).test(url) ? url : null;
}
