/* Lazy PDF.js ESM initialization: one verified distribution for module, worker and data. */
(function () {
  'use strict';
  const base = new URL('../vendor/pdfjs/', document.currentScript.src);
  let pending;
  window.pdfjsDocumentOptions = {
    isEvalSupported: false,
    cMapUrl: new URL('cmaps/', base).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', base).href,
    wasmUrl: new URL('wasm/', base).href,
    iccUrl: new URL('iccs/', base).href,
  };
  function loadClassic(filename) {
    return new Promise(function (resolve, reject) {
      const script = document.createElement('script');
      script.src = new URL(filename, base).href;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('pdf-library-missing')); };
      document.head.appendChild(script);
    });
  }
  window.loadPdfJs = function () {
    // File URLs cannot import modules or create module workers. The bridge is
    // generated from the same safe ESM release and exposes its main-thread worker.
    if (location.protocol === 'file:') {
      if (!pending) pending = loadClassic('pdf.file.js')
        .then(function () { return loadClassic('pdf.worker.file.js'); })
        .then(function () {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.file.js', base).href;
          return window.pdfjsLib;
        });
      return pending;
    }
    if (!pending) pending = import(new URL('pdf.min.mjs', base).href).then(function (lib) {
      lib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', base).href;
      window.pdfjsLib = lib;
      return lib;
    });
    return pending;
  };
})();
