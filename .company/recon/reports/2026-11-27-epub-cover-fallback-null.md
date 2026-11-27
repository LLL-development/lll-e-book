# 調査報告: EPUB カバーフォールバックが実行時に null になる原因（epub.js 0.3.93）

日付: 2026-11-27
担当: recon（読み取り専用調査。コード変更なし）
対象: C:\Users\user\lll-e-book\js\renderers\epub.js（L121-191 resolveCover / pickFallbackImageHref）
検証対象ライブラリ: epubjs@0.3.93（npm tarball 実物。CDN dist と同一パッケージ）

## 結論（確定）

**フォールバックで `book.archive.createUrl(href, {base64:true})` に渡している `packaging.manifest[id].href` は OPF 相対の未解決パスであり、zip 実パス（先頭スラッシュ付き zip ルート相対）と一致しないため、`createUrl` が reject し、それがチェーンの `.catch(()=>null)` で握り潰されて null になる。**

epub.js が href を zip 実パスへ解決する唯一の経路は `book.resolve(href)`（`Book.prototype.resolve`）であり、宣言カバー（`book.loaded.cover`）は内部でこの `resolve` を通った後の値（例 `/OEBPS/images/cover.jpg`）を返している。フォールバックは `book.resolve(href)` を経由していないので落ちる。

## 根拠 1: epub.js 0.3.93 実ソース（npm tarball）

