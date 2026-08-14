/* ==========================================================================
   LLL-E-Book — renderers/pdf.js
   Renders PDF files page-by-page onto a canvas using pdf.js (loaded via CDN).
   Requires the pdf.worker from a CDN (set below once on first render).
   ========================================================================== */
(function () {
  'use strict';

  const WORKER_SRC =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const RENDER_SCALE = 1.5;
  let workerConfigured = false;

  function ensurePdfJs() {
    if (typeof window.pdfjsLib === 'undefined') {
      return Promise.reject(new Error('pdf-library-missing'));
    }
    if (!workerConfigured) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_SRC;
      workerConfigured = true;
    }
    return Promise.resolve();
  }

  // Build a flat TOC list from a PDF outline tree (title -> page number).
  function flattenPdfOutline(pdfDoc) {
    return pdfDoc.getOutline().then(function (outline) {
      function mapItem(item, depth) {
        const pageP = item.dest
          ? (function () {
              var destP = Array.isArray(item.dest)
                ? Promise.resolve(item.dest)
                : pdfDoc.getDestination(item.dest);
              return destP
                .then(function (dest) {
                  if (dest && dest[0] != null) {
                    return pdfDoc
                      .getPageIndex(dest[0])
                      .then(function (idx) { return idx + 1; })
                      .catch(function () { return null; });
                  }
                  return null;
                })
                .catch(function () { return null; });
            })()
          : Promise.resolve(null);
        return pageP.then(function (pageNum) {
          const kids = (item.items || []).map(function (c) {
            return mapItem(c, depth + 1);
          });
          return Promise.all(kids).then(function (children) {
            return {
              label: item.title || '',
              target: pageNum != null ? { page: pageNum } : null,
              depth: depth,
              children: children,
            };
          });
        });
      }
      return Promise.all((outline || []).map(function (item) {
        return mapItem(item, 0);
      })).then(function (nodes) {
        const flat = [];
        (function walk(list) {
          list.forEach(function (n) {
            if (n.label) flat.push({ label: n.label, target: n.target, depth: n.depth });
            if (n.children && n.children.length) walk(n.children);
          });
        })(nodes);
        return flat;
      });
    }).catch(function () {
      return [];
    });
  }

  /**
   * render(file, container) -> Promise<session>
   * Page-based session: location = { page, numPages }.
   */
  function render(file, container) {
    return ensurePdfJs().then(function () {
      return new Promise(function (resolve, reject) {
        const reader = new FileReader();
        reader.onload = function () {
          const task = window.pdfjsLib.getDocument({ data: reader.result });
          task.promise.then(function (pdfDoc) {
            container.innerHTML = '';
            const canvas = document.createElement('canvas');
            container.appendChild(canvas);
            const ctx = canvas.getContext('2d');
            let pageNum = 1;
            let tocPromise = null;

            function renderPage(num) {
              return pdfDoc.getPage(num).then(function (page) {
                const viewport = page.getViewport({ scale: RENDER_SCALE });
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                return page.render({ canvasContext: ctx, viewport: viewport }).promise;
              });
            }

            renderPage(1).then(function () {
              const session = {
                title: file.name,
                format: 'pdf',
                numPages: pdfDoc.numPages,
                next: function () {
                  if (pageNum < pdfDoc.numPages) {
                    pageNum += 1;
                    return renderPage(pageNum);
                  }
                  return Promise.resolve();
                },
                prev: function () {
                  if (pageNum > 1) {
                    pageNum -= 1;
                    return renderPage(pageNum);
                  }
                  return Promise.resolve();
                },
                goTo: function (loc) {
                  if (loc && typeof loc.page === 'number') {
                    pageNum = Math.max(1, Math.min(pdfDoc.numPages, loc.page));
                    return renderPage(pageNum);
                  }
                  return Promise.resolve();
                },
                getLocation: function () {
                  return { type: 'page', page: pageNum, numPages: pdfDoc.numPages };
                },
                getToc: function () {
                  if (!tocPromise) {
                    tocPromise = flattenPdfOutline(pdfDoc);
                  }
                  return tocPromise;
                },
                destroy: function () {
                  container.innerHTML = '';
                },
              };
              resolve(session);
            }, reject);
          }, reject);
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
  window.LLLBook.renderers.pdf = { render };
})();