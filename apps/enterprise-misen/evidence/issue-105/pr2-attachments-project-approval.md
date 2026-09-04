# Issue #105 / #125 PR 2 受け入れ記録

## 変更前後

- 変更前（PR 1 完了時、依頼「8月の月次管理レポートを作成してください。」）: `pr1-registry-after.png`
- 変更後（同じ依頼）: `pr2-after.png`
- 変更後は、公式コンポーザーの添付ボタンと説明文、その下に「プロジェクト」「承認」、右端に情報アイコンを配置した。

## 削るもの

- [x] モデル選択なし
- [x] 設定画面なし
- [x] 生の推論・プロバイダー表示なし（接続先の provider / model は情報欄だけ）
- [x] 分岐なし
- [x] メッセージ編集なし
- [x] 再生成なし
- [x] 音声入力なし
- [x] Assistant Cloud なし
- [x] 添付は削除せず、公式 registry の attachment を使用

## 受け入れ結果

- [x] `.xlsx .docx .pptx .csv .md .txt`、64 MB 上限、対象外形式・超過時の日本語拒否を自動テストで確認。
- [x] 実ブラウザーで `.xlsx` を選択して送信し、`input/8月月次管理レポート.xlsx`（8 bytes）と `file.imported`（ファイル名・サイズ・SHA-256）が作られることを確認。
- [x] 同名持ち込みの `(2)` 連番、安全なファイル名への正規化を自動テストで確認。
- [x] Agent に持ち込み済み `input/` 相対パスを渡し、会話表示には内部案内を混ぜないことを自動テストで確認。
- [x] `/project/select` の候補外・UNC 拒否、実行中 409、最近5件、切替後の runner root と `output/project-result.xlsx` を自動テストで確認。
- [x] `/project/pick` は注入した picker で自動テストし、テスト中に OS ダイアログを表示していない。
- [ ] 実際の `FolderBrowserDialog` 操作は未確認（自動テストでは意図的に注入へ差し替え）。
- [x] `Misen起動.cmd` の記憶済みプロジェクト起動とドラッグ＆ドロップ優先を Windows 統合テストで確認。
- [x] 「毎回確認」を既定とし、上書き・要素削除（batch 内 remove を含む）を止め、「このセッションは自動」では通す最小ポリシーをテスト。
- [x] project / approval / attachment のイベントは各 PC の追記専用 JSONL にメタデータだけを記録。
- [x] project エンドポイントは UI 専用で、Agent Tool roster に追加していない。
- [x] 情報欄に provider / model のみを表示し、キーを返さない。
- [x] `npm run test:unit`: 102 tests、99 pass、3 skip、0 fail。全体約8.2秒（30秒以内）。
- [x] `node --test launcher/test/launch.test.mjs`: 1 pass、約33秒。
- [x] `dist/web/assets`: `client.js` と `client.css` の2ファイル。
- [x] `package.json` / `package-lock.json` に変更なし。実行時依存は main と同一。

## 補足

launcher テストを Codex の PowerShell 7 配下から起動すると、子 Windows PowerShell 5.1 が互換性のない `PSModulePath` を継承して `Get-FileHash` を発見できなかった。テスト子プロセスだけで `PSModulePath` を外し、利用者が cmd をダブルクリックしたときの Windows PowerShell 5.1 標準探索経路を再現して PASS を確認した。
