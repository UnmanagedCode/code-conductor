// The two UIs every parity scenario runs against, in the order its halves are
// registered. Dependency-free: tests/web-parity/titles.ts reads it to resolve a
// scenario's `<title> > <ui>` test titles without loading Playwright.
export const UI_NAMES = ['legacy', 'next'] as const;
export type UiName = (typeof UI_NAMES)[number];
