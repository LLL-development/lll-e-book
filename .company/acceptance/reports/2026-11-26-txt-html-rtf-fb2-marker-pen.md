# 受け入れ検証: TXT/HTML/RTF/FB2 マーカーペン + 契約一般化（EPUB 非デグレ）

日付: 2026-11-26 / 検証者: acceptance
対象: js/highlights-dom.js(新規), js/renderers/text.js, js/renderers/fb2.js, js/app.js, js/renderers/epub.js, index.html

注: `.company/acceptance/CLAUDE.md` は本リポジトリに存在しない（reports ディレクトリのみ存在）。部署規約・テンプレートは未参照のため、汎用手順で検証した。

## 結論
スタブ/偽実装ではない。fuzzy 復元・anchor 透過・EPUB 非デグレはいずれも実コードで到達確認。**Critical/High なし**。Low 2 件（コメント陳腐化・選択解除時のボタン活性残存）。ブラウザ実行時は未検証。

## 実行コマンドと結果
- `node --check` を highlights-dom.js / text.js / fb2.js / app.js / epub.js に実行 -> 全ファイル構文 OK（出力なし、CHECK_DONE）。
- grep `anchor\.type|anchor\.cfi|\.cfi|anchor\[` in app.js -> **0 件**（app.js は anchor を一切解釈しない＝透過）。cfi 参照は全て renderers/epub.js 側（L800,812,822,831）。
- grep `innerHTML` in highlights-dom.js -> **0 件**。wrapRange は createTextNode/createElement/textContent/replaceChild のみ（highlights-dom.js:70-82）。HTML インジェクションなし。
- Select-String `addHighlight|applyHighlights|jumpToHighlight|removeHighlight|onSelect` in pdf.js / comic.js -> **両ファイル 0 件** -> sessionSupportsHighlights() は false（仕様5 OK）。

## 受け入れ基準の到達確認（実根拠）
1. 選択で #highlight-btn 有効化: 到達。text.js:369-379 / fb2.js:571-577 の selectionchange -> session.onSelect(anchor, anchor.text) -> app.js:882-885 pendingHighlight 設定 -> updateHighlightButton(app.js:871-877) で disabled 解除。
2. <mark class="lll-highlight"> 付与 + localStorage 保存: 到達。addHighlight(app.js:896-924) が {id,color,text,created,anchor} を Storage.setHighlights（storage.js:83-85、anchor は非解釈保存 storage.js:76-79）。本文引きは HighlightsDom.addHighlight->applyOne->wrapRange の mark.textContent（highlights-dom.js:74-77）。CSS 半透明黄色 style.css:1453-1459。
3. 右パネル一覧/ジャンプ/削除: 到達。renderHighlights(app.js:957-1008)、ジャンプ jumpToHighlight(h.anchor).then(app.js:986)、削除 removeHighlight(app.js:926-949)。
4. 開き直し fuzzy 復元: 到達。setupHighlights(app.js:886-887)->session.applyHighlights->HighlightsDom.applyHighlights(highlights-dom.js:229-241)->applyOne(198-225)。attempts は before+text+after -> before+text -> text+after -> text の順（206-211）で仕様どおり緩和。collectTextNodes(30-60) で既存 mark/search-hit を除外し再帰適用を防止。
5. 非対応で disabled: 到達（上記 grep）。
6. EPUB 非デグレ: 到達。selected->onSelect({type:'cfi',cfi},text)(epub.js:572-582)、applyHighlights は h.anchor.cfi 読取(800)、addHighlight(812)、removeHighlight は annotations.remove(cfi,'highlight')(825)、jumpToHighlight は rendition.display(cfi) を返し Promise(830-834)。app.js は anchor 透過なので EPUB/TXT 同一コードパス。annotations.highlight の type='highlight'（第4引数 HL_CLASS は class 名、type は内部 'highlight'）と remove の 'highlight' は既存 EPUB 検証レポート(2026-11-26-epub-marker-pen.md L19)で hash 一致確認済み。

## 反スタブ観点
- fuzzy は本物: applyOne が collectTextNodes でテキストノードを走査し、tryMatchAndWrap->wrapRange(66-84)で Range 相当のスライスを createTextNode/replaceChild で包む。保存専用スタブではない。
- anchor 透過の完全性: app.js に anchor.type/anchor.cfi 参照ゼロ（grep 実証）。
- selectionchange 誤発火ガード: text.js:373 / fb2.js:574 に `container.contains(sel.anchorNode)` が実在。ライブラリ UI/ツールバー選択では onSelect 不走。
- 読み込み順: index.html L212 highlights-dom.js は text.js(L213)/fb2.js(L217) より前。create 未定義リスクなし。
- リーク: text.js:361 / fb2.js:624 で destroy 時に selectionchange を removeEventListener。両方あり。
- fb2.js の session 引き上げ: var session=null(547) -> buildSession で代入(579) -> onSelectionChange は null ガード(572)。settleWithCover 前に addEventListener(633) するが session null 期間は何も発火しない。構造変更は正しい。

## 指摘（Low）
- [Low] js/app.js:850 見出しコメント `/* ---------------- Highlights (marker pen, EPUB only) ---------------- */` が陳腐化。実態は TXT/HTML/RTF/FB2 をサポート。機能影響なし、コメントのみ。
- [Low] js/app.js:871-877 updateHighlightButton は pendingHighlight がある限り選択解除後も btn.disabled=false のまま。選択解除イベントで pendingHighlight をクリアしていない（closeReader:1192 でのみリセット）。実行時に stale なボタン活性が起こり得る（未実行検証）。

## 既知の限界（過度に盛らない）
- 同一テキスト複数箇所: applyOne は attempts ごとに先頭マッチで包む（highlights-dom.js:217-222）。before/after 文脈で緩和を絞る設計上、完全一致が複数ヒットすると誤位置復元の可能性。fuzzy 方式の構造的限界。
- 跨ぎ選択（複数ブロック/要素をまたぐ Range）: wrapRange は単一テキストノード内のみ包む。before/after はノード横断で構築(106-168)されるが、復元は単一ノード内の needle マッチに依存するため跨ぎ範囲の完全復元は保証外。
- フォントサイズ変更後の復元: テキスト内容ベースなのでレイアウト非依存で復元する見込み（実行未検証）。

## 見ていない範囲 / 実行時未検証
- ブラウザでの実 fuzzy 復元・跨ぎ選択・複数一致・EPUB の注釈 hash 一致の再実行は未実施（静的到達のみ）。
- epub.js の annotations.highlight/remove の hash 一致は前レポート(2026-11-26-epub-marker-pen.md)の結論を引用。今回 epub.js 実体（CDN）の再走査は未実施。
- 実データ/E2E、localStorage 実書き込み、selectionchange の実発火タイミングは未確認。
