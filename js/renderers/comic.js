/* ==========================================================================
   LLL-E-Book — renderers/comic.js
   Renders comic archives as full pages of images.
     - CBZ: ZIP archive unpacked in-memory with JSZip (works on file://).
     - CBR: RAR archive via unrar-wasm IF it is available. Browsers block the
       WASM fetch on file://, so on failure we show a helpful notice.
   ========================================================================== */
(function () {
  'use strict';

  const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

  /**
   * Build a page-based session over a list of page loader functions.
   */
  function imageSession(loaders, name) {
    let idx = 0;
    const img = document.createElement('img');
    const root = document.createElement('div');
    root.appendChild(img);

    function load(i) {
      return loaders[i]().then(function (url) {
        img.src = url;
      });
    }

    const session = {
      title: name,
      format: 'comic',
      numPages: loaders.length,
      next: function () {
        if (idx < loaders.length - 1) {
          idx += 1;
          return load(idx);
        }
        return Promise.resolve();
      },
      prev: function () {
        if (idx > 0) {
          idx -= 1;
          return load(idx);
        }
        return Promise.resolve();
      },
      goTo: function (loc) {
        if (loc && typeof loc.page === 'number') {
          idx = Math.max(0, Math.min(loaders.length - 1, loc.page));
          return load(idx);
        }
        return Promise.resolve();
      },
      getLocation: function () {
        return { type: 'page', page: idx, numPages: loaders.length };
      },
      destroy: function () {
        root.remove();
      },
    };
    return { session: session, root: root };
  }

  function renderCbz(buf, container, name) {
    if (typeof window.JSZip === 'undefined') {
      return Promise.reject(new Error('jszip-missing'));
    }
    // Quick sanity check for the ZIP magic bytes ("PK") — catches files that
    // are mislabelled CBZ but are actually RAR/7-Zip or plain data.
    const head = new Uint8Array(buf, 0, 4);
    if (head.length < 4 || head[0] !== 0x50 || head[1] !== 0x4b) {
      return Promise.reject(new Error('zip-invalid'));
    }
    return window.JSZip.loadAsync(buf)
      .catch(function () {
        throw new Error('zip-invalid');
      })
      .then(function (zip) {
        const entries = Object.keys(zip.files)
          .filter(function (n) {
            return !zip.files[n].dir && IMAGE_RE.test(n);
          })
          .sort();
        if (!entries.length) throw new Error('no-images');

        const loaders = entries.map(function (entryName) {
          return function () {
            return zip.file(entryName).async('blob').then(URL.createObjectURL);
          };
        });
        const built = imageSession(loaders, name);
        built.session.format = 'cbz';
        container.innerHTML = '';
        container.appendChild(built.root);
        return built.session.load(0).then(function () {
          return built.session;
        });
      });
  }

  function renderCbr(buf, container, name) {
    if (typeof window.createUnrar !== 'function') {
      return Promise.resolve(showCbrNotice(container));
    }
    return window
      .createUnrar()
      .then(function (unrar) {
        return unrar.extract({ data: buf, files: [] });
      })
      .then(function (result) {
        const images = result.files.filter(function (f) {
          return IMAGE_RE.test(f.name);
        });
        if (!images.length) throw new Error('no-images');

        const loaders = images.map(function (file) {
          return function () {
            return Promise.resolve(
              URL.createObjectURL(new Blob([file.extraction]))
            );
          };
        });
        const built = imageSession(loaders, name);
        built.session.format = 'cbr';
        container.innerHTML = '';
        container.appendChild(built.root);
        return built.session.load(0).then(function () {
          return built.session;
        });
      })
      .catch(function () {
        return showCbrNotice(container);
      });
  }

  function showCbrNotice(container) {
    container.innerHTML =
      '<div class="notice"><p><strong>CBR note:</strong> RAR files need the browser to ' +
      'load a decoding module, which is blocked when the page is opened directly from disk ' +
      '(<code>file://</code>).</p><p>Options:</p><ul>' +
      '<li>Serve this folder with a local server: <code>python -m http.server 8000</code>, then open <code>http://localhost:8000</code>.</li>' +
      '<li>Convert the file to <strong>CBZ</strong> (ZIP) and upload that instead.</li>' +
      '</ul></div>';
    const session = {
      title: '',
      format: 'cbr',
      next: function () { return Promise.resolve(); },
      prev: function () { return Promise.resolve(); },
      goTo: function () { return Promise.resolve(); },
      getLocation: function () { return { type: 'none' }; },
      destroy: function () { container.innerHTML = ''; },
    };
    return session;
  }

  /**
   * render(file, container) -> Promise<session>
   */
  function render(file, container) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        const buf = reader.result;
        if (/\.cbz$/i.test(file.name)) {
          renderCbz(buf, container, file.name).then(resolve, reject);
        } else {
          renderCbr(buf, container, file.name).then(resolve, reject);
        }
      };
      reader.onerror = function () {
        reject(new Error('read-error'));
      };
      reader.readAsArrayBuffer(file);
    });
  }

  window.LLLBook = window.LLLBook || {};
  window.LLLBook.renderers = window.LLLBook.renderers || {};
  window.LLLBook.renderers.comic = { render };
})();