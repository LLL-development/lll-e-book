# 受け入れ検証レポート: .cbr（RAR圧縮コミック）閲覧対応（2026-11-27）

担当: acceptance / 対象: LLL-E-Book CBR(RAR) 閲覧対応（node-unrar-js vendored wasm）
スタンス: 敵対的・反スタブ。既定「未達」から証拠で達成を確認。
規約参照: `.company/acceptance/CLAUDE.md` は本リポジトリに未配置（`reports/` のみ存在）。部署規約・テンプレートは `~/.config/opencode/company-template/acceptance/` の慣習に準拠した。

## 結論（サマリ）
- **偽実装ではない**。comic.js の RAR 経路は vendored extractor を実際に呼び、画像バイトを取り出している。モック・空返却・TODO は不在。wasm は本物（magic `00 61 73 4d` = `\0asm`、207,593 B）で、`unrar.file.js`/`unrar.mjs` に base64 インライン化されたバイトは `unrar.wasm` と**全バイト一致**（実測 True）。
- **extractor が本物である実行証拠**: node で `unrar.mjs` をロードし、RAR マジック付きのゴミデータを通すと `UnrarError(reason: ERAR_BAD_DATA, "Archive header or data are damaged")` が実 throw した。スタブなら throw しない。
- **メモリリーク規約は満たす**。`[...list.fileHeaders]`（comic.js:340）と `[...extracted.files]`（同347）で lazy イテレータを全走査し、加えて `extractor.delete()`（同353）を明示呼び。部分走査によるリークなし。
- **依存証跡（unrar 分）は完全一致**。UPSTREAM.json の unrar エントリ 11 ファイル、sha256 すべて実測一致。ライセンス 2 種（MIT + rarlab UnRAR freeware 全文、段落2 inclusion 条件充足）同梱済み。
- **ただし受け入れ基準4は形式的に未達**: `node --test tests/dependencies.test.mjs` は **FAIL**。不一致は `pdfjs/LICENSE` 1 件で**本案件変更外**（git stash で HEAD のみでも同 FAIL を実測＝既存の破損）。unrar 起因ではないが「テストが通ること」を要求する受け入れゲートは通っていない。
- **CBR でページめくりレイアウトが CBZ と同一にならない疑い（High）**: `app.js:107` の `isPaged` が `pdf`/`cbz` のみで `cbr` を含まない。CBZ だけ `reader-paged` class が付き、CBR は付かない。仕様1「既存 CBZ と同じ閲覧体験」に反する可能性。
- **実ブラウザ E2E（file://・http で .cbr を実際に開く）は未実施**。ボリューム分割/パスワード保護の実アーカイブ検証も未実施（RAR 生成ツール不在、手組み RAR は ERAR_EREAD/BAD_DATA で通せず）。

## 実行コマンドと結果
- `node --test tests/dependencies.test.mjs` → **fail 1 / pass 1**。`not ok 2 - vendored runtime files match the recorded official distribution hashes`、不一致は `pdfjs/LICENSE`（expected `0d542e0c…` / actual `eb3d7b54…`）。
- `git stash push -- index.html js vendor/UPSTREAM.json` 後に再実行 → **同様に fail 1**（＝pdfjs/LICENSE 破損は本案件変更前から存在）。`git stash pop` で復帰済み。
- `node --test tests/cdn-integrity.test.mjs` → **pass 1 / fail 0**。
- unrar エントリ sha256 を全11ファイル実測照合 → **全 OK**（LICENSE.md / LICENSE_UNRAR.txt / index.esm.js / unrar.js / unrar.singleton.js / Extractor.js / ExtractorData.js / ExtractorData.helper.js / unrar.wasm / unrar.file.js / unrar.mjs）。
- `vendor/unrar/unrar.wasm` magic 実測: `00 61 73 4d`（= `\0asm`、本物 wasm）、207,593 B。
- `unrar.file.js` L2803 の `unrar_default2` base64 をデコード → 207,593 B、magic `00 61 73 4d`、**unrar.wasm と全バイト一致**（inlined == unrar.wasm: True）。`unrar.mjs` も同様に `wasmBinary.byteLength: 207593` を node 実測。
- `node --check` 構文: unrar-library.js / comic.js / app.js / file-loader.js / i18n.js / unrar.mjs すべて OK。
- extractor 動作実測（node）: `unrar.mjs` を import、`atob/btoa` polyfill 下で RAR マジック付きゴミを `createExtractorFromData` → `UnrarError reason: ERAR_BAD_DATA` を実 throw。
- i18n: `reader.cbr_lib_missing / cbr_not_rar / cbr_volume_unsupported / cbr_password / cbr_password_prompt` が各 **6言語**に存在（実測 count）。

## 反スタブ判定の根拠
- **extractor 実呼び出し**: `renderCbr`（comic.js:326-421）は `window.loadUnrar()` → `lib.createExtractorFromData({data, password})`（333）→ `extractor.getFileList()`（337）→ `extractor.extract()`（345）→ `entry.extraction` を `images[header.name]` に格納（351）。ローダー（395-401）は `new Blob([page.bytes])` で実バイトから objectURL を生成。常に空を返す経路なし。
- **エラー分岐が本物**: `RAR_ERROR_REASONS`（276-281）で `ERAR_MISSING_PASSWORD/BAD_PASSWORD → rar-password`、`ERAR_EREAD/EREFERENCE → rar-volume-unsupported`、他 `rar-invalid`。app.js:1310-1313 で i18n メッセージに接続。ゴミ RAR で `ERAR_BAD_DATA → rar-invalid` になることを実測。
- **空実装/TODO/モック**: 対象ファイル内に未検出。

