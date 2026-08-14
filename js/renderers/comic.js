/* ==========================================================================
   LLL-E-Book — renderers/comic.js
   Renders comic archives as full pages of images.
     - CBZ: ZIP archive unpacked in-memory with JSZip (works on file://).
     - CBR: RAR archive via node-unrar-js (ESM + WASM). Requires HTTP(S)
       protocol to fetch the WASM binary; on file:// or fetch failure we
       show a helpful notice.
   ========================================================================== */
(function () {
  'use strict';

  const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

  /**
   * Build a page-based session over a list of page loader functions.
   */
  function imageSession(loaders, name, entries) {
    let idx = 0;
    let currentUrl = null;
    let currentLoad = 0;
    const img = document.createElement('img');
    const root = document.createElement('div');
    root.appendChild(img);

    function load(i) {
      idx = i;
      const token = ++currentLoad;
      return loaders[i]().then(function (url) {
        if (token === currentLoad) {
          if (currentUrl) URL.revokeObjectURL(currentUrl);
          currentUrl = url;
          img.src = url;
        } else {
          URL.revokeObjectURL(url);
        }
      });
    }

    const session = {
      title: name,
      format: 'comic',
      numPages: loaders.length,
      load: load,
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
          idx = Math.max(0, Math.min(loaders.length - 1, loc.page - 1));
          return load(idx);
        }
        return Promise.resolve();
      },
      getLocation: function () {
        return { type: 'page', page: idx + 1, numPages: loaders.length };
      },
      destroy: function () {
        if (currentUrl) URL.revokeObjectURL(currentUrl);
        currentUrl = null;
        root.remove();
      },
      getToc: function () {
        return entries.map(function (entryName, idx) {
          var label = entryName.replace(/\.[^/.]+$/, '');
          var pageMatch = label.match(/(\d+)/);
          if (pageMatch) {
            label = 'Page ' + parseInt(pageMatch[1], 10);
          }
          return {
            label: label,
            target: { page: idx + 1 },
            depth: 0
          };
        });
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
          .sort(function (a, b) {
            return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
          });
        if (!entries.length) throw new Error('no-images');

        const loaders = entries.map(function (entryName) {
          return function () {
            return zip.file(entryName).async('blob').then(URL.createObjectURL);
          };
        });
        const built = imageSession(loaders, name, entries);
        built.session.format = 'cbz';
        container.innerHTML = '';
        container.appendChild(built.root);
        return built.session.load(0).then(function () {
          return built.session;
        });
      });
  }

  function renderCbr(buf, container, name) {
    var isFileProtocol = window.location.protocol === 'file:';
    if (isFileProtocol) {
      return Promise.resolve(showCbrNotice(container));
    }
    return loadUnrar()
      .then(function (createExtractor) {
        return createExtractor(buf);
      })
      .then(function (extractor) {
        var imageNames = [];
        var list = extractor.getFileList();
        var headers = list.fileHeaders;
        for (var h = headers.next(); !h.done; h = headers.next()) {
          var fh = h.value;
          if (!fh.flags.directory && IMAGE_RE.test(fh.name)) {
            imageNames.push(fh.name);
          }
        }
        imageNames.sort(function (a, b) {
          return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
        });
        if (!imageNames.length) throw new Error('no-images');
        var extracted = extractor.extract({
          files: function (fh) {
            return imageNames.indexOf(fh.name) !== -1;
          }
        });
        var images = [];
        var filesIter = extracted.files;
        for (var f = filesIter.next(); !f.done; f = filesIter.next()) {
          images.push(f.value);
        }
        var loaders = images.map(function (file) {
          return function () {
            return Promise.resolve(
              URL.createObjectURL(new Blob([file.extraction]))
            );
          };
        });
        var built = imageSession(loaders, name, imageNames);
        built.session.format = 'cbr';
        container.innerHTML = '';
        container.appendChild(built.root);
        return built.session.load(0).then(function () {
          return built.session;
        });
      })
      .catch(function (err) {
        if (err && err.message === 'no-images') throw err;
        return showCbrNotice(container);
      });
  }

  var _unrarPromise = null;
  function loadUnrar() {
    if (_unrarPromise) return _unrarPromise;
    _unrarPromise = (function () {
      var wasmUrl = 'https://cdn.jsdelivr.net/npm/node-unrar-js@2.0.2/esm/js/unrar.wasm';
      return fetch(wasmUrl)
        .then(function (res) {
          if (!res.ok) throw new Error('wasm-fetch-failed');
          return res.arrayBuffer();
        })
        .then(function (wasmBinary) {
          return import('https://cdn.jsdelivr.net/npm/node-unrar-js@2.0.2/esm/index.esm.js')
            .then(function (mod) {
              var createExtractorFromData = mod.createExtractorFromData;
              if (!createExtractorFromData) {
                throw new Error('unrar-api-missing');
              }
              return function (data) {
                return createExtractorFromData({ wasmBinary: wasmBinary, data: data });
              };
            });
        })
        .catch(function () {
          _unrarPromise = null;
          throw new Error('unrar-init-failed');
        });
    })();
    return _unrarPromise;
  }

  function showCbrNotice(container) {
    var isFileProtocol = window.location.protocol === 'file:';
    var message = isFileProtocol
      ? window.LLLBook.I18n.t('cbr.file_protocol_error')
      : window.LLLBook.I18n.t('cbr.decode_error');

    container.innerHTML = '<div class="notice"><p>' + message + '</p></div>';

    const session = {
      title: '',
      format: 'cbr',
      load: function () { return Promise.resolve(); },
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