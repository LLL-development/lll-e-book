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

  /**
   * render(file, container) -> Promise<session>
   * CFI-based session: location = { cfi }.
   */
  function render(file, container) {
    return ensureEpubJs().then(function () {
      return new Promise(function (resolve, reject) {
        const reader = new FileReader();
        reader.onload = function () {
          let book;
          let rendition;
          try {
            book = window.ePub(reader.result);
            rendition = book.renderTo(container, {
              width: '100%',
              height: '100%',
              flow: 'paginated',
            });
          } catch (e) {
            reject(new Error('epub-parse'));
            return;
          }

          // Generate locations for accurate percentage tracking
          book.ready.then(function () {
            return book.locations.generate(1600, function (current, total) {
              console.log('[EPUB] Generating locations:', current, '/', total);
            });
          }).then(function () {
            console.log('[EPUB] Locations generated, total:', book.locations.length());
            rendition.display().then(
                function () {
                  rendition.on('relocated', function (location) {
                    console.log('[EPUB] relocated event fired, location:', location);
                    console.log('[EPUB] relocated start:', location && location.start);
                    document.dispatchEvent(new CustomEvent('epub-relocated', {
                      detail: { location: location }
                    }));
                  });
                  const session = {
                title: file.name,
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
              resolve(session);
            },
            function (err) {
              reject(new Error('epub-parse'));
            }
            );
          }).catch(function (err) {
            reject(new Error('epub-parse'));
          });
        };
        reader.onerror = function () {
          reject(new Error('read-error'));
        };
        reader.readAsArrayBuffer(file);
      });
    });
  }

  window.LLLBook = window.LLLBook || {};
  window.LLLBook.renderers = window.LLLBook.renderers || {};
  window.LLLBook.renderers.epub = { render };
})();