## 仕様項目別の到達確認
1. **閲覧体験（ページめくり/ズーム/TOC/カバー）**: 概ね到達。`imageSession` 共通（402）、`session.format='cbr'`（403）、カバーは `buildCover(new Blob([first.bytes]))`（414）。ズームは app.js:681/1523 で cbr 追加済み。**ただし `isPaged`（app.js:107）に cbr 漏れ → ページめくりレイアウト class 非適用の疑い（High 参照）**。
2. **file:// / http 両対応**: 到達。`unrar-library.js` は `location.protocol === 'file:'` で classic script（`unrar.file.js`、wasmBinary インライン）、それ以外で dynamic import（`unrar.mjs`）。`pdf-library.js`（file: 分岐 L26 / dynamic import L35）と同型。wasm fetch 非依存（`createExtractorFromData({data, wasmBinary})`）。
3. **既存フォーマット非破壊**: 到達。`renderCbz` は `buildCover` の引数形変更（zip,entry → 先頭 Blob）のみでロジック維持（247-257）。`render()` は RAR マジック判定後に CBZ へフォールバック（439-443）。file-loader.js は `cbr` 追加のみ。app.js 既存分岐は cbr 追加のみで既存値不変。
4. **依存証跡体制**: unrar 分は完全一致（実測）。ライセンス 2 種同梱・条文 inclusion 条件充足。**しかし `dependencies.test.mjs` 自体は pdfjs/LICENSE 不一致で FAIL**（本案件外要因。High 参照）。
5. **ボリューム分割/パスワード/不正 RAR の説明付きエラー**: 実装は到達（276-285, 372-381, app.js:1310-1313）。ゴミ RAR → `rar-invalid` は実測。パスワードプロンプト（298-324）・ボリューム分岐はコード上是達だが**実アーカイブでの E2E 未実施**。

## 指摘（重大度別）

### High
- **H1: dependencies テストが FAIL（受け入れ基準4の直接違反）**
  - 場所: `C:\Users\user\lll-e-book\vendor\UPSTREAM.json`（pdfjs/LICENSE エントリ）／ `vendor\pdfjs\LICENSE`（10,351 B、実測 sha256 `eb3d7b54…`）
  - 何が起きるか: `node --test tests/dependencies.test.mjs` が fail。受け入れ基準4「テストが通ること」を満たさない。
  - 再現条件: 作業ディレクトリで当該テスト実行。git stash で本案件変更を外しても同 FAIL（＝既存破損、本案件起因ではない）。
  - 修正案: pdfjs/LICENSE の UPSTREAM.json 記録ハッシュを実ファイル（`eb3d7b54…`）に更新するか、pdfjs LICENSE を公式配布物へ復元。**本案件 CBR 実装の合否とは分離して扱うこと**（unrar 分は全一致）。
- **H2: CBR でページめくりレイアウト class が適用されない疑い**
  - 場所: `C:\Users\user\lll-e-book\js\app.js:107` `const isPaged = fmt && (fmt.key === 'pdf' || fmt.key === 'cbz');`
  - 何が起きるか: CBZ では `reader-paged` class が付与されるが CBR は付かない。ズーム（681/1523）は cbr 対応済みなのにレイアウト分岐だけ漏れており、「CBZ と同じ閲覧体験」（仕様1）に差が出る。
  - 再現条件: .cbr を開き `#reader-view` の class を確認（CBZ と比較）。
  - 修正案: `isPaged` に `|| fmt.key === 'cbr'` を追加。

### Medium
- **M1: 実ブラウザ E2E 未実施**: file://・http で実際に .cbr をドロップし、ページ表示/ズーム/TOC/カバー/ページめくりが CBZ と同一に動くかは未確認。静的到達のみ。
- **M2: ボリューム分割・パスワード保護の実アーカイブ検証なし**: RAR 生成ツールが環境に無く（`rar/unrar/7z` 不在）、手組み RAR4/RAR5 は ERAR_EREAD/BAD_DATA で展開不可。エラー分岐はコード上・ゴミデータ throw で妥当性確認したが、該当実ファイルでの経路は未踏。

### Low
- **L1: ブリッジ生成スクリプトは esbuild 実行環境に非依存で再生成不可**: `scripts/build-unrar-bridge.mjs:24` が `esbuild` を import するが `node_modules` に esbuild 無し（実測 False）。生成物（unrar.file.js/unrar.mjs）はコミット済みで実行時影響なし。コメント L4 に `npm i --no-save esbuild@0.28.2` の手順あり。

## 見ていない範囲
- 実ブラウザ（file:// / http）での .cbr 開封 E2E、および CBZ/EPUB/PDF/FB2/text のデグレ実走（ブラウザ実行環境なし）。
- ボリューム分割・パスワード保護の実 RAR アーカイブでの挙動（生成ツール不在）。
- `vendor/unrar/` の各 JS が npm 公式 tarball のバイトと一致するか（UPSTREAM.json の sha256 は実ファイルと一致するが、tarball 由来かは tarball を取得して突き合わせていない）。
- `unrar.wasm` が rarlab 公式 unrarsrc-6.1.7 ビルドか（wasm 内部文字列は圧縮/難読化で `Rar!`/`ERAR_` 等が平文検索で見つからず、ビルド由来は UPSTREAM.json notes の自己申告に依存）。
- pdfjs/LICENSE 破損の根本原因（本案件外のため深追いせず、HEAD 時点 FAIL のみ確認）。
