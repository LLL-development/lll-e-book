# 受け入れ検証レポート — PDF レンダラ JS バグ主張の反証検証

日付: 2026-11-26
対象: C:\Users\user\lll-e-book\js\renderers\pdf.js（作業ツリー＝未コミット、HEAD 39efe8a に対するハイライト機能追加差分）
担当: acceptance（受け入れ検証）

## 前提の注記
- `.company/acceptance/CLAUDE.md` は本プロジェクトに**存在しない**（reports ディレクトリのみ存在）。部署規約・テンプレートは未参照のため、本レポートは汎用手順で作成した。
- 検証対象は JS のみ。CSS（style.css の .pdf-textlayer span absolute 化）は対象外。

## 実行コマンドと結果
- `node --check js/renderers/pdf.js` → **SYNTAX OK**（構文エラー無し＝構造的な ReferenceError 確定は起きない）
- `git diff -- js/renderers/pdf.js` → 現行の pdf.js 変更は**未コミット**。ハイライト/検索/TextLayer 一式が今回の追加。`canvas.width/height` 行は差分の**コンテキスト行**（＝既存）。
- vendored TextLayer 実装（vendor/pdfjs/pdf.min.mjs, class TextLayer）を通読し span 生成条件を確認。

---

## 主張1: session スコープ ReferenceError — 判定【誤認 / 実在せず】深刻度: なし

呼び出し順序を実際に追跡した。

- `onSelectionChange`（511-528行）は冒頭 512 行で `session` を参照。`session` は 588 行 `const session = {...}` で初期化される **const（TDZ あり）**。
- 重要: 512 行は `try`（513行開始）の**外**。もし TDZ 中に呼ばれれば未捕捉の ReferenceError になり得る。
- だが `onSelectionChange` の起動経路は `document.addEventListener('selectionchange', onSelectionChange)` のみ。この登録は `attachSelectionListener()`（530-533行）で行われ、その**呼び出しは 886 行**。
- 886 行は `const session`（588）と `resolve(session)`（880）の**後**。同一 then コールバック内で上から順に実行されるため、リスナー登録時点で `session` は初期化済み（TDZ 脱出済み）。
- 登録前に selectionchange が発火しても、まだハンドラが紐付いていないので呼ばれない。
- 呼び出し元 app.js 側でも `currentSession.onSelect` 代入（app.js:882）は render 解決後の setupHighlights（app.js:1286）で行われ、512 行の `typeof session.onSelect !== 'function'` ガードも成立する。

**結論: 実行時 ReferenceError は起きない。誤認。**

## 主張2: render タスク競合（renderVersion/disposed ガード不足）— 判定【誤認 / ガード十分】深刻度: なし

- `renderPage` は先頭 181 行で `const version = ++renderVersion` を**同期取得**。
- canvas 書き込み（188-189）は getPage 解決後・**同一マイクロタスク内で 185 行の `if (disposed || version !== renderVersion) return` を通過した後**にのみ実行。古い継続はここで打ち切られ canvas を触らない。
- buildTextLayer は version を引き継ぎ、221 行（生成前）と 243 行（DOM 差し替え前）で `version !== renderVersion` を再チェック。
- 差し替え `textLayerDiv.replaceChildren(host)`（244）と `pageTextItems/pageTextSpans` 代入（245-251）は 243 のガード直後で **await を挟まない同期ブロック**。よってチェックと実行の間に割り込みが入らず、古い build が新しい DOM/スナップショットを上書きしない。
- TextLayer は**detached な host** へ描画し、live DOM には version 一致時のみ swap。stale build は host が非接続なので DOM を汚染しない。
- `destroy`（866）は `disposed=true; renderVersion++` で進行中タスクを全て無効化。

**結論: 高速ページめくり/ズームでも古い buildTextLayer は新しい DOM を汚染しない。ガードは十分。誤認。**

## 主張3: canvas 上限なし — 判定【実在するが軽微・既存挙動（本件の追加ではない）】深刻度: Low

- 188-189 行 `canvas.width = viewport.width; canvas.height = viewport.height;` に明示的キャップは無い（**実在**）。
- ただしズームは `setZoomLevel`/`zoomIn/Out` で `Math.max(0.5, Math.min(4.0, ...))`（642/649/656）、スライダーも `max="400"`（index.html:95）で **scale ≤ 4.0 に上限**。fit-page/fit-width はコンテナサイズ由来で有界。DPR 乗算も無し。
- 典型ページ（A4 相当）×4.0 は Chrome の canvas 上限（辺 ~16384px / 面積 ~268MP）内に収まる。上限超過は**極端に大きな PDF（ポスター等）×最大ズーム**という稀条件でのみ理論上起こり得る。
- **由来の区別**: git diff 上、`canvas.width/height` 行とズーム上限ロジックは**今回の追加差分ではなく既存コード**。ハイライト機能で新規導入されていない。

**結論: 上限未設定は事実だが既存挙動・低頻度。本件の退行ではない。Regression ではない。**

## 主張4: 選択→矩形が行単位になる / span-item 対応崩れ — 判定【誤認】深刻度: なし

- `selectionRects`（392-446）は `pageTextItems` を走査し、**選択範囲 [ms,me) に重なる項目のみ** rect を push（434-444）。行単位ではなく項目単位。段落全体にはならない（段落全体化は CSS absolute 化で解消済＝本対象外）。
- 対応の要である `pageTextSpans`（collectTextSpans, 260-265）と `pageTextItems`（buildItemMap, 270-286）の長さ一致を TextLayer ソースで検証:
  - TextLayer は**全テキスト項目**に span を作るが、`i.hasText`（= `""!==t.str`）のときだけ container に append。→ **空 str 項目の span は DOM に接続されない**。
  - `collectTextSpans` は `span[role="presentation"]` から `!!s.textContent`（非空）のみ残す → 空項目 span は除外。
  - `buildItemMap` も `!item.str` を除外。**両者とも「非空項目のみ・同一順」で一致**。
  - 混入し得る `<br role="presentation">`（hasEOL）は BR 要素でセレクタ `span` に非該当。markedContent ラッパ span は `role=presentation` 非付与で非該当。→ 余計な span は入らない。
- 仮に長さがずれても `selectionOrigin`（452）が `pageTextSpans.length !== pageTextItems.length` で `-1` を返し、`indexOf` フォールバック（409）へ安全降格。クラッシュや矩形破綻は起きない。

**結論: 対応は構築論理的に成立し、矩形は選択項目のみ。誤認。**

---

## 総合判定
4 主張のうち **Critical/High に相当する実在バグは 0 件**。
- 主張1（ReferenceError）: 誤認（呼び出し順序上 TDZ に触れない）
- 主張2（render 競合）: 誤認（ガード十分）
- 主張3（canvas 上限）: 軽微な実在だが**既存挙動**・Low・本件の退行ではない
- 主張4（行単位矩形）: 誤認（項目単位・対応一致）

## 見ていない範囲（未確認）
- ブラウザ実行時の実際の選択矩形・TextLayer レンダリング結果は**静的到達のみ**（ヘッドレス E2E 未実施）。
- `getTextContent()` と `streamTextContent()` の非空項目列が全 PDF で完全一致する前提は、コードコメント（234-235）と TextLayer 実装からの推論。**特殊 PDF（marked content 境界等）での一致は未実測**。仮に不一致でも -1 降格で安全側に倒れることは確認済み。
- 他レンダラ（epub/text/fb2）との整合は本検証対象外。
