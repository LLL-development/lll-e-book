/* ==========================================================================
   LLL-E-Book — renderers/text.js
   Renders TXT, HTML, and RTF files. HTML is sanitized to strip any
   script-capable content before insertion.
   ========================================================================== */
(function () {
  'use strict';

  /**
   * Strip anything that could execute code from a raw HTML string.
   */
  function sanitize(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, iframe, object, embed, link, style, meta, base').forEach(function (el) {
      el.remove();
    });
    doc.querySelectorAll('*').forEach(function (el) {
      Array.from(el.attributes).forEach(function (attr) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) el.removeAttribute(attr.name);
        if (name === 'href' && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
        if (name === 'src' && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
      });
    });
    return doc.body ? doc.body.innerHTML : '';
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Very basic RTF -> plain text: strip control words, escapes, and groups.
   * Good enough to read a document's body text.
   */
  function rtfToText(rtf) {
    return String(rtf)
      .replace(/\\par\b/gi, '\n\n')
      .replace(/\\line\b/gi, '\n')
      .replace(/\\tab\b/gi, '\t')
      .replace(/\\([A-Za-z]+)(-?\d+)? ?/g, '')
      .replace(/\\'[0-9a-fA-F]{2}/g, '')
      .replace(/[{}]/g, '');
  }

  function renderTxt(text) {
    return '<div class="txt-content"><pre>' + escapeHtml(text) + '</pre></div>';
  }

  function renderHtml(raw) {
    return sanitize(raw);
  }

  function renderRtf(text) {
    return '<div class="txt-content"><pre>' + escapeHtml(rtfToText(text)) + '</pre></div>';
  }

  function selectorFor(fileName) {
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    if (ext === 'html' || ext === 'htm') return renderHtml;
    if (ext === 'rtf') return renderRtf;
    return renderTxt;
  }

  /**
   * render(file, container) -> Promise<session>
   * Scroll-based session: location is a 0..1 ratio of the container's scroll.
   */
  function render(file, container) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        const html = selectorFor(file.name)(reader.result);
        container.innerHTML = html;

        function scrollable() {
          return container;
        }
        function ratio() {
          const max = scrollable().scrollHeight - scrollable().clientHeight;
          return max > 0 ? scrollable().scrollTop / max : 0;
        }
        function setRatio(r) {
          const max = scrollable().scrollHeight - scrollable().clientHeight;
          scrollable().scrollTop = Math.max(0, Math.min(1, r)) * max;
        }

        // For HTML books, build a table of contents from the headings.
        let toc = [];
        if (/\.(html|htm)$/i.test(file.name)) {
          container.querySelectorAll('h1,h2,h3,h4').forEach(function (h, i) {
            if (!h.id) h.id = 'hd' + i;
            const level = parseInt(h.tagName.charAt(1), 10) || 1;
            toc.push({
              label: (h.textContent || '').trim(),
              target: { anchor: h.id },
              depth: Math.max(0, level - 1),
            });
          });
        }

        const session = {
          title: file.name,
          format: 'text',
          next: function () {
            scrollable().scrollBy({ top: scrollable().clientHeight * 0.9, behavior: 'smooth' });
            return Promise.resolve();
          },
          prev: function () {
            scrollable().scrollBy({ top: -scrollable().clientHeight * 0.9, behavior: 'smooth' });
            return Promise.resolve();
          },
          goTo: function (loc) {
            if (!loc) return Promise.resolve();
            if (loc.anchor) {
              const el = document.getElementById(loc.anchor);
              if (el) el.scrollIntoView({ block: 'start' });
              return Promise.resolve();
            }
            if (typeof loc.ratio === 'number') setRatio(loc.ratio);
            return Promise.resolve();
          },
          getLocation: function () {
            return { type: 'scroll', ratio: ratio() };
          },
          getToc: function () {
            return toc;
          },
          destroy: function () {
            container.innerHTML = '';
          },
        };
        resolve(session);
      };
      reader.onerror = function () {
        reject(new Error('read-error'));
      };
      reader.readAsText(file);
    });
  }

  window.LLLBook = window.LLLBook || {};
  window.LLLBook.renderers = window.LLLBook.renderers || {};
  window.LLLBook.renderers.text = { render };
})();