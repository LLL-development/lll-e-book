/* ==========================================================================
   LLL-E-Book — renderers/fb2.js
   Renders FB2 (FictionBook) files by parsing the XML and rendering as HTML.
   Location is a scroll-based ratio (0..1) within the rendered content.
   ========================================================================== */
(function () {
  'use strict';

  /**
   * Parse FB2 XML string into a DOM Document.
   */
  function parseFb2(xml) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(xml, 'application/xml');
    var parseError = doc.querySelector('parsererror');
    if (parseError) {
      throw new Error('fb2-parse: ' + parseError.textContent);
    }
    return doc;
  }

  /**
   * Extract text content from an FB2 element, handling nested <p>, <a>,
   * <style>, <emphasis>, <strikethrough>, <strong>, <sub>, <sup> etc.
   */
  function extractText(el, binaries) {
    if (!el) return '';
    var parts = [];
    var children = el.childNodes;
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (child.nodeType === 3) {
        parts.push(escapeHtml(child.textContent));
      } else if (child.nodeType === 1) {
        var tag = child.tagName ? child.tagName.toLowerCase() : '';
        var inner = extractText(child, binaries);
        if (tag === 'a') {
          var aHref = sanitizeUrl(child.getAttribute('href') || '');
          inner = '<a href="' + escapeAttr(aHref) + '">' + inner + '</a>';
        } else if (tag === 'emphasis') {
          inner = '<em>' + inner + '</em>';
        } else if (tag === 'strong') {
          inner = '<strong>' + inner + '</strong>';
        } else if (tag === 'strikethrough') {
          inner = '<s>' + inner + '</s>';
        } else if (tag === 'sub') {
          inner = '<sub>' + inner + '</sub>';
        } else if (tag === 'sup') {
          inner = '<sup>' + inner + '</sup>';
        } else if (tag === 'style') {
          inner = '<span style="' + escapeAttr(child.getAttribute('style') || '') + '">' + inner + '</span>';
        } else if (tag === 'title' || tag === 'subtitle' || tag === 'p' || tag === 'empty-line') {
          inner = '<' + tag + '>' + inner + '</' + tag + '>';
        } else if (tag === 'section') {
          inner = '<section>' + inner + '</section>';
        } else if (tag === 'epigraph') {
          inner = '<div class="fb2-epigraph">' + inner + '</div>';
        } else if (tag === 'annotation') {
          inner = '<div class="fb2-annotation">' + inner + '</div>';
        } else if (tag === 'image') {
          var imgSrc = child.getAttribute('xlink:href') || child.getAttribute('href') || '';
          if (binaries && binaries[imgSrc]) imgSrc = binaries[imgSrc];
          inner = '<img src="' + escapeAttr(imgSrc) + '" alt="" />';
        } else if (tag === 'table') {
          inner = '<table>' + inner + '</table>';
        } else if (tag === 'tr' || tag === 'td' || tag === 'th') {
          inner = '<' + tag + '>' + inner + '</' + tag + '>';
        } else if (tag === 'paragraph') {
          inner = '<p>' + inner + '</p>';
        } else if (tag === 'text-author') {
          inner = '<cite>' + inner + '</cite>';
        } else if (tag === 'poem') {
          inner = '<div class="fb2-poem">' + inner + '</div>';
        } else if (tag === 'stanza') {
          inner = '<div class="fb2-stanza">' + inner + '</div>';
        } else if (tag === 'quote') {
          inner = '<blockquote>' + inner + '</blockquote>';
        } else if (tag === 'note') {
          inner = '<aside class="fb2-note">' + inner + '</aside>';
        } else {
          inner = '<span>' + inner + '</span>';
        }
        parts.push(inner);
      }
    }
    return parts.join('');
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function sanitizeUrl(url) {
    var u = String(url || '').trim();
    if (/^(https?:|mailto:|#|\/)/i.test(u)) return u;
    return '';
  }

  /**
   * Extract the body element from an FB2 document.
   */
  function getBody(doc) {
    return doc.querySelector('body') || doc.documentElement;
  }

  function isFb2(doc) {
    return !!(doc.documentElement && doc.documentElement.localName === 'FictionBook');
  }

  /**
   * Flatten nested FB2 <section> elements into a flat HTML string with
   * proper heading levels and paragraph structure.
   */
  function renderSection(section, headingLevel, toc, idCounter, binaries) {
    headingLevel = headingLevel || 1;
    toc = toc || [];
    var html = '';
    var children = section.childNodes;
    var hasTitle = false;
    var sectionIndex = 0;

    for (var i = 0; i < children.length; i++) {
      var child = children[i];

      if (child.nodeType === 3) {
        var text = child.textContent.trim();
        if (text) {
          html += '<p>' + escapeHtml(text) + '</p>';
        }
        continue;
      }

      if (child.nodeType !== 1) continue;

      var tag = child.tagName ? child.tagName.toLowerCase() : '';

      if (tag === 'title' || tag === 'subtitle') {
        hasTitle = true;
        var titleText = (child.textContent || '').trim();
        if (titleText) {
          var hTag = 'h' + Math.min(headingLevel + 1, 6);
          var titleId = 'fb2-title-' + idCounter.n++;
          toc.push({ label: titleText, target: { anchor: titleId }, depth: headingLevel });
          html += '<' + hTag + ' id="' + titleId + '">' + escapeHtml(titleText) + '</' + hTag + '>';
        }
      } else if (tag === 'section') {
        sectionIndex++;
        var sectionHasTitle = false;
        var sectionChildren = child.childNodes;
        for (var si = 0; si < sectionChildren.length; si++) {
          var sc = sectionChildren[si];
          if (sc.nodeType === 1) {
            var scTag = sc.tagName ? sc.tagName.toLowerCase() : '';
            if (scTag === 'title' || scTag === 'subtitle') {
              sectionHasTitle = true;
              break;
            }
          }
        }
        if (!sectionHasTitle) {
          var sectionLabel = '';
          var firstP = null;
          for (var pi = 0; pi < sectionChildren.length; pi++) {
            var pc = sectionChildren[pi];
            if (pc.nodeType === 1 && pc.tagName && pc.tagName.toLowerCase() === 'p') {
              firstP = pc;
              break;
            }
          }
          if (firstP) {
            sectionLabel = (firstP.textContent || '').trim().substring(0, 50);
          }
          if (!sectionLabel) {
            sectionLabel = 'Section ' + sectionIndex;
          }
          var secId = 'fb2-title-' + idCounter.n++;
          toc.push({ label: sectionLabel, target: { anchor: secId }, depth: headingLevel });
          html += '<div id="' + secId + '">';
          html += renderSection(child, headingLevel + 1, toc, idCounter, binaries);
          html += '</div>';
          continue;
        }
        html += renderSection(child, headingLevel + 1, toc, idCounter, binaries);
      } else if (tag === 'p') {
        html += '<p>' + extractText(child, binaries) + '</p>';
      } else if (tag === 'epigraph') {
        var epigraphChildren = child.childNodes;
        var epigraphHasContent = false;
        var epigraphFirstP = null;
        for (var ei = 0; ei < epigraphChildren.length; ei++) {
          var ec = epigraphChildren[ei];
          if (ec.nodeType === 1 && ec.tagName && ec.tagName.toLowerCase() === 'p') {
            epigraphFirstP = ec;
            break;
          }
          if (ec.nodeType === 1) {
            epigraphHasContent = true;
          }
          if (ec.nodeType === 3 && ec.textContent.trim()) {
            epigraphHasContent = true;
          }
        }
        if (epigraphHasContent && !epigraphFirstP) {
          for (var ej = 0; ej < epigraphChildren.length; ej++) {
            var ejc = epigraphChildren[ej];
            if (ejc.nodeType === 1) {
              epigraphHasContent = true;
              break;
            }
          }
        }
        var epigraphLabel = '';
        if (epigraphFirstP) {
          epigraphLabel = (epigraphFirstP.textContent || '').trim().substring(0, 50);
        }
        if (epigraphLabel) {
          var epigraphId = 'fb2-title-' + idCounter.n++;
          toc.push({ label: epigraphLabel, target: { anchor: epigraphId }, depth: 1 });
        }
        html += '<div class="fb2-epigraph"><blockquote>' + extractText(child, binaries) + '</blockquote></div>';
      } else if (tag === 'annotation') {
        var annotationChildren = child.childNodes;
        var annotationFirstP = null;
        for (var ai = 0; ai < annotationChildren.length; ai++) {
          var ac = annotationChildren[ai];
          if (ac.nodeType === 1 && ac.tagName && ac.tagName.toLowerCase() === 'p') {
            annotationFirstP = ac;
            break;
          }
        }
        var annotationLabel = '';
        if (annotationFirstP) {
          annotationLabel = (annotationFirstP.textContent || '').trim().substring(0, 50);
        }
        if (annotationLabel) {
          var annotationId = 'fb2-title-' + idCounter.n++;
          toc.push({ label: annotationLabel, target: { anchor: annotationId }, depth: 1 });
        }
        html += '<div class="fb2-annotation">' + extractText(child, binaries) + '</div>';
      } else if (tag === 'empty-line') {
        html += '<div style="height:0.5em"></div>';
      } else if (tag === 'image') {
        var src = child.getAttribute('xlink:href') || child.getAttribute('href') || '';
        if (binaries && binaries[src]) src = binaries[src];
        html += '<div class="fb2-image"><img src="' + escapeAttr(src) + '" alt="" /></div>';
      } else if (tag === 'table') {
        html += '<div class="fb2-table">' + extractText(child, binaries) + '</div>';
      } else if (tag === 'note') {
        html += '<aside class="fb2-note"><blockquote>' + extractText(child, binaries) + '</blockquote></aside>';
      } else if (tag === 'quote') {
        html += '<blockquote class="fb2-quote">' + extractText(child, binaries) + '</blockquote>';
      } else if (tag === 'text-author') {
        html += '<p class="fb2-text-author"><cite>' + extractText(child, binaries) + '</cite></p>';
      } else if (tag === 'poem') {
        var poemTitle = '';
        var poemTitleEl = child.querySelector('title') || child.querySelector('subtitle');
        if (poemTitleEl) {
          poemTitle = (poemTitleEl.textContent || '').trim();
        }
        if (!poemTitle) {
          var firstV = child.querySelector('v');
          if (firstV) {
            poemTitle = (firstV.textContent || '').trim().substring(0, 50);
          }
        }
        if (poemTitle) {
          var poemId = 'fb2-title-' + idCounter.n++;
          toc.push({ label: poemTitle, target: { anchor: poemId }, depth: headingLevel });
        }
        html += '<div class="fb2-poem">' + extractText(child, binaries) + '</div>';
      } else if (tag === 'strophe') {
        html += '<div class="fb2-strophe">' + extractText(child, binaries) + '</div>';
      } else if (tag === 'a') {
        var href = sanitizeUrl(child.getAttribute('href') || '');
        html += '<a href="' + escapeAttr(href) + '">' + extractText(child, binaries) + '</a>';
      } else if (tag === 'emphasis') {
        html += '<em>' + extractText(child, binaries) + '</em>';
      } else if (tag === 'strong') {
        html += '<strong>' + extractText(child, binaries) + '</strong>';
      } else if (tag === 'strikethrough') {
        html += '<s>' + extractText(child, binaries) + '</s>';
      } else if (tag === 'sub') {
        html += '<sub>' + extractText(child, binaries) + '</sub>';
      } else if (tag === 'sup') {
        html += '<sup>' + extractText(child, binaries) + '</sup>';
      } else if (tag === 'code' || tag === 'style') {
        html += '<code>' + extractText(child, binaries) + '</code>';
      } else {
        html += extractText(child, binaries);
      }
    }

    return html;
  }

  /**
   * Extract book title and author(s) from <description><title-info>.
   * Returns { title, author } with empty strings when absent. Multiple
   * authors are joined with ", ". Author names combine
   * first/middle/last when present, otherwise fall back to <nickname>.
   */
  function extractMeta(doc) {
    var meta = { title: '', author: '' };
    var desc = doc.querySelector('description');
    if (!desc) return meta;
    var titleInfo = desc.querySelector('title-info');
    if (!titleInfo) return meta;

    var titleEl = titleInfo.querySelector('book-title');
    if (!titleEl) titleEl = titleInfo.querySelector('article-title');
    if (titleEl) meta.title = (titleEl.textContent || '').trim();

    var names = [];
    titleInfo.querySelectorAll('author').forEach(function (a) {
      // Only direct <author> children of this title-info (skip nested ones).
      if (a.parentNode !== titleInfo) return;
      function txt(tag) {
        var el = a.querySelector(tag);
        return el ? (el.textContent || '').trim() : '';
      }
      var parts = [txt('first-name'), txt('middle-name'), txt('last-name')];
      var name = parts.filter(Boolean).join(' ');
      if (!name) name = txt('nickname');
      if (name) names.push(name);
    });
    meta.author = names.join(', ');
    return meta;
  }

  /**
   * Library thumbnail bounds (both axes capped) and the budget for cover
   * resolution. The cover is enrichment only: if the shrink pipeline never
   * settles, the session must still open without a cover.
   */
  var COVER_MAX_WIDTH = 360;
  var COVER_MAX_HEIGHT = 480;
  var COVER_TIMEOUT_MS = 2500;

  /**
   * Shrink a dataURL image to a library-thumbnail-sized JPEG dataURL.
   * Purely best-effort: any failure (decode error, tainted canvas) resolves
   * with null so the caller leaves session.cover unset and the book opens.
   */
  function shrinkToDataURL(src) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width;
          var h = img.naturalHeight || img.height;
          if (!w || !h) { resolve(null); return; }
          var scale = Math.min(1, COVER_MAX_WIDTH / w, COVER_MAX_HEIGHT / h);
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          var out = canvas.toDataURL('image/jpeg', 0.82);
          // A canvas over the browser's dataURL size limit yields "data:," —
          // treat anything that is not an image dataURL as no cover.
          resolve(typeof out === 'string' && out.indexOf('data:image/') === 0 ? out : null);
        } catch (e) {
          resolve(null);
        }
      };
      img.onerror = function () { resolve(null); };
      try {
        img.src = String(src);
      } catch (e) {
        resolve(null);
      }
    });
  }

  /**
   * Resolve the FB2 coverpage image to a dataURL via the <binary> map.
   * FB2 standard: <description><title-info><coverpage><image href="#id"/>.
   * The href may use the xlink:href attribute. Returns null when absent or
   * unresolved.
   */
  function extractCover(doc, binaries) {
    var desc = doc.querySelector('description');
    if (!desc) return null;
    var titleInfo = desc.querySelector('title-info');
    if (!titleInfo) return null;
    var coverpage = titleInfo.querySelector('coverpage');
    if (!coverpage) return null;
    var imgEl = coverpage.querySelector('image');
    if (!imgEl) return null;
    // FB2 <image> uses the namespaced xlink:href. getAttribute('xlink:href')
    // only works when the parser kept the prefixed name (HTML mode); in XML
    // mode the attribute is namespace-local and needs getAttributeNS. Try all
    // three so the cover is found either way.
    var href = '';
    try {
      if (typeof imgEl.getAttributeNS === 'function') {
        href = imgEl.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
      }
    } catch (e) { /* fall through to plain getAttribute */ }
    if (!href) href = imgEl.getAttribute('xlink:href') || '';
    if (!href) href = imgEl.getAttribute('href') || '';
    if (!href) return null;
    // binaries keys are built as '#' + id (see render()); normalize a bare id.
    var src = binaries[href] || (href.charAt(0) !== '#' ? binaries['#' + href] : null);
    return src || null;
  }

  /**
   * render(file, container) -> Promise<session>
   * Scroll-based session: location is a 0..1 ratio of the container's scroll.
   */
  function render(file, container) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var doc = parseFb2(reader.result);
          if (!isFb2(doc)) {
            throw new Error('fb2-invalid-root');
          }
          var body = getBody(doc);

          // Build binary map for embedded images (covers, etc.)
          var binaries = {};
          doc.querySelectorAll('binary').forEach(function (b) {
            var id = b.getAttribute('id');
            if (id) {
              binaries['#' + id] = 'data:' + (b.getAttribute('content-type') || 'image/jpeg') + ';base64,' + (b.textContent || '').trim();
            }
          });

          // Build the rendered HTML from the body sections.
          var html = '';
          var toc = [];
          var idCounter = { n: 0 };

          // Check for annotation at body level (direct children only)
          var annotation = Array.from(body.children).find(function (el) {
            return el.localName === 'annotation';
          });
          if (annotation) {
            html += '<div class="fb2-annotation">' + extractText(annotation, binaries) + '</div>';
          }

          // Render all top-level sections.
          var sections = body.querySelectorAll(':scope > section');
          for (var i = 0; i < sections.length; i++) {
            html += renderSection(sections[i], 1, toc, idCounter, binaries);
          }

          // Fallback: if no TOC entries were found in body sections,
          // extract the book title from <description><title-info><book-title>.
          if (!toc.length) {
            var desc = doc.querySelector('description');
            if (desc) {
              var bookTitleEl = desc.querySelector('title-info > book-title');
              if (!bookTitleEl) {
                bookTitleEl = desc.querySelector('title-info > article-title');
              }
              if (!bookTitleEl) {
                bookTitleEl = desc.querySelector('title-info > title');
              }
              if (bookTitleEl) {
                var fallbackText = (bookTitleEl.textContent || '').trim();
                if (fallbackText) {
                  var fallbackId = 'fb2-title-' + idCounter.n++;
                  toc.push({ label: fallbackText, target: { anchor: fallbackId }, depth: 0 });
                  // Prepend the fallback title to the rendered content.
                  html = '<h1 id="' + fallbackId + '">' + escapeHtml(fallbackText) + '</h1>' + html;
                }
              }
            }
          }

          // Also check for direct <p> elements in body (no section wrapper).
          var directParagraphs = body.querySelectorAll(':scope > p');
          for (var j = 0; j < directParagraphs.length; j++) {
            html += '<p>' + extractText(directParagraphs[j], binaries) + '</p>';
          }

          container.innerHTML = '<div class="fb2-content">' + html + '</div>';

          function ratio() {
            var viewH = window.innerHeight;
            var docH = document.documentElement.scrollHeight;
            var maxDocScroll = docH - viewH;
            if (maxDocScroll <= 0) return 0;
            return Math.max(0, Math.min(1, window.scrollY / maxDocScroll));
          }
          function setRatio(r) {
            r = Math.max(0, Math.min(1, r));
            var viewH = window.innerHeight;
            var docH = document.documentElement.scrollHeight;
            var maxDocScroll = docH - viewH;
            if (maxDocScroll <= 0) return;
            window.scrollTo({ top: r * maxDocScroll, behavior: 'auto' });
          }

          var meta = extractMeta(doc);
          var searchApi = window.LLLBook.Search.createSearch(container);

          // Best-effort coverpage: resolve before the session is returned so
          // app.js can persist it. The wrapper below always settles within
          // COVER_TIMEOUT_MS (null on failure/timeout), and buildSession
          // failures fall back to a cover-less session, so a cover problem can
          // never block opening the book.
          function resolveCover() {
            return new Promise(function (resolve) {
              var done = false;
              var timer = setTimeout(function () {
                if (done) return;
                done = true;
                resolve(null);
              }, COVER_TIMEOUT_MS);
              function finish(value) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(value || null);
              }
              try {
                var coverSrc = extractCover(doc, binaries);
                if (!coverSrc) { finish(null); return; }
                shrinkToDataURL(coverSrc).then(finish, function () { finish(null); });
              } catch (e) {
                finish(null);
              }
            });
          }

          function settleWithCover() {
            resolveCover().then(function (cover) {
              var session = null;
              try {
                session = buildSession(cover);
              } catch (e) {
                session = null;
              }
              if (!session) {
                try {
                  session = buildSession(null);
                } catch (e2) {
                  reject(new Error('fb2-render: ' + e2.message));
                  return;
                }
              }
              resolve(session);
            });
          }
          function buildSession(cover) {
            var session = {
            title: meta.title || file.name,
            author: meta.author,
            format: 'fb2',
            next: function () {
              window.scrollBy({ top: window.innerHeight * 0.9, behavior: 'smooth' });
              return Promise.resolve();
            },
            prev: function () {
              window.scrollBy({ top: -window.innerHeight * 0.9, behavior: 'smooth' });
              return Promise.resolve();
            },
            goTo: function (loc) {
              if (!loc) return Promise.resolve();
              if (loc.anchor) {
                var el = document.getElementById(loc.anchor);
                if (el) el.scrollIntoView({ block: 'start' });
                return Promise.resolve();
              }
              if (typeof loc.ratio === 'number') setRatio(loc.ratio);
              return Promise.resolve();
            },
            getLocation: function () {
              return { type: 'scroll', ratio: ratio() };
            },
            setFontSize: function (px) {
              if (container && typeof px === 'number') {
                container.style.fontSize = px + 'px';
              }
              return Promise.resolve();
            },
            getToc: function () {
              return toc;
            },
            search: searchApi.search,
            clearSearch: searchApi.clearSearch,
            destroy: function () {
              container.innerHTML = '';
            },
            };
            if (cover) session.cover = cover;
            return session;
          }

          settleWithCover();
        } catch (e) {
          reject(new Error('fb2-render: ' + e.message));
        }
      };
      reader.onerror = function () {
        reject(new Error('read-error'));
      };
      reader.readAsText(file);
    });
  }

  window.LLLBook = window.LLLBook || {};
  window.LLLBook.renderers = window.LLLBook.renderers || {};
  window.LLLBook.renderers.fb2 = { render };
})();
