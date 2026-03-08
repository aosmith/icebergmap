// IndexedDB wrapper for local sighting storage
// No user data, no identity — just sightings and confirmations

const DB_NAME = 'boatlift';
const DB_VERSION = 1;

let db = null;

export function openDB() {
    return new Promise((resolve, reject) => {
        if (db) return resolve(db);

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const database = event.target.result;

            if (!database.objectStoreNames.contains('sightings')) {
                const store = database.createObjectStore('sightings', { keyPath: 'id' });
                store.createIndex('received_at', 'received_at');
                store.createIndex('report_type', 'report_type');
                store.createIndex('state', 'state');
            }

            if (!database.objectStoreNames.contains('confirmations')) {
                const store = database.createObjectStore('confirmations', { keyPath: 'id' });
                store.createIndex('sighting_id', 'sighting_id');
            }

            if (!database.objectStoreNames.contains('settings')) {
                database.createObjectStore('settings', { keyPath: 'key' });
            }
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            resolve(db);
        };

        request.onerror = (event) => {
            reject(new Error(`IndexedDB error: ${event.target.error}`));
        };
    });
}

export async function saveSighting(sighting) {
    const database = await openDB();
    return new Promise((resolve, reject) => {
        const tx = database.transaction('sightings', 'readwrite');
        const store = tx.objectStore('sightings');
        // Use put (upsert) — same sighting from multiple peers is fine
        store.put(sighting);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
    });
}

export async function getSightings({ type, state, limit = 100 } = {}) {
    const database = await openDB();
    return new Promise((resolve, reject) => {
        const tx = database.transaction('sightings', 'readonly');
        const store = tx.objectStore('sightings');
        const request = store.index('received_at').openCursor(null, 'prev');
        const results = [];

        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor && results.length < limit) {
                const s = cursor.value;
                if (type && s.report_type !== type) { cursor.continue(); return; }
                if (state && s.state !== state) { cursor.continue(); return; }
                results.push(s);
                cursor.continue();
            } else {
                resolve(results);
            }
        };
        request.onerror = (e) => reject(e.target.error);
    });
}

export async function getSightingsWithLocation() {
    const database = await openDB();
    return new Promise((resolve, reject) => {
        const tx = database.transaction('sightings', 'readonly');
        const store = tx.objectStore('sightings');
        const request = store.getAll();

        request.onsuccess = (event) => {
            resolve(event.target.result.filter(s => s.latitude != null && s.longitude != null));
        };
        request.onerror = (e) => reject(e.target.error);
    });
}

export async function sightingExists(id) {
    const database = await openDB();
    return new Promise((resolve, reject) => {
        const tx = database.transaction('sightings', 'readonly');
        const store = tx.objectStore('sightings');
        const request = store.count(id);
        request.onsuccess = () => resolve(request.result > 0);
        request.onerror = (e) => reject(e.target.error);
    });
}

export async function saveConfirmation(confirmation) {
    const database = await openDB();
    return new Promise((resolve, reject) => {
        const tx = database.transaction('confirmations', 'readwrite');
        const store = tx.objectStore('confirmations');
        store.put(confirmation);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
    });
}

export async function getConfirmationCounts(sightingId) {
    const database = await openDB();
    return new Promise((resolve, reject) => {
        const tx = database.transaction('confirmations', 'readonly');
        const store = tx.objectStore('confirmations');
        const index = store.index('sighting_id');
        const request = index.getAll(sightingId);

        request.onsuccess = (event) => {
            const all = event.target.result;
            resolve({
                confirms: all.filter(c => c.confirmed).length,
                disputes: all.filter(c => !c.confirmed).length
            });
        };
        request.onerror = (e) => reject(e.target.error);
    });
}

