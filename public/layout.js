// The phone-layout breakpoint: the one JS-side value for the `@media` blocks in
// styles.css. Keep it equal to that query — tests/header-compact-css.test.mjs
// pins the match.
export const MOBILE_LAYOUT_QUERY = '(max-width: 720px)';

// The touch-primary signal: the JS-side twin of the `@media (hover: none)`
// blocks in styles.css. Keyed on the input device, not the layout width.
export const TOUCH_QUERY = '(hover: none)';
