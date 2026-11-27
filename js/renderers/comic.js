/* ==========================================================================
   LLL-E-Book — renderers/comic.js
   Renders CBZ/CBR comic archives as full pages of images.
   CBZ files are ZIP archives unpacked in-memory with JSZip (works on file://).
   CBR files are RAR archives unpacked in-memory with the vendored
   node-unrar-js wasm build (js/unrar-library.js, also works on file://).
   ========================================================================== */
(function () {
  'use strict';

  const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

  // Library thumbnail bounds (both axes capped) and the budget for cover
  // generation. The cover is enrichment only: if the Image decode or the blob
  // read never settles, the session must still open without a cover.
  const COVER_MAX_WIDTH = 360;
  const COVER_MAX_HEIGHT = 480;
  const COVER_TIMEOUT_MS = 2500;

  function blobToCoverDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = function () {
        try {
          const naturalW = image.naturalWidth || image.width;
          const naturalH = image.naturalHeight || image.height;
          if (!naturalW || !naturalH) {
            reject(new Error('cover-no-size'));
            return;
          }
          const scale = Math.min(1, COVER_MAX_WIDTH / naturalW, COVER_MAX_HEIGHT / naturalH);
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(naturalW * scale));
          canvas.height = Math.max(1, Math.round(naturalH * scale));
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
          const out = canvas.toDataURL('image/jpeg', 0.7);
          // A canvas over the browser's dataURL size limit yields "data:," —
          // treat anything that is not an image dataURL as no cover.
          if (typeof out === 'string' && out.indexOf('data:image/') === 0) {
            resolve(out);
          } else {
            reject(new Error('cover-dataurl-invalid'));
          }
        } catch (e) {
          reject(e);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      image.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('cover-image-error'));
      };
      image.src = url;
    });
  }

  // Cover generation gets a hard budget: whatever happens (pending blob read,
  // Image onload/onerror never firing, synchronous throw), it settles within
  // COVER_TIMEOUT_MS so the session resolves even without a cover. The reader
  // hands over the first page already as a Blob, so no archive access is
  // needed here and the same helper serves both CBZ and CBR.
  function buildCover(blob) {
    return new Promise(function (resolve) {
      let done = false;
      const timer = setTimeout(function () {
        if (done) return;
        done = true;
        console.warn('[COMIC] cover generation timed out');
        resolve(null);
      }, COVER_TIMEOUT_MS);
      function finish(value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value || null);
      }
      try {
        if (!blob) { finish(null); return; }
        Promise.resolve(blob)
          .then(blobToCoverDataUrl)
          .then(finish, function () { finish(null); });
      } catch (e) {
        finish(null);
      }
    });
  }

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
          return zip.file(entries[0]).async('blob').catch(function () {
            return null;
          });
        }).then(function (firstPageBlob) {
          return buildCover(firstPageBlob).then(function (dataUrl) {
            if (dataUrl) built.session.cover = dataUrl;
          });
        }).then(function () {
          return built.session;
        });
      });
  }

  // RAR signature "Rar!\x1a\x07" — the two trailing bytes differ between RAR4
  // (0x00) and RAR5 (0x01), so only these six bytes are compared.
  const RAR_MAGIC = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07];

  function isRar(buf) {
    if (buf.byteLength < RAR_MAGIC.length) return false;
    const head = new Uint8Array(buf, 0, RAR_MAGIC.length);
    for (let i = 0; i < RAR_MAGIC.length; i++) {
      if (head[i] !== RAR_MAGIC[i]) return false;
    }
    return true;
  }

  // node-unrar-js hands back the archive's own error reason. Only the reasons we
  // can explain get their own message; everything else stays 'rar-invalid'.
  const RAR_ERROR_REASONS = {
    ERAR_MISSING_PASSWORD: 'rar-password',
    ERAR_BAD_PASSWORD: 'rar-password',
    ERAR_EREAD: 'rar-volume-unsupported',
    ERAR_EREFERENCE: 'rar-volume-unsupported',
  };

  function rarError(err) {
    if (err && err.message === 'rar-too-large') return err;
    return new Error(RAR_ERROR_REASONS[err && err.reason] || 'rar-invalid');
  }

  // Decompression-bomb guard. A few-KB .cbr can declare gigabytes of unpacked
  // output, so the declared sizes are capped BEFORE extract() materialises
  // anything. The limits are generous for real comics and far below what would
  // crash the tab.
  const MAX_TOTAL_UNPACKED = 512 * 1024 * 1024;
  const MAX_ENTRIES = 5000;

  function naturalSort(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }

  // node-unrar-js never asks for a password: an encrypted entry without one
  // fails with ERAR_MISSING_PASSWORD. The archive is kept in memory only, so a
  // password is asked for once per file name and dropped with the session.
  // Only a password that actually opened the archive is cached — a typo must
  // trigger a fresh prompt, never a cached rejection.
  const passwordByArchive = new Map();
  const PASSWORD_LIMIT = 8;

  // window.prompt blocks synchronously, so there is no async queue to protect.
  // A single shared latch used to hand one archive's prompt result to another
  // archive when two encrypted CBRs opened together, so each call prompts for
  // its own name directly.
  function askPassword(name) {
    return Promise.resolve().then(function () {
      const label = name || '';
      const question = window.LLLBook.I18n
        ? window.LLLBook.I18n.t('reader.cbr_password_prompt', { name: label })
        : 'This CBR archive is password protected. Enter the password:';
      const entered = window.prompt(question, '');
      // The prompt invites an empty input as a cancel, so an empty string is
      // mapped to the same null as an explicit cancel.
      if (entered === null || entered === '') return null;
      return entered;
    });
  }

  // Returns the password to try. A cancel — the Cancel button or an empty
  // input, which the prompt text offers as the cancel gesture — rejects with
  // 'rar-cancelled' but is NOT cached: a re-open must prompt again (the cancel
  // message already says to re-open). A typed password is NOT cached here
  // either — openAndRead caches it only after the archive actually opens with
  // it.
  function providePassword(name) {
    return askPassword(name).then(function (entered) {
      if (entered === null) {
        return Promise.reject(new Error('rar-cancelled'));
      }
      return entered;
    });
  }

  function renderCbr(buf, container, name) {
    if (!window.loadUnrar) return Promise.reject(new Error('unrar-missing'));
    let lib;
    let pages;

    function open(password) {
      // The wasm wants a standalone ArrayBuffer holding exactly the archive:
      // ExtractorData keeps a Uint8Array view over the buffer it is given, so a
      // detached or offset buffer would corrupt reads. slice(0) copies — the
      // price of isolation for a file we already hold fully in memory.
      // A synchronous throw (e.g. a bad buffer) is normalised into a rejected
      // promise so it rides the .catch chain and becomes a rarError instead of
      // escaping to the app as an unknown message.
      try {
        return Promise.resolve(lib.createExtractorFromData({ data: buf.slice(0), password: password || '' }));
      } catch (e) {
        return Promise.reject(e);
      }
    }

    // The wasm archive handle must be released on every path, including the
    // error paths. The library's lazy iterators already close the handle once
    // each walk finishes, and its delete() throws on an already-deleted handle,
    // so cleanup goes through isDeleted() and never double-deletes.
    function safeDelete(handle) {
      if (!handle || !handle.delete) return;
      if (handle.isDeleted && handle.isDeleted()) return;
      try {
        handle.delete();
      } catch (e) {
        // Already released by the library walk or a previous cleanup.
      }
    }

    function readPages(extractor) {
      try {
        const list = extractor.getFileList();
        // The header iterator is lazy: the C++ archive object is released when
        // the walk reaches the end (closeArc) or when a walk error throws
        // (getFailException → closeArc), and safeDelete below covers the rest.
        // An early break would suspend the generator without running either,
        // so the over-limit detection drains the rest of the walk (headers are
        // dropped, never kept) and throws only after it finishes.
        const headers = [];
        let overLimit = false;
        let totalUnpacked = 0;
        for (const h of list.fileHeaders) {
          if (overLimit) continue;
          headers.push(h);
          // Decompression-bomb guard: check the *declared* sizes of every
          // entry (not just the images we keep) before extract() materialises
          // anything.
          if (headers.length > MAX_ENTRIES) {
            overLimit = true;
            continue;
          }
          totalUnpacked += h.unpSize || 0;
          if (totalUnpacked > MAX_TOTAL_UNPACKED) {
            overLimit = true;
          }
        }
        if (overLimit) throw new Error('rar-too-large');
        const wanted = headers.filter(function (h) {
          return !h.flags.directory && IMAGE_RE.test(h.name);
        });
        if (!wanted.length) throw new Error('no-images');
        const extracted = extractor.extract();
        const images = {};
        for (const entry of extracted.files) {
          const header = entry.fileHeader;
          if (header.flags.directory || !entry.extraction) continue;
          if (!IMAGE_RE.test(header.name)) continue;
          images[header.name] = entry.extraction;
        }
        const result = wanted.map(function (h) {
          return { name: h.name, bytes: images[h.name] };
        }).filter(function (page) {
          return !!page.bytes;
        }).sort(function (a, b) {
          return naturalSort(a.name, b.name);
        });
        // Every image entry failed to extract (corrupt or zero-byte data): an
        // empty page list would crash the session on its first loader, so it
        // reports as no-images instead.
        if (!result.length) throw new Error('no-images');
        return result;
      } finally {
        safeDelete(extractor);
      }
    }

    function openAndRead(password) {
      let extractor;
      return open(password).then(function (opened) {
        extractor = opened;
        return readPages(extractor);
      }).catch(function (err) {
        // readPages always cleans up in its finally; this covers a rejection
        // from open() itself leaving a half-built handle behind.
        safeDelete(extractor);
        if (err && err.message === 'no-images') throw err;
        if (err && err.message === 'rar-too-large') throw err;
        // Defensive passthrough: rar-cancelled normally propagates around this
        // catch (it rejects from providePassword inside it), never through it.
        if (err && err.message === 'rar-cancelled') throw err;
        // A header-encrypted archive only fails once the headers are walked, so
        // both call sites funnel through here.
        if (err && err.reason === 'ERAR_MISSING_PASSWORD') {
          // A cached (correct) password still failed — do not loop the prompt.
          if (!passwordByArchive.has(name)) {
          return providePassword(name).then(function (entered) {
            let fresh;
            return open(entered).then(function (opened) {
                fresh = opened;
                return readPages(fresh);
              }).then(function (pages) {
                // Cache only a password that actually opened the archive, so a
                // typo falls through to a fresh prompt instead of a cached lie.
                if (passwordByArchive.size >= PASSWORD_LIMIT) passwordByArchive.clear();
                passwordByArchive.set(name, entered);
                return pages;
              }).catch(function (err2) {
                // readPages cleans up `fresh` in its finally; this covers an
                // open() rejection after the prompt.
                safeDelete(fresh);
                if (err2 && err2.message === 'no-images') throw err2;
                if (err2 && err2.message === 'rar-too-large') throw err2;
                if (err2 && (err2.reason === 'ERAR_BAD_PASSWORD' || err2.reason === 'ERAR_MISSING_PASSWORD')) {
                  throw new Error('rar-password');
                }
                throw rarError(err2);
              });
            });
          }
        }
        throw rarError(err);
      });
    }

    return window.loadUnrar()
      .then(function (loaded) {
        lib = loaded;
        // Reuse a cached password (only ever a real one — cancels and typos
        // are never cached).
        return openAndRead(passwordByArchive.get(name) || '');
      })
      .then(function (read) {
        pages = read;
        const entries = pages.map(function (page) {
          return page.name;
        });
        const loaders = pages.map(function (page) {
          return function () {
            const ext = (page.name.match(/\.[A-Za-z0-9]+$/) || [''])[0].toLowerCase();
            const type = MIME_BY_EXT[ext] || 'application/octet-stream';
            return Promise.resolve(URL.createObjectURL(new Blob([page.bytes], { type: type })));
          };
        });
        const built = imageSession(loaders, name, entries);
        built.session.format = 'cbr';
        const destroy = built.session.destroy;
        built.session.destroy = function () {
          passwordByArchive.delete(name);
          pages = null;
          return destroy.call(built.session);
        };
        container.innerHTML = '';
        container.appendChild(built.root);
        return built.session.load(0).then(function () {
          const first = pages[0];
          return buildCover(new Blob([first.bytes])).then(function (dataUrl) {
            if (dataUrl) built.session.cover = dataUrl;
          });
        }).then(function () {
          return built.session;
        });
      });
  }

  const MIME_BY_EXT = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
  };

  function render(file, container) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        const buf = reader.result;
        // Route by extension first: a .cbr whose RAR magic is missing must not
        // fall onto the CBZ path and report "not a ZIP" — renderCbr turns the
        // bad archive into rar-invalid ("not a RAR/CBR"). RAR magic still
        // catches a mislabelled .cbz that is really a RAR.
        const isCbr = /\.cbr$/i.test(file.name || '');
        if (isCbr || isRar(buf)) {
          renderCbr(buf, container, file.name).then(resolve, reject);
        } else {
          renderCbz(buf, container, file.name).then(resolve, reject);
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