// Cadence's service worker: shows phone notifications for new card
// purchases and chores (see docs/notifications-plan.md, docs/chores-plan.md). It deliberately has no fetch
// handler and caches nothing, so pages and updates load exactly as before.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// Sent by the notify-purchase Edge Function:
// { title, body, tag, importId } or { title, body, tag, choreTaskId | open: 'chores' }.
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
    data: {
      importId: data.importId ?? null,
      choreTaskId: data.choreTaskId ?? null,
      chores: !!(data.choreTaskId || data.open === 'chores'),
    },
  }));
});

// Tapping it opens Cadence on that purchase (or on Chores): an open Cadence
// is brought to the front and told which one; otherwise Cadence opens with
// ?review=<id> (or ?chores=<task id>).
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const importId = event.notification.data?.importId;
  const chores = event.notification.data?.chores;
  const taskId = event.notification.data?.choreTaskId;
  const link = importId ? `./?review=${importId}` : chores ? `./?chores=${taskId ?? 'open'}` : './';
  const url = new URL(link, self.registration.scope).href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(w => w.url.startsWith(self.registration.scope));
    if (open) {
      await open.focus();
      if (importId) open.postMessage({ type: 'review-import', importId });
      else if (chores) open.postMessage({ type: 'open-chores', taskId: taskId ?? null });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
