// Starts browser notifications for top-level sessions that start waiting on
// the user or finish, registers the service worker (also what makes the PWA
// installable), and installs the standalone-PWA external-link handler.
import { stashCurrentAnchorForRelaunch } from '@shared/anchor';
import { on } from '@/app/events';
import { appStore, activeInstance } from '@/state/app';
import { routeStore } from '@/state/route';
import { createAttentionNotifier, initNotifications } from './notifications';
import { installExternalLinkOpener } from './externalLinks';

let started = false;

/** The user is looking at this session: tab visible, session pane showing, it is the active one. */
function isOnScreen(sessionId: string) {
  return document.visibilityState === 'visible'
    && routeStore.get().route.view === 'session'
    && activeInstance(appStore.get())?.sessionId === sessionId;
}

export function startNotifications() {
  if (started) return;
  started = true;
  initNotifications();
  const notifier = createAttentionNotifier({ isOnScreen });
  on('instances', () => notifier.observe(appStore.get().instances));
  installExternalLinkOpener({ beforeNavigate: () => stashCurrentAnchorForRelaunch() });
}
