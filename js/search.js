/* ==========================================================================
   LLL-E-Book — search.js
   In-book text search for the DOM-rendered, scroll-based formats (TXT/HTML/
   RTF via text.js, FB2 via fb2.js). Shared by those renderers to build a
   uniform session.search / session.clearSearch interface.

   EPUB / PDF / CBZ deliberately do NOT use this module: epub.js 0.3.93 has no
   official search API (would need a full spine scan), PDF renders to canvas
   (no text nodes in the DOM) and CBZ is images only. Those formats are out of
   scope for phase 1, so their sessions expose no search() and app.js shows an
   "unsupported" notice instead.

   Loaded as a classic script BEFORE the renderers that call createSearch().
   ========================================================================== */
(function () {
  'use strict';

  var MAX_HITS = 200;        // safety cap on highlighted matches per search
  var MARK_CLASS = 'book-search-hit';
  var INJECTED_ATTR = 'data-lll-search-injected'; // marks elements whose id WE injected
  var CONTEXT = 40;          // snippet context characters on each side

  // Per-instance random prefix so injected ids cannot collide with ids that
  // already exist in the book body.
  function makeIdPrefix() {
    return 'lll-search-' + Math.random().toString(36).slice(2) + '-';
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Nearest block-level ancestor used as the scroll anchor for a hit.
  function blockAncestor(node) {
    var el = node.nodeType === 3 ? node.parentNode : node;
    while (el && el.nodeType === 1) {
      var tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'li' ||
          tag === 'td' || tag === 'th' || tag === 'blockquote' ||
          tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' ||
          tag === 'h5' || tag === 'h6') {
        return el;
      }
      el = el.parentNode;
    }
    return node.nodeType === 3 ? node.parentNode : node;
  }

  // Collect the text nodes inside `root` that are worth searching. Skips
  // script/style and any marks left over from a previous (uncleared) search.
  function collectTextNodes(root) {
    var nodes = [];
    var walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (node) {
          if (!node.nodeValue || !node.nodeValue.trim()) {
            return NodeFilter.FILTER_REJECT;
          }
          var p = node.parentNode;
          while (p && p.nodeType === 1) {
            var tag = p.tagName ? p.tagName.toLowerCase() : '';
            if (tag === 'script' || tag === 'style') {
              return NodeFilter.FILTER_REJECT;
            }
            if (p.classList && p.classList.contains(MARK_CLASS)) {
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
    return nodes;
  }

  // Wrap every occurrence of `query` (case-insensitive) inside a single text
  // node with <mark> elements. Returns the number of marks created, never more
  // than `budget` (the remaining hit allowance across all nodes). Uses only
  // DOM APIs (splitText / appendChild / createTextNode) — the raw query is
  // never concatenated into an HTML string, so no markup can be injected.
  function markNode(node, re, budget) {
    var text = node.nodeValue;
    re.lastIndex = 0;
    if (!re.test(text)) return 0;
    re.lastIndex = 0;

    var frag = document.createDocumentFragment();
    var last = 0;
    var count = 0;
    var m;
    while ((m = re.exec(text)) !== null && count < budget) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (m.index > last) {
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      var mark = document.createElement('mark');
      mark.className = MARK_CLASS;
      mark.textContent = m[0]; // textContent: query text is never parsed as HTML
      frag.appendChild(mark);
      last = m.index + m[0].length;
      count++;
    }
    if (count === 0) return 0;
    if (last < text.length) {
      frag.appendChild(document.createTextNode(text.slice(last)));
    }
    node.parentNode.replaceChild(frag, node);
    return count;
  }

  // A short plain-text snippet around the hit for the results list. Returned
  // as raw text — app.js renders it via textContent (no HTML injection).
  // Uses a Range to measure the exact offset of THIS mark inside its block,
  // so multiple hits in one block each get a snippet centered on their own
  // occurrence instead of all showing the first one.
  function buildSnippet(mark) {
    var block = blockAncestor(mark);
    if (!block) return (mark.textContent || '').trim();
    var full = block.textContent || '';
    var word = mark.textContent || '';

    var idx = -1;
    try {
      var range = document.createRange();
      range.selectNodeContents(block);
      range.setEnd(mark, 0); // everything in the block strictly before the mark
      idx = (range.toString() || '').length;
    } catch (e) {
      idx = -1;
    }
    if (idx < 0) idx = Math.max(0, full.indexOf(word));

    var start = Math.max(0, idx - CONTEXT);
    var end = Math.min(full.length, idx + word.length + CONTEXT);
    var snippet = full.slice(start, end).replace(/\s+/g, ' ').trim();
    if (start > 0) snippet = '\u2026' + snippet;
    if (end < full.length) snippet += '\u2026';
    return snippet;
  }

  /**
   * createSearch(container) -> { search, clearSearch }
   * `container` is the same element the renderer painted into. The returned
   * pair is attached to the session as session.search / session.clearSearch.
   */
  function createSearch(container) {
    var idPrefix = makeIdPrefix();
    var idSeq = 0;
    // Elements whose `id` WE injected (never book-body elements). clearSearch
    // only ever touches ids recorded here.
    var injectedIdEls = new Set();

    function clearSearch() {
      if (!container) return;
      // Remove ONLY the ids we injected ourselves (tracked in the Set), so an
      // id that already existed in the book body is never removed.
      injectedIdEls.forEach(function (el) {
        el.removeAttribute('id');
        el.removeAttribute(INJECTED_ATTR);
      });
      injectedIdEls.clear();
      // Unwrap every highlight mark, restoring the original text nodes. The
      // per-hit ids live on the marks themselves, so they disappear with them.
      container.querySelectorAll('mark.' + MARK_CLASS).forEach(function (mark) {
        var parent = mark.parentNode;
        if (!parent) return;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
      });
      container.normalize();
    }

    function search(query) {
      return Promise.resolve().then(function () {
        clearSearch(); // re-search starts from a clean DOM
        var q = String(query == null ? '' : query).trim();
        if (!q || !container) return [];

        var re;
        try {
          re = new RegExp(escapeRegExp(q), 'gi');
        } catch (e) {
          return [];
        }

        var nodes = collectTextNodes(container);
        var total = 0;
        for (var i = 0; i < nodes.length && total < MAX_HITS; i++) {
          var budget = MAX_HITS - total; // remaining allowance, so the sum
          total += markNode(nodes[i], re, budget); // across nodes never exceeds MAX_HITS
        }
        if (total === 0) return [];

        var results = [];
        var marks = container.querySelectorAll('mark.' + MARK_CLASS);
        for (var k = 0; k < marks.length; k++) {
          var mark = marks[k];
          // Give every mark its own unique id so goTo({anchor: hit.id}) can
          // scroll to the exact matched word, not just the start of the block.
          // If an element already has a real id, keep it and remember it as one
          // we injected so clearSearch removes exactly what we added.
          if (!mark.id) {
            mark.id = idPrefix + idSeq;
            idSeq++;
          }
          mark.setAttribute(INJECTED_ATTR, '1');
          injectedIdEls.add(mark);
          results.push({
            id: mark.id,
            snippet: buildSnippet(mark)
          });
        }
        return results;
      });
    }

    return { search: search, clearSearch: clearSearch };
  }

  window.LLLBook = window.LLLBook || {};
  window.LLLBook.Search = { createSearch: createSearch, MAX_HITS: MAX_HITS };
})();
