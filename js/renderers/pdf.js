/* ==========================================================================
   LLL-E-Book — renderers/pdf.js
   Renders PDF files page-by-page onto a canvas using the locally vendored PDF.js ESM.
   The module and worker are initialized together before first render.
   ========================================================================== */
(function () {
  'use strict';

  function ensurePdfJs() {
    return window.loadPdfJs();
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
          const task = window.pdfjsLib.getDocument({ ...window.pdfjsDocumentOptions, data: reader.result, isEvalSupported: false });
          task.promise.then(function (pdfDoc) {
            container.innerHTML = '';
            const wrapper = document.createElement('div');
            wrapper.className = 'pdf-page';
            // Stage centers the canvas (flex margin:auto) and the text layer
            // overlays it from the stage origin, so both share one origin even
            // when the page is smaller than the wrapper. The vendored TextLayer
            // class positions spans with percentages of its container box and
            // sizes fonts via --font-height * --total-scale-factor, so JS sets
            // the stage/textlayer to the exact viewport pixels and
            // --total-scale-factor to viewport.scale on every render (nothing
            // in the distribution sets that variable; the official viewer.css
            // does).
            const stage = document.createElement('div');
            stage.className = 'pdf-page-stage';
            const canvas = document.createElement('canvas');
            stage.appendChild(canvas);
            const textLayerDiv = document.createElement('div');
            textLayerDiv.className = 'pdf-textlayer';
            textLayerDiv.style.setProperty('--scale-round-x', '1px');
            textLayerDiv.style.setProperty('--scale-round-y', '1px');
            stage.appendChild(textLayerDiv);
            wrapper.appendChild(stage);
            container.appendChild(wrapper);
            const ctx = canvas.getContext('2d');
            let pageNum = 1;
            let zoomMode = 'fit-page';
            let zoomLevel = 1.0;
            let tocPromise = null;
            let resizeTimer = null;
            let currentQuery = '';
            // Per-page hit rectangles computed at search time in PDF user space:
            // Map<pageNumber, Array<{ rects: [{x,y,w,h}, ...] }>>. The search
            // matches against the concatenation of all text items, so a hit can
            // span several items; each item contributes one rect. Painting uses
            // only these saved rects, which keeps search and highlight in the
            // same matching unit (list hits are always paintable).
            let hitRectsByPage = new Map();
            // Rects of the hit the user clicked (activeRects), painted in a
            // stronger color on top of the pale all-occurrence highlights.
            // activePage records which page those rects belong to, so the orange
            // active highlight is only painted on that page (never on a neighbor
            // after a page turn).
            let activeRects = null;
            let activePage = 0;
            // Generation counter for searches. A slow scan (search A) must not
            // write stale rects into hitRectsByPage after clearSearch or a newer
            // search (B) has reset the cache. Each search/clear bumps the version;
            // the per-page scan and final write only apply while their captured
            // version is still current.
            let searchVersion = 0;
            // User marker-pen highlights, in PDF user space, kept separately
            // from the search rects (hitRectsByPage) so search never regresses:
            // Map<pageNumber, Array<{x,y,w,h}, ...]>. paintUserHighlights
            // paints these on top of the canvas after each render.
            let userHighlightRects = new Map();
            // Text items of the page currently on screen (PDF user space
            // geometry), captured when the text layer is built. The selection
            // handler maps selected text onto these items to produce the
            // anchor rects — the same unit the search rects use.
            let pageTextItems = [];
            let pageTextItemsPage = 0;
            // Text layer spans in document order (one per non-empty text item,
            // same order as pageTextItems). Used to locate where a DOM
            // selection starts inside the concatenated page text, so repeated
            // strings highlight at the selected occurrence, not the first.
            let pageTextSpans = [];
            // Lazily built concatenation of pageTextItems.str and each item's
            // start offset, cached until the next text layer rebuild. The
            // selection handler runs on every selectionchange; rebuilding the
            // full page string per event would be wasteful on text-heavy pages.
            let pageFullText = '';
            let pageItemStarts = [];
            // Generation counter for renderPage/buildTextLayer. Overlapping
            // renders (fast page turns, zoom spam) must not let an older
            // buildTextLayer overwrite the item snapshot of a newer one.
            let renderVersion = 0;
            // Set by destroy: in-flight getPage/render continuations must stop
            // touching the torn-down DOM.
            let disposed = false;

            function calcScale(page) {
              const naturalVp = page.getViewport({ scale: 1.0 });
              const cw = wrapper.clientWidth || (container.clientWidth - 16);
              const ch = wrapper.clientHeight || (container.clientHeight - 16);
              if (cw <= 0 || ch <= 0) return 1.5;
              if (zoomMode === 'fit-page') {
                // Portrait fit-page is height-driven only: scale = ch/nat.height,
                // independent of card width (cw). This breaks the shrink feedback
                // loop where a narrower card would flip the min() to the width
                // term, shrink the scale, and compound across page turns/resizes.
                if (naturalVp.height >= naturalVp.width) {
                  return ch / naturalVp.height;
                }
                return Math.min(cw / naturalVp.width, ch / naturalVp.height);
              } else if (zoomMode === 'fit-width') {
                return cw / naturalVp.width;
              } else if (zoomMode === 'original') {
                return 1.0;
              } else {
                return zoomLevel;
              }
            }

            function renderPage(num) {
              const version = ++renderVersion;
              return pdfDoc.getPage(num).then(function (page) {
                // Stale renders (fast page turns / zoom spam) must not touch
                // the shared canvas or start a text layer for an old page.
                if (disposed || version !== renderVersion) return;
                const scale = calcScale(page);
                const viewport = page.getViewport({ scale: scale });
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                stage.style.width = viewport.width + 'px';
                stage.style.height = viewport.height + 'px';
                applyPageFitWidth(page, viewport);
                return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function () {
                  if (disposed || version !== renderVersion) return;
                  paintUserHighlights(page, viewport);
                  return paintSearchHighlights(page, viewport);
                }).then(function () {
                  // The text layer is enrichment for selection: never let a
                  // slow/hanging text extraction block the page promise.
                  buildTextLayer(page, viewport, version).catch(function (e) { if (window.LLLBook && window.LLLBook.hlDbg) window.LLLBook.hlDbg('[HL-DBG] buildTextLayer threw: ' + ((e && e.stack) ? e.stack : String(e))); });
                });
              });
            }

            // Rebuild the selectable text layer on top of the canvas for the
            // current viewport. The vendored distribution exports the TextLayer
            // class (no renderTextLayer function): new TextLayer({
            // textContentSource: page.streamTextContent(), container, viewport })
            // then .render() -> Promise. The layer renders into a detached
            // host div first and is swapped into the stage only while its
            // render version is still current, so overlapping builds can
            // never mix two pages' spans in the live DOM. The class rewrites
            // the host width/height via setLayerDimensions (from
            // --total-scale-factor, which we set to viewport.scale: span
            // left/top are % of the viewport-pixel box and --font-height is
            // in PDF user space), while the CSS inset pins keep the host
            // fitted to the stage. Failure must never break the page display.
            function buildTextLayer(page, viewport, version) {
              return Promise.resolve().then(function () {
                const TL = window.pdfjsLib && window.pdfjsLib.TextLayer;
                if (disposed || version !== renderVersion) return null;
                if (!TL || typeof page.streamTextContent !== 'function') { if (window.LLLBook && window.LLLBook.hlDbg) window.LLLBook.hlDbg('[HL-DBG] buildTextLayer abort: TL= ' + !!TL + ' streamTextContent= ' + typeof (page && page.streamTextContent)); return null; }
                const host = document.createElement('div');
                host.className = 'pdf-textlayer';
                host.style.setProperty('--total-scale-factor', String(viewport.scale));
                host.style.setProperty('--scale-round-x', '1px');
                host.style.setProperty('--scale-round-y', '1px');
                const layer = new TL({
                  textContentSource: page.streamTextContent(),
                  container: host,
                  viewport: viewport,
                });
                // Snapshot the item geometry for selection -> PDF rects.
                // getTextContent() defaults match streamTextContent() defaults
                // (normalization on), so the snapshot and the layer text agree.
                const snapshotP = page.getTextContent().then(function (textContent) {
                  return buildItemMap(textContent);
                }, function () {
                  return null;
                });
                return snapshotP.then(function (items) {
                  return layer.render().then(function () {
                    if (disposed || version !== renderVersion || !items) { if (window.LLLBook && window.LLLBook.hlDbg) window.LLLBook.hlDbg('[HL-DBG] buildTextLayer abort before swap: disposed= ' + disposed + ' version= ' + version + ' renderVersion= ' + renderVersion + ' items= ' + (items ? items.length : 'null')); return; }
                    textLayerDiv.replaceChildren(host);
                    pageTextItems = items;
                    pageTextSpans = collectTextSpans(host);
                    pageFullText = '';
                    pageItemStarts = [];
                    // Set only once items AND spans are both ready, so the
                    // selection handler never sees a half-built mapping.
                    pageTextItemsPage = page.pageNumber;
                    if (window.LLLBook && window.LLLBook.hlDbg) window.LLLBook.hlDbg('[HL-DBG] buildTextLayer OK: pageTextItemsPage= ' + pageTextItemsPage + ' items= ' + pageTextItems.length + ' spans= ' + pageTextSpans.length);
                  });
                });
              });
            }

            // The layer renders one <span role="presentation"> per text item
            // (plus <br> separators) in item order; keep only spans with text
            // so the list aligns with buildItemMap (which drops empty items).
            function collectTextSpans(host) {
              const spans = host.querySelectorAll('span[role="presentation"]');
              return Array.prototype.slice.call(spans).filter(function (s) {
                return !!s.textContent;
              });
            }

            // PDF user space geometry per non-empty text item (same fields and
            // derivation as the search scan): x/y from the transform origin,
            // h from |tr[3]|, w from item.width.
            function buildItemMap(textContent) {
              const items = (textContent && textContent.items) || [];
              const map = [];
              for (var i = 0; i < items.length; i++) {
                const item = items[i];
                if (!item || typeof item.str !== 'string' || !item.str) continue;
                const tr = item.transform;
                map.push({
                  str: item.str,
                  x: (tr && tr.length >= 6) ? tr[4] : 0,
                  y: (tr && tr.length >= 6) ? tr[5] : 0,
                  h: (tr && tr.length >= 6) ? Math.abs(tr[3]) : 0,
                  w: typeof item.width === 'number' ? item.width : 0
                });
              }
              return map;
            }

            // Map a point from PDF user space (origin bottom-left) into canvas
            // space (origin top-left) through the viewport transform. Prefer the
            // PageViewport official point conversion (convertToViewportPoint),
            // which applies the translation terms (v[4], v[5]). Fall back to
            // applying the matrix by hand, always adding the translation terms:
            // cx = v[0]*x + v[2]*y + v[4]; cy = v[1]*x + v[3]*y + v[5].
            // NOTE: pdfjsLib.Util.transform composes two 6-element affine
            // matrices; passing a point [x, y] as the second argument is wrong
            // (the translation terms are dropped/NaN), so it is not used here.
            function pdfPointToCanvas(viewport, x, y) {
              if (viewport && typeof viewport.convertToViewportPoint === 'function') {
                const p = viewport.convertToViewportPoint(x, y);
                return [p[0], p[1]];
              }
              const v = viewport.transform;
              return [v[0] * x + v[2] * y + v[4], v[1] * x + v[3] * y + v[5]];
            }

            // Overlay translucent rectangles over the search hits saved at
            // search time (hitRectsByPage / activeRects, in PDF user space).
            // The body is canvas drawn, so highlights are painted directly onto
            // the canvas after each render (page turns / zoom / resizes re-apply
            // them). Rects are mapped through pdfPointToCanvas per corner and
            // normalized to a canvas rect. Any failure here must never break
            // the page display.
            function paintSearchHighlights(page, viewport) {
              const pageHits = hitRectsByPage.get(page.pageNumber) || null;
              const activeOnThisPage = !!(activeRects && activeRects.length &&
                page.pageNumber === activePage);
              if (!pageHits && !activeOnThisPage) {
                return Promise.resolve();
              }
              ctx.save();
              try {
                function fillRects(rects, color) {
                  if (!rects) return;
                  ctx.fillStyle = color;
                  for (var r = 0; r < rects.length; r++) {
                    const rect = rects[r];
                    if (!rect) continue;
                    const base = pdfPointToCanvas(viewport, rect.x, rect.y);
                    const topRight = pdfPointToCanvas(
                      viewport, rect.x + rect.w, rect.y + rect.h);
                    ctx.fillRect(
                      Math.min(base[0], topRight[0]),
                      Math.min(base[1], topRight[1]),
                      Math.abs(topRight[0] - base[0]),
                      Math.abs(topRight[1] - base[1])
                    );
                  }
                }
                // Pale yellow over every occurrence of the query on this page.
                if (pageHits) {
                  for (var h = 0; h < pageHits.length; h++) {
                    fillRects(pageHits[h].rects, 'rgba(255, 210, 0, 0.4)');
                  }
                }
                // Stronger orange over the clicked hit (only on its own page).
                if (activeOnThisPage) {
                  fillRects(activeRects, 'rgba(255, 140, 0, 0.55)');
                }
              } finally {
                ctx.restore();
              }
              return Promise.resolve();
            }

            // Overlay translucent marker-pen rects (userHighlightRects, PDF
            // user space) on the canvas after each render, same mapping as
            // paintSearchHighlights. Independent of the search caches.
            function paintUserHighlights(page, viewport) {
              const rects = userHighlightRects.get(page.pageNumber);
              if (!rects || !rects.length) return;
              ctx.save();
              try {
                ctx.fillStyle = 'rgba(255, 210, 0, 0.45)';
                for (var r = 0; r < rects.length; r++) {
                  const rect = rects[r];
                  if (!rect) continue;
                  const base = pdfPointToCanvas(viewport, rect.x, rect.y);
                  const topRight = pdfPointToCanvas(
                    viewport, rect.x + rect.w, rect.y + rect.h);
                  ctx.fillRect(
                    Math.min(base[0], topRight[0]),
                    Math.min(base[1], topRight[1]),
                    Math.abs(topRight[0] - base[0]),
                    Math.abs(topRight[1] - base[1])
                  );
                }
              } catch (e) {
                // Never break the page display.
              } finally {
                ctx.restore();
              }
            }

            // PDF user space rects for the current selection inside the text
            // layer. The selected text is located in the concatenation of the
            // page's text items (same unit as search). The search start is
            // pinned to the DOM selection's start span so a string occurring
            // several times on a page highlights the selected occurrence, not
            // the first one. Each covered item contributes one rect with its
            // width apportioned by character count, mirroring the search
            // rectsForSpan logic.
            function selectionRects(sel) {
              if (!pageTextItems.length) return [];
              let selText = '';
              try { selText = sel.toString(); } catch (e) { return []; }
              if (!selText || !selText.trim()) return [];
              if (!pageFullText) {
                pageFullText = '';
                pageItemStarts = [];
                for (var i = 0; i < pageTextItems.length; i++) {
                  pageItemStarts.push(pageFullText.length);
                  pageFullText += pageTextItems[i].str;
                }
              }
              const full = pageFullText;
              const starts = pageItemStarts;
              const origin = selectionOrigin(sel);
              let ms = origin >= 0 ? full.indexOf(selText, origin) : -1;
              if (ms === -1) ms = full.indexOf(selText);
              if (ms === -1) {
                // Browsers may normalize whitespace when serializing the
                // selection; fall back to whole-item matching, but only for
                // items inside the selected DOM range (never page-wide).
                const matched = selText.replace(/\s+/g, ' ').trim().toLowerCase();
                if (!matched) return [];
                const rects = [];
                try {
                  const range = sel.getRangeAt(0);
                  for (var c = 0; c < pageTextSpans.length; c++) {
                    if (!range.intersectsNode(pageTextSpans[c])) continue;
                    const it = pageTextItems[c];
                    const s = it.str.replace(/\s+/g, ' ');
                    if (s && matched.indexOf(s.toLowerCase()) !== -1) {
                      rects.push({ x: it.x, y: it.y, w: it.w, h: it.h });
                    }
                  }
                } catch (e) {
                  return [];
                }
                return rects;
              }
              const me = ms + selText.length;
              const rects = [];
              for (var m = 0; m < pageTextItems.length; m++) {
                const it = pageTextItems[m];
                const itStart = starts[m];
                const itEnd = itStart + it.str.length;
                if (it.str.length <= 0 || itStart >= me || itEnd <= ms) continue;
                const s = Math.max(ms, itStart);
                const e = Math.min(me, itEnd);
                const off = (s - itStart) / it.str.length * it.w;
                const w = (e - s) / it.str.length * it.w;
                rects.push({ x: it.x + off, y: it.y, w: w, h: it.h });
              }
              return rects;
            }

            // Offset in the concatenated page text where the DOM selection
            // starts, derived from the start span's index in pageTextSpans.
            // -1 when the span mapping is unavailable.
            function selectionOrigin(sel) {
              if (!pageTextSpans.length || pageTextSpans.length !== pageTextItems.length) return -1;
              try {
                const range = sel.getRangeAt(0);
                let node = range.startContainer;
                if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
                const idx = pageTextSpans.indexOf(node);
                if (idx === -1) return -1;
                let off = 0;
                for (var i = 0; i < idx; i++) off += pageTextItems[i].str.length;
                if (range.startContainer.nodeType === Node.TEXT_NODE) {
                  off += range.startOffset;
                }
                return off;
              } catch (e) {
                return -1;
              }
            }

            // Narrow the reader card to the displayed page width so a portrait
            // page fit by height does not leave large dead side margins. Only
            // for fit-page + portrait: there scale = ch/nat.height, independent
            // of card width, so shrinking the card cannot feed back into
            // calcScale. Every other case clears the property (full width).
            function applyPageFitWidth(page, viewport) {
              const naturalVp = page.getViewport({ scale: 1.0 });
              const portrait = naturalVp.height >= naturalVp.width;
              if (zoomMode === 'fit-page' && portrait) {
                // Card must stay wide enough that the wrapper's client width
                // (card - horizontal padding - borders) never falls below the
                // displayed page width, or a horizontal scrollbar appears.
                const HPAD = 114;   // 56*2 padding + 2 border
                const SLACK = 48;   // keeps wrapper.clientWidth >= viewport.width
                const targetW = Math.max(viewport.width + HPAD + SLACK, 280);
                container.style.setProperty('--pdf-page-w', targetW + 'px');
              } else {
                container.style.removeProperty('--pdf-page-w');
              }
            }

            function onResize() {
              if (zoomMode === 'manual') return;
              clearTimeout(resizeTimer);
              resizeTimer = setTimeout(function () {
                renderPage(pageNum);
              }, 200);
            }

            // Repaint the current page after a user-highlight change. The
            // re-render is fire-and-forget; its rejection must stay handled.
            function repaintForHighlights() {
              try {
                Promise.resolve(renderPage(pageNum)).catch(function () {});
              } catch (e) { /* never fatal */ }
            }

            // Marker-pen selection capture. The text layer spans are the only
            // selectable content in the PDF view, so a document-level
            // 'selectionchange' guarded by container.contains() (same idiom as
            // text.js) is enough. Emits onSelect with an opaque rect anchor.
            function onSelectionChange() {
              if (window.LLLBook && window.LLLBook.hlDbg) window.LLLBook.hlDbg('[HL-DBG] onSelectionChange ENTER');
              if (!session || typeof session.onSelect !== 'function') {
                if (window.LLLBook && window.LLLBook.hlDbg) window.LLLBook.hlDbg('[HL-DBG] sel skip: onSelect not fn, session=' + !!session + ' type=' + (session && typeof session.onSelect));
                return;
              }
              try {
                const sel = window.getSelection();
                if (!sel || sel.rangeCount !== 1 || sel.isCollapsed) { if (window.LLLBook && window.LLLBook.hlDbg) window.LLLBook.hlDbg('[HL-DBG] sel skip: rangeCount= ' + (sel && sel.rangeCount) + ' collapsed= ' + (sel && sel.isCollapsed)); return; }
                if (!container.contains(sel.anchorNode)) { if (window.LLLBook && window.LLLBook.hlDbg) window.LLLBook.hlDbg('[HL-DBG] sel skip: anchor not in container'); return; }
                const range = sel.getRangeAt(0);
                if (!textLayerDiv.contains(range.startContainer) ||
                  !textLayerDiv.contains(range.endContainer)) { if (window.LLLBook && window.LLLBook.hlDbg) window.LLLBook.hlDbg('[HL-DBG] sel skip: range not in textLayerDiv'); return; }
                if (pageTextItemsPage !== pageNum) { if (window.LLLBook && window.LLLBook.hlDbg) window.LLLBook.hlDbg('[HL-DBG] sel skip: pageTextItemsPage= ' + pageTextItemsPage + ' pageNum= ' + pageNum); return; }
                const rects = selectionRects(sel);
                if (!rects.length) { if (window.LLLBook && window.LLLBook.hlDbg) window.LLLBook.hlDbg('[HL-DBG] sel skip: rects empty, selText= ' + JSON.stringify((function(){try{return sel.toString();}catch(e){return '';}})())); return; }
                const anchor = { type: 'rect', page: pageNum, rects: rects };
                if (window.LLLBook && window.LLLBook.hlDbg) window.LLLBook.hlDbg('[HL-DBG] onSelect fire: rects= ' + rects.length);
                session.onSelect(anchor, sel.toString());
              } catch (e) {
                // never fatal
              }
            }

            function attachSelectionListener() {
              if (disposed) return;
              document.addEventListener('selectionchange', onSelectionChange);
            }

            // Library thumbnail bounds (both axes capped) and the budget for
            // cover rendering. The cover is enrichment only: if page.render
            // never settles, the session must still open without a cover.
            const COVER_MAX_WIDTH = 360;
            const COVER_MAX_HEIGHT = 480;
            const COVER_TIMEOUT_MS = 2500;

            function buildCover() {
              return pdfDoc.getPage(1).then(function (page) {
                const naturalVp = page.getViewport({ scale: 1.0 });
                const scale = Math.min(1.0, COVER_MAX_WIDTH / naturalVp.width, COVER_MAX_HEIGHT / naturalVp.height);
                const viewport = page.getViewport({ scale: scale });
                const coverCanvas = document.createElement('canvas');
                coverCanvas.width = Math.max(1, Math.round(viewport.width));
                coverCanvas.height = Math.max(1, Math.round(viewport.height));
                const coverCtx = coverCanvas.getContext('2d');
                return page.render({ canvasContext: coverCtx, viewport: viewport }).promise.then(function () {
                  const out = coverCanvas.toDataURL('image/jpeg', 0.7);
                  // A canvas over the browser's dataURL size limit yields
                  // "data:," — treat anything not an image dataURL as no cover.
                  return typeof out === 'string' && out.indexOf('data:image/') === 0 ? out : null;
                });
              });
            }

            // Always settles (null on failure or timeout) so resolve(session)
            // runs even if the cover render hangs or throws synchronously.
            function resolveCover() {
              return new Promise(function (resolve) {
                let done = false;
                const timer = setTimeout(function () {
                  if (done) return;
                  done = true;
                  console.warn('[PDF] cover generation timed out');
                  resolve(null);
                }, COVER_TIMEOUT_MS);
                function finish(value) {
                  if (done) return;
                  done = true;
                  clearTimeout(timer);
                  resolve(value || null);
                }
                try {
                  buildCover().then(finish, function () { finish(null); });
                } catch (e) {
                  finish(null);
                }
              });
            }

            window.addEventListener('resize', onResize);
            let session = null;

            renderPage(1).then(function () {
              session = {
                title: file.name,
                format: 'pdf',
                numPages: pdfDoc.numPages,
                zoomMode: zoomMode,
                zoomLevel: zoomLevel,
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
                    // Search hits carry their rects inside loc (app.js calls
                    // goTo(hit.loc) unchanged). Adopt them as the active rects
                    // so the clicked hit is painted in the stronger color; any
                    // other navigation clears the active highlight.
                    activeRects = (loc && Array.isArray(loc.rects) && loc.rects.length)
                      ? loc.rects
                      : null;
                    activePage = activeRects ? loc.page : 0;
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
                setZoomMode: function (mode) {
                  zoomMode = mode;
                  session.zoomMode = mode;
                  if (mode === 'original') {
                    zoomLevel = 1.0;
                    session.zoomLevel = zoomLevel;
                  }
                  return renderPage(pageNum);
                },
                setZoomLevel: function (level) {
                  zoomLevel = Math.max(0.5, Math.min(4.0, level));
                  zoomMode = 'manual';
                  session.zoomMode = 'manual';
                  session.zoomLevel = zoomLevel;
                  return renderPage(pageNum);
                },
                zoomIn: function () {
                  zoomLevel = Math.min(zoomLevel + 0.1, 4.0);
                  zoomMode = 'manual';
                  session.zoomMode = 'manual';
                  session.zoomLevel = zoomLevel;
                  return renderPage(pageNum);
                },
                zoomOut: function () {
                  zoomLevel = Math.max(zoomLevel - 0.1, 0.5);
                  zoomMode = 'manual';
                  session.zoomMode = 'manual';
                  session.zoomLevel = zoomLevel;
                  return renderPage(pageNum);
                },
                // Page-based search over the PDF text layer. Matching is done
                // on the concatenation of all text items, so a hit can span
                // several items. For every hit we compute the PDF-space rects
                // of the matched span across the items it covers and store
                // them on the hit (hit.rects, also mirrored into hit.loc so
                // app.js's goTo(hit.loc) carries them). The same rects are
                // cached per page (hitRectsByPage) and paintSearchHighlights
                // paints only these saved rects — search and highlight share
                // one matching unit, so every listed hit is paintable.
                search: function (query) {
                  return Promise.resolve().then(function () {
                    const q = String(query == null ? '' : query).trim();
                    currentQuery = q;
                    activeRects = null;
                    activePage = 0;
                    hitRectsByPage = new Map();
                    const version = ++searchVersion;
                    if (!q) return [];
                    const needle = q.toLowerCase();
                    const MAX_HITS = 200;
                    const CONTEXT = 40;
                    const numPages = pdfDoc.numPages;
                    const hits = [];

                    function scanPage(p) {
                      if (version !== searchVersion) return Promise.resolve();
                      if (hits.length >= MAX_HITS) return Promise.resolve();
                      return pdfDoc.getPage(p)
                        .then(function (page) {
                          return page.getTextContent();
                        })
                        .then(function (textContent) {
                          if (version !== searchVersion) return;
                          const items = (textContent && textContent.items) || [];
                          // Build the concatenated text plus, per contributing
                          // item, its start offset in the concatenation and its
                          // PDF-space geometry (transform origin, height, width).
                          let full = '';
                          const map = [];
                          for (var i = 0; i < items.length; i++) {
                            const item = items[i];
                            if (!item || typeof item.str !== 'string' || !item.str) continue;
                            const tr = item.transform;
                            map.push({
                              start: full.length,
                              len: item.str.length,
                              x: (tr && tr.length >= 6) ? tr[4] : 0,
                              y: (tr && tr.length >= 6) ? tr[5] : 0,
                              h: (tr && tr.length >= 6) ? Math.abs(tr[3]) : 0,
                              w: typeof item.width === 'number' ? item.width : 0
                            });
                            full += item.str;
                          }
                          const hay = full.toLowerCase();

                          // Rects (PDF user space) for the matched span
                          // [ms, me) of the concatenation. The span may cover
                          // several items; each covered item contributes one
                          // rect, its width apportioned by character count
                          // within that item (same proportional logic as before,
                          // now per covered item instead of per matched item).
                          function rectsForSpan(ms, me) {
                            const rects = [];
                            for (var m = 0; m < map.length; m++) {
                              const it = map[m];
                              const itEnd = it.start + it.len;
                              if (it.len <= 0 || it.start >= me || itEnd <= ms) continue;
                              const s = Math.max(ms, it.start);
                              const e = Math.min(me, itEnd);
                              const off = (s - it.start) / it.len * it.w;
                              const w = (e - s) / it.len * it.w;
                              rects.push({ x: it.x + off, y: it.y, w: w, h: it.h });
                            }
                            return rects;
                          }

                          let from = 0;
                          let idx = hay.indexOf(needle, from);
                          const pageHits = hitRectsByPage.get(p) || [];
                          while (idx !== -1 && hits.length < MAX_HITS) {
                            const start = Math.max(0, idx - CONTEXT);
                            const end = Math.min(full.length, idx + needle.length + CONTEXT);
                            let snippet = full.slice(start, end).replace(/\s+/g, ' ').trim();
                            if (start > 0) snippet = '\u2026' + snippet;
                            if (end < full.length) snippet += '\u2026';
                            const rects = rectsForSpan(idx, idx + needle.length);
                            const hit = {
                              id: 'pdf-' + p + '-' + hits.length,
                              page: p,
                              loc: { page: p, rects: rects },
                              rects: rects,
                              snippet: snippet
                            };
                            hits.push(hit);
                            pageHits.push(hit);
                            from = idx + needle.length;
                            idx = hay.indexOf(needle, from);
                          }
                          if (pageHits.length && version === searchVersion) {
                            hitRectsByPage.set(p, pageHits);
                          }
                        })
                        .catch(function () {
                          // Skip a page we cannot fetch/parse; keep searching.
                        });
                    }

                    let chain = Promise.resolve();
                    for (var p = 1; p <= numPages; p++) {
                      (function (page) {
                        chain = chain.then(function () {
                          return scanPage(page);
                        });
                      })(p);
                    }
                    return chain.then(function () {
                      if (version !== searchVersion) return [];
                      return hits;
                    });
                  });
                },
                clearSearch: function () {
                  // Drop the canvas highlights: clear the cached rects, the
                  // active hit and the query, then repaint.
                  currentQuery = '';
                  activeRects = null;
                  activePage = 0;
                  hitRectsByPage = new Map();
                  searchVersion++;
                  return renderPage(pageNum);
                },
                highlightMatches: function (query) {
                  currentQuery = String(query == null ? '' : query).trim();
                  activeRects = null;
                  activePage = 0;
                  return renderPage(pageNum);
                },
                // Marker-pen highlights. Same contract as the text renderers:
                // app.js assigns onSelect and calls applyHighlights with the
                // saved list [{ id, anchor: {type:'rect', page, rects} }].
                // Anchors are opaque to app.js (passed through untouched).
                onSelect: null,
                applyHighlights: function (list) {
                  if (!Array.isArray(list)) return;
                  userHighlightRects = new Map();
                  for (var i = 0; i < list.length; i++) {
                    const h = list[i];
                    const anchor = h && h.anchor;
                    if (!anchor || typeof anchor.page !== 'number' ||
                      !Array.isArray(anchor.rects)) continue;
                    const arr = userHighlightRects.get(anchor.page) || [];
                    for (var r = 0; r < anchor.rects.length; r++) {
                      if (anchor.rects[r]) arr.push(anchor.rects[r]);
                    }
                    userHighlightRects.set(anchor.page, arr);
                  }
                  repaintForHighlights();
                },
                addHighlight: function (anchor) {
                  if (!anchor || typeof anchor.page !== 'number' ||
                    !Array.isArray(anchor.rects)) return;
                  const arr = userHighlightRects.get(anchor.page) || [];
                  for (var r = 0; r < anchor.rects.length; r++) {
                    if (anchor.rects[r]) arr.push(anchor.rects[r]);
                  }
                  userHighlightRects.set(anchor.page, arr);
                  repaintForHighlights();
                },
                removeHighlight: function (anchor) {
                  if (!anchor || typeof anchor.page !== 'number') return;
                  const arr = userHighlightRects.get(anchor.page);
                  if (!arr) return;
                  const kill = Array.isArray(anchor.rects) ? anchor.rects : [];
                  // Remove one stored rect per kill rect (count-based 1:1
                  // consumption), so a rect shared by two highlights survives
                  // until both highlights are removed.
                  const counts = new Map();
                  for (var k = 0; k < kill.length; k++) {
                    const kk = kill[k];
                    if (!kk) continue;
                    const key = kk.x + '|' + kk.y + '|' + kk.w + '|' + kk.h;
                    counts.set(key, (counts.get(key) || 0) + 1);
                  }
                  const kept = arr.filter(function (rect) {
                    if (!rect) return false;
                    const key = rect.x + '|' + rect.y + '|' + rect.w + '|' + rect.h;
                    const n = counts.get(key) || 0;
                    if (!n) return true;
                    counts.set(key, n - 1);
                    return false;
                  });
                  if (kept.length) {
                    userHighlightRects.set(anchor.page, kept);
                  } else {
                    userHighlightRects.delete(anchor.page);
                  }
                  repaintForHighlights();
                },
                jumpToHighlight: function (anchor) {
                  if (!anchor || typeof anchor.page !== 'number') {
                    return Promise.resolve();
                  }
                  return session.goTo({ page: anchor.page });
                },
                destroy: function () {
                  disposed = true;
                  renderVersion++;
                  window.removeEventListener('resize', onResize);
                  document.removeEventListener('selectionchange', onSelectionChange);
                  session.onSelect = null;
                  clearTimeout(resizeTimer);
                  container.innerHTML = '';
                },
              };
              // Resolve immediately so the session (and thus search) is usable
              // as soon as page 1 is on screen. The cover is unrelated to search
              // and may take up to COVER_TIMEOUT_MS, so build it in the
              // background and attach it when it arrives.
              resolve(session);
              resolveCover().then(function (dataUrl) {
                if (!dataUrl) return;
                session.cover = dataUrl;
                if (typeof session.onCover === 'function') session.onCover(dataUrl);
              }).catch(function () {});
              attachSelectionListener();
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