取得: `npm pack epubjs@0.3.93` → `C:\Users\user\AppData\Local\Temp\opencode\epubjs-src\package\`

### 1a. manifest[href] は OPF 相対のまま格納される（変換なし）
`package\src\packaging.js` L124-137:
```js
items.forEach(function(item){
    var id = item.getAttribute("id"),
            href = item.getAttribute("href") || "",
    ...
    manifest[id] = { "href" : href, "type" : type, ... };
```
→ `manifest[id].href` は OPF 記載値そのまま（OPF 相対）。`Packaging` には `directory` プロパティは**存在しない**（src 全体を grep したが Packaging の directory は無し。OPF ディレクトリは `Book.path.directory` に保持される）。

### 1b. Archive は「先頭スラッシュ付き zip ルート相対」しか引けない
`package\src\archive.js` L165-175（getBase64）:
```js
getBase64(url, mimeType){
    var decodededUrl = window.decodeURIComponent(url.substr(1)); // Remove first slash
    var entry = this.zip.file(decodededUrl);
    if(entry) { ... return "data:" + mimeType + ";base64," + data; }
}
```
`createUrl`（L183-233）は `useBase64` なら `getBase64(url)` を使い、`response` が `undefined`（エントリ無し）なら:
```js
if (!response) {
    deferred.reject({ message : "File not found in the epub: " + url, ... });
}
```
→ **エントリが見つからない場合 createUrl は reject**（resolve(undefined) ではない）。`url.substr(1)` で先頭 1 文字を捨てるため、zip 実パスは `/OEBPS/images/cover.jpg` 形式を期待する。

### 1c. 宣言カバーが動く理由: unpack() が resolve() 済みの値を loading.cover に流す
`package\src\book.js` L486-493:
```js
if (this.packaging.coverPath) {
    this.cover = this.resolve(this.packaging.coverPath);
}
// Resolve promises
...
this.loading.cover.resolve(this.cover);
```
`Book.prototype.resolve`（L361-381）:
```js
if (this.path) { resolved = this.path.resolve(path); }   // OPF ディレクトリ基準の相対解決
if(absolute != false && this.url) { resolved = this.url.resolve(resolved); }  // archived 時は url = new Url("/", "")（L253）なので "/"+相対 になる
```
`openPackaging`（L316-322）で `this.path = new Path(url)`（OPF パス）→ `this.packaging = new Packaging(xml)` → `unpack(this.packaging)` の順なので、**`book.packaging` は `book.loaded.cover` が settle する前に設定される**（app のコメントは正しい）。

### 1d. カバー未宣言時の loaded.cover は resolve(undefined)
`book.js` L486-493 では `coverPath` が falsy でも `this.loading.cover.resolve(this.cover)`（this.cover = undefined）が無条件に走る。**reject はしない**（実測でも `loaded.cover RESOLVED: undefined`）。
なお `book.loaded.packaging` は **0.3.93 には存在しない**（`loaded` は book.js L95-104 の 8 項目のみ。実測でも `book.loaded.packaging = undefined`）。app L160-161 のコメントは正しい。

## 根拠 2: Node 実測（dist/epub.js + jszip + linkedom）

最小 EPUB（OPF を `OEBPS/content.opf`、カバー未宣言、manifest に `images/notcover.jpg` / `images/cover.jpg`、spine は ch1 のみ）を JSZip で構築し、`package\dist\epub.js` を Node でロードして実行。
（スクリプト: `C:\Users\user\AppData\Local\Temp\opencode\epubjs-test\probe2.mjs` / `probe6.mjs`。renderTo/display は DOM 依存のためスキップ、カバー解決に必要な open→locations.generate まで再現）

実行結果の要点（probe6、app.js と同じ ready→locations.generate 順序を含む）:
```
coverPath after full pipeline: undefined
raw href: "images/cover.jpg"
book.resolve(raw): "/OEBPS/images/cover.jpg"
createUrl(raw) REJECTED: File not found in the epub: images/cover.jpg
```
probe2 の追加結果:
```
book.path.directory = /OEBPS/
packaging.coverPath = false
manifest.img2.href = "images/cover.jpg"
book.loaded.packaging = undefined
loaded.cover RESOLVED: undefined
getBase64(rawHref) = undefined            ← zip.file("images/cover.jpg") が hit しない
book.resolve(rawHref) = "/OEBPS/images/cover.jpg"
createUrl(resolved) RESOLVED（base64 経由では "data:image/jpeg;base64,/9j/3QECAw==" ）
```
宣言カバー版（probe3）:
```
book.loaded.cover = "/OEBPS/images/cover.jpg"   ← resolve 済み完全 zip パス
manifest.ci.href  = "images/cover.jpg"          ← 生 href とは違う
```
→ **最有力仮説は実測で確定**。`pickFallbackImageHref` が選ぶ `images/cover.jpg` は zip 内に存在せず（実体は `OEBPS/images/cover.jpg`）、`createUrl` は reject。app の resolveCover ではその reject が L185 前のチェーン（L183→L190 の `.catch(()=>null)`）で null 化される。

## 修正方針（推奨）

1. **フォールバックでも `book.resolve(href)` を経由して createUrl に渡す**（宣言カバーと同一経路）。
   - `js/renderers/epub.js` L181-183 を「`var href = pickFallbackImageHref(packaging); ... book.archive.createUrl(book.resolve(href), {base64:true})`」にする形。`book.resolve` は archived 時に `/`+OPF相対解決 した zip 実パスを返す（book.js L361-381、実測値 `/OEBPS/images/cover.jpg`）。
   - `pickFallbackImageHref` の戻り値（生 href）をそのまま createUrl に渡すのは不可。basename 判定（cover 優先）は href のままでも問題ないので、選択ロジックは現行維持でよい。
2. 副次問題（同じ EPUB で宣言カバーがあってもカバーが空になる原因になり得る）: **`createUrl(url, {base64:true})` の戻り値は 0.3.93 では `data:` ではなく blob URL になる**（`Archive.createUrl` は `useBase64` でも `getBase64` の結果をそのまま返すが、epub.js 本体の呼び出しは `coverUrl()` で `{base64}` を渡さず blob URL を使う。実測では `createUrl(resolved,{base64:true})` が `blob:fake` を返した = dist の createUrl は base64 分岐を持つが、`data:` 文字列になる保証はない。app L187 の `dataUrl.indexOf("data:") !== 0 → null` ガードで弾かれる可能性）。
   - 安全策: フォールバック/宣言とも **`book.archive.getBase64(resolved)` を直接使う**（戻り値が `"data:" + mimeType + ";base64," + data` であることは archive.js L165-175 と実測 `data:image/jpeg;base64,...` で確認済み）、または L187 のガードを `data:` か `blob:` を許容し `shrinkToDataURL` 側で両対応（Blob/blob URL どちらも Image.src 可）に緩める。
   - 注: 実測の `blob:fake` は Node スタブ由来。ブラウザの実 `URL.createObjectURL` でも `{base64:true}` 経路の戻り値が `data:` になるかは**ブラウザ実機で未確認**（dist L17105-17113 のコード上は getBase64 の結果を resolve するので `data:` のはずだが、probe4/5 で blob:fake が返った原因（urlCache の挙動等）は切り分けていない — 未確認事項参照）。

## 未確認事項

- **ブラウザ実機での resolveCover の実際の reject ログ**は未取得（Node 再現で同等パスを確定済みだが、実 EPUB ファイルでの console 確認はしていない）。
- probe4/5 で `createUrl(resolved, {base64:true})` が `blob:fake` を返した理由（dist の createUrl は useBase64 分岐を持つはず）を切り分けていない。`data:` 前提の L187 ガードがブラウザでどう挙動するかは実機確認が必要。
- 対象 EPUB の OPF が zip ルート直下（`book.path.directory = "/"`）の場合は `resolve` 後も `images/cover.jpg` と同じ形になり得るが、その場合でも `url.resolve` で先頭に `/` が付き `/images/cover.jpg` になる（archive.js の `url.substr(1)` と整合）。OPF 直下のみの EPUB で現に失敗している事例は未確認。
- js/renderers/fb2.js L520 / pdf.js L568 の resolveCover は本調査対象外（未読）。

## 実行したコマンド（要点）

- `npm pack epubjs@0.3.93` → tarball 展開（`%TEMP%\opencode\epubjs-src\package`）
- `node %TEMP%\opencode\epubjs-test\probe2.mjs` / `probe3.mjs` / `probe5.mjs` / `probe6.mjs`（出力は上記引用）
- grep: `createUrl(` / `useBase64` / `loading.cover.resolve` / `this.packaging =` in dist/epub.js（行番号 17091, 17105, 18083, 18090, 17913 等）

## 変更ポイント候補（実装はしない）

- `C:\Users\user\lll-e-book\js\renderers\epub.js` L181-183: `pickFallbackImageHref` の結果を `book.resolve()` してから `createUrl` へ。
- 同 L169: 宣言カバー側は既に resolve 済み値なので変更不要（ただし L187 の `data:` ガードと base64/blob の戻り値型の整合は要確認）。
- 同 L187: `data:` 限定ガードの見直し（`blob:` 許容または `getBase64` 直接利用へ）。
- リスク: `book.resolve` は `path` 未設定時（open 失敗経路） undefined を返す → 既存の null フォールバックで吸収されるが、テストでカバー未宣言/OPF 階層あり/なしのパターンを確認すること。
