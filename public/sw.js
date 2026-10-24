// Intentionally minimal: present so browsers treat the app as installable.
// No precache, no runtime cache, no response handling: every request (including /api/*) goes straight to the network.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
