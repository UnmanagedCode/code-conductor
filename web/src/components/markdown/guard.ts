import { COMPLEXITY_LIMITS, measureComplexity, overBudget } from './complexity';

export const MAX_SIZE = COMPLEXITY_LIMITS.size;
export const MAX_NESTING = COMPLEXITY_LIMITS.nesting;
export const nestingDepth = (text: string) => measureComplexity(text).nesting;
/** Whether Markdown may parse `text`. */
export const parseable = (text: string) => !overBudget(text);
