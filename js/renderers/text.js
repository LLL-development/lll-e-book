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
   * RTF -> plain text parser.
   * Handles control words/symbols, hex escapes, unicode, destination groups,
   * and nested braces. Strips all formatting, returning only readable text.
   */
  function rtfToText(rtf) {
    var input = String(rtf);
    var i = 0;
    var len = input.length;
    var out = [];

    // State stack for nested groups (fonttbl, colortbl, stylesheets, etc.)
    var stateStack = [];
    var skipGroup = false;

    // Control words that produce visible text
    var textMap = {
      emdash: '\u2014', endash: '\u2013', bullet: '\u2022',
      ldblquote: '\u201c', rdblquote: '\u201d',
      lquote: '\u2018', rquote: '\u2019',
      ldash: '\u2013', rdash: '\u2013',
      ellipsis: '\u2026',
      tab: '\t',
    };

    // Destination names whose entire group should be skipped
    var skipDests = {
      fonttbl: true, colortbl: true, stylesheet: true,
      info: true, data: true, pict: true,
      listtemplate: true, list: true, header: true, footer: true,
    };

    function readWord() {
      var word = '';
      while (i < len && /[A-Za-z]/.test(input[i])) {
        word += input[i];
        i++;
      }
      return word;
    }

    function readSignedDigit() {
      var negative = false;
      if (i < len && input[i] === '-') {
        negative = true;
        i++;
      }
      var num = '';
      while (i < len && /\d/.test(input[i])) {
        num += input[i];
        i++;
      }
      return negative ? -parseInt(num, 10) : (num ? parseInt(num, 10) : 0);
    }

    function readDigit() {
      var num = '';
      while (i < len && /\d/.test(input[i])) {
        num += input[i];
        i++;
      }
      return num ? parseInt(num, 10) : 0;
    }

    // Unicode accumulator: \uN? may be followed by ?ANSI
    var uniAccum = null; // { cp: number, ansi: number|null }

    function flushUni() {
      if (uniAccum !== null) {
        var cp = uniAccum.cp;
        if (cp < 0 || cp > 0x10FFFF) {
          out.push('\uFFFD'); // replacement char for invalid
        } else if (uniAccum.ansi !== null) {
          // ANSI fallback present: use it for out-of-BMP or negative
          if (cp > 0xFFFF || cp < 0) {
            out.push(String.fromCharCode(uniAccum.ansi));
          } else {
            out.push(String.fromCodePoint(cp));
          }
        } else {
          out.push(String.fromCodePoint(cp));
        }
        uniAccum = null;
      }
    }

    function parseControl() {
      // \\'XX hex escape (ANSI code page)
      if (i < len && input[i] === "'") {
        i++;
        var hex = input.substring(i, i + 2);
        i += 2;
        flushUni();
        out.push(String.fromCharCode(parseInt(hex, 16)));
        return;
      }

      // \uN? — Unicode with optional ANSI fallback
      if (i < len && input[i] === 'u') {
        i++;
        var cp = readSignedDigit();
        var ansi = null;
        if (i < len && input[i] === '?') {
          i++;
          ansi = readDigit();
        }
        uniAccum = { cp: cp, ansi: ansi };
        return;
      }

      // Read control word
      var word = readWord();
      if (!word) {
        // Not a control word — shouldn't happen, skip one char
        i++;
        return;
      }

      // Read optional numeric parameter
      var param = null;
      if (i < len && /\d/.test(input[i])) {
        param = readDigit();
      }

      var lower = word.toLowerCase();

      // Destination detection: \word{ pattern
      if (i < len && input[i] === '{') {
        if (skipDests[lower] || lower === '*') {
          stateStack.push({ skipGroup: true });
        }
        i++; // consume '{'
        return;
      }

      // Group open/close
      if (lower === '{') {
        stateStack.push({ skipGroup: skipGroup });
        return;
      }
      if (lower === '}') {
        if (stateStack.length > 0) {
          var prev = stateStack.pop();
          skipGroup = prev.skipGroup;
        }
        return;
      }

      // Inside a skip group — consume everything
      if (skipGroup) {
        // Consume trailing space after control word
        if (i < len && input[i] === ' ') { i++; }
        return;
      }

      flushUni();

      // Text-producing control words
      if (lower in textMap) {
        out.push(textMap[lower]);
        if (i < len && input[i] === ' ') { i++; }
        return;
      }

      // Paragraph / page breaks
      if (lower === 'par' || lower === 'pard' || lower === 'page') {
        out.push('\n\n');
        if (i < len && input[i] === ' ') { i++; }
        return;
      }
      if (lower === 'line') {
        out.push('\n');
        if (i < len && input[i] === ' ') { i++; }
        return;
      }

      // Formatting switches (b, i, ul, etc.) — skip silently
      // All other unknown control words — skip silently

      // Consume trailing space
      if (i < len && input[i] === ' ') { i++; }
    }

    while (i < len) {
      var ch = input[i];

      if (ch === '\\') {
        i++;
        parseControl();
      } else if (ch === '{') {
        // Bare '{' not preceded by \ — push group state
        stateStack.push({ skipGroup: skipGroup });
        i++;
      } else if (ch === '}') {
        if (stateStack.length > 0) {
          var prev = stateStack.pop();
          skipGroup = prev.skipGroup;
        }
        i++;
      } else if (ch === '\r') {
        if (i + 1 < len && input[i + 1] === '\n') {
          i += 2; // skip CRLF, treat as newline below
          out.push('\n');
        } else {
          i++; // bare CR — skip
        }
      } else if (ch === '\n') {
        out.push('\n');
        i++;
      } else {
        out.push(ch);
        i++;
      }
    }

    // Flush any remaining unicode buffer
    flushUni();

    // Post-process: collapse 3+ newlines to 2, strip trailing whitespace
    var result = out.join('').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();

    return result;
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