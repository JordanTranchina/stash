// Stash IndexedDB Wrapper
const DB_NAME = 'StashDB';
const DB_VERSION = 1;
const STORE_ARTICLES = 'articles';
const STORE_PENDING = 'pending_saves'; // For offline shares

const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => {
        console.error('IndexedDB error:', event.target.error);
        reject(event.target.error);
    };

    request.onsuccess = (event) => {
        resolve(event.target.result);
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

    async deletePendingShare(key) {
        const db = await dbPromise;
        const transaction = db.transaction([STORE_PENDING], 'readwrite');
        const store = transaction.objectStore(STORE_PENDING);
        store.delete(key);
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    }
};
