// Minimal Service Worker. Exists for one reason: mobile Chrome refuses to
// construct page-level `new Notification(...)` and requires
// `ServiceWorkerRegistration.showNotification(...)`. The SW also handles
// notification clicks so tapping a ping focuses the existing tab instead of
// just dismissing the notification.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        try { return await client.focus(); } catch { /* fall through */ }
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow('/');
  })());
});
