// Stash Service Worker
// Pull in config (CONFIG) and the IndexedDB wrapper (self.StashDB) so the
// Background Sync handler can drain the offline "pending saves" queue.
importScripts('/config.js', '/analytics.js', '/db.js', '/save-lib.js');

const CACHE_NAME = 'stash-v5';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/version.js',
  '/app.js',
  '/db.js',
  '/save-lib.js',
  '/config.js',
  '/manifest.json',
  '/icons/icon192.png',
  '/icons/icon512.png'
];

// Install
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch Strategy
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. API Requests (Supabase): Network only (handled by app.js/db.js)
  if (url.hostname.includes('supabase.co')) {
    return;
  }

  // 2. Navigation (HTML): Network First, fall back to Cache
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .catch(() => {
          return caches.match('/index.html');
        })
    );
    return;
  }

  // 3. Static Assets (JS/CSS/Images): Stale-While-Revalidate
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, networkResponse.clone());
        });
        return networkResponse;
      });
      return cachedResponse || fetchPromise;
    })
  );
});

// Background Sync: robustly retry offline saves that were queued in IndexedDB.
// Registered from save.html (and app.js) via registration.sync.register('sync-pending-saves').
async function drainPendingSaves() {
  let pending;
  try {
    pending = await self.StashDB.getPendingShares();
  } catch (e) {
    return; // IndexedDB unavailable; nothing to do
  }
  if (!pending || !pending.length) return;

  let failed = 0;
  for (const { key, data } of pending) {
    try {
      // Drain through the scraper so queued offline saves get the full article
      // ingested, not just the shared link.
      const ok = await self.StashSave.saveViaScrape(data);
      if (ok) {
        await self.StashDB.deletePendingShare(key);
      } else {
        failed++;
      }
    } catch (e) {
      failed++; // Likely still offline; leave queued
    }
  }

  // Reject so the browser reschedules this sync and retries later.
  if (failed > 0) {
    throw new Error(`${failed} pending save(s) failed to sync; will retry`);
  }
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-pending-saves') {
    event.waitUntil(drainPendingSaves());
  }
});
