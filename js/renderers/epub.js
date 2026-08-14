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
              rendition.display().then(
                function () {
                  rendition.on('relocated', function (location) {
                    document.dispatchEvent(new CustomEvent('epub-relocated', {
                      detail: { location: location }
                    }));
                  });
                  const session = {
                title: file.name,
                format: 'epub',
                next: function () {
                  return rendition.next();
                },
                prev: function () {
                  return rendition.prev();
                },
                goTo: function (loc) {
                  if (!loc) return Promise.resolve();
                  // EPUB TOC targets are plain chapter-href strings;
                  // saved progress locations are objects with a cfi.
                  if (typeof loc === 'string') return rendition.display(loc);
                  if (loc.href) return rendition.display(loc.href);
                  if (loc.cfi) return rendition.display(loc.cfi);
                  return Promise.resolve();
                },
                getLocation: function () {
                  const loc = rendition.currentLocation();
                  const cfi = loc && loc.start ? loc.start.cfi : null;
                  const result = { type: 'cfi', cfi: cfi };
                  if (loc && loc.start && loc.start.percentage != null) {
                    result.percentage = loc.start.percentage;
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