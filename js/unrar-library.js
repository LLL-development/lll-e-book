/* Lazy node-unrar-js initialization: one verified distribution for the module
   and the wasm bytes. CBR (RAR) archives are read entirely in memory, so the
   wasm bytes travel with the loader instead of being fetched: the Emscripten
   output refuses to fetch() a file: URI, and passing the bytes to
   createExtractorFromData({ data, wasmBinary }) needs no request at all. */
(function () {
  'use strict';
  const base = new URL('../vendor/unrar/', document.currentScript.src);
  let pending;
  function loadClassic() {
    return new Promise(function (resolve, reject) {
      const script = document.createElement('script');
      script.src = new URL('unrar.file.js', base).href;
      script.onload = function () {
        if (!window.LLLUnrar || typeof window.LLLUnrar.createExtractorFromData !== 'function') {
          reject(new Error('unrar-library-missing'));
          return;
        }
        resolve(window.LLLUnrar);
      };
      script.onerror = function () { reject(new Error('unrar-library-missing')); };
      document.head.appendChild(script);
    });
  }
  window.loadUnrar = function () {
    // File URLs cannot import modules, so they take the generated IIFE bridge,
    // which bundles the same verified ESM release plus the inlined wasm bytes.
    if (location.protocol === 'file:') return loadClassic();
    if (!pending) {
      pending = import(new URL('unrar.mjs', base).href).then(function (lib) {
        if (!lib || typeof lib.createExtractorFromData !== 'function') {
          throw new Error('unrar-library-missing');
        }
        window.LLLUnrar = lib;
        return lib;
      });
    }
    return pending;
  };
})();
