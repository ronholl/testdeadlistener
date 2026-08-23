// Ron's Deadhead Listener installation service worker.
// It deliberately stores nothing: setlists, catalogs, and audio remain governed
// by the app and network so an old service-worker cache can never stale the music.
self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(fetch(event.request));
});
