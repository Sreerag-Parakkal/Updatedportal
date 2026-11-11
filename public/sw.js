// Minimal service worker so the portal can be installed as an app. Nothing is cached:
// the portal always needs the live server for its data.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).catch(() => new Response('You are offline. Reconnect to use the portal.', { status: 503, headers: { 'Content-Type': 'text/plain' } })));
});

// Tapping a pop-up opens the portal on the complaint.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  const url = d.url || (d.complaintId ? '/#/complaints/' + d.complaintId : '/');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) { c.navigate(url).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});

// A push from the portal: show it in the phone's notification panel (with the phone's notification sound).
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((c) => c.visibilityState === 'visible' && c.focused)) return; // the open page already alerts
    await self.registration.showNotification(d.title || 'SCM SERVICE PORTAL', {
      body: d.body || '', icon: '/icon-192.png', badge: '/badge-96.png', tag: d.tag || 'portal', renotify: true,
      vibrate: [200, 100, 200], data: { url: d.url || '/' },
    });
  })());
});
