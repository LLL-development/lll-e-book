# 受け入れ検証レポート: PDF 版マーカーペン（2026-11-26）

担当: acceptance / 対象: LLL-E-Book PDF マーカーペン（textLayer 重畳 → PDF user space 矩形 → canvas 再現）
スタンス: 敵対的・反スタブ。既定「未達」から証拠で達成を確認。
規約参照: `.company/acceptance/CLAUDE.md` は本リポジトリに未配置（`reports/` のみ存在）。部署規約・テンプレートは `~/.config/opencode/company-template/acceptance/` を参照した。

## 結論（サマリ）
- **textLayer API は実在する**（推測 API による実行時 TypeError の懸念は否定）。vendored `pdf.min.mjs` と `pdf.file.js` の両方に `TextLayer` クラスが export され、`constructor({textContentSource, images, container, viewport})` / `render() -> Promise` / `cancel()` の形が pdf.js の呼び出しと一致。`renderTextLayer` 関数は**存在しない**が、pdf.js はそれを使っていない（コメント 206-208 行の記述も実態と一致）。
- **スタブではない**。選択→矩形は `sel.toString()` をページ連結テキスト上で検索し、`getTextContent` の `item.transform`/`width` から PDF user space 矩形を実算出（`selectionRects` 392-446 行）。保存だけ・矩形 0 件の空実装ではない。
- **再現経路が成立**。`renderPage` の `render().promise` 解決後に `paintUserHighlights` → `paintSearchHighlights` の順で呼び（195-196 行）、`pdfPointToCanvas` で canvas 矩形へ写し `fillRect`。`applyHighlights`→`repaintForHighlights`→`renderPage` で開き直し復元も通る。
- **検索と分離**。`hitRectsByPage`（検索）と `userHighlightRects`（ユーザー）は別 Map（113 / 131 行）。`paintSearchHighlights` の挙動は不変。検索デグレなし。
- **app.js 契約と整合**。`sessionSupportsHighlights` が要求する 3 メソッド（applyHighlights/addHighlight/jumpToHighlight）が揃い（804/820/860 行）、anchor は中身非解釈で透過、`jumpToHighlight` は Promise を返す（app.js の `.then` 前提を満たす）。
- **Critical / High は検出せず**。Medium 1 件（span の font-size スケール規則欠落による可視選択帯の横ずれ。保存矩形の正確性には影響なし）。
- **ブラウザ実行（実 textLayer 重畳・選択→矩形・復元描画・ズーム/リサイズ再描画）は未実施。静的到達のみ。**

## 実行コマンドと結果
- `node --check js/renderers/pdf.js` -> OK / `node --check js/app.js` -> OK（構文）。
- `node` で `vendor/pdfjs/pdf.min.mjs`（458,931 B）を走査:
  - `export{...TextLayer,...}` に `TextLayer` を確認。`class TextLayer` 実在（idx 242824）。
  - `constructor({textContentSource:t,images:e,container:i,viewport:n})`、`render(){...return this.#br.promise}`、`cancel(){...}` を原文で確認。
  - `renderTextLayer` 文字列なし（false）。`streamTextContent`/`convertToViewportPoint`/`setLayerDimensions`/`--total-scale-factor`/`--font-height`/`role="presentation"`/`<br>` すべて実在。
  - `setLayerDimensions(t,e)` は `e instanceof PageViewport` 時に `width=round(down, var(--total-scale-factor)*pageWidth, var(--scale-round-x))` を書く（22841 行）→ pdf.js が `--total-scale-factor`/`--scale-round-*` を host に設定する設計と一致。
  - `convertToViewportPoint(t,e)` は `Util.applyTransform([t,e], this.transform)`（`x'=v0*x+v2*y+v4` 等）→ `pdfPointToCanvas` のフォールバック手計算（303 行）と同一式。
  - `getTextContent()` は既定で `streamTextContent()` と同一正規化（`disableNormalization:false`）→ スナップショットと layer テキストの一致前提は成立。
