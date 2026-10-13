// Class readers the user-bubble layout tests share. Declares no tests.

export const classesOf = (el: Element) => el.className.split(/\s+/).filter(Boolean);
/** A constant's classes; `?? ''` lets a build without the constant fail at an assertion rather than a TypeError. */
export const tokens = (s: string | undefined) => (s ?? '').split(/\s+/).filter(Boolean).sort();
/** Horizontal margin utilities, with any variant prefix: m-, mx-, ml-, mr-, ms-, me-. */
export const marginX = (el: Element) => classesOf(el).filter((c) => /^(?:[\w-]+:)*m[lrsex]?-/.test(c)).sort();
/** Horizontal padding utilities, with any variant prefix: p-, px-, pl-, pr-, ps-, pe-. */
export const padX = (el: Element) => classesOf(el).filter((c) => /^(?:[\w-]+:)*p[xlrse]?-/.test(c)).sort();
/** Width-cap utilities, with any variant prefix. */
export const capClasses = (el: Element) => classesOf(el).filter((c) => /^(?:[\w-]+:)*max-w-/.test(c)).sort();
/** What stops an element itself spanning its container: a width cap, an auto margin, a self alignment, an intrinsic width. */
export const selfAlignClasses = (el: Element) => classesOf(el).filter((c) =>
  /^(?:[\w-]+:)*(?:max-w-|(?:ml|mr)-auto$|self-(?:end|start|center)$|w-(?:fit|max|auto)$)/.test(c));
/**
 * selfAlignClasses plus what stops a container's children spanning it: a non-stretch cross-axis alignment, or a
 * main-axis push to the end. For a container whose children must fill it (a user item, the pin wrapper); a flex row
 * inside one may centre its own contents.
 */
export const alignClasses = (el: Element) => [
  ...selfAlignClasses(el),
  ...classesOf(el).filter((c) => /^(?:[\w-]+:)*(?:items-(?:end|start|center)$|justify-end$)/.test(c)),
];
