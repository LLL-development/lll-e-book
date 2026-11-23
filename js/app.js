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
  let currentPageJump = null; // { type: 'page' | 'slider', total: number }

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

  // Reader-only layout helpers: widen <main> and sync the side-rail collapse
  // state (desktop rail is CSS-only via .rail-collapsed on #reader-view).
  function setMainWide(on) {
    const m = document.querySelector('main');
    if (m) m.classList.toggle('reader-wide', !!on);
  }

  function syncRailState() {
    const rv = $('#reader-view');
    if (!rv) return;
    const collapsed = window.LLLBook.Storage.getRailCollapsed();
    rv.classList.toggle('rail-collapsed', !!collapsed);
    document.body.classList.toggle('rail-collapsed', !!collapsed);
    const toggle = $('#rail-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  function showReader(title, fmt) {
    $('#book-title').textContent = title;
    $('#library-view').classList.add('hidden');
    document.body.classList.add('reader-active');
    const rv = $('#reader-view');
    rv.classList.remove('hidden');
    setMainWide(true);
    syncRailState();
    const isPaged = fmt && (fmt.key === 'pdf' || fmt.key === 'cbz');
    rv.classList.toggle('reader-paged', isPaged);
    // Start both zoom controls hidden: they only appear after a successful
    // open, when updateZoomUI() shows them (presets for PDF, slider for
    // PDF/CBZ). Failed opens leave them off.
    document.getElementById('pdf-zoom-group').style.display = 'none';
    document.getElementById('zoom-slider-group').style.display = 'none';
    rv.classList.remove('reader-entered');
    void rv.offsetWidth; // restart the animation
    rv.classList.add('reader-entered');
    syncReaderLayout();
  }

  function showLibrary() {
    const rv = $('#reader-view');
    rv.classList.add('hidden');
    rv.classList.remove('reader-paged');
    setMainWide(false);
    document.body.classList.remove('reader-active');
    $('#pdf-zoom-group').style.display = 'none';
    $('#library-view').classList.remove('hidden');
    syncReaderLayout();
  }

  // Desktop-only rail collapse controls. #rail-toggle is hidden by CSS at
  // <=640px (!important), so its inline display style never shows on mobile;
  // #rail-expand-float visibility is driven purely by body.rail-collapsed CSS.
  function initRailToggle() {
    const DESKTOP = '(min-width: 641px)';
    const toggle = $('#rail-toggle');
    const expand = $('#rail-expand-float');
    if (toggle) {
      toggle.style.display = window.matchMedia(DESKTOP).matches ? 'flex' : 'none';
      toggle.addEventListener('click', function () {
        window.LLLBook.Storage.setRailCollapsed(true);
        syncRailState();
      });
    }
    if (expand) {
      expand.addEventListener('click', function () {
        window.LLLBook.Storage.setRailCollapsed(false);
        syncRailState();
      });
    }
    const mq = window.matchMedia(DESKTOP);
    const onMQ = function () {
      if (toggle) toggle.style.display = mq.matches ? 'flex' : 'none';
    };
    if (mq.addEventListener) mq.addEventListener('change', onMQ);
    else if (mq.addListener) mq.addListener(onMQ);
  }

  /* ---------------- Reading-card geometry sync (desktop >640px only) ------
     The right rail is position:fixed, so CSS alone cannot know where the
     reading card (.reader-content) sits. These helpers measure the card once
     per animation frame on demand (resize / font-size changes / reader
     open+close) and:
        - syncRailPosition(): pins the rail's top/bottom to the card's exact
          top edge and bottom margin, so the rail spans the same height as the
          card while staying fixed (never scrolls away). min-height stays 0;
          the CSS max-height floor (max(200px, ...)) keeps it visible.
     (The zoom slider used to float over the card's bottom-right corner via
     syncZoomFloat() and --zoom-float-* vars; it now sits inline in the sticky
     reader title row, so that geometry sync was removed.)
     At <=640px the rail pins are cleared so mobile CSS (top bar) rules. */
  function isDesktopRail() {
    return window.matchMedia('(min-width: 641px)').matches;
  }

  function syncRailPosition() {
    const rail = $('#reader-toolbar');
    if (!rail) return;
    if (!isDesktopRail()) {
      rail.style.top = '';
      rail.style.bottom = '';
      return;
    }
    // Only meaningful while the reader is on screen.
    if (document.body.classList.contains('reader-active')) {
      const content = $('#book-container');
      if (content) {
        const rect = content.getBoundingClientRect();
        // Same 200px floor as the CSS fallback: never shrink to nothing.
        if (rect.height >= 200) {
          // Rail top = card's visible top edge; rail bottom = card's visible
          // bottom edge. Clamping rect against the viewport keeps the rail
          // aligned whether or not the page scrolls, with no fixed 18px floor
          // (that floor used to leave an 8px offset when gapBelow was smaller).
          rail.style.top = Math.max(0, Math.round(rect.top)) + 'px';
          const visibleBottom = Math.min(window.innerHeight, rect.bottom);
          const bottom = Math.max(0, Math.round(window.innerHeight - visibleBottom));
          rail.style.bottom = bottom + 'px';
        } else {
          // Card too short: hand top/bottom back to the CSS fallbacks so the
          // rail never ends up off-screen or floating over nothing.
          rail.style.top = '';
          rail.style.bottom = '';
        }
      }
    } else {
      rail.style.top = '';
      rail.style.bottom = '';
    }
  }

  let layoutSyncRaf = 0;
  function syncReaderLayout() {
    if (layoutSyncRaf) cancelAnimationFrame(layoutSyncRaf);
    layoutSyncRaf = requestAnimationFrame(function () {
      layoutSyncRaf = 0;
      syncRailPosition();
    });
  }

  function initReaderLayoutSync() {
    window.addEventListener('resize', syncReaderLayout);
    // The rail is position:fixed, so any scroll that moves the reading card's
    // viewport coordinates must re-sync it. capture:true is required to also
    // catch scrolls inside #book-container (the card itself scrolls
    // internally), not just document-level scrolling. syncReaderLayout
    // coalesces via RAF, so scroll bursts run at most once per frame.
    window.addEventListener('scroll', syncReaderLayout, true);
    const mq = window.matchMedia('(min-width: 641px)');
    if (mq.addEventListener) mq.addEventListener('change', syncReaderLayout);
    else if (mq.addListener) mq.addListener(syncReaderLayout);
    // Reflow-driven geometry changes (card grows/shrinks, header resizes) do
    // not fire resize/scroll; observe them when the API exists.
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { syncReaderLayout(); });
      var card = $('#book-container');
      if (card) ro.observe(card);
      var header = document.querySelector('.reader-header');
      if (header) ro.observe(header);
    }
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

  // Persist real metadata (title/author) discovered by a renderer, but only
  // when it is non-empty and differs from the file-name-based title. The book
  // id never changes; setBook merges so lastOpened/stored/etc. are kept.
  function applySessionMeta(id, session) {
    if (!session) return;
    const books = window.LLLBook.Storage.getBooks();
    const book = books[id];
    if (!book) return;
    const patch = {};
    const metaTitle = session.title ? String(session.title).trim() : '';
    if (metaTitle && metaTitle !== book.title) patch.title = metaTitle;
    const metaAuthor = session.author ? String(session.author).trim() : '';
    if (metaAuthor && metaAuthor !== book.author) patch.author = metaAuthor;
    if (Object.keys(patch).length) {
      window.LLLBook.Storage.setBook(id, patch);
    }
    // A renderer may hand us a cover image (Blob or dataURL string) via
    // session.cover. Persist it in IndexedDB (never localStorage) and refresh
    // the library card once saved. Never let a cover failure break reading.
    if (session.cover && window.LLLBook.Covers) {
      window.LLLBook.Covers.save(id, session.cover)
        .then(function () { renderLibrary(); })
        .catch(function () {});
    }
  }

  function renderLibrary() {
    const books = window.LLLBook.Storage.getBooks();
    const list = $('#library-list');
    revokeCoverUrls(list);
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
          (b.author
            ? '<div class="book-author">' + escapeHtml(b.author) + '</div>'
            : '') +
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
      applyCoverToCard(card, b.id);
    });
  }

  // Revoke every live blob: objectURL held by a cover <img> under `root` and
  // detach the src, so clearing/re-rendering the library does not leak URLs
  // and later revokes cannot double-fire on the same URL.
  function revokeCoverUrls(root) {
    if (!root || !root.querySelectorAll) return;
    const imgs = root.querySelectorAll('.book-cover-img');
    for (let i = 0; i < imgs.length; i++) {
      const src = imgs[i].getAttribute('src');
      imgs[i].removeAttribute('src');
      if (src && src.indexOf('blob:') === 0) {
        try { URL.revokeObjectURL(src); } catch (e) { /* already revoked */ }
      }
    }
  }

  // Try to show a saved cover on a freshly rendered card. The gradient +
  // title placeholder stays as the fallback until (and unless) a cover blob
  // resolves from IndexedDB.
  function applyCoverToCard(card, id) {
    if (!window.LLLBook.Covers) return;
    window.LLLBook.Covers.load(id)
      .then(function (blob) {
        if (!blob) return;
        const cover = card.querySelector('.book-cover');
        if (!cover || !cover.isConnected) return;
        // Replace any previous image (and revoke its objectURL) on re-render.
        const oldImg = cover.querySelector('.book-cover-img');
        if (oldImg) {
          const oldSrc = oldImg.getAttribute('src');
          oldImg.removeAttribute('src');
          if (oldSrc && oldSrc.indexOf('blob:') === 0) {
            URL.revokeObjectURL(oldSrc);
          }
          oldImg.remove();
        }
        const img = document.createElement('img');
        img.className = 'book-cover-img';
        img.alt = '';
        const url = URL.createObjectURL(blob);
        // Attach the image and the has-cover styling only once it actually
        // decoded: a broken blob must leave the gradient + title placeholder
        // untouched instead of overlaying a broken-image icon.
        img.onload = function () {
          if (!cover.isConnected) {
            URL.revokeObjectURL(url);
            return;
          }
          cover.appendChild(img);
          cover.classList.add('has-cover');
        };
        img.onerror = function () {
          URL.revokeObjectURL(url);
        };
        img.src = url;
      })
      .catch(function () {});
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

  function renderPageJump(session) {
    const container = $('#page-jump');
    const input = $('#page-input');
    const totalSpan = $('#page-total');
    const slider = $('#page-slider');
    if (!container || !input || !totalSpan || !slider) return;

    // The read-only progress label duplicates the editable position control
    // (page input / slider) whenever #page-jump is shown, so hide it here and
    // restore it when #page-jump goes away.
    const progressLabel = $('#progress-label');

    // Attach listeners once (shared across all formats)
    if (!input._pageJumpWired) {
      input._pageJumpWired = true;
      input.setAttribute('aria-label', window.LLLBook.I18n.t('reader.go_to_page'));
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); goToPage(input, slider); }
      });
      input.addEventListener('change', function () { goToPage(input, slider); });
    }
    if (!slider._pageJumpWired) {
      slider._pageJumpWired = true;
      slider.setAttribute('aria-label', window.LLLBook.I18n.t('reader.page_slider'));
      slider.addEventListener('input', function () {
        if (!currentSession) return;
        if (currentPageJump && currentPageJump.type !== 'slider') return;
        const v = parseInt(slider.value, 10);
        if (isNaN(v)) return;
        slider.style.setProperty('--fill', v + '%');
        currentSession.goTo({ ratio: v / 100 }).then(function () {
          saveProgress(); updateProgressLabel(); updateBookmarkButton();
        }).catch(function () {});
      });
    }

    if (!session) {
      container.style.display = 'none';
      if (progressLabel) progressLabel.classList.remove('hide-progress');
      return;
    }

    // Page-based formats (PDF, Comic)
    if (typeof session.numPages === 'number' && session.numPages > 0) {
      container.style.display = 'flex';
      if (progressLabel) progressLabel.classList.add('hide-progress');
      input.style.display = 'inline-block';
      slider.style.display = 'none';
      totalSpan.textContent = session.numPages;
      input.min = 1;
      input.max = session.numPages;
      const loc = session.getLocation();
      const pageNum = loc && typeof loc.page === 'number' ? loc.page : 1;
      input.value = pageNum;
      currentPageJump = { type: 'page', total: session.numPages };
      return;
    }

    // Scroll-based formats (Text, FB2)
    container.style.display = 'flex';
    if (progressLabel) progressLabel.classList.add('hide-progress');
    input.style.display = 'none';
    slider.style.display = 'inline-block';
    totalSpan.textContent = '';
    slider.min = 0;
    slider.max = 100;
    currentPageJump = { type: 'slider' };

    updateSliderFromSession();

    if (!window._pageJumpScrollAttached) {
      window._pageJumpScrollAttached = true;
      window._pageJumpScrollHandler = function () {
        if (currentPageJump && currentPageJump.type === 'slider') {
          updateSliderFromSession();
          updateProgressLabel();
          updateBookmarkButton();
          clearTimeout(window._saveProgressTimer);
          window._saveProgressTimer = setTimeout(saveProgress, 500);
        }
      };
      window.addEventListener('scroll', window._pageJumpScrollHandler);
    }
  }

  function updateSliderFromSession() {
    const slider = $('#page-slider');
    if (!slider || !currentSession) return;
    const loc = currentSession.getLocation();
    if (loc && typeof loc.ratio === 'number') {
      slider.value = Math.round(loc.ratio * 100);
    } else if (loc && typeof loc.percentage === 'number') {
      slider.value = Math.round(loc.percentage * 100);
    }
    // keep the rail progress bar's --fill in sync with the real value
    slider.style.setProperty('--fill', (parseInt(slider.value, 10) || 0) + '%');
  }

  function goToPage(input, slider) {
    if (!currentSession) return;
    const val = parseInt(input.value, 10);
    if (isNaN(val)) return;
    const loc = currentSession.getLocation();
    if (loc && typeof loc.page === 'number') {
      const max = (typeof currentSession.numPages === 'number') ? currentSession.numPages : val;
      const page = Math.max(1, Math.min(max, val));
      currentSession.goTo({ page: page }).then(function () {
        saveProgress();
        updateProgressLabel();
        updateBookmarkButton();
        input.value = page;
      }).catch(function () {
        const loc2 = currentSession.getLocation();
        input.value = loc2 && typeof loc2.page === 'number' ? loc2.page : '';
      });
    } else if (slider) {
      const ratio = parseInt(slider.value, 10) / 100;
      currentSession.goTo({ ratio: ratio }).then(function () {
        saveProgress(); updateProgressLabel(); updateBookmarkButton();
      }).catch(function () {});
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
      renderPageJump(currentSession);
    });
  }

  function updateZoomButtons() {
    if (!currentSession) return;
    const mode = currentSession.zoomMode;
    const fitPage = $('#zoom-fit-page');
    const fitWidth = $('#zoom-fit-width');
    const zoom100 = $('#zoom-100');
    if (fitPage) fitPage.classList.toggle('is-active', mode === 'fit-page');
    if (fitWidth) fitWidth.classList.toggle('is-active', mode === 'fit-width');
    if (zoom100) zoom100.classList.toggle('is-active', mode === 'original');
  }

  /* ---------------- Toolbar actions ---------------- */

  function adjustFont(delta) {
    if (currentSession && typeof currentSession.zoomIn === 'function') {
      if (delta > 0) {
        currentSession.zoomIn();
      } else if (delta < 0) {
        currentSession.zoomOut();
      }
      updateZoomUI();
    } else if (currentSession && typeof currentSession.setFontSize === 'function') {
      const current = currentSession.getFontSize ? currentSession.getFontSize() : 16;
      const newSize = Math.max(8, Math.min(32, current + (delta > 0 ? 2 : -2)));
      currentSession.setFontSize(newSize);
    }
  }

  function updateZoomUI() {
    const slider = document.getElementById('zoom-slider');
    const percent = document.getElementById('zoom-percentage');
    const presetGroup = document.getElementById('pdf-zoom-group');
    const sliderGroup = document.getElementById('zoom-slider-group');
    const format = currentSession ? currentSession.format : '';

    // Presets are PDF-only; the slider works for PDF and CBZ. Both only show
    // after a successful open (currentSession set), never on a failed one.
    const hasPresets = !!(currentSession && typeof currentSession.setZoomMode === 'function');
    if (presetGroup) {
      presetGroup.style.display = (format === 'pdf' && hasPresets) ? 'flex' : 'none';
    }

    if (format === 'pdf' || format === 'cbz') {
      const level = currentSession.zoomLevel || 1.0;
      const percentValue = Math.round(level * 100);
      if (slider) slider.value = percentValue;
      if (percent) percent.textContent = percentValue + '%';
      if (sliderGroup) sliderGroup.style.display = 'flex';
    } else {
      if (sliderGroup) sliderGroup.style.display = 'none';
    }

    // Keep preset is-active in sync with the real zoomMode on every path.
    updateZoomButtons();
  }

  function applySavedFontSize() {
    const size = window.LLLBook.Storage.getFontSize() || 18;
    document.documentElement.style.setProperty('--reader-font-size', size + 'px');
    if (currentSession && typeof currentSession.setFontSize === 'function') {
      currentSession.setFontSize(size);
    }
    syncReaderLayout();
  }

  const THEME_NAMES = ['light', 'sepia', 'dark'];

  function setTheme(name) {
    if (THEME_NAMES.indexOf(name) === -1) name = 'light';
    document.documentElement.setAttribute('data-theme', name);
    window.LLLBook.Storage.setTheme(name);
    updateThemeButtons(name);
  }

  function updateThemeButtons(active) {
    const buttons = [
      ['#theme-light', 'light'],
      ['#theme-sepia', 'sepia'],
      ['#theme-dark', 'dark']
    ];
    buttons.forEach(function (pair) {
      const btn = $(pair[0]);
      if (!btn) return;
      const on = pair[1] === active;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    });
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

  /* ---------------- Side-panel accordion (TOC / Bookmarks / Search) ------- */

  // One section open at a time. The header's aria-expanded and the body's
  // hidden attribute are kept in sync; clicking an already-open header keeps it
  // open (always exactly one section stays expanded).
  function setAccSection(header, open) {
    const body = document.getElementById(header.getAttribute('aria-controls'));
    header.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!body) return;
    if (open) body.removeAttribute('hidden');
    else body.setAttribute('hidden', '');
  }

  function openAccSectionByName(name) {
    const headers = document.querySelectorAll('.panel-acc-header');
    headers.forEach(function (header) {
      setAccSection(header, header.parentElement.getAttribute('data-acc') === name);
    });
  }

  function initAccordion() {
    const headers = document.querySelectorAll('.panel-acc-header');
    headers.forEach(function (header) {
      header.addEventListener('click', function () {
        const isOpen = header.getAttribute('aria-expanded') === 'true';
        setAccSection(header, true); // always-one-open: re-click keeps it open
        if (isOpen) return;
        headers.forEach(function (other) {
          if (other !== header) setAccSection(other, false);
        });
      });
    });
  }

  /* ---------------- Search within the book ---------------- */

  // Reset the search box + results and drop any highlights from the current
  // session. Called when a new book opens, the reader closes, or the user
  // clears/escapes the field — so marks never leak into another book's DOM.
  function resetSearchUI() {
    const input = $('#search-input');
    if (input) input.value = '';
    const results = $('#search-results');
    if (results) results.innerHTML = '';
    if (currentSession && typeof currentSession.clearSearch === 'function') {
      currentSession.clearSearch();
    }
  }

  function renderSearchResults(results, hits) {
    results.innerHTML = '';
    const countEl = document.createElement('div');
    countEl.className = 'search-count';
    countEl.textContent = window.LLLBook.I18n.t('search.count', { n: hits.length });
    results.appendChild(countEl);

    hits.forEach(function (hit) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'search-item';
      // Raw snippet text via textContent — never injected as HTML.
      row.textContent = hit.snippet;
      row.addEventListener('click', function () {
        if (!currentSession || typeof currentSession.goTo !== 'function') return;
        currentSession.goTo({ anchor: hit.id }).then(function () {
          saveProgress();
          updateProgressLabel();
          updateBookmarkButton();
        });
      });
      results.appendChild(row);
    });
  }

  function runSearch() {
    const input = $('#search-input');
    const results = $('#search-results');
    if (!input || !results) return;
    openAccSectionByName('search'); // make sure results are visible
    const query = (input.value || '').trim();
    if (!query) { results.innerHTML = ''; return; }
    // Only the open, text-based books expose search(). EPUB/PDF/CBZ do not.
    if (!currentSession || typeof currentSession.search !== 'function') {
      results.innerHTML =
        '<p class="empty">' + window.LLLBook.I18n.t('search.unsupported') + '</p>';
      return;
    }
    Promise.resolve(currentSession.search(query))
      .then(function (hits) {
        if (!hits || !hits.length) {
          results.innerHTML =
            '<p class="empty">' + window.LLLBook.I18n.t('search.no_results') + '</p>';
          return;
        }
        renderSearchResults(results, hits);
      })
      .catch(function () {
        results.innerHTML =
          '<p class="empty">' + window.LLLBook.I18n.t('search.no_results') + '</p>';
      });
  }

  function closeReader() {
    saveProgress();
    if (currentSession && typeof currentSession.clearSearch === 'function') {
      currentSession.clearSearch();
    }
    if (currentSession && typeof currentSession.destroy === 'function') {
      currentSession.destroy();
    }
    if (window._pageJumpScrollHandler) {
      window.removeEventListener('scroll', window._pageJumpScrollHandler);
      window._pageJumpScrollHandler = null;
      window._pageJumpScrollAttached = false;
      clearTimeout(window._saveProgressTimer);
      window._saveProgressTimer = null;
    }
    currentSession = null;
    currentBookId = null;
    currentPageJump = null;
    document.getElementById('zoom-slider-group').style.display = 'none';
    $('#toc-panel').classList.remove('open');
    showLibrary();
    renderLibrary();
    updateButtonLabels();
  }

  /* ---------------- Open / upload ---------------- */

  // Register + persist a picked file in the library without opening it.
  function addBookToList(file) {
    const id = bookIdFor(file);
    registerBook(file);
    tryStore(file, id);
    return id;
  }

  function openBook(file) {
    const id = addBookToList(file);
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
      .catch(function (err) {
        /* storage unavailable or full — book won't persist */
        if (err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014)) {
          showToast(window.LLLBook.I18n.t('reader.storage_full_alert'));
        } else {
          console.warn('tryStore failed:', err);
        }
      });
  }

  function renderFromFile(file, id) {
    resetSearchUI(); // clear the search box/results and any prior highlights
    if (currentSession && typeof currentSession.destroy === 'function') {
    currentSession.destroy();
    currentSession = null;
    }
    const fmt = window.LLLBook.FileLoader.detectFormat(file);
    // Prefer the stored real title (metadata from a previous open) over the
    // file name for the reader header.
    const storedBook = window.LLLBook.Storage.getBook(id);
    showReader((storedBook && storedBook.title) || file.name, fmt);
    const container = $('#book-container');
    container.innerHTML =
      '<div class="loading">' + window.LLLBook.I18n.t('reader.loading') + '</div>';
    const saved = window.LLLBook.Storage.getProgress(id);
    // True only once this call's dispatch resolves. Distinguishes a genuine
    // open failure from a later throw (e.g. progress restore) in the catch.
    let dispatched = false;

    window.LLLBook.FileLoader.dispatch(file, container, { saved: saved })
      .then(function (session) {
        dispatched = true;
        currentSession = session;
        currentBookId = id;
        applySessionMeta(id, session);
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
        renderPageJump(currentSession);
        renderLibrary();
        // Zoom controls (presets for PDF, slider for PDF/CBZ) are shown here,
        // only after a successful open, in one place.
        updateZoomUI();
        updateButtonLabels();
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
        // Opening failed: make sure neither the preset group nor the floating
        // zoom slider lingers over the error notice (showReader already inits
        // both hidden; this also covers a failure after a previous successful
        // PDF/CBZ session).
        document.getElementById('pdf-zoom-group').style.display = 'none';
        document.getElementById('zoom-slider-group').style.display = 'none';
        // A failed open never reaches renderPageJump, so reset the page-jump
        // controls (and the progress label's hide flag) here as well.
        renderPageJump(null);
        // Only drop the book when opening itself failed (dispatch never
        // resolved). If it opened but a later step threw — e.g. restoring the
        // saved position via goTo — the book is fine, so keep it in the library.
        if (!dispatched) removeFailedBook(id);
      });
  }

  // Purge a book that failed to open: record, progress, bookmarks, stored copy.
  function removeFailedBook(id) {
    if (window.LLLBook.StoredBooks) {
      window.LLLBook.StoredBooks.remove(id).catch(function () {});
    }
    if (window.LLLBook.Covers) {
      window.LLLBook.Covers.remove(id).catch(function () {});
    }
    window.LLLBook.Storage.deleteBook(id);
    renderLibrary();
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
    if (window.LLLBook.Covers) {
      window.LLLBook.Covers.remove(book.id).catch(function () {});
    }
    window.LLLBook.Storage.deleteBook(book.id);
    renderLibrary();
  }

  function onFiles(e) {
    const files = Array.from(e.target.files || []);
    registerAndOpenFiles(files);
    e.target.value = '';
  }

  // Shared by the file picker and drag&drop: register every picked file,
  // then open only the first one in the reader.
  function registerAndOpenFiles(files) {
    if (files.length) {
      files.forEach(addBookToList);
      openBook(files[0]);
    }
  }

  /* ---------------- Drag & drop ---------------- */

  let dragDepth = 0; // enter/leave counter: the overlay hides only at 0

  function isFileDrag(e) {
    if (!e.dataTransfer) return false;
    const types = Array.from(e.dataTransfer.types || []);
    return types.indexOf('Files') !== -1;
  }

  function showDropOverlay() {
    const overlay = $('#drop-overlay');
    if (overlay) overlay.classList.add('visible');
  }

  function hideDropOverlay() {
    dragDepth = 0;
    const overlay = $('#drop-overlay');
    if (overlay) overlay.classList.remove('visible');
  }

  function onDragEnter(e) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    showDropOverlay();
  }

  function onDragOver(e) {
    if (!isFileDrag(e)) return;
    // Without preventDefault the browser opens dropped files in a new tab.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    showDropOverlay();
  }

  function onDragLeave(e) {
    if (!isFileDrag(e)) return;
    // Fires on every child element crossed; only the last leave hides it.
    dragDepth--;
    if (dragDepth <= 0) hideDropOverlay();
  }

  function onDrop(e) {
    e.preventDefault();
    hideDropOverlay();
    if (!isFileDrag(e)) return;
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    registerAndOpenFiles(files);
  }

  /* ---------------- Keyboard ---------------- */

  function onKeydown(e) {
    if ($('#reader-view').classList.contains('hidden')) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'g' || e.key === 'G') {
      e.preventDefault();
      const input = $('#page-input');
      if (input && input.style.display !== 'none') {
        input.focus();
        input.select();
      }
      return;
    }
    if (e.key === '=' || e.key === '+') {
      if (currentSession && typeof currentSession.zoomIn === 'function') {
        currentSession.zoomIn();
        updateZoomUI();
      }
    } else if (e.key === '-' || e.key === '_') {
      if (currentSession && typeof currentSession.zoomOut === 'function') {
        currentSession.zoomOut();
        updateZoomUI();
      }
    } else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
  }

  /* ---------------- Init ---------------- */

  function applySavedTheme() {
    const theme = window.LLLBook.Storage.getTheme();
    setTheme(THEME_NAMES.indexOf(theme) !== -1 ? theme : 'light');
  }

  function updateButtonLabels() {
    const format = currentSession ? currentSession.format : '';
    const isZoom = (format === 'pdf' || format === 'cbz');

    const minusBtn = $('#font-minus');
    const plusBtn = $('#font-plus');

    if (minusBtn) {
      minusBtn.title = isZoom ? 'Zoom out' : 'Decrease font size';
      minusBtn.setAttribute('aria-label', isZoom ? 'Zoom out' : 'Decrease font size');
    }
    if (plusBtn) {
      plusBtn.title = isZoom ? 'Zoom in' : 'Increase font size';
      plusBtn.setAttribute('aria-label', isZoom ? 'Zoom in' : 'Increase font size');
    }
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
    // mobile bottom bar: reuse the shared step() — no new page-turn logic
    const prevBtnBottom = $('#prev-btn-bottom');
    const nextBtnBottom = $('#next-btn-bottom');
    if (prevBtnBottom) prevBtnBottom.addEventListener('click', function () { step(-1); });
    if (nextBtnBottom) nextBtnBottom.addEventListener('click', function () { step(1); });
    $('#font-minus').addEventListener('click', function () { adjustFont(-1); });
    $('#font-plus').addEventListener('click', function () { adjustFont(1); });
    $('#theme-light').addEventListener('click', function () { setTheme('light'); });
    $('#theme-sepia').addEventListener('click', function () { setTheme('sepia'); });
    $('#theme-dark').addEventListener('click', function () { setTheme('dark'); });
    $('#bookmark-btn').addEventListener('click', toggleBookmark);
    $('#toc-toggle').addEventListener('click', toggleToc);
    initAccordion();
    initRailToggle();
    initReaderLayoutSync();

    const searchInput = $('#search-input');
    const searchBtn = $('#search-btn');
    if (searchBtn) searchBtn.addEventListener('click', runSearch);
    if (searchInput) {
      searchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
        else if (e.key === 'Escape') { resetSearchUI(); }
      });
      // Clearing the field by any means (backspace, clear button) drops marks.
      searchInput.addEventListener('input', function () {
        if (!(searchInput.value || '').trim()) resetSearchUI();
      });
    }
    $('#zoom-fit-page').addEventListener('click', function () {
      if (currentSession && typeof currentSession.setZoomMode === 'function') {
        currentSession.setZoomMode('fit-page').then(updateZoomUI);
      }
    });
    $('#zoom-fit-width').addEventListener('click', function () {
      if (currentSession && typeof currentSession.setZoomMode === 'function') {
        currentSession.setZoomMode('fit-width').then(updateZoomUI);
      }
    });
    $('#zoom-100').addEventListener('click', function () {
      if (currentSession && typeof currentSession.setZoomMode === 'function') {
        currentSession.setZoomMode('original').then(updateZoomUI);
      }
    });
    const zoomSlider = document.getElementById('zoom-slider');
    if (zoomSlider) {
      zoomSlider.addEventListener('input', function(e) {
        if (currentSession && typeof currentSession.setZoomLevel === 'function') {
          const level = parseInt(e.target.value) / 100;
          currentSession.setZoomLevel(level);
          // Reflect the real (clamped) level and sync presets, not the raw input.
          updateZoomUI();
        }
      });
    }
    document.addEventListener('keydown', onKeydown);

    // Accept book files dropped anywhere on the page.
    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);

    // EPUB relocated event for page/slider updates
    document.addEventListener('epub-relocated', function () {
      if (!currentSession) return;

      const loc = currentSession.getLocation();

      // Update page input for page-based formats (PDF, CBZ, EPUB)
      if (currentPageJump && currentPageJump.type === 'page' && loc && typeof loc.page === 'number') {
        const input = $('#page-input');
        if (input) {
          input.value = loc.page;
        }
      }

      // Update slider for scroll-based formats (Text, FB2)
      if (currentPageJump && currentPageJump.type === 'slider') {
        updateSliderFromSession();
      }

      // Always update progress label
      updateProgressLabel();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();