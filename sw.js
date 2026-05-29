// ═══════════════════════════════════════════
// BILLI SERVICE WORKER v1.0
// Caches app shell for instant load + offline
// ═══════════════════════════════════════════

const CACHE_NAME = 'billi-v1';
const CACHE_URLS = [
  '/app',
  '/billi-avatar.svg',
  '/billi-logo.svg',
  '/favicon.svg',
  '/favicon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js'
];

// Install — cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(CACHE_URLS).catch(err => {
        console.warn('SW: some cache items failed', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy:
// API calls — network only (always fresh)
// App shell — cache first, fall back to network
// Everything else — network first, fall back to cache
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API — always network, never cache
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/auth/') ||
      url.pathname.startsWith('/webhook/')) {
    return;
  }

  // App shell — cache first
  if (CACHE_URLS.includes(url.pathname) || url.pathname === '/app') {
    event.respondWith(
      caches.match(event.request).then(cached => {
        const fresh = fetch(event.request).then(res => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return res;
        });
        return cached || fresh;
      })
    );
    return;
  }

  // Static assets — network first, cache fallback
  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res && res.status === 200 && event.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// Offline fallback message for chat
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
