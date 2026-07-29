// Minimal Service Worker. Exists for one reason: mobile Chrome refuses to
// construct page-level `new Notification(...)` and requires
// `ServiceWorkerRegistration.showNotification(...)`. The SW also handles
// notification clicks so tapping a ping focuses the existing tab and
// navigates it to the session the notification was about, instead of just
// dismissing the notification.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Pass-through fetch handler. CodeConductor has no offline mode (the local Node
// server is the whole app), so we don't cache anything — but Chrome's PWA
// installability check requires a registered fetch listener before it will
// surface the "Install app" entry. Without this, the menu shows only the
// weaker "Add to home screen" bookmark shortcut.
self.addEventListener('fetch', () => { /* default network handling */ });

self.addEventListener('notificationclick', (event) => {
  // `data` carries {project, instanceId, sessionId} (see notifications.js's
  // `fire`) — undefined/missing fields here just mean a notification fired
  // by pre-update code, and everything below degrades to the old
  // focus-first-client / bare-'/' behavior for that case.
  const data = event.notification.data;
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const focusable = all.filter((c) => 'focus' in c);
    // Prefer a client the user is already looking at over an arbitrary
    // background tab — otherwise a second open tab can get yanked to the
    // front for a notification about a session it isn't even showing.
    // Fall back through the rest, in their original order, if the preferred
    // client fails to focus.
    const visible = focusable.filter((c) => c.visibilityState === 'visible' || c.focused);
    const rest = focusable.filter((c) => !visible.includes(c));
    for (const client of [...visible, ...rest]) {
      try {
        const focused = await client.focus();
        focused.postMessage({ type: 'cc-notification-click', instanceId: data?.instanceId, sessionId: data?.sessionId });
        return;
      } catch { /* fall through */ }
    }
    if (self.clients.openWindow) {
      const url = data?.sessionId ? `/#session=${encodeURIComponent(data.sessionId)}` : '/';
      return self.clients.openWindow(url);
    }
  })());
});
