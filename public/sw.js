// Pass-through service worker. It exists only so browsers treat the app as installable.
// It NEVER caches and never answers a request: HTML, /api/*, and Next build chunks all go straight to the network,
// so a new deploy is always what the next page load gets.
// Bump VERSION to force browsers to install a new copy (any byte change does; this makes it deliberate).
const VERSION = "2";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  // Take over open pages immediately and delete any cache a previous version might have created.
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Required by some browsers for install eligibility. Deliberately does not call respondWith().
self.addEventListener("fetch", () => {});
