# 受け入れ検証レポート: EPUB 版マーカーペン（2026-11-26）

担当: acceptance / 対象: LLL-E-Book EPUB マーカーペン
スタンス: 敵対的・反スタブ。既定「未達」から証拠で達成を確認。

## 結論（サマリ）
- スタブ/偽実装ではない。epub.js の注釈 API を実際に呼び、引数順・型とも epub.js 0.3.93 の実ライブラリ（CDN 実体 607KB を取得し照合）と一致。保存だけでなく本文描画経路が実在する。
- ただしマーカー色の指定方法に実挙動と意図の乖離がある（Medium）。仕様「半透明黄色」は結果として満たすが、それは epub.js のデフォルト fill:yellow に依存した偶然で、HL_STYLES の background-color は SVG に効かず無意味。テーマ別 alpha 調整 CSS も EPUB 本文には適用されない。
- Critical / High は検出せず。合格は条件付き（下記 Medium を直すと意図どおりの挙動になる）。
- ブラウザ実行（実描画・CFI 往復・localStorage 往復）は未実施。静的到達のみ。

## 実行コマンドと結果
- node --check epub.js / app.js / storage.js / i18n.js -> 全て OK（構文）。
- Invoke-WebRequest https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.js -> 607376 バイト取得。注釈 API を実体で照合（下記）。
- index.html:206 の CDN は epubjs@0.3.93（integrity 付き）。tests/CDN-PROVENANCE.json と整合。

## epub.js 0.3.93 実仕様との照合（CDN 実体）
- Annotations.highlight(cfiRange, data, cb, className, styles)（epub.js:8027）-> add("highlight", ...)。app 呼び出し highlight(cfi, {id}, undefined, HL_CLASS, HL_STYLES)（renderers/epub.js:803,812）は引数順・型とも一致（data=オブジェクト, styles=オブジェクト）。
- Annotations.remove(cfiRange, type) hash=encodeURI(cfiRange+type)（epub.js:7979）。登録 type="highlight"（8028）、除去 remove(cfi,'highlight')（renderers/epub.js:820）-> hash 一致で除去可。
- rendition.on("selected", (cfirange, contents)) の cfirange は文字列（epub.js:6545 .toString()、9116 emit）。app の pendingHighlight={cfi,text}、保存 anchor.cfi、epub 読取 h.anchor.cfi（renderers/epub.js:800）-> 型一致。
- 復元: Annotations は rendition.hooks.render.register(inject)（epub.js:7927）でセクション再レンダ時に annotation.attach(view)（8069-8078）。よって applyHighlights 登録後は再適用される前提は成立。
- 選択テキスト: contents.window.getSelection()（renderers/epub.js:575-576）。contents は iframe の Contents で window は iframe 側。host window ではない。正しい。

## 指摘一覧

### [Medium] HL_STYLES の background-color/color は SVG に効かず、色は epub.js デフォルトに依存
- 該当: C:\Users\user\lll-e-book\js\renderers\epub.js:232
  var HL_STYLES = { 'background-color': 'rgba(255, 210, 0, 0.45)', 'color': 'inherit' };
- 根拠: epub.js の注釈 highlight は SVG を描画する。View.highlight は
  attributes = Object.assign({fill:"yellow","fill-opacity":"0.3","mix-blend-mode":"multiply"}, styles)（epub.js:9915-9919）を作り、
  Highlight.bind が this.element.setAttribute(attr, ...) を全 attr に対して行う（epub.js:7054-7058）。element は SVG <g>（Pane.addMark の createElement('g') epub.js:6905）。
  background-color / color は SVG 属性として無効（無視される）。実色はデフォルトの fill:yellow + fill-opacity:0.3（＝半透明黄色）で決まる。
- 影響: 仕様「半透明黄色」は結果として満たすが、意図（HL_STYLES で色を制御）と実挙動が乖離。色を変えようとしても HL_STYLES を書き換えても効かず、fill/fill-opacity を渡す必要がある。コメント（renderers/epub.js:226-230）は誤解を含む。
- 推奨: HL_STYLES = { 'fill': 'rgb(255,210,0)', 'fill-opacity': '0.45' } に修正し、コメントを実態に合わせる。

