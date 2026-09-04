# Misen

広島・宮島の弥山（みせん）に由来する、社内向け AI エージェントプロジェクトです。

| アプリ | 役割 | 利用者の入口 |
| --- | --- | --- |
| Enterprise Misen（`apps/enterprise-misen`） | Excel / Word / PowerPoint を扱う財務本部向けエージェント。同梱 Node.js と OfficeCLI で動く自己完結ランタイム | 共有フォルダーの **`Misen起動.cmd`** |

2026 年 8 月の実験（coding-agent、Computer Use の試作、連結デモ）はリポジトリから外しました。必要になったらタグ `archive/coding-agent-be614a6` から取り出せます。

## 設計の要点

全体設計（第7版）は Issue #84 のコメントと、各 Issue の「第7版」コメントを正とします。要点は次のとおりです。

- **実行場所は利用者の PC。** サーバーは建てません。共有フォルダーの `Misen起動.cmd` がハッシュ検証つきでローカルに同期し、ローカルで起動します。
- **ファイルは PC から出ません。** 作業フォルダーの Office ファイルを OfficeCLI で編集し、成果物も同じ場所の `output\` に出ます。外へ出る通信は LLM への推論要求だけです。
- **コード実行は持ちません。** Python やシェル、ブラウザー操作は提供しません。一方で Office ファイルへの操作は OfficeCLI の動詞（get / query / set / add / remove / move / swap / batch / validate / import）と要素モデルをそのまま Tool にし、危険な動詞・要素・プロパティだけを拒否リストで塞ぎます。境界は操作の種類ではなく、書き込み先が `output\` 内であること、数式の拒否リスト、外部参照の禁止、送信系の不在で守ります（第9版）。
- **利用者体験は Microsoft Copilot Cowork に合わせます。** 計画の提示、チェックポイントでの承認、Skills の形式、モデルの自動選択、監査の語彙を同じ形で作ります（Issue #98 〜 #107）。
- **監査は各 PC に追記専用で置き、善意を前提にします。** 共有フォルダーは財務本部が管理し、読める人は全員書き込めるため、ハッシュ検証は改ざん防止ではなく事故防止です。

## リポジトリ構成

```text
launcher\                利用者用（共有フォルダーへそのまま公開されるファイル）
  Misen起動.cmd            Enterprise Misen の唯一の起動入口
  launch.ps1               起動スクリプト本体（manifest 比較・SHA-256 検証・ローカル版の起動）
  test\launch.test.mjs     初回起動・2回目起動・版更新後の起動・改ざん検出の自動テスト
  create-shortcut.ps1      ショートカット作成の補助
scripts\                 管理者用
  Publish-Release.ps1                                      配布物を生成して GitHub Release に添付（推奨）
  Expand-MisenShare.ps1                                    社内 PC で Release の zip を検証して共有フォルダーへ展開
  prepare-misen.cmd / Prepare-Misen.ps1 / New-Misen.ps1    共有フォルダーへ直接公開（開発 PC が社内ネットワークにある場合）
  get-llama.ps1 / start-llama.cmd                          開発用のローカル LLM（OpenAI 互換 API）
.github\workflows\release-share.yml   GitHub Actions で同じ Release を作る予備（手動実行専用）
apps\enterprise-misen\   Enterprise Misen 本体
docs\                    補足資料
```

## 配布（管理者）

開発 PC のファイルを社内へ直接持ち込めないため、配布は GitHub Release 経由です。詳しい手順は `DEPLOY.md` を参照してください。

1. 開発 PC で、コミット済みの main から Release を作ります。

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Publish-Release.ps1 -NodeRuntime <検証済み Node 入力> -OfficeCliRuntime <検証済み OfficeCLI 入力>
```

2. 社内 PC で Release から zip・`.sha256.txt`・`Expand-MisenShare.ps1` をダウンロードし、共有フォルダーへ展開します。git も Node.js も管理者権限も要りません。

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -File .\Expand-MisenShare.ps1 -Zip .\misen-share-<version>-<sha>.zip -Destination "\\fileserver\財務\Misen"
```

## Enterprise Misen の起動（利用者）

共有フォルダーの `Misen起動.cmd` をダブルクリックするだけです。共有フォルダーの最上位に見えるのはこのファイルだけで、配布物は隠し属性の `_misen\versions\<version>\` 配下にあります。

```text
\\fileserver\...\Misen\
  Misen起動.cmd            ← 利用者が触るのはこれだけ
  _misen\                  ← 隠し属性
    manifest.json          ← current・公開ID・zip/展開後ファイルの SHA-256
    publish-log.txt        ← 公開直後の再検証結果
    versions\<version>\    ← launcher\ と misen-<version>.zip（前の版を 1 つ残す）
