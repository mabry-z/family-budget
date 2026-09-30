// Cadence's service worker: shows phone notifications for new card
// purchases (see docs/notifications-plan.md). It deliberately has no fetch
// handler and caches nothing, so pages and updates load exactly as before.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// Sent by the notify-purchase Edge Function: { title, body, tag, importId }.
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Cadence', {
    body: data.body || '',
    tag: data.tag,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { importId: data.importId ?? null },
  }));
});

// Tapping it opens Cadence on that purchase: an open Cadence is brought to
// the front and told which one; otherwise Cadence opens with ?review=<id>.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const importId = event.notification.data?.importId;
  const url = new URL(importId ? `./?review=${importId}` : './', self.registration.scope).href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(w => w.url.startsWith(self.registration.scope));
    if (open) {
      await open.focus();
      if (importId) open.postMessage({ type: 'review-import', importId });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
