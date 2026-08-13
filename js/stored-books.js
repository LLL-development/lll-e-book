/* ==========================================================================
   LLL-E-Book — stored-books.js
   Tiny IndexedDB wrapper that keeps a copy of each uploaded book so it can
   be reopened from the Library without re-uploading. Uses the browser's
   built-in IndexedDB (no database/server, no dependencies).

   IndexedDB stores Blob objects natively, so we keep it simple and store
   the file as-is (PDF/EPUB/CBZ are already compressed internally, and text
   files are tiny). A per-book size cap keeps total storage bounded.

   NOTE: IndexedDB works when the app is served over HTTP (recommended).
   Some browsers restrict it when a page is opened directly from file://,
   so every call here is wrapped to fail gracefully.
   ========================================================================== */
(function () {
  'use strict';

  const DB_NAME = 'lllebook';
  const STORE = 'books';
  const CAP_BYTES = 25 * 1024 * 1024; // 25 MB

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

  /* save(id, blob) -> Promise */
  function save(id, blob) {
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

  /* load(id) -> Promise<Blob|null> */
  function load(id) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction(STORE, 'readonly');
        const req = t.objectStore(STORE).get(id);
        req.onsuccess = function () { resolve(req.result || null); };
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

  /* storedBytes() -> Promise<number> total bytes kept in this store */
  function storedBytes() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction(STORE, 'readonly');
        const req = t.objectStore(STORE).openCursor();
        let total = 0;
        req.onsuccess = function () {
          const cursor = req.result;
          if (cursor) {
            total += (cursor.value && cursor.value.size) || 0;
            cursor.continue();
          } else {
            resolve(total);
          }
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  /* estimate() -> Promise<{usage, quota}> total browser storage, if available */
  function estimate() {
    return new Promise(function (resolve, reject) {
      if (!navigator.storage || typeof navigator.storage.estimate !== 'function') {
        reject(new Error('estimate-unsupported'));
        return;
      }
      navigator.storage.estimate().then(resolve, reject);
    });
  }

  window.LLLBook = window.LLLBook || {};
  window.LLLBook.StoredBooks = {
    CAP_BYTES: CAP_BYTES,
    save: save,
    load: load,
    remove: remove,
    storedBytes: storedBytes,
    estimate: estimate,
  };
})();