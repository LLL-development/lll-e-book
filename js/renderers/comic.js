/* ==========================================================================
   LLL-E-Book — renderers/comic.js
   Renders CBZ comic archives as full pages of images.
   CBZ files are ZIP archives unpacked in-memory with JSZip (works on file://).
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
    root.className = 'comic-page';
    root.appendChild(img);

    function load(i) {
      idx = i;
      const token = ++currentLoad;
      return loaders[i]().then(function (url) {
        if (token === currentLoad) {
          if (currentUrl) URL.revokeObjectURL(currentUrl);
          currentUrl = url;
          img.src = url;
          session._applyZoom();
        } else {
          URL.revokeObjectURL(url);
        }
      }).then(function () {
        if (token === currentLoad) {
          session._applyZoom();
        }
      });
    }

    const session = {
      title: name,
      format: 'comic',
      numPages: loaders.length,
      load: load,
      zoomLevel: 1.0,
      zoomIn: function () {
        this.zoomLevel = Math.min(this.zoomLevel + 0.1, 4.0);
        this._applyZoom();
        return Promise.resolve();
      },
      zoomOut: function () {
        this.zoomLevel = Math.max(this.zoomLevel - 0.1, 0.5);
        this._applyZoom();
        return Promise.resolve();
      },
      setZoomLevel: function (level) {
        this.zoomLevel = Math.max(0.5, Math.min(4.0, level));
        this._applyZoom();
        return Promise.resolve();
      },
      _applyZoom: function () {
        var naturalWidth = img.naturalWidth || img.width;
        var naturalHeight = img.naturalHeight || img.height;
        if (naturalWidth === 0 || naturalHeight === 0) return;

        // Calculate the "fit" scale — same as object-fit:contain
        var containerWidth = root.clientWidth || (root.parentElement ? root.parentElement.clientWidth : naturalWidth);
        var containerHeight = root.clientHeight || (root.parentElement ? root.parentElement.clientHeight : naturalHeight);
        var fitScale = Math.min(containerWidth / naturalWidth, containerHeight / naturalHeight);

        // Displayed size = natural * fitScale * zoomLevel
        // At zoom 1.0 this equals the fit size (same as maxWidth:100%, maxHeight:100%)
        // At zoom 0.9 it is 90% of the fit size (smaller)
        // At zoom 1.5 it is 150% of the fit size (larger)
        var displayedWidth = naturalWidth * fitScale * this.zoomLevel;
        var displayedHeight = naturalHeight * fitScale * this.zoomLevel;

        img.style.maxWidth = 'none';
        img.style.maxHeight = 'none';
        img.style.width = Math.round(displayedWidth) + 'px';
        img.style.height = Math.round(displayedHeight) + 'px';
      },
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

  function render(file, container) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        const buf = reader.result;
        renderCbz(buf, container, file.name).then(resolve, reject);
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