/* ==========================================================================
   LLL-E-Book — file-loader.js
   Detects a file's format by extension (with MIME fallback) and dispatches it
   to the matching renderer. Every renderer lives in LLLBook.renderers.X and
   exposes render(file, container, options) -> Promise<session>.
   ========================================================================== */
(function () {
  'use strict';

  /* extension -> { key, renderer } */
  const FORMATS = {
    txt: { key: 'txt', renderer: 'text' },
    html: { key: 'html', renderer: 'text' },
    htm: { key: 'html', renderer: 'text' },
    rtf: { key: 'rtf', renderer: 'text' },
    pdf: { key: 'pdf', renderer: 'pdf' },
    epub: { key: 'epub', renderer: 'epub' },
    fb2: { key: 'fb2', renderer: 'fb2' },
    cbz: { key: 'cbz', renderer: 'comic' },
  };

  function getExtension(name) {
    const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  /**
   * detectFormat(file) -> { key, renderer } | null
   */
  function detectFormat(file) {
    if (!file) return null;
    const ext = getExtension(file.name);
    if (FORMATS[ext]) return FORMATS[ext];

    // MIME fallback for files with no/odd extension
    const mime = (file.type || '').toLowerCase();
    if (mime === 'application/pdf') return FORMATS.pdf;
    if (mime === 'application/epub+zip') return FORMATS.epub;
    if (mime === 'text/plain') return FORMATS.txt;
    if (mime === 'text/html') return FORMATS.html;
    return null;
  }

  /**
   * dispatch(file, container, options) -> Promise<session>
   * Resolves with the renderer's session object (has next/prev/goTo/
   * getLocation/destroy). Rejects with Error('unsupported') for unknown types.
   */
  function dispatch(file, container, options) {
    const fmt = detectFormat(file);
    if (!fmt) return Promise.reject(new Error('unsupported'));

    const renderer = window.LLLBook.renderers[fmt.renderer];
    if (!renderer || typeof renderer.render !== 'function') {
      return Promise.reject(new Error('no-renderer'));
    }

    return renderer.render(file, container, options || {}).then(function (session) {
      if (!session.title) session.title = file.name;
      if (!session.format) session.format = fmt.key;
      return session;
    });
  }

  window.LLLBook = window.LLLBook || {};
  window.LLLBook.FileLoader = { FORMATS, detectFormat, dispatch };
})();