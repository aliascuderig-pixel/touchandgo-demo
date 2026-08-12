// Touch&Go — service worker: caches the app shell so the interface itself
// (screens, saved addresses, purchase history, dashboard) still loads
// without an internet connection. AI classification, geolocation and QR
// generation still require a live connection and are handled gracefully
// in-app when offline.

const CACHE_NAME = "touchandgo-shell-v2";
const APP_SHELL = ["/", "/index.html", "/assets/app.js", "/assets/style.css"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never intercept calls to the AI/QR/geolocation APIs — those must always
  // hit the network live, never be served from a stale cache.
  if (
    url.pathname.startsWith("/.netlify/functions/") ||
    url.hostname.includes("qrserver.com") ||
    url.hostname.includes("bigdatacloud.net") ||
    url.hostname.includes("ipapi.co") ||
    url.hostname.includes("wikipedia.org")
  ) {
    return;
  }

  const isAppShell = url.origin === self.location.origin && APP_SHELL.includes(url.pathname);

  if (isAppShell) {
    // App shell: rete prima di tutto, così ogni turista vede subito
    // l'ultima versione deployata al primo caricamento — la cache serve
    // solo come fallback quando il dispositivo è offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
