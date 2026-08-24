// Stash Service Worker
// Pull in config (CONFIG) and the IndexedDB wrapper (self.StashDB) so the
// Background Sync handler can drain the offline "pending saves" queue.
importScripts('/config.js', '/db.js', '/save-lib.js');

const CACHE_NAME = 'stash-v5';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
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

// Refresh an expiring session against the Supabase token endpoint. The stored
// session is the only credential a Service Worker has (it can't read the
// localStorage copy supabase-js maintains), so if it goes stale the queue is
// stuck until the app is opened again — refresh it here instead. Returns the
// usable session, or null if the refresh failed. Note the endpoint reports
// `expires_at` in seconds; StashDB.saveSession normalizes to epoch
// milliseconds, which is what the comparison below assumes.
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;

async function getFreshSession() {
  let session;
  try {
    session = await self.StashDB.getSession();
  } catch (e) {
    return null;
  }
  if (!session || !session.access_token) return null;
  if (session.expires_at && session.expires_at - Date.now() > TOKEN_EXPIRY_MARGIN_MS) {
    return session;
  }
  if (!session.refresh_token) return null;

  const res = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {
      'apikey': CONFIG.SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  if (!res.ok) return null;

  const refreshed = await res.json();
  if (!refreshed.access_token) return null;
  const next = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token || session.refresh_token,
    expires_at: refreshed.expires_at,
    user_id: (refreshed.user && refreshed.user.id) || session.user_id,
  };
  await self.StashDB.saveSession(next);
  return next;
}

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

  // Without a usable session there is nobody to attribute these saves to, and
  // no amount of retrying fixes that until the user signs in again — so leave
  // the queue alone and return rather than throwing (which would have the
  // browser reschedule a sync that can only fail the same way).
  let session;
  try {
    session = await getFreshSession();
  } catch (e) {
    return; // Refresh couldn't reach the network; the next sync tries again
  }
  if (!session) return;

  let failed = 0;
  for (const { key, data } of pending) {
    try {
      // Drain through the scraper so queued offline saves get the full article
      // ingested, not just the shared link.
      const ok = await self.StashSave.saveViaScrape(data, session.access_token);
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
