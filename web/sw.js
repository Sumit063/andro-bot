// Minimal service worker so Chrome treats the page as an installable app. Nothing is cached:
// the app is live data from your Mac.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
