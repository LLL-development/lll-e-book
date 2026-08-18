# LLL-E-Book

A browser-based e-book reader that lets you open and read books directly in your web browser — no separate apps needed for different file types. LLL-E-Book detects the uploaded file's format and renders it through a consistent, distraction-free reading interface.

Built with **pure HTML, CSS, and JavaScript** — no build tools, no package manager. Just serve the folder over a simple local HTTP server (`python -m http.server 8000`) and open it in your browser.

## Features

- Open books by simply clicking **Upload** (or add several files at once)
- Automatic format detection and routing to the right renderer
- Distraction-free reading view with a comfortable typographic column
- Adjustable font size (A− / A+)
- Light / dark theme toggle (preference is remembered)
- Bookmark any location and return to it later
- Reading progress saved automatically and persists across sessions (via `localStorage`)
- Personal library view showing each book's saved reading progress
- Table of contents panel (for formats that expose one)
- Reopen previously opened books from your Library without re-uploading (kept locally via IndexedDB)
- Interface language selector: English, Bahasa Melayu, 日本語, 한국어, 简体中文, 繁體中文

## Supported formats

|   Format   |   Extension(s)  | Renderer 
|------------|-----------------|----------
| Plain text | `.txt`          | Built-in                               
| HTML       | `.html`, `.htm` | Built-in (sanitized) 
| Rich Text  | `.rtf`          | Built-in (basic) 
| PDF        | `.pdf`          | [pdf.js](https://mozilla.github.io/pdf.js/) 
| EPUB       | `.epub`         | [epub.js](https://github.com/futurepress/epub.js)
| FB2        | `.fb2`          | [epub.js](https://github.com/futurepress/epub.js)
| CBZ comic  | `.cbz`          | [JSZip](https://stuk.github.io/jszip/)

### Out of scope: MOBI / AZW / AZW3

MOBI and AZW (including AZW3/KF8) are **not supported**. These are Amazon-proprietary formats and are almost always DRM-encrypted, which cannot be decrypted in a web browser. There is also no mature JavaScript parser for them. If you have such a file, convert it to **EPUB** (e.g. with [Calibre](https://calibre-ebook.com/)) and it will open here.

## How to run

Use a **local static server** so every format works reliably. Browsers block certain features when a page is opened directly from disk, so serving over HTTP is the recommended way to run the app.

```bash
# Make sure you run this from inside the project folder:
cd c:\Users\user\lll-e-book

# Python 3 (built into most systems)
python -m http.server 8000

# then open this URL in your browser:
http://localhost:8000
```

Press **Ctrl+C** in the terminal to stop the server.

> **Tip:** If port `8000` is already in use, pick another one: `python -m http.server 8080`.

Alternatively, use the VS Code **Live Server** extension and click **Go Live** — it does the same thing without typing any commands.

> **Note:** The app is written in plain HTML/CSS/JS and *will* also open if you simply double-click `index.html`. However, this bypasses the local server, so **CBR (RAR) files won't load** and other `file://` restrictions may apply. For the full experience, use the server.


## Project structure

```
lll-e-book/
├── index.html              App shell — upload, library, reader, CDN libs
├── README.md
├── .gitignore
├── css/
│   └── style.css           Themes, layout, reader typography
└── js/
    ├── app.js              Controller — views, upload, wiring, persistence
    ├── storage.js          localStorage: book registry, progress, bookmarks
    ├── i18n.js             UI translation engine + language dictionaries
    ├── stored-books.js     IndexedDB storage so books reopen without re-upload
    ├── file-loader.js      Format detection + dispatch
    └── renderers/
        ├── text.js         TXT / HTML / RTF
        ├── pdf.js          PDF via pdf.js
        ├── epub.js         EPUB + FB2 via epub.js
        └── comic.js        CBZ via JSZip
```

## Libraries (loaded via CDN)

- [pdf.js](https://mozilla.github.io/pdf.js/) — PDF rendering
- [epub.js](https://github.com/futurepress/epub.js) — EPUB / FB2
- [JSZip](https://stuk.github.io/jszip/) — CBZ comic archives
- [unrar-wasm](https://www.npmjs.com/package/unrar-wasm) — CBR (needs a local server)
