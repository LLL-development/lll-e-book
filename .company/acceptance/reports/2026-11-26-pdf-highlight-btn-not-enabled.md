# 受け入れ検証: PDF で #highlight-btn が有効化されない 原因追跡（2026-11-26）

担当: acceptance。`.company/acceptance/CLAUDE.md` は本リポジトリに未配置（reports/ のみ）。静的到達のみ（ブラウザ未実行）。

## 結論
- 追加 CSS（style.css:1778-1789）は **span をゼロサイズ化しておらず、選択を不能にしていない**。calc も成立する。CSS 修正は本症状の原因ではない。
- 最も蓋然性の高い単一根本原因: **buildTextLayer が pageTextItemsPage を設定する前に return する（pdf.js:243）→ onSelectionChange の pdf.js:520 `if (pageTextItemsPage !== pageNum) return;` で常に停止**。textLayer 構築が未完/失敗。
- 実行時ガードの分岐を全経路追跡した結果、onSelect 到達を阻む分岐は 520 の pageTextItemsPage ガードのみが構造的に成立し、他ガード（515/516/518/522）は正常構築時に素通りする。

## 各ガードの判定（原文引用）
- pdf.js:515 `if (!sel || sel.rangeCount !== 1 || sel.isCollapsed) return;` — ドラッグ選択では rangeCount=1 かつ非 collapse。素通り。
- pdf.js:516 `if (!container.contains(sel.anchorNode)) return;` — span は container 配下。素通り。
- pdf.js:518-519 `if (!textLayerDiv.contains(range.startContainer) || !textLayerDiv.contains(range.endContainer)) return;` — host は textLayerDiv.replaceChildren(host) で子（pdf.js:244）。span は host 配下。素通り。
- pdf.js:520 `if (pageTextItemsPage !== pageNum) return;` — **停止候補**。pageTextItemsPage は pdf.js:251 でのみ代入。代入経路は 243 `if (disposed || version !== renderVersion || !items) return;` を通過する必要があり、layer.render() 完了・items 取得成功・renderVersion 一致の 3 条件が要る。どれか欠けると 0 のまま＝常に return。
- pdf.js:521-522 `const rects = selectionRects(sel); if (!rects.length) return;` — selectionRects は selText を pageFullText で検索（408-409）、不一致でも item 内部分一致にフォールバック（414-426）。正常構築時は非空。

## CSS 判定（選択不能か否か）
- span の left/top は %（vendored pdf.file.js: `u.left=${(100*c/this.#h).toFixed(2)}%`）。% top の基準は host の高さ。
- host の高さ: setLayerDimensions（pdf.file.js の St）が `height=round(down, var(--total-scale-factor)*pageHeight, var(--scale-round-y))` を host インラインに書く（TextLayer 構築子 `St(s,i)`）。style.css:1764 `height:auto!important` が上書きするが、inset:0（1758-1762）で textLayerDiv 基準の高さ＝stage 高さ＝viewport.height px（pdf.js:191 `stage.style.height=viewport.height+'px'`）。**host 高さは 0 でない**。よって % top は潰れない。
- `--total-scale-factor` は host に設定（pdf.js:225）。span は host 配下で継承。`--font-height` は span インライン px（vendored: `u.setProperty("--font-height",`${p}px`)`）。calc(数値px * 数値) は成立 → font-size 正常。ゼロ化なし。
- 入れ子 .pdf-textlayer（外 textLayerDiv / 内 host）: 両方に inset:0 が効くが、外の高さも stage=inset:0 で viewport px。重なり崩れは起きない。
- user-select: canvas は none（1747）、.pdf-textlayer は text（1766）。span は継承で選択可。
- 判定: **CSS 修正は選択を不能にしていない**。

## 推奨修正（JS）
- buildTextLayer の失敗を握りつぶさず可視化: pdf.js:200 `.catch(function(){})` と 243 の `!items` return に診断ログを追加し、(a) TL 未定義(222) (b) streamTextContent 非関数(222) (c) getTextContent 失敗(items=null,238-239) (d) render() 失敗 (e) renderVersion ミスマッチ のどれで止まるか特定。
- 根本は textLayer 構築完了保証。243 の `!items` で弾かれているなら snapshotP のエラーハンドリング（238-239）を緩めず原因（worker/正規化）を調査。

## 実行コマンドと結果
- `node --check js/renderers/pdf.js` -> OK / `node --check js/app.js` -> OK
- vendored pdf.file.js 走査: `--font-height`(px), setLayerDimensions(St) の width/height 式, span left/top %, `--scale-x` 設定, TextLayer 構築子 `St(s,i)` を原文確認。
- `Select-String css/style.css user-select` -> 1747/1766 のみ。

## 見ていない範囲
- ブラウザ実行未実施。buildTextLayer が実際にどの条件で return するか（TL 有無/getTextContent 成否/render 完了/version）は実行時ログなしには確定できない。520 ガード停止は構造的推定。