- `node` で `vendor/pdfjs/pdf.file.js`（430,287 B, file: プロトコル用ブリッジ）も走査: `TextLayer:se` として export、`constructor({textContentSource:t,images:e,container:s,viewport:i})` / `render(){` / `cancel(){` を確認。**両ディストリビューションで API 一致**。
- `index.html`: `#highlight-btn` 実在（`<button id="highlight-btn" class="btn btn-...">`）。`js/renderers/pdf.js` を classic 読込（214 行）。PDF ESM は `js/pdf-library.js` が `loadPdfJs()` で遅延初期化し `window.pdfjsLib` に束縛（http=pdf.min.mjs / file=pdf.file.js）。

## 反スタブ判定の根拠
- **textLayer 生成 API**: `buildTextLayer`（218-255 行）は `window.pdfjsLib.TextLayer` を取得し `new TL({textContentSource: page.streamTextContent(), container: host, viewport})` → `layer.render()`。引数形が実クラスと一致。ガード `if (!TL || typeof page.streamTextContent !== "function") return null;`（222 行）で欠落時も page 表示は壊さない。
- **矩形算出が本物**: `selectionRects`（392-446 行）は連結テキスト `pageFullText` 上で `selText` を検索し、被覆 item ごとに `{x: it.x+off, y: it.y, w, h: it.h}` を生成（443 行）。`it.x/y/h/w` は `buildItemMap`（270-286 行）が `transform[4]/[5]/|transform[3]|/item.width` から算出。検索の `rectsForSpan`（723-736 行）と同一の文字数按分ロジック。
- **再現経路**: `paintUserHighlights`（358-382 行）は `userHighlightRects.get(page.pageNumber)` を `pdfPointToCanvas` で 2 隅変換 → `fillRect`。`renderPage` の render 後（195 行）に呼ばれ、ページめくり/ズーム/リサイズ（`onResize`→`renderPage`）で再適用。
- **空実装/TODO/モック**: 対象ファイル内に未検出。

## 仕様項目別の到達確認（静的）
1. 選択で `#highlight-btn` 有効化: 到達。`onSelectionChange`（511-528 行）が `textLayerDiv.contains(range.start/endContainer)` ガード後 `session.onSelect(anchor, sel.toString())` → app.js `onSelect`→`updateHighlightButton`（app.js:882-884, 871-877）。
2. 保存 1 件 = `{id,color,text,created,anchor:{type:'rect',page,rects:[{x,y,w,h}]}}`: 到達。anchor は pdf.js:523 `{type:'rect',page:pageNum,rects}`、保存形は app.js:906-912。localStorage は storage.js。
3. 一覧追加・クリックで該当ページ移動・削除: 到達。`renderHighlights`（app.js:957-1008）→`jumpToHighlight`（pdf.js:860-865、`goTo({page})`）/`removeHighlight`（pdf.js:830-859）。
4. 開き直し復元 / ズーム・リサイズ再描画: 到達。`setupHighlights`→`applyHighlights`（app.js:887→pdf.js:804-819）→`repaintForHighlights`→`renderPage`。ズーム/リサイズも `renderPage` 経由で `paintUserHighlights` 再実行。
5. 検索ハイライトと衝突しない: 到達。別 Map・`paintSearchHighlights` 不変（313-353 行）。`clearSearch`/`search` は `hitRectsByPage` のみ操作（677/789 行）で `userHighlightRects` に触れない。
6. EPUB/TXT/FB2 と app.js 契約整合・既存デグレなし: 到達。app.js は anchor を中身非解釈で透過（`JSON.stringify` 比較のみ、app.js:903）。PDF rect anchor も EPUB cfi / TXT-FB2 dom anchor も同一経路。`sessionSupportsHighlights` の 3 メソッド判定は PDF で成立。text.js/fb2.js/epub.js は本案件で変更対象外。

## 指摘一覧

