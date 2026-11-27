/* ==========================================================================
   LLL-E-Book — renderers/epub.js
   Renders EPUB (and best-effort FB2) files via epub.js (loaded via CDN).
   Locations are EPUB CFI strings, which let us restore reading position.
   ========================================================================== */
(function () {
  'use strict';

  function ensureEpubJs() {
    if (typeof window.ePub !== 'function') {
      return Promise.reject(new Error('epub-library-missing'));
    }
    return Promise.resolve();
  }

  function flattenToc(items, depth) {
    depth = depth || 0;
    let out = [];
    (items || []).forEach(function (item) {
      out.push({ label: item.label, target: item.href, depth: depth });
      if (item.subitems && item.subitems.length) {
        out = out.concat(flattenToc(item.subitems, depth + 1));
      }
    });
    return out;
  }

  // epub.js exposes parsing as a set of internal promises (book.loaded.*).
  // A corrupt ZIP/OPF rejects the package.xml-driven promises (packaging and
  // metadata) without always surfacing through the open .catch() chain, so we
  // watch those directly and reject as soon as either fails. book.ready is
  // intentionally NOT watched: in epub.js it resolves via Promise.all that also
  // includes navigation (the TOC), so watching it would reject books that are
  // perfectly readable but merely missing/broken in their TOC — contradicting
  // the non-fatal policy for a missing TOC (getToc already falls back to []).
  function attachEarlyParseFailure(book, onError) {
    if (!book || !book.loaded) return;
    var watched = [book.loaded.metadata, book.loaded.packaging];
    watched.forEach(function (p) {
      if (p && typeof p.then === 'function') {
        p.then(null, function () { onError(); });
      }
    });
  }

  // Shrink an image (Blob or dataURL) to a library-thumbnail-sized JPEG
  // dataURL. Purely best-effort: any failure (decode error, tainted canvas,
  // unsupported type) resolves with null so the caller leaves session.cover
  // unset and the book still opens.
  function shrinkToDataURL(src) {
    return new Promise(function (resolve) {
      var url = null;
      var img = new Image();
      function cleanup() {
        if (url && typeof URL !== 'undefined' && URL.revokeObjectURL) {
          try { URL.revokeObjectURL(url); } catch (e) { /* already revoked */ }
        }
      }
      function done(value) { cleanup(); resolve(value); }
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width;
          var h = img.naturalHeight || img.height;
          if (!w || !h) { done(null); return; }
          var scale = Math.min(1, COVER_MAX_WIDTH / w, COVER_MAX_HEIGHT / h);
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          var out = canvas.toDataURL('image/jpeg', 0.82);
          // A canvas over the browser's dataURL size limit yields "data:," —
          // treat anything that is not an image dataURL as no cover.
          done(typeof out === 'string' && out.indexOf('data:image/') === 0 ? out : null);
        } catch (e) {
          // Tainted canvas (CORS) or draw failure — no cover, never fatal.
          done(null);
        }
      };
      img.onerror = function () { done(null); };
      try {
        if (typeof Blob !== 'undefined' && src instanceof Blob) {
          url = URL.createObjectURL(src);
          img.src = url;
        } else {
          img.src = String(src);
        }
      } catch (e) {
        done(null);
      }
    });
  }

  // Library thumbnail bounds (both axes capped) and the budget for cover
  // resolution. The cover is enrichment only: if book.loaded.cover or the
  // shrink pipeline never settles, we must not keep the session from opening.
  var COVER_MAX_WIDTH = 360;
  var COVER_MAX_HEIGHT = 480;
  var COVER_TIMEOUT_MS = 2500;

  // Resolve the EPUB cover image to a small JPEG dataURL. epub.js computes
  // book.cover during unpack() from packaging.coverPath, which Packaging
  // finds via <item properties="cover-image"> (EPUB 3) or
  // <meta name="cover"> (EPUB 2 fallback). For archived EPUBs (we always
  // open from an ArrayBuffer) archive.createUrl(url, {base64:true}) returns
  // a "data:..." URL directly from the zip entry. Best-effort: any missing
  // piece or failure resolves with null.
  // Fallback cover pick for EPUBs without a declared cover. Packaging
  // (epub.js 0.3.93 src/packaging.js) gives:
  //   packaging.manifest — plain object, id → { href, type, overlay,
  //     properties[] } (note: the media-type attribute is stored as `type`)
  //   packaging.spine    — array of { idref, linear, properties, index }
  // Priority: (a) first image following spine reading order (linear="no"
  // refs skipped), (b) first image in manifest walk order. Only items whose
  // type starts with "image/" are considered; SVG is excluded because it
  // tends to fail/taint the canvas in shrinkToDataURL (harmless but useless).
  // Among candidates, a basename that starts with "cover" (cover.jpg,
  // COVER_1.png) wins as closest to a real title page; a plain substring
  // match would also catch unrelated names like discover.png. Returns ''
  // when nothing qualifies.
  function pickFallbackImageHref(packaging) {
    if (!packaging || !packaging.manifest) return '';
    var manifest = packaging.manifest;
    function imageItem(id) {
      var item = manifest[id];
      if (!item || !item.href) return null;
      var type = String(item.type || '').toLowerCase();
      if (type.indexOf('image/') !== 0) return null;
      if (type === 'image/svg+xml') return null;
      return item;
    }
    var first = null;
    var preferred = null;
    function consider(id) {
      var item = imageItem(id);
      if (!item) return;
      if (!first) first = item;
      if (!preferred) {
        var basename = String(item.href).split('/').pop().toLowerCase();
        if (basename.indexOf('cover') === 0) preferred = item;
      }
    }
    var spine = packaging.spine;
    if (Array.isArray(spine) && spine.length) {
      spine.forEach(function (ref) {
        if (preferred) return;
        if (ref && ref.linear !== 'no') consider(ref.idref);
      });
    }
    // Manifest walk only when the spine carried no image at all (spec: b).
    if (!first) {
      Object.keys(manifest).forEach(function (id) {
        consider(id);
      });
    }
    var picked = preferred || first;
    return picked ? picked.href : '';
  }

  // Some EPUB producers do not put a cover in package metadata (or list their
  // images with unhelpful names such as "001.jpg"). In that case the only
  // reliable hint is often the first image actually used by the opening spine
  // documents. Keep this bounded: it is a last-resort thumbnail heuristic, not
  // a full book scan, and must never delay opening the reader indefinitely.
  function isRasterImagePath(path) {
    return /\.(?:avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i.test(String(path || ''));
  }

  function resolveSectionAssetPath(section, src) {
    if (!section || !src || /^(?:data:|blob:|https?:|file:)/i.test(src)) return '';
    try {
      // `section.url` is the already-resolved archive path (normally
      // /OEBPS/text/chapter.xhtml). Give URL a throwaway origin so it can
      // normalize ../ segments without turning the asset into a network URL.
      var base = String(section.url || section.href || '');
      if (base.charAt(0) !== '/') base = '/' + base;
      return new URL(String(src), 'https://epub.local' + base).pathname;
    } catch (e) {
      return '';
    }
  }

  function findChapterImagePath(book) {
    var spine = book && book.spine;
    var sections = spine && (spine.spineItems || spine.items);
    if (!sections || !sections.length) return Promise.resolve('');
    var index = 0;
    var limit = Math.min(sections.length, 3);
    function next() {
      if (index >= limit) return Promise.resolve('');
      var section = sections[index++];
      if (!section || section.linear === false || typeof section.load !== 'function') return next();
      return Promise.resolve(section.load())
        .then(function (contents) {
          var doc = section.document || contents;
          if (!doc || typeof doc.querySelectorAll !== 'function') return '';
          var images = doc.querySelectorAll('img[src]');
          for (var i = 0; i < images.length; i++) {
            var path = resolveSectionAssetPath(section, images[i].getAttribute('src'));
            if (isRasterImagePath(path)) return path;
          }
          return '';
        })
        .catch(function () { return ''; })
        .then(function (path) { return path || next(); });
    }
    return next();
  }

  function archiveUrlForPath(book, path) {
    if (!path || !book || !book.archived || !book.archive) return Promise.resolve(null);
    return book.archive.createUrl(path, { base64: true }).catch(function () {
      return null;
    });
  }

  // epub.js 0.3.93 has no book.loaded.packaging (that name only exists in the
  // 0.4 line). In 0.3.93 unpack() does loading.cover.resolve(this.cover), so
  // book.loaded.cover resolves with undefined when no cover is declared — but
  // we keep the .catch below so the fallback also runs if a future/patched
  // build rejects here instead. Declared-cover books behave as before.
  function resolveCover(book) {
    // TEMP diagnostic logs (prefix "[EPUB cover]") — remove after cover issue triage.
    console.log('[EPUB cover] start', { archived: book.archived, hasArchive: !!(book.archived && book.archive) });
    return book.loaded.cover
      .then(function (coverPath) {
        console.log('[EPUB cover] declared coverPath =', coverPath);
        if (!coverPath || !book.archived || !book.archive) return null;
        return book.archive.createUrl(coverPath, { base64: true })
          .then(function (u) {
            console.log('[EPUB cover] declared createUrl ->', u ? String(u).slice(0, 20) : u);
            return u;
          }, function (err) {
            console.log('[EPUB cover] declared createUrl ERROR', err);
            throw err;
          });
      })
      .catch(function (err) {
        console.log('[EPUB cover] declared cover rejected/empty -> fallback', err);
        return null;
      })
      .then(function (dataUrl) {
        if (dataUrl) return dataUrl;
        // No declared cover (or its fetch failed): try the first image in the
        // package instead. unpack() sets book.packaging before resolving
        // book.loaded.cover, so the Packaging object is already available.
        var pkg = book.loaded.packaging
          ? book.loaded.packaging
          : Promise.resolve(book.packaging);
        return pkg.then(function (packaging) {
          console.log('[EPUB cover] fallback packaging =', !!packaging, 'manifest =', !!(packaging && packaging.manifest));
          var href = pickFallbackImageHref(packaging);
          console.log('[EPUB cover] fallback href =', href);
          if (!href || !book.archived || !book.archive) return null;
          // manifest href is OPF-relative (e.g. "images/cover.jpg") but the zip
          // key is the full path (e.g. "/OEBPS/images/cover.jpg"). Declared
          // covers work because book.js stores this.cover = this.resolve(...)
          // (src/book.js L486-493), so resolve the same way here.
          var resolved = (typeof book.resolve === 'function') ? book.resolve(href) : href;
          console.log('[EPUB cover] resolved =', resolved);
          return archiveUrlForPath(book, resolved)
            .then(function (u) {
              console.log('[EPUB cover] fallback createUrl ->', u ? String(u).slice(0, 20) : u);
              return u;
            }, function (err) {
              console.log('[EPUB cover] fallback createUrl ERROR', err);
              throw err;
            });
        });
      })
      .then(function (dataUrl) {
        if (dataUrl) return dataUrl;
        // Final fallback: pull the first usable image from the opening pages.
        return findChapterImagePath(book).then(function (path) {
          console.log('[EPUB cover] chapter-image fallback path =', path);
          return archiveUrlForPath(book, path);
        });
      })
      .then(function (dataUrl) {
        // Archive.createUrl caches by archive path, not by its `base64` option.
        // If epub.js already prepared the same asset for the rendition, this
        // can therefore be a blob URL even though we requested base64. The
        // thumbnail decoder supports both, so do not discard that valid cover.
        if (!dataUrl || typeof dataUrl !== 'string' ||
            (dataUrl.indexOf('data:') !== 0 && dataUrl.indexOf('blob:') !== 0)) return null;
        return shrinkToDataURL(dataUrl);
      })
      .then(function (dataUrl) {
        console.log('[EPUB cover] final dataUrl prefix =', dataUrl ? String(dataUrl).slice(0, 20) : dataUrl);
        return dataUrl;
      })
      .catch(function (err) {
        console.log('[EPUB cover] FINAL null (error absorbed)', err);
        return null;
      });
  }

  // Cover resolution gets a hard budget: whatever happens (pending promise,
  // synchronous throw inside the chain), it settles as null within
  // COVER_TIMEOUT_MS so opening the book is never blocked by the cover.
  function resolveCoverWithTimeout(book) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        resolve(null);
      }, COVER_TIMEOUT_MS);
      try {
        resolveCover(book).then(function (cover) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(cover || null);
        }, function () {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(null);
        });
      } catch (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  // Safety net: if display never resolves within the budget (e.g. an epub.js
  // internal rejection on a path we do not watch), reject so the UI can show
  // an error instead of hanging on "Loading…". Kept long enough that large but
  // valid EPUBs are not failed by mistake.
  var DISPLAY_TIMEOUT_MS = 60000;

  /* ---------------- Search (spine scan) ----------------------------------
     epub.js 0.3.93 exposes no book-level text search, so we walk the spine
     ourselves. Per section we call section.load() — in this version it
     resolves with section.contents (the documentElement) and sets
     section.document to the parsed XML document (see lib/section.js load()).
     We read plain text from whichever of those carries textContent. The scan
     is sequential (one section at a time via a promise chain) and stops at
     SEARCH_MAX_HITS so huge books do not lock the UI. Any section that fails
     to load/parse is skipped, and the whole search never rejects: worst case
     it resolves with [] so app.js shows "no results". */
  var SEARCH_MAX_HITS = 200;
  var SEARCH_SNIPPET_RADIUS = 40;

  // Collapse whitespace runs to single spaces so the snippet is one tidy line.
  function collapseSpaces(s) {
    return String(s).replace(/\s+/g, ' ').trim();
  }

  // Build a plain-text snippet around `index` (an index into `text`), ~40
  // chars on each side, with leading/trailing ellipses when truncated. Pure
  // string work — never injects the query into HTML (app.js renders via
  // textContent).
  function buildSnippet(text, index, len) {
    var start = Math.max(0, index - SEARCH_SNIPPET_RADIUS);
    var end = Math.min(text.length, index + len + SEARCH_SNIPPET_RADIUS);
    var out = text.slice(start, end);
    if (start > 0) out = '…' + out;
    if (end < text.length) out = out + '…';
    return out;
  }

  // Read plain text from a loaded section. Prefer <body> (avoids matching
  // <title>/<style> in <head>), then fall back to documentElement / the
  // load()-resolved contents. Document.textContent is null per DOM spec, so we
  // must never rely on section.document itself carrying textContent.
  function getSectionText(section, contents) {
    var doc = section && section.document;
    var candidates = [
      doc && doc.body,
      doc && doc.documentElement,
      contents,
      section && section.contents
    ];
    for (var i = 0; i < candidates.length; i++) {
      var node = candidates[i];
      if (node && typeof node.textContent === 'string') return node.textContent;
    }
    return '';
  }

  /* ---------------- In-iframe search highlighting ------------------------
      The app's style.css is NOT loaded inside the epub.js iframes, so a
      <mark class="book-search-hit"> would be invisible unless we style it
      ourselves. We inject a one-shot <style> into each iframe document and
      wrap query occurrences with the same class name TXT/FB2 use.

      Targeting: epub.js 0.3.93 rendition.getContents() returns the array of
      Contents instances for the currently rendered views (see lib/rendition
      getContents(){ ... this.views.forEach(v => v && v.contents ...) }). Each
      Contents is constructed from an iframe's contentDocument and exposes
      `.document` (the parsed iframe Document) and `.window`. We operate on
      contents[].document — never the host window.LLLBook document. */
  var SEARCH_MARK_CLASS = 'book-search-hit';
  var SEARCH_MARK_ACTIVE_CLASS = 'book-search-hit-active';
  var MARK_STYLE_ID = 'lll-epub-search-style';
  var MARK_INJECT_LIMIT = 5000;

  // Marker-pen highlight color. The app's style.css is NOT loaded inside the
  // epub.js iframes, so the color must be passed as inline styles to
  // rendition.annotations.highlight (we do not rely on a CSS class). This is a
  // separate path from the search marks above (class 'lll-highlight' vs
  // 'book-search-hit'), so the two never interfere.
  var HL_CLASS = 'lll-highlight';
  var HL_STYLES = { 'fill': '#ffd200', 'fill-opacity': '0.45' };

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Ensure the highlight <style> exists in an iframe document (idempotent).
  function ensureMarkStyle(doc) {
    try {
      if (doc.getElementById(MARK_STYLE_ID)) return;
      var style = doc.createElement('style');
      style.id = MARK_STYLE_ID;
      style.textContent =
        '.' + SEARCH_MARK_CLASS +
        '{background:rgba(255,210,0,0.4);color:inherit;border-radius:2px;padding:0 1px;}' +
        '.' + SEARCH_MARK_ACTIVE_CLASS +
        '{background:rgba(255,120,0,0.6);}';
      (doc.head || doc.documentElement).appendChild(style);
    } catch (e) { /* cross-origin or detached — skip styling, never fatal */ }
  }

  // Unwrap every mark we injected, restoring the original text nodes.
  function clearMarksInDoc(doc) {
    try {
      if (!doc || !doc.body || typeof doc.querySelectorAll !== 'function') return;
      var marks = doc.querySelectorAll('mark.' + SEARCH_MARK_CLASS);
      for (var i = 0; i < marks.length; i++) {
        var mark = marks[i];
        var parent = mark.parentNode;
        if (!parent) continue;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
      }
      doc.body.normalize();
    } catch (e) { /* cross-origin or detached — ignore */ }
  }

  // Wrap query occurrences inside one text node with <mark>. DOM APIs only
  // (createTextNode / replaceChild); the query is never concatenated into an
  // HTML string, so no markup can be injected. Returns marks created, capped
  // by `budget`.
  function markTextNode(doc, node, re, budget) {
    var text = node.nodeValue;
    if (!text) return 0;
    re.lastIndex = 0;
    if (!re.test(text)) return 0;
    re.lastIndex = 0;

    var frag = doc.createDocumentFragment();
    var last = 0;
    var count = 0;
    var m;
    while ((m = re.exec(text)) !== null && count < budget) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (m.index > last) {
        frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
      }
      var mark = doc.createElement('mark');
      mark.className = SEARCH_MARK_CLASS;
      mark.textContent = m[0]; // textContent: query never parsed as HTML
      frag.appendChild(mark);
      last = m.index + m[0].length;
      count++;
    }
    if (count === 0) return 0;
    if (last < text.length) {
      frag.appendChild(doc.createTextNode(text.slice(last)));
    }
    node.parentNode.replaceChild(frag, node);
    return count;
  }

  // Collect searchable text nodes in an iframe document, skipping script/style
  // and any leftover marks.
  function collectDocTextNodes(doc) {
    var nodes = [];
    try {
      if (!doc || !doc.body || typeof doc.createTreeWalker !== 'function') return nodes;
      var walker = doc.createTreeWalker(
        doc.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: function (node) {
            if (!node.nodeValue || !node.nodeValue.trim()) {
              return NodeFilter.FILTER_REJECT;
            }
            var p = node.parentNode;
            while (p && p.nodeType === 1) {
              var tag = p.tagName ? p.tagName.toLowerCase() : '';
              if (tag === 'script' || tag === 'style') return NodeFilter.FILTER_REJECT;
              if (p.classList && p.classList.contains(SEARCH_MARK_CLASS)) {
                return NodeFilter.FILTER_REJECT;
              }
              p = p.parentNode;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );
      var n;
      while ((n = walker.nextNode())) nodes.push(n);
    } catch (e) { /* cross-origin or unsupported — return empty */ }
    return nodes;
  }

  // After marks are injected, activate the mark at `occIndex` (the occurrence
  // the user clicked, numbered per section by search()'s text-node scan) in the
  // given iframe
  // document: clear any previous active class, mark the target, and scroll it
  // into view. scrollIntoView runs on the mark element inside the iframe's own
  // document, so it scrolls the iframe viewport (epub.js 0.3.93 renders each
  // view in an iframe whose Contents exposes .document / .window).
  function activateMarkInDoc(doc, contentsEntry, occIndex) {
    try {
      if (!doc || typeof doc.querySelectorAll !== 'function') return;
      var marks = doc.querySelectorAll('mark.' + SEARCH_MARK_CLASS);
      if (!marks.length) return;
      for (var i = 0; i < marks.length; i++) {
        marks[i].classList.remove(SEARCH_MARK_ACTIVE_CLASS);
      }
      var target = marks[occIndex];
      if (!target) return;
      target.classList.add(SEARCH_MARK_ACTIVE_CLASS);
      if (typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'center' });
      } else if (contentsEntry && contentsEntry.window &&
        typeof contentsEntry.window.scrollTo === 'function') {
        contentsEntry.window.scrollTo(0, target.offsetTop || 0);
      }
    } catch (e) { /* cross-origin or detached — skip, never fatal */ }
  }

  // Apply (or clear) the highlight across every currently-rendered iframe
  // document. Always clears first so a re-search starts from a clean DOM, then
  // re-marks if `query` is non-empty. Returns nothing; all failures are
  // swallowed so opening/searching never break on a highlight error.
  // `pendingScroll` (optional): { occIndex } set by goTo when a search hit was
  // clicked. It is consumed here — exactly once — so a later plain page turn
  // never re-scrolls to a stale occurrence.
  function applyHighlight(rendition, query, pendingScroll) {
    if (!rendition || typeof rendition.getContents !== 'function') return;
    var contents;
    try {
      contents = rendition.getContents();
    } catch (e) {
      return;
    }
    if (!contents || !contents.length) return;

    var docs = [];
    var entries = [];
    for (var i = 0; i < contents.length; i++) {
      try {
        var doc = contents[i] && contents[i].document;
        if (doc && doc.body) {
          docs.push(doc);
          entries.push(contents[i]);
        }
      } catch (e) { /* cross-origin getter — skip this contents */ }
    }

    for (var d = 0; d < docs.length; d++) clearMarksInDoc(docs[d]);

    var q = String(query == null ? '' : query).trim();
    if (!q) {
      // Consume any pending scroll on the early-return path so a stale
      // occurrence cannot scroll on a later highlight.
      if (pendingScroll) pendingScroll.occIndex = -1;
      return;
    }

    var re;
    try {
      re = new RegExp(escapeRegExp(q), 'gi');
    } catch (e) {
      if (pendingScroll) pendingScroll.occIndex = -1;
      return;
    }

    var budget = MARK_INJECT_LIMIT;
    for (var k = 0; k < docs.length && budget > 0; k++) {
      var doc = docs[k];
      try {
        ensureMarkStyle(doc);
        var nodes = collectDocTextNodes(doc);
        for (var j = 0; j < nodes.length && budget > 0; j++) {
          budget -= markTextNode(doc, nodes[j], re, budget);
        }
      } catch (e) { /* skip this document, keep going */ }
    }

    // One-shot scroll/activate for the clicked occurrence. Consumed here even
    // on failure so subsequent relocated-driven re-highlights do not scroll.
    if (pendingScroll && typeof pendingScroll.occIndex === 'number' &&
      pendingScroll.occIndex >= 0) {
      var wantedOcc = pendingScroll.occIndex;
      var wantedHref = pendingScroll.href || '';
      pendingScroll.occIndex = -1;
      pendingScroll.href = '';

      function docMarkCount(idx) {
        try {
          return docs[idx].querySelectorAll('mark.' + SEARCH_MARK_CLASS).length;
        } catch (e) { return 0; }
      }
      function docHref(idx) {
        try {
          var u = docs[idx].defaultView && docs[idx].defaultView.location;
          return u ? String(u.pathname || '') : '';
        } catch (e) { return ''; }
      }
      function hrefMatches(idx) {
        if (!wantedHref) return false;
        var p = docHref(idx);
        if (!p) return false;
        // Compare on the decoded basename: epub.js loads each view's iframe
        // from a blob/data URL whose pathname ends with the section href.
        var want = decodeURIComponent(wantedHref.split('?')[0].split('#')[0]);
        var have = decodeURIComponent(p);
        if (have === want) return true;
        var base = want.split('/').pop();
        return !!base && have.slice(-base.length) === base;
      }

      // Prefer the document whose href matches the clicked hit; fall back to
      // the first document that actually holds that occurrence index.
      var chosen = -1;
      for (var a = 0; a < docs.length; a++) {
        if (hrefMatches(a) && wantedOcc < docMarkCount(a)) { chosen = a; break; }
      }
      if (chosen === -1) {
        for (var b = 0; b < docs.length; b++) {
          if (wantedOcc < docMarkCount(b)) { chosen = b; break; }
        }
      }
      if (chosen !== -1) {
        activateMarkInDoc(docs[chosen], entries[chosen], wantedOcc);
      }
    }
  }

  /**
   * render(file, container) -> Promise<session>
   * CFI-based session: location = { cfi }.
   */
  function render(file, container) {
    return ensureEpubJs().then(function () {
      return new Promise(function (resolve, reject) {
        var settled = false;
        // book/rendition live here (not inside reader.onload) so the reject path
        // can tear them down. They are assigned once parsing starts.
        var book = null;
        var rendition = null;
        // Set once the session is built so the relocated handler can read the
        // current search query for re-highlighting after a section change.
        var sessionRef = null;
        // Set by goTo when a search hit (loc.occIndex) is clicked. The next
        // applyHighlight (normally the relocated following display()) consumes
        // it once, scrolling to and activating that occurrence's mark.
        var pendingScrollOcc = { occIndex: -1, href: '' };
        function settle(fn, arg) {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          fn(arg);
        }
        function doResolve(session) { settle(resolve, session); }
        // Cleanup runs only on the reject path. On success we keep book and
        // rendition alive for the session, so doResolve never calls this.
        function cleanup() {
          try { if (rendition && typeof rendition.destroy === 'function') rendition.destroy(); } catch (e) { /* already gone */ }
          try { if (book && typeof book.destroy === 'function') book.destroy(); } catch (e) { /* already gone */ }
          try { container.innerHTML = ''; } catch (e) { /* detached container */ }
        }
        function doReject() {
          settle(reject, new Error('epub-parse'));
          cleanup();
        }

        var timeoutId = setTimeout(function () {
          console.warn('[EPUB] display did not complete in time; rejecting');
          doReject();
        }, DISPLAY_TIMEOUT_MS);

        const reader = new FileReader();
        reader.onload = function () {
          try {
            book = window.ePub(reader.result);
            // Watch internal parse promises so a corrupt ZIP/OPF rejects even
            // when it does not surface through the open .catch() chain below.
            attachEarlyParseFailure(book, doReject);
            // Clear the container (e.g. the "Loading…" placeholder inserted by
            // app.js) right before renderTo so it is not left behind: epub.js
            // appends its own view (.epubview/iframe) without clearing the
            // container first. Doing this before renderTo avoids wiping the
            // epub.js view itself.
            container.innerHTML = '';
            rendition = book.renderTo(container, {
              width: '100%',
              height: '100%',
              flow: 'paginated',
            });
          } catch (e) {
            doReject();
            return;
          }

          // Generate locations for accurate percentage tracking
          book.ready.then(function () {
            return book.locations.generate(1600, function (current, total) {
              console.log('[EPUB] Generating locations:', current, '/', total);
            });
          }).then(function () {
            // If we already settled (e.g. early parse failure or timeout), the
            // book is being torn down; do not start display on a dead book.
            if (settled) { cleanup(); return; }
            console.log('[EPUB] Locations generated, total:', book.locations.length());
            rendition.display().then(
                function () {
                  if (settled) { cleanup(); return; }
                  rendition.on('relocated', function (location) {
                    console.log('[EPUB] relocated event fired, location:', location);
                    console.log('[EPUB] relocated start:', location && location.start);
                    // Re-apply the current search highlight to the newly
                    // rendered section. currentQuery lives on the session
                    // (assigned after this handler is registered), so read it
                    // lazily and guard against a not-yet-built session.
                    try {
                      if (sessionRef && sessionRef.currentQuery) {
                        applyHighlight(rendition, sessionRef.currentQuery, pendingScrollOcc);
                      }
                    } catch (e) { /* highlight is best-effort, never fatal */ }
                    document.dispatchEvent(new CustomEvent('epub-relocated', {
                      detail: { location: location }
                    }));
                  });
                  // Text selection -> notify app.js via session.onSelect. The
                  // selection text is read from the iframe's own window. Guarded
                  // so a not-yet-built session or an unwired onSelect (TXT/FB2)
                  // does nothing.
                  rendition.on('selected', function (cfiRange, contents) {
                    var text = '';
                    try {
                      if (contents && contents.window && typeof contents.window.getSelection === 'function') {
                        text = contents.window.getSelection().toString();
                      }
                    } catch (e) { text = ''; }
                    if (sessionRef && typeof sessionRef.onSelect === 'function') {
                      try { sessionRef.onSelect({ type: 'cfi', cfi: cfiRange }, text); } catch (e) { /* never fatal */ }
                    }
                  });
                  // Metadata is best-effort enrichment only. book.loaded.metadata
                  // resolves for valid EPUBs (attachEarlyParseFailure already
                  // rejects corrupt ones before this point), and a failure here
                  // must never block opening the book — fall back to file.name.
                  function buildSession(meta, cover) {
                    meta = meta || {};
                    const session = {
                title: (meta.title && String(meta.title).trim()) || file.name,
                author: (meta.creator && String(meta.creator).trim()) || '',
                format: 'epub',
                numPages: 100,
                // Current search term to highlight in the iframe body. Empty
                // means no highlight. Updated by search()/clearSearch() and
                // re-applied on every relocated event.
                currentQuery: '',
                next: function () {
                  return new Promise(function (resolve) {
                    var handler = function () {
                      rendition.off('relocated', handler);
                      resolve();
                    };
                    rendition.on('relocated', handler);
                    rendition.next();
                  });
                },
                prev: function () {
                  return new Promise(function (resolve) {
                    var handler = function () {
                      rendition.off('relocated', handler);
                      resolve();
                    };
                    rendition.on('relocated', handler);
                    rendition.prev();
                  });
                },
                goTo: function (loc) {
                  if (!loc) return Promise.resolve();
                  // Any goTo without a search occIndex cancels a stale pending
                  // scroll so a cancelled/failed display cannot scroll later.
                  pendingScrollOcc.occIndex = -1;
                  pendingScrollOcc.href = '';
                  // EPUB TOC targets are plain chapter-href strings;
                  // saved progress locations are objects with a cfi.
                  if (typeof loc === 'string') return rendition.display(loc);
                  if (loc.href) {
                    // Search hits carry loc.occIndex: remember it (and the href,
                    // so a multi-view pagination picks the matching document) so
                    // the relocated following this display() scrolls to that
                    // occurrence's mark once.
                    pendingScrollOcc.occIndex =
                      (typeof loc.occIndex === 'number') ? loc.occIndex : -1;
                    pendingScrollOcc.href = String(loc.href);
                    return rendition.display(loc.href);
                  }
                  if (loc.cfi) return rendition.display(loc.cfi);
                  if (typeof loc.page === 'number') {
                    const percentage = (loc.page - 1) / 100;
                    return rendition.display(percentage);
                  }
                  if (typeof loc.ratio === 'number') {
                    return rendition.display(loc.ratio);
                  }
                  return Promise.resolve();
                },
                getLocation: function () {
                  const loc = rendition.currentLocation();
                  console.log('[EPUB] currentLocation raw:', loc);
                  console.log('[EPUB] loc.start:', loc && loc.start);
                  console.log('[EPUB] loc.start.percentage:', loc && loc.start && loc.start.percentage);
                  console.log('[EPUB] All keys in loc:', loc ? Object.keys(loc) : 'null');
                  console.log('[EPUB] All keys in loc.start:', loc && loc.start ? Object.keys(loc.start) : 'null');

                  const cfi = loc && loc.start ? loc.start.cfi : null;
                  const result = { type: 'page', cfi: cfi, numPages: 100 };

                  if (loc && loc.start && loc.start.percentage != null) {
                    result.percentage = loc.start.percentage;
                    result.page = Math.round(loc.start.percentage * 100) + 1;
                    console.log('[EPUB] Using percentage:', loc.start.percentage, '-> page:', result.page);
                  } else {
                    result.page = 1;
                    console.log('[EPUB] No percentage available, defaulting to page 1');

                    // Try alternative fields
                    if (loc && loc.start) {
                      console.log('[EPUB] Trying alternative fields:');
                      console.log('[EPUB]   displayed:', loc.start.displayed);
                      console.log('[EPUB]   location:', loc.start.location);
                      console.log('[EPUB]   index:', loc.start.index);
                    }
                  }

                  return result;
                },
                setFontSize: function (px) {
                  if (
                    rendition &&
                    rendition.themes &&
                    typeof rendition.themes.fontSize === 'function'
                  ) {
                    rendition.themes.fontSize(px + 'px');
                  }
                  return Promise.resolve();
                },
                getToc: function () {
                  return book.loaded.navigation
                    .then(function (nav) {
                      return flattenToc(nav.toc || []);
                    })
                    .catch(function () {
                      return [];
                    });
                },
                // Sequentially scan the spine for `query` and return
                // Promise<hits[]> where each hit is
                // { id, snippet, loc: { href } }. Never rejects: a section
                // that fails to load/parse is skipped, and any unexpected
                // error (including a destroyed book) resolves with [].
                search: function (query) {
                  var needle = String(query == null ? '' : query).trim().toLowerCase();
                  // Remember the term for in-iframe highlighting and apply it
                  // to the currently displayed section now.
                  session.currentQuery = needle;
                  try { applyHighlight(rendition, needle); } catch (e) { /* best-effort */ }
                  if (!needle) return Promise.resolve([]);
                  var hits = [];
                  var sections = [];
                  // After destroy() the spine is torn down; guard so we never
                  // throw and simply report no results.
                  try {
                    var spine = book && book.spine;
                    var items = spine && spine.spineItems;
                    if (items && items.length) {
                      sections = items.slice();
                    } else if (spine && typeof spine.each === 'function') {
                      spine.each(function (section) { sections.push(section); });
                    }
                  } catch (e) {
                    return Promise.resolve([]);
                  }
                  // Per-section occurrence counter, reset for every section so
                  // loc.occIndex is "which occurrence inside this href".
                  var occCounter = { value: 0 };
                  var i = 0;
                  function nextSection() {
                    if (i >= sections.length || hits.length >= SEARCH_MAX_HITS) {
                      return Promise.resolve();
                    }
                    var section = sections[i];
                    i += 1;
                    var href = section && section.href;
                    occCounter.value = 0;
                    if (!href || typeof section.load !== 'function') {
                      return nextSection();
                    }
                     return Promise.resolve()
                       .then(function () { return section.load(); })
                       .then(function (contents) {
                         // Number occurrences over the SAME text-node set that
                         // applyHighlight/markTextNode later wraps in <mark>
                         // (collectDocTextNodes), so loc.occIndex equals the
                         // index into that document's mark.book-search-hit
                         // list. A body-wide collapsed string would count
                         // cross-node matches that no per-node mark can show.
                         var doc = (section && section.document) || contents;
                         if (!doc) return;
                         var nodes = collectDocTextNodes(doc);
                         var re;
                         try {
                           re = new RegExp(escapeRegExp(needle), 'gi');
                         } catch (e) {
                           return;
                         }
                         for (var n = 0; n < nodes.length && hits.length < SEARCH_MAX_HITS; n++) {
                           var text = nodes[n].nodeValue;
                           if (!text) continue;
                           re.lastIndex = 0;
                           var m;
                           while (hits.length < SEARCH_MAX_HITS && (m = re.exec(text)) !== null) {
                             if (m[0].length === 0) { re.lastIndex++; continue; }
                             var occIndex = occCounter.value;
                             occCounter.value = occIndex + 1;
                             hits.push({
                               id: 'epub-' + href + '-' + occIndex + '-' + hits.length,
                               snippet: buildSnippet(collapseSpaces(text), m.index, m[0].length),
                               loc: { href: href, occIndex: occIndex },
                             });
                           }
                         }
                       })
                       .catch(function () { /* skip unreadable section */ })
                       .then(function () { return nextSection(); });
                  }
                  return nextSection()
                    .then(function () { return hits; })
                    .catch(function () { return hits; });
                },
                // Clear the in-iframe highlight and forget the term.
                clearSearch: function () {
                  session.currentQuery = '';
                  try { applyHighlight(rendition, ''); } catch (e) { /* best-effort */ }
                },
                // Marker-pen highlights. app.js assigns a function to onSelect
                // after the session is returned; the rendition 'selected'
                // handler calls it when the user selects text. EPUB-only.
                onSelect: null,
                // Restore saved highlights. Each entry is
                // { id, anchor: { type: 'cfi', cfi }, text }. rendition
                // annotations re-apply on every section re-render, so this also
                // covers reopening. Per-entry try/catch so one bad CFI never
                // stops the rest.
                applyHighlights: function (list) {
                  if (!rendition || !rendition.annotations ||
                    typeof rendition.annotations.highlight !== 'function') return;
                  if (!list || !list.length) return;
                  for (var i = 0; i < list.length; i++) {
                    var h = list[i];
                    var cfi = h && h.anchor && h.anchor.cfi;
                    if (!cfi) continue;
                    try {
                      rendition.annotations.highlight(cfi, { id: h.id }, undefined, HL_CLASS, HL_STYLES);
                    } catch (e) { /* skip this highlight, keep going */ }
                  }
                },
                // Draw one highlight immediately. app.js passes the anchor
                // object through; this renderer interprets it.
                addHighlight: function (anchor) {
                  if (!rendition || !rendition.annotations ||
                    typeof rendition.annotations.highlight !== 'function') return;
                  var cfi = anchor && anchor.cfi;
                  if (!cfi) return;
                  try {
                    rendition.annotations.highlight(cfi, {}, undefined, HL_CLASS, HL_STYLES);
                  } catch (e) { /* best-effort */ }
                },
                // Remove one highlight by its anchor.
                removeHighlight: function (anchor) {
                  if (!rendition || !rendition.annotations ||
                    typeof rendition.annotations.remove !== 'function') return;
                  var cfi = anchor && anchor.cfi;
                  if (!cfi) return;
                  try {
                    rendition.annotations.remove(cfi, 'highlight');
                  } catch (e) { /* best-effort */ }
                },
                // Jump to a saved highlight. Returns a Promise so app.js can
                // refresh progress afterwards.
                jumpToHighlight: function (anchor) {
                  var cfi = anchor && anchor.cfi;
                  if (!cfi) return Promise.resolve();
                  return rendition.display(cfi);
                },
                destroy: function () {
                  // Drop the highlight reference first so a late relocated
                  // event cannot re-apply marks to a tearing-down rendition.
                  sessionRef = null;
                  session.currentQuery = '';
                  session.onSelect = null;
                  pendingScrollOcc.occIndex = -1;
                  pendingScrollOcc.href = '';
                  try { applyHighlight(rendition, ''); } catch (e) { /* best-effort */ }
                  try {
                    rendition.destroy();
                  } catch (e) { /* already gone */ }
                  container.innerHTML = '';
                },
              };
                    sessionRef = session;
                    // TEMP diagnostic log — remove after cover issue triage.
                    console.log('[EPUB cover] buildSession cover =', cover ? String(cover).slice(0, 20) : cover);
                    if (cover) session.cover = cover;
                    return session;
                  }
                  // Cover is best-effort enrichment resolved before the session
                  // is returned, so app.js can persist it with the rest of the
                  // metadata. resolveCoverWithTimeout always settles (null on
                  // failure or timeout) and buildSession failures fall back to
                  // a cover-less session, so opening is never blocked.
                  function buildWithCover(meta) {
                    return resolveCoverWithTimeout(book).then(function (cover) {
                      return buildSession(meta, cover);
                    });
                  }
                  function resolveWithoutCover(meta) {
                    var session = null;
                    try {
                      session = buildSession(meta || {}, null);
                    } catch (e) {
                      session = null;
                    }
                    if (!session) {
                      try {
                        session = buildSession(null, null);
                      } catch (e2) {
                        session = null;
                      }
                    }
                    doResolve(session);
                  }
                  book.loaded.metadata.then(
                    function (meta) {
                      buildWithCover(meta).then(doResolve, function () {
                        resolveWithoutCover(meta);
                      });
                    },
                    function () { resolveWithoutCover(null); }
                  );
            },
            function (err) {
              doReject();
            }
            );
          }).catch(function (err) {
            doReject();
          });
        };
        reader.onerror = function () {
          settle(reject, new Error('read-error'));
        };
        reader.readAsArrayBuffer(file);
      });
    });
  }

  window.LLLBook = window.LLLBook || {};
  window.LLLBook.renderers = window.LLLBook.renderers || {};
  window.LLLBook.renderers.epub = { render };
})();
