// Stash IndexedDB Wrapper
const DB_NAME = 'StashDB';
const DB_VERSION = 4;
const STORE_ARTICLES = 'articles';
const STORE_PENDING = 'pending_saves'; // For offline shares
const STORE_SESSION = 'session'; // Auth tokens the Service Worker can read
const STORE_OFFLINE_STATUS = 'offline_status'; // Per-article image prefetch bookkeeping
const SESSION_KEY = 'current'; // Single-record store; one signed-in user per device
const STORE_BUG_REPORTS = 'bug_reports'; // Bug reports queued when a submit fails

const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => {
        console.error('IndexedDB error:', event.target.error);
        reject(event.target.error);
    };

    request.onsuccess = (event) => {
        const db = event.target.result;
        // If another context (a page tab, or the Service Worker) opens this DB
        // with a newer DB_VERSION, close our connection so its upgrade isn't
        // blocked. Without this, bumping DB_VERSION can deadlock the newer
        // context against an older one that never lets go.
        db.onversionchange = () => db.close();
        resolve(db);
    };

    request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // Store for cached articles (read-only offline access)
        if (!db.objectStoreNames.contains(STORE_ARTICLES)) {
            db.createObjectStore(STORE_ARTICLES, { keyPath: 'id' });
        }

        // Store for pending saves (write offline, sync later)
        if (!db.objectStoreNames.contains(STORE_PENDING)) {
            const store = db.createObjectStore(STORE_PENDING, { autoIncrement: true });
        }

        // Store for the Supabase session. supabase-js keeps the session in
        // localStorage, which a Service Worker cannot read — so the page mirrors
        // it here for Background Sync to authenticate its drain requests.
        if (!db.objectStoreNames.contains(STORE_SESSION)) {
            db.createObjectStore(STORE_SESSION);
        }

        // Tracks, per article, which image URLs have been downloaded into the
        // stash-images-v1 Cache Storage bucket for offline reading. Kept
        // separate from STORE_ARTICLES (rather than a field on the article
        // record) because saveArticles() overwrites article records wholesale
        // on every server refresh, which would otherwise wipe this bookkeeping.
        if (!db.objectStoreNames.contains(STORE_OFFLINE_STATUS)) {
            db.createObjectStore(STORE_OFFLINE_STATUS, { keyPath: 'id' });
        }

        // Store for bug reports whose submit failed (offline, or GitHub was
        // down). bug-report.js drains this on startup / when back online. Values
        // are { fields: {...}, files: [{ blob, name, type }] } — Blobs
        // structured-clone fine; FormData does not, so it's rebuilt on retry.
        if (!db.objectStoreNames.contains(STORE_BUG_REPORTS)) {
            db.createObjectStore(STORE_BUG_REPORTS, { autoIncrement: true });
        }
    };
});

