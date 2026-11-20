# 受け入れ検証レポート: モバイル用「ページめくりボトムバー」

日付: 2026-11-19 / 担当: acceptance
対象: index.html L133-141, js/app.js L1072-1076, css/style.css L1160-1165 / L1205-1264

## 前提
- `.company/acceptance/CLAUDE.md` は本プロジェクトに存在しない（`.company\acceptance` は空、reports も自前作成）。部署規約・テンプレートは未参照。以下は依頼文の受け入れ基準に直接沿って検証した結果。
- 検証はコード読解 + `node --check` + 機械的整合チェック。**ブラウザ実機での描画/タップ検証は未実施**（下記「未確認」参照）。

## 判定サマリ
1 配線: PASS / 2 モバイル限定: PASS / 3 下部配置: PASS / 4 コンテンツ回避: PASS(注) / 5 非デグレ: PASS / 6 構文: PASS
スタブ・モック・TODO・空実装は該当なし。全体: 合格（Low 1件 + 未確認あり）。

## 各基準の根拠
### 1. 下部バーの実在と配線 — PASS
- index.html L134 `<nav id="mobile-nav" class="mobile-nav">`、L135 `#prev-btn-bottom`、L138 `#next-btn-bottom` が実在。
- app.js L1073-1076: `const prevBtnBottom = $('#prev-btn-bottom'); ... if (prevBtnBottom) prevBtnBottom.addEventListener('click', function () { step(-1); });`（next も同型）。既存共通関数 `step(dir)`(L351-367) を呼ぶだけで、ページめくりロジックの再実装なし。null ガード(`if (prevBtnBottom)`)あり。

### 2. モバイル限定表示 — PASS
- style.css L1163-1165 `.mobile-nav { display: none; }`（デフォルト非表示）。
- `display:flex` は L1206-1223 の `@media (max-width: 640px)` 内のみ。`.mobile-nav` ルールは全ファイルで2箇所(grep)のみで、メディアクエリ外に flex 化の宣言なし。デスクトップ(>640px)は完全非表示。

### 3. 下部配置 — PASS
- L1208 `position: fixed;` / L1211 `bottom: 0;` / L1216 `padding-bottom: calc(8px + env(safe-area-inset-bottom));`
- タップ目標 L1229-1232 `width:64px; min-width:44px; height:48px; min-height:44px;`（>=44px角）。
- 色は全てテーマ変数: L1217 `var(--surface)` / L1218 `var(--line)` / L1235 `var(--surface-2)` / L1236 `var(--text)` / L1242-1244 `--accent-soft/--accent/--accent-strong`。ハードコード色なし（実在は :root L16/17/21/26/36 等で確認）。
- z-index: L1222 `z-index: 20;`。ヘッダー app-header=10(L246)、reader header=5(L579) より上、drop-overlay=90(L977)、reader-toast=100(L933) より下。要件どおり。

### 4. コンテンツ回避 — PASS（注: 実機未確認）
- L1258-1260 `.reader-content { padding-bottom: calc(64px + env(safe-area-inset-bottom)); }`、L1262-1264 `#reader-view.reader-paged .reader-content { ... }`。
- 後方宣言で優先される: 同メディアクエリ内の L1193 `.reader-content{padding:22px 20px}` / L1199 `#reader-view.reader-paged .reader-content{padding:4px}` より後ろ(L1258/1262)にあり、同一特異性なので後勝ちで padding-bottom が上書きされる。
- 注: バー実高は約70px(ボタン48+padding8+safe-area)、padding-bottom は64px+safe-area で約6px不足の恐れ（Low）。

### 5. 非デグレ — PASS
- 上部 prev/next 維持: index.html L51/L54、app.js L1070-1071 `step(-1)/step(1)`。キーボード app.js L1021-1022 `ArrowRight/ArrowLeft`。ページジャンプ CSS(L1201-1203)は追加ブロック外で無変更。
- `step()`(L351-367) は既存のまま（下部バーから同一関数を呼ぶのみ）。
- アコーディオン initAccordion(L1084)、TOC/検索/ブックマークの id(toc-panel/search-body/bookmark-body 等 L100-128) に追加ブロックは触れていない。
- id 一意性: `mobile-nav`/`prev-btn-bottom`/`next-btn-bottom` は grep で各1件のみ、衝突なし。

### 6. 構文 — PASS
- `node --check C:\Users\user\lll-e-book\js\app.js` → 出力なし（正常）。
- CSS ブレース `{`=195 / `}`=195 で一致。HTML `<nav>`1/1, `<button>`20/20, `<svg>`11/11 で対応。

## 未確認 / 軽微指摘
- [Low] style.css L1259/L1263 の `padding-bottom: calc(64px + env(safe-area-inset-bottom))` は、バー実高（ボタン48px + 上下padding8px + safe-area ≒ 70px+safe-area）より約6px小さい。最終行がわずかにバーに近接/重なる可能性。修正案: `calc(72px + env(safe-area-inset-bottom))` 等へ引き上げ、実機で最終行の可視性を確認。
- [未確認] ブラウザ実機での描画・タップ（fixed 固定、safe-area 効き、最終行非重なり、640px 境界）は未実施。コード上の静的判定のみ。
- [参考] i18n は `data-i18n`/`-title`/`-placeholder` のみ処理(js/i18n.js L394-404)。下部バーの `aria-label`(L135/L138) は英語固定のまま（上部 prev/next も同様に英語固定で既存挙動と一貫、デグレではない）。
- 見ていない範囲: js/app.js 全体・他ワーカーの未コミット変更・実データ/E2E。依頼どおり追加ブロックと既存機能との干渉に限定。
