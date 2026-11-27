# Recon: wasm 版 unrar（.cbr 対応）を vendor 同梱できるか

日付: 2026-11-27 / 担当: recon（読み取り専用。コード変更なし）
対象: C:\Users\user\lll-e-book

## 注意（部署規約）
本プロジェクトの .company\ には acceptance\reports のみ存在し、.company\recon\CLAUDE.md と .company\CLAUDE.md は存在しなかった（Test-Path で確認）。よって部署規約・テンプレートは未参照のまま、汎用手順で報告する。

## 結論
vendor 同梱方針は体制に適合する。pdf.js が既に「UPSTREAM.json に per-file sha256 を登録した .wasm を vendor からロードする」前例そのもの。CDN+SRI は wasm には使えない（SRI は <script> タグのみ）。

## 1. pdf.js の wasm ロード実装（引用）
- js\pdf-library.js:4 `const base = new URL('../vendor/pdfjs/', document.currentScript.src);`
- js\pdf-library.js:11 `wasmUrl: new URL('wasm/', base).href,`（cMapUrl:8 / standardFontDataUrl:10 / iccUrl:12 も同型）
- js\pdf-library.js:26-33 file:// では ESM/module worker が使えないため、esbuild で生成した IIFE ブリッジ pdf.file.js + pdf.worker.file.js をクラシック script で順に読み、`workerSrc` を pdf.worker.file.js へ差し替える。
- js\renderers\pdf.js:75 `window.pdfjsLib.getDocument({ ...window.pdfjsDocumentOptions, data: reader.result, ... })` — wasmUrl はここに渡される。
- vendor\pdfjs\pdf.worker.min.mjs（minify 済み、行は 25/28 付近）:
  - `setOptions({handler:e,useWasm:t,useWorkerFetch:a,wasmUrl:n}){...WasmImage.#R=n...}`
  - `class JpxImage extends WasmImage{_filename="openjpeg.wasm";_noWasmFilename="openjpeg_nowasm_fallback.js";...}`（jbig2 / qcms_bg も同型）
  - wasm 取得は `fetchBinaryData(`${WasmImage.#R}${this._filename}`)` または worker 経由 `sendWithPromise("FetchBinaryData",{kind:"wasmUrl",filename})` → `WebAssembly.instantiate`。qcms は `fetchSync(`${this.#R}qcms_bg.wasm`)`（同期 XHR）。
- file:// ブリッジでも wasmUrl は健在: vendor\pdfjs\pdf.worker.file.js 内に `_filename="openjpeg.wasm"`（オフセット 275252）が残存し、先頭 1 行目 `var __pdfjsWorkerBridgeSource = document.currentScript.src;` が import.meta.url を置換（scripts\build-pdf-file-bridge.mjs:8 の define/banner）。
- 実運用が file:// でも wasm を fetch できているかは**未確認**（ブラウザ実機テストは未実施）。UPSTREAM.json:843 の generatedFileCompatibility purpose に「file:// cannot import ESM or module workers... preserving local-file use」とあり、ローカル利用を維持する設計であることは確認できる。

## 2. vendor 同梱手順（既存パターンの要求）
- vendor\UPSTREAM.json: packages[] に name/version/upstream/license/tarball/integrity(sha512)/gitHead を登録し、**同梱する全ファイル**を files[] に {path, sha256} で列挙（例: pdfjs/wasm/openjpeg.wasm = 809-811 行）。生成物は generated: true（830-837）。
- tests\dependencies.test.mjs:9-15 が manifest.packages[].files[] を全走査し `vendor/<path>` の sha256 を照合。manifest に無いファイルは検査されないし、manifest に有って実ファイルが無いと落ちる。**新 wasm は必ず files[] に登録が必要**。
- ライセンス証跡: vendor 依存はライセンス本体を vendor 内同梱（pdfjs\LICENSE、vendor\pdfjs\wasm\LICENSE_JBIG2 等）。tests\licenses\ は CDN 依存用（jszip-LICENSE / epubjs-LICENSE の 2 件のみ）。tests\CDN-PROVENANCE.json が対応する。tests\SECURITY.md:1「Original upstream licenses are retained beside the runtime files.」
- tests\SECURITY.md:1 に「rerun dependency policy and real browser rendering/conversion tests」（UPSTREAM.json:2 にも同文）。

## 3. CDN vs vendor 判定
- tests\cdn-integrity.test.mjs:6-8 は `https://` の外部 <script src> に対して integrity=sha512 と crossorigin=anonymous を強制。**wasm は script タグで読めないので SRI 適用外**。wasm を CDN から fetch する構成は証跡機構（CDN-PROVENANCE.json）も CI も無い。
- 既存パターン（pdf.js の wasm を vendor + UPSTREAM.json sha256 で同梱）と整合するのは **vendor 同梱方式**。JS 側も vendor 化すれば dependencies.test.mjs の網羅下に置ける。
- node-unrar-js は wasm バイナリ + JS ラッパーの 2 成果物。両方 vendor に置き、UPSTREAM.json に登録するのが既存様式。file:// で ESM が読めない問題は pdf.js と同じ IIFE ブリッジ（esbuild、UPSTREAM.json:839-844 の generatedFileCompatibility の前例）で解決可能。

## 4. CI/デプロイ検証
- .github\workflows\deploy.yml: checkout → cloudflare/wrangler-action でリポジトリ直下 `.` をデプロイするのみ。**ハッシュ検証もテスト実行も無い**。wasm の存在確認も無い（ディレクトリごとコピーするので同梱ファイルはそのまま配信される）。
- .github\workflows\pr-drift-check.yml: 外部ゲートウェイ（https://gh.live-laugh-love.tech/pr-review）へ PR 情報を POST するだけで、失敗しても `|| echo ... non-blocking`（32 行）。**wasm の存在・ハッシュを CI で検証する仕組みは無い**。
- tests\dependencies.test.mjs はローカル実行（node --test）が前提と読めるが、それを回すワークフローは deploy.yml / pr-drift-check.yml には見当たらなかった。**テストを自動実行する別 CI の有無は未確認**（.github\workflows 配下はこの 2 ファイルのみ）。
- 備考: リポジトリ直下に deploy.yml / pr-drift-check.yml のコピーがある（.github 外）。内容の同一性は未確認。

## 5. 手順の骨子（適合する場合）
1. node-unrar-js の公式固定リリース（npm tarball）を選び、sha512 integrity と gitHead を記録。
2. vendor\unrar\ に JS ラッパーと .wasm と LICENSE を同梱。
3. UPSTREAM.json の packages[] にエントリ追加、files[] に同梱全ファイルの sha256 を登録。
4. file:// で動かすなら esbuild で IIFE ブリッジを生成し、generated: true と generatedFileCompatibility 相当の記録を追加（pdf.js の様式に倣う）。
5. node --test tests/dependencies.test.mjs でハッシュ照合、実ブラウザ（http と file://）で .cbr 展開の実機確認。
6. js\file-loader.js の FORMATS に cbr を追加し、index.html:31 の accept 属性に .cbr を追加（変更ポイント候補）。

## 変更ポイント候補
- vendor\UPSTREAM.json（新 package エントリ）
- vendor\unrar\（新規ディレクトリ）
- js\pdf-library.js と同型のローダ（js\unrar-library.js 新設が自然）
- js\file-loader.js:12-19 FORMATS、index.html:31 accept、index.html:204 付近に script 追加
- js\renderers\comic.js の CBZ 展開を JSZip 依存と同様に、CBR は unrar へ分岐

## リスク
- file:// での WebAssembly fetch/instantiate が実際に通るか未検証（pdf.js で同経路だが実機確認は本調査では未実施）。
- node-unrar-js のライセンス（unrar 本体は freeware ライセンス節に注意）と、このプロジェクトの「official fixed release + license 同梱」ポリシー適合性は未調査（tech-lead の deep-research 送り推奨）。
- wasm ファイルサイズの増分（unrar wasm は数十〜数百 KB 程度の見積もり、未確認）。

## 未確認事項
- file:// 環境で pdf.js の wasm が実際にロードできているか（実機未実施）
- dependencies.test.mjs を自動実行する CI の有無
- node-unrar-js / libarchive.js のライセンス・保守状況・wasm の ESM/CJS 形態
- リポジトリ直下の deploy.yml / pr-drift-check.yml と .github 版の差分