// Exposed on `self` (not `window`) so this file can be imported into the
// Service Worker via importScripts() for Background Sync, while remaining
// accessible as window.StashDB in page contexts (self === window there).
self.StashDB = {
    async getArticles() {
        const db = await dbPromise;
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_ARTICLES], 'readonly');
            const store = transaction.objectStore(STORE_ARTICLES);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    },

    async saveArticles(articles) {
        // Bulk save
        const db = await dbPromise;
        const transaction = db.transaction([STORE_ARTICLES], 'readwrite');
        const store = transaction.objectStore(STORE_ARTICLES);
        
        // Clear old cache? Or just merge? for now, let's just clear and replace to keep it simple and sync with backend
        // Actually that's risky if we want true offline. merging by ID is better.
        // But for "Last 20 articles" spec, clearing and rewriting the top list is fine.
        // Let's iterate and put.
        articles.forEach(article => store.put(article));
        
        return new Promise((resolve, reject) => {
             transaction.oncomplete = () => resolve();
             transaction.onerror = () => reject(transaction.error);
        });
    },
    
    // Update the archived flag on a single cached article in place. Keeps the
    // offline cache consistent with the server after an archive/unarchive so the
    // next load's filtered render doesn't flash a stale (wrongly-filed) item.
    async setArchived(id, isArchived) {
        const db = await dbPromise;
        const transaction = db.transaction([STORE_ARTICLES], 'readwrite');
        const store = transaction.objectStore(STORE_ARTICLES);
        const getReq = store.get(id);
        getReq.onsuccess = () => {
            const article = getReq.result;
            if (article) {
                article.is_archived = isArchived;
                store.put(article);
            }
        };
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    },

    // Update the cached read_percent on a single article in place, mirroring
    // setArchived so offline reopens show the last-synced progress.
    async setReadPercent(id, percent) {
        const db = await dbPromise;
        const transaction = db.transaction([STORE_ARTICLES], 'readwrite');
        const store = transaction.objectStore(STORE_ARTICLES);
        const getReq = store.get(id);
        getReq.onsuccess = () => {
            const article = getReq.result;
            if (article) {
                article.read_percent = percent;
                store.put(article);
            }
        };
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    },

    async savePendingShare(shareData) {
        const db = await dbPromise;
        const transaction = db.transaction([STORE_PENDING], 'readwrite');
        const store = transaction.objectStore(STORE_PENDING);
        store.add({
            ...shareData,
            created_at: new Date().toISOString()
        });
        return new Promise((resolve, reject) => {
             transaction.oncomplete = () => resolve();
             transaction.onerror = () => reject(transaction.error);
        });
    },

    async getPendingShares() {
        const db = await dbPromise;
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_PENDING], 'readonly');
            const store = transaction.objectStore(STORE_PENDING);
            const request = store.getAll();
            const keyRequest = store.getAllKeys();
            let results, keys;
            request.onsuccess = () => {
                results = request.result;
                if (keys !== undefined) resolve(results.map((r, i) => ({ key: keys[i], data: r })));
            };
            keyRequest.onsuccess = () => {
                keys = keyRequest.result;
                if (results !== undefined) resolve(results.map((r, i) => ({ key: keys[i], data: r })));
            };
            request.onerror = () => reject(request.error);
        });
    },

    // Mirror the Supabase session so the Service Worker can authenticate.
    // `expires_at` is always stored as epoch MILLISECONDS so it compares
    // directly against Date.now(); supabase-js and the /auth/v1/token endpoint
    // both hand back seconds, so anything that looks like seconds is scaled up
    // here rather than at every call site.
    async saveSession(session) {
        const db = await dbPromise;
        const transaction = db.transaction([STORE_SESSION], 'readwrite');
        const store = transaction.objectStore(STORE_SESSION);
        const expiresAt = Number(session.expires_at) || 0;
        store.put({
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            expires_at: expiresAt < 1e12 ? expiresAt * 1000 : expiresAt,
            user_id: session.user_id || (session.user && session.user.id) || null
        }, SESSION_KEY);
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    },

    async getSession() {
        const db = await dbPromise;
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_SESSION], 'readonly');
            const store = transaction.objectStore(STORE_SESSION);
            const request = store.get(SESSION_KEY);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    },

    async clearSession() {
        const db = await dbPromise;
        const transaction = db.transaction([STORE_SESSION], 'readwrite');
        const store = transaction.objectStore(STORE_SESSION);
        store.delete(SESSION_KEY);
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    },

    async deletePendingShare(key) {
        const db = await dbPromise;
        const transaction = db.transaction([STORE_PENDING], 'readwrite');
        const store = transaction.objectStore(STORE_PENDING);
        store.delete(key);
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    },

    // Offline image prefetch bookkeeping (see STORE_OFFLINE_STATUS above).
    async getOfflineStatus(id) {
        const db = await dbPromise;
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_OFFLINE_STATUS], 'readonly');
            const store = transaction.objectStore(STORE_OFFLINE_STATUS);
            const request = store.get(id);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    },

    async getAllOfflineStatuses() {
        const db = await dbPromise;
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_OFFLINE_STATUS], 'readonly');
            const store = transaction.objectStore(STORE_OFFLINE_STATUS);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    },

    async setOfflineStatus(id, status) {
        const db = await dbPromise;
        const transaction = db.transaction([STORE_OFFLINE_STATUS], 'readwrite');
        const store = transaction.objectStore(STORE_OFFLINE_STATUS);
        store.put({ ...status, id });
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    },

    async deleteOfflineStatus(id) {
        const db = await dbPromise;
        const transaction = db.transaction([STORE_OFFLINE_STATUS], 'readwrite');
        const store = transaction.objectStore(STORE_OFFLINE_STATUS);
        store.delete(id);
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    },

    // --- Bug report retry queue (mirrors the pending-shares helpers) ---
    async saveBugReport(report) {
        const db = await dbPromise;
        const transaction = db.transaction([STORE_BUG_REPORTS], 'readwrite');
        transaction.objectStore(STORE_BUG_REPORTS).add({
            ...report,
            queued_at: new Date().toISOString()
        });
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    },

    async getBugReports() {
        const db = await dbPromise;
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_BUG_REPORTS], 'readonly');
            const store = transaction.objectStore(STORE_BUG_REPORTS);
            const request = store.getAll();
            const keyRequest = store.getAllKeys();
            let results, keys;
            const settle = () => {
                if (results !== undefined && keys !== undefined) {
                    resolve(results.map((r, i) => ({ key: keys[i], data: r })));
                }
            };
            request.onsuccess = () => { results = request.result; settle(); };
            keyRequest.onsuccess = () => { keys = keyRequest.result; settle(); };
            request.onerror = () => reject(request.error);
        });
    },

    async deleteBugReport(key) {
        const db = await dbPromise;
        const transaction = db.transaction([STORE_BUG_REPORTS], 'readwrite');
        transaction.objectStore(STORE_BUG_REPORTS).delete(key);
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    }
};
