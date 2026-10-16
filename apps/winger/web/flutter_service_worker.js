/* Replaces an older Flutter service worker so phones load the current page. */
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) { return caches.delete(key); }));
    }).then(function () {
      return self.clients.matchAll({ type: 'window' });
    }).then(function (clients) {
      clients.forEach(function (client) {
        client.navigate(client.url);
      });
      return self.registration.unregister();
    })
  );
});

self.addEventListener('fetch', function (event) {
  event.respondWith(fetch(event.request));
});