### [Medium] mark.lll-highlight のテーマ別 CSS が EPUB 本文に適用されない
- 該当: C:\Users\user\lll-e-book\css\style.css:1453（mark.lll-highlight）、:1461（sepia）、:1465（dark）
- 根拠: epub.js の注釈は <mark> ではなく SVG <g class="lll-highlight"> を生成（epub.js:7060-7062 classList.add(className)、6905 <g>）。セレクタ mark.lll-highlight は <g> にマッチしない。加えて style.css は host document のみで、epub.js の iframe には読込まれない（renderers/epub.js:210,226 のコメント自身が明言）。
- 影響: sepia/dark で alpha を下げる意図（1461-1467）は EPUB 本文に一切効かない。light でも CSS 由来の色は無く、色は上記 epub.js デフォルトに依存。
- 補足: 一覧側の .highlight-item::before（style.css:1471）は host document の DOM なので有効。

### [Low] 選択解除時に pendingHighlight が消えない
- 該当: C:\Users\user\lll-e-book\js\app.js:876-891（setupHighlights の onSelect）、:893-921（addHighlight）
- 根拠: 選択後にボタンを押さず別操作しても pendingHighlight は残り、後続のボタン押下で古い CFI が保存され得る。仕様違反ではないが UX 上の残存状態。実害は軽微。

## 仕様項目別の到達確認（静的）
1. 選択で #highlight-btn 有効化: 到達。rendition.on('selected')->sessionRef.onSelect（renderers/epub.js:572-582）->app onSelect->updateHighlightButton（app.js:879-881,868-874）。disabled 初期化は index.html:122 disabled。
2. 保存1件 = {id,color,text,created,anchor:{type:'cfi',cfi}}: 到達。app.js:903-909 で完全一致の形。localStorage は storage.js:83-85。
3. 右パネル一覧・ジャンプ・削除: 到達。renderHighlights（app.js:955-1007）、ジャンプ goTo({cfi})（app.js:985->renderers/epub.js:637 loc.cfi 対応）、削除 removeHighlight（app.js:923-947->epub.js:816-822）。
4. 開き直し復元: 到達。renderFromFile の dispatch 解決後 currentSession 確定後に setupHighlights（app.js:1272->1285）->applyHighlights（app.js:884）。currentSession null の窓なし。annotations の render フックで再適用（epub.js:7927）。
5. 非対応フォーマットで disabled: 到達。sessionSupportsHighlights は applyHighlights/addHighlight の存在で判定（app.js:860-866）。grep 結果、これらを持つのは renderers/epub.js のみ（TXT/PDF/CBZ/FB2 不在）。onSelect も EPUB の selected ハンドラ経由のみ。
6. デグレ: 検索 mark.book-search-hit（renderers/epub.js:221,245）と注釈 SVG g.lll-highlight は別 DOM・別 class で干渉なし。destroy で onSelect=null（renderers/epub.js:828）、clearSearch 不変。closeReader で pendingHighlight=null（app.js:1191）。

## 反スタブ判定の根拠
- 注釈 API の呼び出しが実在（renderers/epub.js:803,812,820）し、引数順・型が CDN 実体 epub.js の定義と一致。
- 「保存だけして描画していない」ではない: addHighlight/applyHighlights が annotations.highlight を経由して view.highlight（epub.js:8176->9910）で SVG mark を張る経路が成立。
- 空実装/TODO/モックは該当ファイル内に未検出。

## HTML インジェクション
- 一覧の user text は label.textContent（app.js:977）、削除ボタンも rem.textContent（app.js:998）。innerHTML は empty 時のみで I18n 固定文字列のみ（app.js:961-963）。ユーザーテキストの innerHTML 注入は無し。OK。

## 見ていない範囲 / 実行時未検証
- ブラウザでの実描画（実際に半透明黄色が本文に出るか）、CFI の選択->保存->復元の往復、localStorage 実書き込み、iframe 内 SVG の fill 反映は未実行（静的到達のみ）。
- FB2（renderers/fb2.js）が highlight API を持たないことは grep で確認したが、FB2 で誤ってボタンが有効化しない実行時挙動は未確認。
- epub.js の fill 継承が全ブラウザで <g>-><rect> に効くかの互換性は未検証。
- tests/ 配下の既存テスト実行は本検証では未実施（マーカーペンの自動テストは未発見）。