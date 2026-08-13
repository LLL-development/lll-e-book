/* ==========================================================================
   LLL-E-Book — app.js
   Main controller: wires the UI, handles uploads, switches between the
   library and reader views, and persists reading progress + bookmarks.
   Loaded LAST (after storage.js, file-loader.js, and the renderers).
   ========================================================================== */
(function () {
  'use strict';

  const $ = function (sel) { return document.querySelector(sel); };

  let currentSession = null;
  let currentBookId = null;

  function bookIdFor(file) {
    return file.name + '|' + (file.size || 0) + '|' + (file.lastModified || 0);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showToast(message) {
    let t = document.getElementById('reader-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'reader-toast';
      t.className = 'reader-toast';
      document.body.appendChild(t);
    }
    t.textContent = message;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(function () {
      t.classList.remove('show');
    }, 4000);
  }

  /* ---------------- Views ---------------- */

  function showReader(title) {
    $('#book-title').textContent = title;
    $('#library-view').classList.add('hidden');
    const rv = $('#reader-view');
    rv.classList.remove('hidden');
    rv.classList.remove('reader-entered');
    void rv.offsetWidth; // restart the animation
    rv.classList.add('reader-entered');
  }

  function showLibrary() {
    $('#reader-view').classList.add('hidden');
    $('#library-view').classList.remove('hidden');
  }

  /* ---------------- Library ---------------- */

  function registerBook(file) {
    const id = bookIdFor(file);
    const fmt = window.LLLBook.FileLoader.detectFormat(file);
    window.LLLBook.Storage.saveBook({
      id: id,
      title: file.name,
      format: fmt ? fmt.key : 'unknown',
    });
  }

  function renderLibrary() {
    const books = window.LLLBook.Storage.getBooks();
    const list = $('#library-list');
    list.innerHTML = '';
    const entries = Object.keys(books)
      .map(function (key) { return books[key]; })
      .sort(function (a, b) { return (b.lastOpened || 0) - (a.lastOpened || 0); });

    if (!entries.length) {
      list.innerHTML =
        '<div class="empty">' + window.LLLBook.I18n.t('library.empty') + '</div>';
      return;
    }

    const tones = [
      'cover-terra', 'cover-forest', 'cover-plum', 'cover-ochre', 'cover-slate'
    ];
    entries.forEach(function (b, i) {
      const progress = window.LLLBook.Storage.getProgress(b.id);
      const pct = progress && progress.percent ? progress.percent : 0;
      const tone = tones[i % tones.length];
      const title = escapeHtml(b.title);
      const card = document.createElement('div');
      card.className = 'book-card';
      const fmtLabel = window.LLLBook.I18n.t('format.' + (b.format || 'unknown'));
      card.innerHTML =
        '<div class="book-cover ' + tone + '">' +
          '<span class="book-cover-title">' + title + '</span>' +
          '<span class="book-cover-rule"></span>' +
        '</div>' +
        '<div class="book-body">' +
          '<div class="book-title">' + title + '</div>' +
          '<div class="book-meta">' +
            escapeHtml(window.LLLBook.I18n.t('library.read', { format: fmtLabel, pct: pct })) +
          '</div>' +
          '<div class="book-progress"><span class="book-progress-fill" style="width:' +
          pct + '%"></span></div>' +
        '</div>';
      card.addEventListener('click', function () {
        reopenStoredBook(b);
      });

      const body = card.querySelector('.book-body');

      if (b.too_big) {
        const note = document.createElement('div');
        note.className = 'book-note';
        note.textContent = window.LLLBook.I18n.t('reader.too_big');
        body.insertBefore(note, body.querySelector('.book-progress'));
      }

      if (b.stored) {
        const row = document.createElement('div');
        row.className = 'book-stored';
        const label = document.createElement('span');
        label.className = 'book-stored-label';
        label.textContent = window.LLLBook.I18n.t('reader.stored');
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'book-remove';
        rm.title = window.LLLBook.I18n.t('reader.remove_stored');
        rm.setAttribute('aria-label', window.LLLBook.I18n.t('reader.remove_stored'));
        rm.textContent = '\u2715';
        rm.addEventListener('click', function (ev) {
          ev.stopPropagation();
          removeStored(b);
        });
        row.appendChild(label);
        row.appendChild(rm);
        body.appendChild(row);
      }

      const footer = document.createElement('div');
      footer.className = 'book-footer';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'book-delete';
      del.title = window.LLLBook.I18n.t('book.delete_title');
      del.textContent = window.LLLBook.I18n.t('book.delete');
      del.addEventListener('click', function (ev) {
        ev.stopPropagation();
        deleteBook(b);
      });
      footer.appendChild(del);
      body.appendChild(footer);

      list.appendChild(card);
    });
  }

  /* ---------------- Reading / progress ---------------- */

  function computePercent(loc) {
    if (!loc) return 0;
    if (loc.type === 'scroll') return Math.round((loc.ratio || 0) * 100);
    if (loc.type === 'page' && loc.numPages) {
      return Math.round((loc.page / loc.numPages) * 100);
    }
    return 0;
  }

  function saveProgress() {
    if (!currentSession || !currentBookId) return;
    const loc = typeof currentSession.getLocation === 'function'
      ? currentSession.getLocation() : null;
    if (!loc) return;
    window.LLLBook.Storage.saveProgress(currentBookId, {
      loc: loc,
      percent: computePercent(loc),
      updated: Date.now(),
    });
  }

  function updateProgressLabel() {
    const label = $('#progress-label');
    if (!currentSession || typeof currentSession.getLocation !== 'function') {
      label.textContent = '';
      return;
    }
    const loc = currentSession.getLocation();
    if (!loc) {
      label.textContent = '';
      return;
    }
    if (loc.type === 'page') {
      label.textContent = window.LLLBook.I18n.t('reader.page_of', {
        page: loc.page,
        total: loc.numPages,
      });
    } else if (loc.type === 'scroll') {
      label.textContent = window.LLLBook.I18n.t('reader.percent', {
        pct: Math.round((loc.ratio || 0) * 100),
      });
    } else {
      label.textContent = '';
    }
  }

  function step(dir) {
    if (!currentSession) return;
    const fn = dir < 0 ? currentSession.prev : currentSession.next;
    if (typeof fn !== 'function') return;

    const c = $('#book-container');
    c.classList.remove('page-turn');
    void c.offsetWidth; // restart the animation
    c.classList.add('page-turn');

    Promise.resolve(fn.call(currentSession)).then(function () {
      saveProgress();
      updateProgressLabel();
      updateBookmarkButton();
    });
  }

  /* ---------------- Toolbar actions ---------------- */

  function adjustFont(delta) {
    const current = window.LLLBook.Storage.getFontSize() || 18;
    const next = Math.max(12, Math.min(32, current + delta * 2));
    window.LLLBook.Storage.setFontSize(next);
    applySavedFontSize();
  }

  function applySavedFontSize() {
    const size = window.LLLBook.Storage.getFontSize() || 18;
    document.documentElement.style.setProperty('--reader-font-size', size + 'px');
    if (currentSession && typeof currentSession.setFontSize === 'function') {
      currentSession.setFontSize(size);
    }
  }

  function toggleTheme() {
    const root = document.documentElement;
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    window.LLLBook.Storage.setTheme(next);
  }

  function toggleBookmark() {
    if (!currentSession || !currentBookId) return;
    if (typeof currentSession.getLocation !== 'function') return;
    const loc = currentSession.getLocation();
    if (!loc) return;

    const key = JSON.stringify(loc);
    const bookmarks = window.LLLBook.Storage.getBookmarks(currentBookId);
    const existing = bookmarks.findIndex(function (b) { return b.key === key; });
    if (existing >= 0) {
      bookmarks.splice(existing, 1);
    } else {
      bookmarks.push({ key: key, loc: loc, created: Date.now() });
    }
    window.LLLBook.Storage.setBookmarks(currentBookId, bookmarks);

    const btn = $('#bookmark-btn');
    btn.classList.remove('bump');
    void btn.offsetWidth;
    btn.classList.add('bump');

    updateBookmarkButton();
    renderBookmarks();
  }

  function bookmarksForCurrentBook() {
    if (!currentBookId) return [];
    return window.LLLBook.Storage.getBookmarks(currentBookId);
  }

  function currentLocKey() {
    if (!currentSession || typeof currentSession.getLocation !== 'function') {
      return null;
    }
    const loc = currentSession.getLocation();
    return loc ? JSON.stringify(loc) : null;
  }

  function updateBookmarkButton() {
    const btn = $('#bookmark-btn');
    if (!btn) return;
    const key = currentLocKey();
    const active =
      key != null &&
      bookmarksForCurrentBook().some(function (b) { return b.key === key; });
    btn.classList.toggle('is-bookmarked', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  function bookmarkLabel(bm, index) {
    const loc = bm.loc || {};
    if (loc.type === 'page' && typeof loc.page === 'number') {
      return window.LLLBook.I18n.t('reader.page_of', {
        page: loc.page,
        total: loc.numPages || loc.page,
      });
    }
    if (loc.type === 'scroll' && typeof loc.ratio === 'number') {
      return window.LLLBook.I18n.t('reader.percent', {
        pct: Math.round(loc.ratio * 100),
      });
    }
    return window.LLLBook.I18n.t('bookmarks.label', { n: index + 1 });
  }

  function removeBookmark(key) {
    if (!currentBookId) return;
    const bookmarks = bookmarksForCurrentBook().filter(function (b) {
      return b.key !== key;
    });
    window.LLLBook.Storage.setBookmarks(currentBookId, bookmarks);
    updateBookmarkButton();
    renderBookmarks();
  }

  function highlightBookmarkRow(row) {
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
  }

  function renderBookmarks() {
    const panel = $('#bookmark-list');
    if (!panel) return;
    const bookmarks = bookmarksForCurrentBook();

    if (!bookmarks.length) {
      panel.innerHTML =
        '<p class="empty" style="font-size:13px">' +
        window.LLLBook.I18n.t('bookmarks.empty') + '</p>';
      return;
    }

    panel.innerHTML = '';
    bookmarks.forEach(function (bm, i) {
      const row = document.createElement('div');
      row.className = 'bookmark-item';

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'bookmark-label';
      label.title = window.LLLBook.I18n.t('bookmarks.jump');
      label.textContent = bookmarkLabel(bm, i);
      label.addEventListener('click', function () {
        if (currentSession && typeof currentSession.goTo === 'function') {
          currentSession.goTo(bm.loc).then(function () {
            saveProgress();
            updateProgressLabel();
            updateBookmarkButton();
            highlightBookmarkRow(row);
          });
        }
      });

      const rem = document.createElement('button');
      rem.type = 'button';
      rem.className = 'bookmark-remove';
      rem.title = window.LLLBook.I18n.t('bookmarks.remove');
      rem.setAttribute('aria-label', window.LLLBook.I18n.t('bookmarks.remove'));
      rem.textContent = '\u2715';
      rem.addEventListener('click', function () {
        removeBookmark(bm.key);
      });

      row.appendChild(label);
      row.appendChild(rem);
      panel.appendChild(row);
    });
  }

  function renderToc(session) {
    const list = $('#toc-list');
    if (!list) return;
    if (!session || typeof session.getToc !== 'function') {
      list.innerHTML =
        '<p class="empty">' + window.LLLBook.I18n.t('toc.empty') + '</p>';
      return;
    }
    Promise.resolve(session.getToc())
      .then(function (toc) {
        if (!toc || !toc.length) {
          list.innerHTML =
            '<p class="empty">' + window.LLLBook.I18n.t('toc.empty') + '</p>';
          return;
        }
        list.innerHTML = '';
        toc.forEach(function (entry) {
          if (!entry || !entry.label) return;
          const a = document.createElement('a');
          a.href = 'javascript:void(0)';
          a.style.paddingLeft = (10 + (entry.depth || 0) * 16) + 'px';
          a.textContent = entry.label;
          a.addEventListener('click', function (ev) {
            ev.preventDefault();
            const done =
              entry.target &&
              currentSession &&
              typeof currentSession.goTo === 'function'
                ? currentSession.goTo(entry.target).then(function () {
                    saveProgress();
                    updateProgressLabel();
                    updateBookmarkButton();
                  })
                : Promise.resolve();
            done.then(function () {
              $('#toc-panel').classList.remove('open');
            });
          });
          list.appendChild(a);
        });
      })
      .catch(function () {
        list.innerHTML =
          '<p class="empty">' + window.LLLBook.I18n.t('toc.empty') + '</p>';
      });
  }

  function toggleToc() {
    $('#toc-panel').classList.toggle('open');
  }

  function closeReader() {
    saveProgress();
    if (currentSession && typeof currentSession.destroy === 'function') {
      currentSession.destroy();
    }
    currentSession = null;
    currentBookId = null;
    $('#toc-panel').classList.remove('open');
    showLibrary();
    renderLibrary();
  }

  /* ---------------- Open / upload ---------------- */

  function openBook(file) {
    const id = bookIdFor(file);
    registerBook(file);
    tryStore(file, id);
    renderFromFile(file, id);
  }

  // Keep a copy of the book in IndexedDB so it can be reopened without
  // re-uploading — but skip it if the file is larger than the storage cap.
  function tryStore(file, id) {
    if (!window.LLLBook.StoredBooks) return;
    if (file.size > window.LLLBook.StoredBooks.CAP_BYTES) {
      // Too large to keep offline — record it and tell the user now.
      const books = window.LLLBook.Storage.getBooks();
      if (books[id]) {
        books[id].too_big = true;
        window.LLLBook.Storage.setBooks(books);
        renderLibrary();
      }
      showToast(window.LLLBook.I18n.t('reader.too_big_alert'));
      return;
    }
    window.LLLBook.StoredBooks.save(id, file)
      .then(function () {
        const books = window.LLLBook.Storage.getBooks();
        if (books[id]) {
          books[id].stored = true;
          window.LLLBook.Storage.setBooks(books);
          renderLibrary();
        }
      })
      .catch(function () {
        /* storage unavailable or full — book simply won't persist */
      });
  }

  function renderFromFile(file, id) {
    showReader(file.name);
    const container = $('#book-container');
    container.innerHTML =
      '<div class="loading">' + window.LLLBook.I18n.t('reader.loading') + '</div>';
    const saved = window.LLLBook.Storage.getProgress(id);

    window.LLLBook.FileLoader.dispatch(file, container, { saved: saved })
      .then(function (session) {
        currentSession = session;
        currentBookId = id;
        applySavedFontSize();
        if (saved && saved.loc && typeof session.goTo === 'function') {
          return session.goTo(saved.loc);
        }
        return null;
      })
      .then(function () {
        updateProgressLabel();
        updateBookmarkButton();
        renderBookmarks();
        renderToc(currentSession);
        renderLibrary();
      })
      .catch(function (err) {
        const msg = err && err.message;
        let reason;
        if (msg === 'unsupported') reason = window.LLLBook.I18n.t('reader.unsupported');
        else if (msg === 'jszip-missing') reason = window.LLLBook.I18n.t('reader.cbz_lib_missing');
        else if (msg === 'no-images') reason = window.LLLBook.I18n.t('reader.cbz_no_images');
        else if (msg === 'zip-invalid') reason = window.LLLBook.I18n.t('reader.cbz_not_zip');
        else reason = window.LLLBook.I18n.t('reader.corrupt');
        container.innerHTML =
          '<div class="notice">' +
          window.LLLBook.I18n.t('reader.cannot_open') +
          escapeHtml(reason) + '</div>';
      });
  }

  // Reopen a previously stored book from the Library, no re-upload needed.
  function reopenStoredBook(book) {
    if (!window.LLLBook.StoredBooks) {
      window.alert(window.LLLBook.I18n.t('reader.stored_missing'));
      return;
    }
    window.LLLBook.StoredBooks.load(book.id)
      .then(function (blob) {
        if (!blob) throw new Error('missing');
        const file = new File([blob], book.title || 'book');
        window.LLLBook.Storage.saveBook(book); // refresh "last opened"
        renderFromFile(file, book.id);
      })
      .catch(function () {
        window.alert(window.LLLBook.I18n.t('reader.stored_missing'));
      });
  }

  // Remove a stored copy, only freeing space (the metadata/progress remain).
  function removeStored(book) {
    if (!window.LLLBook.StoredBooks) return;
    window.LLLBook.StoredBooks.remove(book.id)
      .then(function () {
        const books = window.LLLBook.Storage.getBooks();
        if (books[book.id]) {
          books[book.id].stored = false;
          window.LLLBook.Storage.setBooks(books);
        }
        renderLibrary();
      })
      .catch(function () {});
  }

  // Delete a book entirely: record, progress, bookmarks, and any stored copy.
  function deleteBook(book) {
    const msg = window.LLLBook.I18n.t('book.delete_confirm', {
      title: book.title,
    });
    if (!window.confirm(msg)) return;

    if (currentBookId === book.id) {
      closeReader(); // we're deleting the book being read
    }

    if (window.LLLBook.StoredBooks) {
      window.LLLBook.StoredBooks.remove(book.id).catch(function () {});
    }
    window.LLLBook.Storage.deleteBook(book.id);
    renderLibrary();
  }

  function onFiles(e) {
    const files = Array.from(e.target.files || []);
    if (files.length) openBook(files[0]);
    e.target.value = '';
  }

  /* ---------------- Keyboard ---------------- */

  function onKeydown(e) {
    if ($('#reader-view').classList.contains('hidden')) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
  }

  /* ---------------- Init ---------------- */

  function applySavedTheme() {
    const theme = window.LLLBook.Storage.getTheme();
    document.documentElement.setAttribute(
      'data-theme',
      theme === 'dark' ? 'dark' : 'light'
    );
  }

  function init() {
    applySavedTheme();
    applySavedFontSize();
    window.LLLBook.I18n.init();
    renderLibrary();

    const langSel = $('#lang-select');
    if (langSel) {
      langSel.addEventListener('change', function () {
        window.LLLBook.I18n.set(langSel.value);
        renderLibrary();
        renderBookmarks();
        renderToc(currentSession);
      });
    }

    $('#upload-btn').addEventListener('click', function () {
      $('#file-input').click();
    });
    $('#file-input').addEventListener('change', onFiles);
    $('#close-btn').addEventListener('click', closeReader);
    $('#prev-btn').addEventListener('click', function () { step(-1); });
    $('#next-btn').addEventListener('click', function () { step(1); });
    $('#font-minus').addEventListener('click', function () { adjustFont(-1); });
    $('#font-plus').addEventListener('click', function () { adjustFont(1); });
    $('#theme-toggle').addEventListener('click', toggleTheme);
    $('#bookmark-btn').addEventListener('click', toggleBookmark);
    $('#toc-toggle').addEventListener('click', toggleToc);
    document.addEventListener('keydown', onKeydown);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();