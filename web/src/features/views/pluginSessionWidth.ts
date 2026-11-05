// Publishes on cc's <html> as data-cc-session-width the width a plugin page should cap itself at, which the plugin
// bridge copies into each plugin page as --cc-session-width. A page in the side pane (the dock's split, or its rail)
// is told `none` and fills the pane; the whole-row column follows the committed setting (sessionWidthCss). While the
// column is hidden the page keeps the context it was last shown in. A handle drag's live width is not published.
import { sessionWidthStore } from '@/app/sessionWidth';
import { sessionWidthCss } from '@/app/sessionWidthScale';
import { dockModeStore } from './dock';

export function startPluginSessionWidth(): void {
  const root = document.documentElement;
  let side = false;
  const publish = () => {
    const { mode } = dockModeStore.get();
    if (mode !== 'hidden') side = mode === 'split' || mode === 'rail';
    root.setAttribute('data-cc-session-width', side ? 'none' : sessionWidthCss(sessionWidthStore.get()));
  };
  publish();
  sessionWidthStore.subscribe(publish);
  dockModeStore.subscribe(publish);
}
