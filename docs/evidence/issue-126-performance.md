# Issue #126 zip 配置のローカル実測

## 条件

- 実施日: 2026-09-04
- 実行環境: Windows、Windows PowerShell 5.1、Node.js v24.18.1
- 保存先: 同一 PC のローカル NTFS（SMB 共有は未接続）
- prepared runtime 治具: 6,508 ファイル、99,196,506 bytes。6,500 個の 1 KiB 小ファイル、実際の `node.exe`、必須 app/runtime/workspace ファイルを含む
- 変更前: このブランチの起点 `3afcd2f6c7ab3ce78a7454e1a5b29ed11d5f4905` を一時 clone して実行
- 変更後: 作業ツリーの Issue #126 実装を実行
- 各条件 3 回。公開は `New-Misen.ps1 -CleanDestination`、初回取得は空のローカル先に対する `launch.ps1 -SyncOnly` のプロセス全体を計測

## 結果

| 処理 | 変更前（3回） | 変更後（3回） | 中央値の変化 |
| --- | ---: | ---: | ---: |
| 共有形式への公開 | 19.922 / 20.511 / 20.320 秒 | 14.833 / 14.568 / 15.411 秒 | 20.320 → 14.833 秒（27.0%短縮） |
| 空のローカル先への初回取得・検証 | 11.412 / 10.745 / 13.617 秒 | 10.874 / 11.152 / 11.085 秒 | 11.412 → 11.085 秒（2.9%短縮） |

共有側の版フォルダー直下は、変更前の展開済み `app/`、`runtime/`、`workspace/`、`launcher/` から、変更後は `launcher/` と `misen-<version>.zip` の 2 項目になった。変更後の3回すべてでこの構成を確認した。

この計測はローカル NTFS 上なので、Issue #126 の主対象である SMB のファイル単位往復遅延を含まない。したがって LAN 上の短縮率は未検証であり、この数値から推定しない。一方、SMB 境界を通る payload が約6,500ファイルから zip 1ファイルへ減ることは生成物の構成で確認した。

## 展開経路

変更後の共有形式を外側の Release zip に格納し、`Expand-MisenShare.ps1` で別の一時フォルダーへ展開した。外側 zip の SHA-256 検証、`misen-distribution/3` manifest、版フォルダー直下の `launcher/` と `misen-<version>.zip` を確認した。