export async function getSightingCount() {
    const database = await openDB();
    return new Promise((resolve, reject) => {
        const tx = database.transaction('sightings', 'readonly');
        const store = tx.objectStore('sightings');
        const request = store.count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

export async function purgeOldSightings(days) {
    const database = await openDB();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    return new Promise((resolve, reject) => {
        const tx = database.transaction(['sightings', 'confirmations'], 'readwrite');
        const sightingStore = tx.objectStore('sightings');
        const confirmStore = tx.objectStore('confirmations');
        const request = sightingStore.index('received_at').openCursor(IDBKeyRange.upperBound(cutoff));
        let deleted = 0;

        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                // Delete associated confirmations
                const confIndex = confirmStore.index('sighting_id');
                const confReq = confIndex.openCursor(IDBKeyRange.only(cursor.value.id));
                confReq.onsuccess = (e) => {
                    const cc = e.target.result;
                    if (cc) { cc.delete(); cc.continue(); }
                };
                cursor.delete();
                deleted++;
                cursor.continue();
            }
        };

        tx.oncomplete = () => resolve(deleted);
        tx.onerror = (e) => reject(e.target.error);
    });
}

export async function getAllSightingIds() {
    const database = await openDB();
    return new Promise((resolve, reject) => {
        const tx = database.transaction('sightings', 'readonly');
        const store = tx.objectStore('sightings');
        const request = store.getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

export async function getSightingsById(ids) {
    const database = await openDB();
    return new Promise((resolve, reject) => {
        const tx = database.transaction('sightings', 'readonly');
        const store = tx.objectStore('sightings');
        const results = [];
        let pending = ids.length;

        if (pending === 0) { resolve([]); return; }

        for (const id of ids) {
            const request = store.get(id);
            request.onsuccess = () => {
                if (request.result) results.push(request.result);
                if (--pending === 0) resolve(results);
            };
            request.onerror = () => {
                if (--pending === 0) resolve(results);
            };
        }
    });
}

export async function estimatePhotoStorage() {
    const database = await openDB();
    return new Promise((resolve, reject) => {
        const tx = database.transaction('sightings', 'readonly');
        const store = tx.objectStore('sightings');
        const request = store.getAll();

        request.onsuccess = () => {
            let totalBytes = 0;
            for (const s of request.result) {
                if (s.photos) {
                    for (const p of s.photos) {
                        totalBytes += (p.length - p.indexOf(',') - 1) * 0.75;
                    }
                }
            }
            resolve(totalBytes);
        };
        request.onerror = (e) => reject(e.target.error);
    });
}

export async function evictOldestPhotos(targetBytes) {
    const database = await openDB();
    return new Promise((resolve, reject) => {
        const tx = database.transaction('sightings', 'readwrite');
        const store = tx.objectStore('sightings');
        const request = store.index('received_at').openCursor();
        let freed = 0;

        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor && freed < targetBytes) {
                const s = cursor.value;
                if (s.photos && s.photos.length > 0) {
                    for (const p of s.photos) {
                        freed += (p.length - p.indexOf(',') - 1) * 0.75;
                    }
                    s.photos = null;
                    cursor.update(s);
                }
                cursor.continue();
            }
        };

        tx.oncomplete = () => resolve(freed);
        tx.onerror = (e) => reject(e.target.error);
    });
}

export async function getAllConfirmationIds() {
    const database = await openDB();
    return new Promise((resolve, reject) => {
        const tx = database.transaction('confirmations', 'readonly');
        const store = tx.objectStore('confirmations');
        const request = store.getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

export async function getConfirmationsById(ids) {
    const database = await openDB();
    return new Promise((resolve, reject) => {
        const tx = database.transaction('confirmations', 'readonly');
        const store = tx.objectStore('confirmations');
        const results = [];
        let pending = ids.length;
        if (pending === 0) { resolve([]); return; }
        for (const id of ids) {
            const request = store.get(id);
            request.onsuccess = () => {
                if (request.result) results.push(request.result);
                if (--pending === 0) resolve(results);
            };
            request.onerror = () => {
                if (--pending === 0) resolve(results);
            };
        }
    });
}

export async function getLocalVote(sightingId) {
    const database = await openDB();
    return new Promise((resolve, reject) => {
        const tx = database.transaction('confirmations', 'readonly');
        const store = tx.objectStore('confirmations');
        const index = store.index('sighting_id');
        const request = index.getAll(sightingId);
        request.onsuccess = () => {
            const local = request.result.find(c => c.id.startsWith('local_'));
            resolve(local ? local.confirmed : null);
        };
        request.onerror = (e) => reject(e.target.error);
    });
}

export async function clearAllData() {
    const database = await openDB();
    return new Promise((resolve, reject) => {
        const tx = database.transaction(['sightings', 'confirmations'], 'readwrite');
        tx.objectStore('sightings').clear();
        tx.objectStore('confirmations').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
    });
}
