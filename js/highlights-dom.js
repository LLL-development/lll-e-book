/* ==========================================================================
   LLL-E-Book — highlights-dom.js
   Marker-pen highlights for the DOM-rendered, scroll-based formats (TXT/HTML/
   RTF via text.js, FB2 via fb2.js). Those formats have no EPUB-style CFI, so a
   highlight is stored as { text, before, after } (the selection plus a little
   context on each side) and restored on reopen by fuzzy-matching that text back
   into the painted DOM and wrapping it in <mark class="lll-highlight">.

   This mirrors search.js: classic script, IIFE + 'use strict', TreeWalker text
   collection, and DOM APIs only (createTextNode / replaceChild / textContent)
   so the stored text is never parsed as HTML — no markup can be injected.

   Loaded as a classic script BEFORE the renderers that call create(). It only
   defines window.LLLBook.HighlightsDom; it does not touch the session itself.

   EPUB / PDF / CBZ do NOT use this module: EPUB has its own CFI-based marker
   pen (renderers/epub.js), PDF renders to canvas and CBZ is images only.
   ========================================================================== */
(function () {
  'use strict';

  var MARK_CLASS = 'lll-highlight';   // distinct from search's book-search-hit
  var SEARCH_MARK_CLASS = 'book-search-hit';
  var HL_ID_ATTR = 'data-lll-hl-id';  // lets remove/jump find a mark by id
  var CONTEXT = 40;                   // context characters captured on each side

  // Collect the text nodes inside `root` that are worth matching against. Skips
  // script/style and any marks left over from a previous highlight or search so
  // a re-apply never matches inside an existing mark.
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
            if (p.classList &&
                (p.classList.contains(MARK_CLASS) ||
                 p.classList.contains(SEARCH_MARK_CLASS))) {
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

  // Wrap the text range [start, start+len) of a single text node in a
  // <mark class="lll-highlight">. Uses only createTextNode / createElement /
  // textContent / replaceChild — the matched text is set via textContent, never
  // concatenated into an HTML string, so no markup can be injected.
  function wrapRange(node, start, len, id) {
    var text = node.nodeValue;
    if (len <= 0 || start < 0 || start + len > text.length) return null;

    var frag = document.createDocumentFragment();
    if (start > 0) {
      frag.appendChild(document.createTextNode(text.slice(0, start)));
    }
    var mark = document.createElement('mark');
    mark.className = MARK_CLASS;
    if (id) mark.setAttribute(HL_ID_ATTR, id);
    mark.textContent = text.slice(start, start + len); // never parsed as HTML
    frag.appendChild(mark);
    if (start + len < text.length) {
      frag.appendChild(document.createTextNode(text.slice(start + len)));
    }
    node.parentNode.replaceChild(frag, node);
    return mark;
  }

  // Try to match `pattern` inside a node's text and wrap the `text` portion of
  // that match. `offsetInPattern` is where `text` begins within `pattern`.
  // Returns the created mark, or null when this node/pattern does not match.
  function tryMatchAndWrap(node, pattern, text, offsetInPattern, id) {
    if (!pattern) return null;
    var val = node.nodeValue;
    var idx = val.indexOf(pattern);
    if (idx < 0) return null;
    var start = idx + offsetInPattern;
    return wrapRange(node, start, text.length, id);
  }

  /**
   * create(container) -> highlight methods, attached to the session by the
   * renderer. `container` is the element the renderer painted the body into
   * (host document, not an iframe), so window.getSelection() applies directly.
   */
  function create(container) {
    // Read up to `count` characters of context before the selection start,
    // walking left through preceding text nodes when the start node is short.
    function readBefore(node, offset, count) {
      var acc = '';
      var cur = node;
      var off = offset;
      while (acc.length < count && cur) {
        var s = (cur.nodeValue || '').slice(0, off);
        if (s.length) acc = s + acc;
        var prev = null;
        var p = cur.previousSibling;
        while (p) {
          if (p.nodeType === 3) { prev = p; break; }
          if (p.nodeType === 1 && p.lastChild) { prev = p.lastChild; break; }
          p = p.previousSibling;
        }
        if (!prev) {
          var par = cur.parentNode;
          if (par && par !== container && par.nodeType === 1) {
            var gp = par.previousSibling;
            while (gp) {
              if (gp.nodeType === 3) { prev = gp; break; }
              if (gp.nodeType === 1 && gp.lastChild) { prev = gp.lastChild; break; }
              gp = gp.previousSibling;
            }
          }
        }
        cur = prev;
        off = cur ? (cur.nodeValue || '').length : 0;
      }
      return acc.length > count ? acc.slice(acc.length - count) : acc;
    }

    // Read up to `count` characters of context after the selection end, walking
    // right through following text nodes when the end node is short.
    function readAfter(node, offset, count) {
      var acc = '';
      var cur = node;
      var off = offset;
      while (acc.length < count && cur) {
        var s = (cur.nodeValue || '').slice(off);
        if (s.length) acc += s;
        var next = null;
        var p = cur.nextSibling;
        while (p) {
          if (p.nodeType === 3) { next = p; break; }
          if (p.nodeType === 1 && p.firstChild) { next = p.firstChild; break; }
          p = p.nextSibling;
        }
        if (!next) {
          var par = cur.parentNode;
          if (par && par !== container && par.nodeType === 1) {
            var gn = par.nextSibling;
            while (gn) {
              if (gn.nodeType === 3) { next = gn; break; }
              if (gn.nodeType === 1 && gn.firstChild) { next = gn.firstChild; break; }
              gn = gn.nextSibling;
            }
          }
        }
        cur = next;
        off = 0;
      }
      return acc.length > count ? acc.slice(0, count) : acc;
    }

    // Build a { type:'dom', text, before, after } anchor from the current
    // selection. Returns null when there is no (or only whitespace) selection.
    function getSelectionAnchor() {
      if (!container) return null;
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

      var text = sel.toString();
      if (!text || !text.trim()) return null;

      var range = sel.getRangeAt(0);
      var before = '';
      var after = '';
      try {
        if (range.startContainer && range.startContainer.nodeType === 3) {
          before = readBefore(range.startContainer, range.startOffset, CONTEXT);
        }
        if (range.endContainer && range.endContainer.nodeType === 3) {
          after = readAfter(range.endContainer, range.endOffset, CONTEXT);
        }
      } catch (e) {
        /* context is best-effort; an empty before/after is acceptable */
      }
      return { type: 'dom', text: text, before: before, after: after };
    }

    // Restore one anchor into the body. Tries the tightest needle first, then
    // loosens (before+text, text+after, text alone). Silent on no match.
    function applyOne(anchor) {
      if (!container || !anchor) return;
      var text = anchor.text || '';
      if (!text) {
        if (window.LLLBook && window.LLLBook.hlDbg) window.LLLBook.hlDbg('[HL-DBG-TXT] applyOne skip: empty text');
        return;
      }
      var before = anchor.before || '';
      var after = anchor.after || '';
      var id = anchor.id || '';

      var attempts = [
        { pat: before + text + after, off: before.length },
        { pat: before + text, off: before.length },
        { pat: text + after, off: 0 },
        { pat: text, off: 0 }
      ];

      var nodes = collectTextNodes(container);
      if (window.LLLBook && window.LLLBook.hlDbg) window.LLLBook.hlDbg('[HL-DBG-TXT] applyOne: nodes= ' + nodes.length + ' text= ' + JSON.stringify((text || '').slice(0, 40)));
      for (var a = 0; a < attempts.length; a++) {
        var attempt = attempts[a];
        if (!attempt.pat) continue;
        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          if (!node.parentNode) continue; // consumed by an earlier wrap
          var mark = tryMatchAndWrap(node, attempt.pat, text, attempt.off, id);
          if (mark) { if (window.LLLBook && window.LLLBook.hlDbg) window.LLLBook.hlDbg('[HL-DBG-TXT] applyOne MATCH attempt= ' + a + ' nodeLen= ' + node.nodeValue.length); return; }
        }
      }
      if (window.LLLBook && window.LLLBook.hlDbg) window.LLLBook.hlDbg('[HL-DBG-TXT] applyOne NO MATCH for text= ' + JSON.stringify((text || '').slice(0, 40)));
      // No match: leave the body untouched, never block reading.
    }

    // Restore a saved list. Per-entry try/catch so one bad anchor never stops
    // the rest. normalize() afterwards re-merges the text nodes split by wraps.
    function applyHighlights(list) {
      if (!container || !list || !list.length) {
        if (window.LLLBook && window.LLLBook.hlDbg) window.LLLBook.hlDbg('[HL-DBG-TXT] applyHighlights skip: list= ' + (list && list.length));
        return;
      }
      for (var i = 0; i < list.length; i++) {
        var h = list[i];
        var anchor = h && h.anchor ? h.anchor : h;
        if (!anchor) continue;
        if (anchor.id == null && h && h.id != null) anchor.id = h.id;
        try {
          if (window.LLLBook && window.LLLBook.hlDbg) window.LLLBook.hlDbg('[HL-DBG-TXT] applyHighlights restoring idx= ' + i + ' hasAnchor= ' + !!(h && h.anchor));
          applyOne(anchor);
        } catch (e) { /* skip this highlight, keep going */ }
      }
      try { container.normalize(); } catch (e) { /* detached container */ }
    }

    // Mark one anchor immediately.
    function addHighlight(anchor) {
      if (!anchor) return;
      try {
        applyOne(anchor);
        try { container.normalize(); } catch (e) { /* detached container */ }
      } catch (e) { /* best-effort */ }
    }

    // Find the mark for an anchor: by its stored id first, then by text.
    function findMark(anchor) {
      if (!container || !anchor) return null;
      if (anchor.id) {
        var byId = container.querySelector(
          'mark.' + MARK_CLASS + '[' + HL_ID_ATTR + '="' + cssEscape(anchor.id) + '"]'
        );
        if (byId) return byId;
      }
      var text = anchor.text || '';
      if (!text) return null;
      var marks = container.querySelectorAll('mark.' + MARK_CLASS);
      for (var i = 0; i < marks.length; i++) {
        if ((marks[i].textContent || '') === text) return marks[i];
      }
      return null;
    }

    // Escape an attribute value for use inside a double-quoted CSS selector.
    function cssEscape(s) {
      return String(s).replace(/["\\]/g, '\\$&');
    }

    // Unwrap the matching mark, restoring the original text node.
    function removeHighlight(anchor) {
      if (!container || !anchor) return;
      var mark = findMark(anchor);
      if (!mark) return;
      var parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      try { container.normalize(); } catch (e) { /* detached container */ }
    }

    // Scroll the matching mark into view. Resolves even when there is no mark
    // (app.js chains .then() onto this).
    function jumpToHighlight(anchor) {
      return Promise.resolve().then(function () {
        var mark = findMark(anchor);
        if (mark && typeof mark.scrollIntoView === 'function') {
          mark.scrollIntoView({ block: 'center' });
        }
      });
    }

    return {
      getSelectionAnchor: getSelectionAnchor,
      applyHighlights: applyHighlights,
      addHighlight: addHighlight,
      removeHighlight: removeHighlight,
      jumpToHighlight: jumpToHighlight
    };
  }

  window.LLLBook = window.LLLBook || {};
  window.LLLBook.HighlightsDom = { create: create };
})();
