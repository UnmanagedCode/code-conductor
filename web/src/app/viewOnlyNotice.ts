import { onViewOnlyRefusal, VIEW_ONLY_MESSAGE } from '@shared/viewOnly';
import { toast, VIEW_ONLY_TOAST_ID } from '@/ui/feedback';

/** Shows a toast for every view-only refusal; sonner replaces a toast of the same id, so a burst reads as one. The returned function stops it. */
export function startViewOnlyNotice(): () => void {
  return onViewOnlyRefusal(() => toast.warning('View-only mode', VIEW_ONLY_MESSAGE, { id: VIEW_ONLY_TOAST_ID }));
}
