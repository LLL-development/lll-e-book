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
  function resolveCover(book) {
    return book.loaded.cover
      .then(function (coverPath) {
        if (!coverPath || !book.archived || !book.archive) return null;
        return book.archive.createUrl(coverPath, { base64: true });
      })
      .then(function (dataUrl) {
        if (!dataUrl || typeof dataUrl !== 'string' || dataUrl.indexOf('data:') !== 0) return null;
        return shrinkToDataURL(dataUrl);
      })
      .catch(function () { return null; });
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
                    document.dispatchEvent(new CustomEvent('epub-relocated', {
                      detail: { location: location }
                    }));
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
                  // EPUB TOC targets are plain chapter-href strings;
                  // saved progress locations are objects with a cfi.
                  if (typeof loc === 'string') return rendition.display(loc);
                  if (loc.href) return rendition.display(loc.href);
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
                destroy: function () {
                  try {
                    rendition.destroy();
                  } catch (e) { /* already gone */ }
                  container.innerHTML = '';
                },
              };
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