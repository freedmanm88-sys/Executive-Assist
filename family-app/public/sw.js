// Minimal service worker — network-passthrough. Exists so Android treats the
// app as installable. Offline caching can come later.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
