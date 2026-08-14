/* ==========================================================================
   LLL-E-Book — storage.js
   Namespaced localStorage helpers: book registry, reading progress, bookmarks.
   All code is attached to the shared LLLBook namespace (no ES modules, so the
   app works when opened directly from the filesystem via file://).
   ========================================================================== */
(function () {
  'use strict';

  const NS = 'lllebook.';
  const BOOKS_KEY = NS + 'books';
  const PROGRESS_PREFIX = NS + 'progress.';
  const BOOKMARK_PREFIX = NS + 'bookmarks.';
  const THEME_KEY = NS + 'theme';
  const LANG_KEY = NS + 'lang';
  const FONT_KEY = NS + 'fontsize';

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* Storage full or unavailable (private mode, etc.) — fail silently. */
    }
  }

  const Storage = {
    /* ---- book registry ---- */
    saveBook(book) {
      const books = this.getBooks();
      books[book.id] = Object.assign({}, books[book.id], book, {
        lastOpened: Date.now(),
      });
      write(BOOKS_KEY, books);
    },
    getBooks() {
      return read(BOOKS_KEY, {});
    },
    getBook(id) {
      return this.getBooks()[id] || null;
    },
    setBooks(books) {
      localStorage.setItem(BOOKS_KEY, JSON.stringify(books));
    },
    setBook(id, book) {
      const books = this.getBooks();
      books[id] = Object.assign({}, books[id], book);
      write(BOOKS_KEY, books);
    },

    /* ---- reading progress ---- */
    saveProgress(id, progress) {
      write(PROGRESS_PREFIX + id, progress);
    },
    getProgress(id) {
      return read(PROGRESS_PREFIX + id, null);
    },

    /* ---- bookmarks ---- */
    getBookmarks(id) {
      return read(BOOKMARK_PREFIX + id, []);
    },
    setBookmarks(id, list) {
      write(BOOKMARK_PREFIX + id, list);
    },

    /* ---- delete a book's record, progress and bookmarks ---- */
    deleteBook(id) {
      const books = this.getBooks();
      if (books[id]) {
        delete books[id];
        write(BOOKS_KEY, books);
      }
      try { localStorage.removeItem(PROGRESS_PREFIX + id); } catch (e) {}
      try { localStorage.removeItem(BOOKMARK_PREFIX + id); } catch (e) {}
    },

    /* ---- theme preference ---- */
    getTheme() {
      return read(THEME_KEY, 'light');
    },
    setTheme(theme) {
      write(THEME_KEY, theme);
    },

    /* ---- interface language ---- */
    getLang() {
      return read(LANG_KEY, 'en');
    },
    setLang(lang) {
      write(LANG_KEY, lang);
    },

    /* ---- reader font size ---- */
    getFontSize() {
      return read(FONT_KEY, 18);
    },
    setFontSize(size) {
      write(FONT_KEY, size);
    },
  };

  window.LLLBook = window.LLLBook || {};
  window.LLLBook.Storage = Storage;
})();