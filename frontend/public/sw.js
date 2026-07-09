/* =============================================================================
   Shop Register — service worker. Minimal app-shell caching so the app is an
   installable PWA and keeps opening when the network is flaky.

   Strategy, deliberately conservative so nothing dynamic goes stale:
     * Navigations        → network-first, fall back to the cached shell offline.
     * Same-origin assets → stale-while-revalidate (hashed Vite bundles).
     * Everything else     → untouched. Cross-origin (Supabase API / auth /
       storage / Google Fonts) and non-GET requests bypass the worker entirely,
       so live data and realtime are never served from cache.
   ========================================================================== */
const CACHE = 'shop-register-v1'
const APP_SHELL = ['/', '/favicon.svg']

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(APP_SHELL)).catch(() => {})
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Leave Supabase, Google Fonts and any other origin to the browser.
  if (url.origin !== self.location.origin) return

  // Navigations: always try the network first so a fresh deploy is picked up;
  // fall back to the cached shell (or root) when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put('/', copy)).catch(() => {})
          return res
        })
        .catch(() => caches.match(request).then((r) => r || caches.match('/')))
    )
    return
  }

  // Static assets: serve cache immediately, refresh it in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {})
          }
          return res
        })
        .catch(() => cached)
      return cached || network
    })
  )
})
