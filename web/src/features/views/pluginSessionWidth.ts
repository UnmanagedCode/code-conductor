// Publishes the committed session width on cc's <html> as data-cc-session-width (sessionWidthCss), which the
// plugin bridge copies into each plugin page as --cc-session-width. A handle drag's live width is not published.
import { sessionWidthStore } from '@/app/sessionWidth';
import { sessionWidthCss } from '@/app/sessionWidthScale';

export function startPluginSessionWidth(): void {
  const root = document.documentElement;
  const publish = () => root.setAttribute('data-cc-session-width', sessionWidthCss(sessionWidthStore.get()));
  publish();
  sessionWidthStore.subscribe(publish);
}