```

1. 共有側 `_misen\manifest.json` の `current`（有効な版）・公開IDを `%LOCALAPPDATA%\Misen\current.json` と比較する
2. 初回、または版数か公開IDが違うときだけ `misen-<version>.zip` 1 ファイルをローカルへコピーし、zip の SHA-256 を確認してから `app\` `runtime\` `workspace\` を展開する。manifest に記載された展開後の全ファイルも検証してから `current` を切り替える（検証に失敗すると前回正常版に戻して停止）
3. 検証済みローカル版の同梱 Node.js でサーバーを起動し、ブラウザーで `http://127.0.0.1:8787/` を開く

作業フォルダーの既定は `%LOCALAPPDATA%\Misen\workspace` で、初回に共有側の雛形 `workspace\` からコピーされます。共有フォルダー上の業務ファイルを使うときは、手元にコピーしたフォルダーを `Misen起動.cmd` へドラッグ＆ドロップしてください。書き込みは `%LOCALAPPDATA%\Misen` 配下と作業フォルダーだけで、共有フォルダーには書きません。

失敗時は日本語のメッセージを表示して停止します。直近の配布状態は `%LOCALAPPDATA%\Misen\state\launch.json` に記録されます（秘密情報は含みません）。

## LLM 接続設定（利用者ごと）

Enterprise Misen が接続する LLM（プロバイダー種別・モデル名・API キー・OpenAI 互換の base URL）は、利用者ごとの次のファイルで決まります。共有フォルダーや配布物には含まれません。

```text
%LOCALAPPDATA%\Misen\config\settings.json
```

初回の `Misen起動.cmd` で、このファイルが無ければ日本語コメント付きのテンプレートを作成してメモ帳で開き、起動を止めます。記入して保存し、もう一度ダブルクリックしてください。社内 GPU の OpenAI 互換 API なら `provider` を `openai-compatible` にして `baseUrl` を書きます。設定項目と検証規則は `apps/enterprise-misen/docs/brain-profile.md` を参照してください。API キーはログ・manifest・共有フォルダー・画面には出ません。

## テスト

回帰テストは 3 層に分かれています（Issue #93）。既定の `npm test` は unit 層だけを実行し、30 秒以内に終わります。`apps/enterprise-misen` で実行します。

| 層 | コマンド | 必要なもの |
| --- | --- | --- |
| unit | `npm test`（`node scripts/test.mjs unit`） | なし（ネットワーク・OfficeCLI・ブラウザーを使わない） |
| integration | `npm run test:integration`（`*.integration.test.ts`、OfficeCLI 実行） | `MISEN_OFFICECLI_PATH` |
| live | `npm run test:live` | 実プロバイダーの資格情報。手動実行のみ |

ビルドは変更検知付きです。ソースが前回ビルドから変わっていなければ typecheck とビルドを飛ばします（`dist/.build-stamp.json`）。強制ビルドは `npm run build:force` です。

起動入口のテストはリポジトリ直下で次を実行します（Windows のみ。一時フォルダーを共有フォルダーに見立て、初回起動・2回目起動・版更新後の起動・改ざん検出を確認します）。

```bash
node --test launcher/test/launch.test.mjs
```

## 進行中の Issue

| Issue | 内容 |
| --- | --- |
| #98 | 境界インターフェースの抽出（Executor / Store / Audit sink / Auth）とゲートウェイの一本道 |
| #99 | OfficeCLI 契約と数式セル書き直し規則 |
| #100 | ポリシー判定の規則、チェックポイントの動詞分類、監査イベント形式 |
| #105 | 計画表示・チェックポイント UI・スタイル付き assistant-ui |
| #104 | Skills / プラグインの Cowork 形式 |
| #122 | Tool を OfficeCLI の動詞と要素モデルにそろえる（危険な動詞・要素・プロパティだけを拒否リストで塞ぐ） |
| #107 | モデル自動選択と複数 brain profile |
| #106 | 定時タスク（後段） |
| #84 | 財務本部の方向性と全体設計の記録 |

推奨順は #98 → #99 → #122 → #100 → #105 → #104 → #107 → #106 です。
