/* ==========================================================================
   LLL-E-Book — covers.js
   Tiny IndexedDB wrapper that keeps a cover image for each book so the
   Library cards can show a real cover instead of the gradient placeholder.

   Covers are images (Blob or dataURL string). They must NOT go into
   localStorage (a few MB quota shared with all app metadata), so we use a
   dedicated IndexedDB database, separate from the stored-book-files DB in
   stored-books.js.

   NOTE: IndexedDB works when the app is served over HTTP (recommended).
   Some browsers restrict it when a page is opened directly from file://,
   so every call here is wrapped to fail gracefully (rejects, never throws
   synchronously; callers can just .catch()).
   ========================================================================== */
(function () {
  'use strict';

  const DB_NAME = 'lllebook-covers'; // separate from stored-books.js ('lllebook')
  const STORE = 'covers';

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error);
      };
    });
    return dbPromise;
  }

  function dataURLToBlob(dataURL) {
    const comma = dataURL.indexOf(',');
    if (comma < 0) return null;
    const meta = dataURL.slice(0, comma);
    const payload = dataURL.slice(comma + 1);
    let bin;
    try {
      bin = atob(payload);
    } catch (e) {
      return null;
    }
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    const mimeMatch = /^data:([^;,]+)/.exec(meta);
    const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    return new Blob([bytes], { type: mime });
  }

  /* save(id, coverData) -> Promise ; coverData is a Blob or a dataURL string */
  function save(id, coverData) {
    let blob = null;
    if (coverData instanceof Blob) {
      blob = coverData;
    } else if (typeof coverData === 'string' && coverData.indexOf('data:') === 0) {
      blob = dataURLToBlob(coverData);
    }
    if (!blob) return Promise.resolve(); // nothing usable: succeed quietly
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction(STORE, 'readwrite');
        t.objectStore(STORE).put(blob, id);
        t.oncomplete = function () { resolve(); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  /* load(id) -> Promise<Blob|undefined> */
  function load(id) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction(STORE, 'readonly');
        const req = t.objectStore(STORE).get(id);
        req.onsuccess = function () { resolve(req.result || undefined); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  /* remove(id) -> Promise */
  function remove(id) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction(STORE, 'readwrite');
        t.objectStore(STORE).delete(id);
        t.oncomplete = function () { resolve(); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  window.LLLBook = window.LLLBook || {};
  window.LLLBook.Covers = {
    save: save,
    load: load,
    remove: remove,
  };
})();
