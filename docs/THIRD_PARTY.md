# 同梱するサードパーティ

Enterprise Misen の配布物に同梱する外部コンポーネントと、その固定方法です。実行時にパッケージ取得や外部 URL の照会は行いません。取得は管理者の準備工程（`scripts/Prepare-Misen.ps1` または `scripts/Publish-Release.ps1`）だけで行い、契約ファイルの SHA-256 と一致したものだけを同梱します。

| コンポーネント | 版 | ライセンス | 固定方法 | 用途 |
| --- | --- | --- | --- | --- |
| Node.js（Windows x64） | 24.20.0 | MIT | `apps/enterprise-misen/scripts/node-runtime-contract.mjs` の公式配布物・実行ファイル・LICENSE の SHA-256 | 同梱ランタイム。利用者 PC への Node.js インストールは不要 |
| OfficeCLI（Windows x64） | 1.0.147 | Apache-2.0 | `apps/enterprise-misen/scripts/officecli-runtime-contract.mjs` の公式リリース資産・LICENSE・NOTICE の SHA-256 | Excel / Word / PowerPoint の OpenXML 編集。Office 本体は不要 |
| pdfjs-dist（PDF.js） | 6.3.289 | Apache-2.0 | `package-lock.json` に固定。純 JS ＋ 画像デコーダーの WebAssembly（jbig2 / openjpeg / qcms）。optional の `@napi-rs/canvas` は `--omit=optional` で同梱しない | `pdf_read`（テキスト・構造・metadata の読み取り）。描画には使わない |
| @hyzyla/pdfium（PDFium の WebAssembly ビルド） | 2.1.13 | MIT（PDFium 本体は BSD-3-Clause） | `package-lock.json` に固定。`dist/pdfium.wasm` を同梱 | `pdf_render`（指定 1 ページの PNG 化） |
| pdf-lib | 1.17.1 | MIT | `package-lock.json` に固定。純 JS | `pdf_create_output`（複製・結合・ページ抽出） |
| npm の実行時依存 | `apps/enterprise-misen/package-lock.json` | 各パッケージの記載どおり | `npm ci --ignore-scripts` と `npm run sbom`（CycloneDX） | Pi Agent、assistant-ui、OpenAI / Anthropic の SDK など |

配布物に含められる WebAssembly は `apps/enterprise-misen/scripts/wasm-runtime-contract.mjs` に列挙した 2 パッケージのフォルダーだけで、`.node` / `.dll` は引き続き 1 つも含めません。OCR エンジン、Java / PDFBox、LiteParse（ネイティブアドオン）は同梱しません。

SBOM は `apps/enterprise-misen` で `npm run sbom` を実行すると生成されます。同梱物の一覧と SHA-256 は配布物の `_misen\manifest.json` と `launcher\prepared-runtime\SHA256SUMS.txt` に記録されます。

2026 年 8 月の coding-agent と連結デモが同梱していたもの（iconv-lite、jsonrepair、OpenCode など）は、それらをリポジトリから外した時点で対象外になりました。記録はタグ `archive/coding-agent-be614a6` の `docs/THIRD_PARTY.md` にあります。