### [Medium] textLayer span の font-size を `--total-scale-factor` でスケールする CSS 規則が欠落
- 該当: `C:\Users\user\lll-e-book\css\style.css:1757-1775`（`.pdf-textlayer`）。span 用の `font-size` 規則がファイル中に不在（grep: `pdf-textlayer span` / `--font-height` / `font-size: calc` は 1754 行のコメントのみ）。
- 根拠: vendored TextLayer は span に `left/top` を **%（viewport 比）** で置き、`--font-height` を **PDF user space の px** でセットするが、`font-size` 自体はインライン設定しない（`pdf.min.mjs` の `#$r` で `d.left=..%`/`d.top=..%`/`--font-height` のみ。`d.fontSize=` はクラス内に存在せず）。公式 viewer.css は `.textLayer span{ font-size: calc(var(--font-height) * var(--total-scale-factor)); ... }` で scale する前提。本実装にはこの規則が無い。
- 影響: **保存される矩形の正確性には影響しない**（`selectionRects` は span の几何でなく `pageTextItems` の PDF 几何から矩形を作るため）。影響するのは画面上の**可視選択帯（`::selection`）の横位置/幅**で、span テキストが viewport スケールされず本文文字と横方向にずれ得る（縦は top% で概ね一致）。ユーザーが「視覚的に選んだ範囲」と実矩形が体感でずれる可能性がある。
- 推奨: `.pdf-textlayer span { font-size: calc(var(--font-height) * var(--total-scale-factor)); line-height: var(--font-height); transform-origin: 0 0; white-space: pre; }` を追加（公式 viewer.css 相当）。**ブラウザで可視選択帯の一致を実測して確認のこと（本検証は静的到達のみ）。**

### [Low] 可視選択帯と `::selection` 色は機能に無関係だが黄色固定
- 該当: `C:\Users\user\lll-e-book\css\style.css:1772-1775`（`background: rgba(255,210,0,0.45)`）。`paintUserHighlights` の fill も黄色固定（pdf.js:363）。仕様「半透明黄色」と一致しており問題なし。色切替機能は仕様外。参考記録。

## 契約整合の細部（証拠）
- `jumpToHighlight` は `anchor.page` が数値なら `session.goTo({page})`（= `renderPage` の Promise）、そうでなければ `Promise.resolve()` を返し、常に Promise（pdf.js:860-865）。app.js の `currentSession.jumpToHighlight(h.anchor).then(...)`（app.js:986）の前提を満たす。
- `applyHighlights`/`addHighlight` は `anchor.page` が number かつ `anchor.rects` が Array のものだけadopt（pdf.js:810-811, 821-822）。app.js が透過する PDF anchor と形が一致。
- `destroy` は `document.removeEventListener('selectionchange', onSelectionChange)`（pdf.js:870）と `window.removeEventListener('resize', onResize)`（869）、`session.onSelect=null`（871）を実施。リーク後片付け OK。

## 見ていない範囲・実行時未検証
- **ブラウザ実行を一切行っていない**: 実 textLayer の canvas 上重畳、実際のドラッグ選択→矩形生成、保存→開き直し復元描画、ズーム/リサイズ再描画、`::selection` の可視位置、localStorage 往復は**静的到達のみ・実行時未検証**。
- Medium の span font-size 問題は、ブラウザで可視選択帯が本文に重なるか実測するまで影響度の確定は保留。
- `pdf.worker.*` の実 PDF パース／`getTextContent` の実データ（複数フォント・回転・vertical text・markedContent 入れ子）での span↔item 1:1 対応は、コード上は成立（`collectTextSpans` が `role="presentation"` かつ textContent ありのみ抽出、`buildItemMap` が str 空を除外）するが、**実 PDF での対応崩れは未検証**。
- 他フォーマット（EPUB/TXT/FB2）の再実行デグレ確認は未実施（pdf.js 変更はそれらに非依存、app.js 契約は不変と静的に判断）。

## 判定
- **条件付き合格**（Critical/High なし）。textLayer API 実在・矩形実算出・再現経路・検索分離・app.js 契約整合・後片付け・構文はいずれも証拠付きで到達。
- 実装層への差し戻し: Medium 1 件（span font-size スケール規則）。ブラウザ実測で可視選択帯の一致を確かめ、必要なら CSS 追加。
- **ブラウザ E2E（選択→矩形→保存→開き直し→ズーム/リサイズ）を 1 回でも実行するまで、delivery ゲートは未通過扱いを推奨**（本検証は静的到達に留まるため）。
