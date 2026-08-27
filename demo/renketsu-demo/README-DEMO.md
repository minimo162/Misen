# 連結デモ（明朝 60 秒動画＋ライブ・アンコール）

この資料は、`demo/renketsu-demo/workspace` だけを実行面にした連結デモの台本と、実機で止める判断を一枚にまとめたものです。主役は事前に成功条件を満たした **60 秒動画**、ライブ実演は上司から求められた場合だけのアンコールです。`validation` は workspace の外に置く真値・fixture であり、エージェントには見せません。ここに書いた Windows、Excel Desktop、Copilot、Edge、EDR の状態は、明朝の実機チェックが終わるまで未確認です。

## 0. 先に押さえる境界

- 起動時の作業ディレクトリは `apps/coding-agent`。config は `..\..\demo\renketsu-demo\config.demo.json`、workspace は `..\..\demo\renketsu-demo\workspace` です。
- M365 Copilot は対話面（Copilot Edge）として使い、ローカルの coding-agent は `host.*` のファイル読み書きとコマンドを workspace 内で実行します。この資料だけでは「組織外へデータが出ない」とは断定しません。説明は「承認済み M365 Copilot／ローカルホスト境界で、テナント・認証・ネットワーク・EDR は実機確認待ち」に統一します。
- `reports/` と `rates/` は読み取り専用。モデルが読むのは workspace 内だけで、`../validation`、正解値、兄弟 fixture は読ませません。作業ファイルは `work/`、書込み先は `work/extracted.json` と `Update-Ledger.ps1` が扱う ledger、任意の `out/`／`backup/` に限定します。
- 新しい launcher は作らず、launcher に `-ExecutionPolicy Bypass` を追加しません。デモ中の読みやすい直接コマンドでは `-ExecutionPolicy Bypass` の有無を問題にせず、削除・ネットワーク・プロセス／サービス・レジストリ変更・`-EncodedCommand` と workspace 外書込みを拒否します。見えないウィンドウ、インタープリター連鎖、実行時ダウンロードは使いません。

## 1. 60 秒動画（主役）

> `demo/video/output/デモ紹介_v1.mp4` は、表示セッション追従を検証済みの `manual-retake.mp4` へ実写を差し替え、2026-08-26に生素材・完成版の動きQAと62秒版QAを通過済みです。詳細は `demo/video/qa/QA-REPORT.md` を参照してください。

### 録画前の画面と証跡

- 実機チェックと 3 回連続リハーサルが全て pass した Run を録画する。録画開始後に固定リクエストを貼り付け、先に実行してから録画を始めない。
- 画面は左に coding-agent のブラウザー／実行ログ、右に Excel の `集計台帳.xlsx` を並べる。通知、個人情報、他案件のタブは閉じる。
- Windows の `Win+G` から画面収録する。編集前の無加工録画を証跡として残し、Run ID、時刻、turn 数、入力・出力 hash と対応付ける。
- Clipchamp では待ち時間だけを速度調整し、各場面に短い字幕を付ける。値や操作順を編集で入れ替えず、60 秒版とは別に無加工版を保存する。

### 62 秒構成（60±10 秒）

| 時間 | 画面・字幕 |
| --- | --- |
| 0–5 秒 | シナリオカード。「20社の子会社報告を、1つの台帳へ」と架空データであることを示す。 |
| 5–16 秒 | 録画メタデータの固定リクエストをタイプ表示し、全文テロップで「全部読んで」「円換算」「台帳に転記」「確認事項」「保存」を強調する。 |
| 16–42 秒 | 対象セッションの実写0–104秒を4倍速で見せ、指示と同じ5語で進行を示す。 |
| 42–48 秒 | 元素材100–106秒を等速で見せ、更新済み台帳の19社提出・1社未提出を披露する。 |
| 48–54 秒 | 元素材108–114秒を等速で見せ、`確認事項` 5件（単位差異3、科目名差異1、未提出1）を披露する。 |
| 54–58 秒 | 「承認済みCopilotのみ」「社外送信なし」「架空データ」と、録画メタデータの実測94.221秒（1.57分）を表示する。 |
| 58–62 秒 | 「次のステップ: 実業務データでの検証」で締める。 |

「データが社外に出ない」は、対象テナント・認証・ネットワーク境界を明朝に確認できた場合だけ使います。「1 時間が 3 分」は同じ業務範囲の実測記録がある場合だけ使います。どちらも未確認なら、上表の控えめな締めに固定し、推測値や絶対表現へ差し替えません。

## 2. ライブ・アンコール（5 分、求められた場合のみ）

### 0:00–0:40 比較と前提

普通の Copilot チャットに同じ依頼を入れ、「表の案は作れても、このローカルの多数ファイルをアップロードなしで読み、既存台帳をその場で更新・保存するところまでは実行していない」ことを画面で示します。そのうえで「今回は **抽出だけ Copilot、計算と転記はスクリプト＋Excel 数式** に分け、同じ入力から確認事項と台帳を残します」と説明します。

添付なら数件を読めるのでは、と聞かれたら認めます。そのうえで「このデモの差は、アップロード操作なしの多数ファイル一括読取と、既存ローカル台帳の更新・保存までを一度の依頼でつなぐ点です」と答えます。実際に開いていない添付や未提示の実機環境を、確認済みとは扱いません。

### 0:40–1:10 固定リクエスト

次の一文をそのまま一度だけ送ります（言い換え・追加の確認質問をしません）。

「reports フォルダの各社の報告ファイルを全部読んで、rates のレート表で円換算して、集計台帳.xlsx に会社別に転記して。未提出の会社と、単位や科目名が怪しい会社は『確認事項』シートにまとめて、保存して」

> reports フォルダの各社の報告ファイルを全部読んで、rates のレート表で円換算して、集計台帳.xlsx に会社別に転記して。未提出の会社と、単位や科目名が怪しい会社は『確認事項』シートにまとめて、保存して

最初の行動が `reports/*` と `rates/*` の全件読みであることを、ログで確認します。

### 1:10–3:30 実行ログを見せる

画面に次のような一行ログが順に出ることを示します（実際の会社名・件数・hash はその Run の値だけを読み上げます）。

```text
[tool] host.read_files: patterns=["reports/*","rates/*"]
[tool] host.run_command: powershell.exe -NoProfile -File tools\Read-Xlsx.ps1 -Path reports\*.xlsx
[tool] host.write_file: work/extracted.json
[tool] host.run_command: powershell.exe -NoProfile -File tools\Update-Ledger.ps1 -Extracted work\extracted.json -Rates rates\レート表.csv -Ledger 集計台帳.xlsx
```

`work/extracted.json` は次の B/C 契約を崩しません。`companies` と `missing` の二配列、各社の `id`、`name`、`source`、`currency`（`JPY|USD|EUR|CNY|THB|GBP`）、`unit`（`ones|thousands|millions`）、`values`（`revenue`、`operatingProfit`、`netIncome`、`totalAssets`、`employees` の数値）、完全一致の `quotes`、`issues`（`unit_variation` または `account_variation` と完全一致の `quote`）を持たせます。未提出は `missing` に `type: "unsubmitted"`、`quote: "提出ファイルなし"` で記録します。

### 3:30–4:30 Excel を開いて確認

`集計台帳.xlsx` の `連結台帳` と `確認事項` シートを開き、(a) 会社数、(b) 未提出数、(c) 単位・科目差異、(d) 円換算後の totals が、Update-Ledger の一行 JSON と一致することだけを確認します。異常の説明には `quote` の原文を一つ添えます。

Update-Ledger の一行目は少なくとも次のキーを含む JSON です。数値は画面の値を推測せず、その行を読みます。

この同梱fixtureを使った正解出力は次の形です。実演時は画面に出た行を読み、値を先回りして言いません。

```json
{"ok":true,"processedCompanies":19,"missingCompanies":1,"convertedCompanies":15,"unitNormalizedCompanies":10,"unitVariations":3,"accountVariations":1,"confirmationCount":5,"totals":{"revenue":670552.0,"operatingProfit":80582.7,"netIncome":52761.1,"totalAssets":1120599.0,"employees":14350}}
```

### 4:30–5:00 閉じる／止める

「同じ指示で同じ値を再現できたか、確認事項を追えるか」を答え、Excel とブラウザーを閉じます。実機チェック未完了、Copilot 軽量接続失敗、または 3 回の連続リハーサル不合格なら、デモは中止します。過去に一度 pass 済みの記録がある場合だけ、録画または人手フォールバックを使い、そうでなければ概念説明・進捗共有に切り替えます。

## 3. 各段階の手動フォールバック

すべて人が画面で確認し、エージェントには `validation` のパスを渡しません。fixture のコピーは LLM のデモではなく、時間切れ時の scripted insurance です。

1. **ローカル起動** — PowerShell の通常ターミナルで、リポジトリの実ファイルを直接起動します。

   ```powershell
   Set-Location C:\Users\yuuki\Misen\apps\coding-agent
   node dist/server.js --config ..\..\demo\renketsu-demo\config.demo.json --workspace ..\..\demo\renketsu-demo\workspace
   ```

   ブラウザーに `http://127.0.0.1:3948`（実際に表示された URL）を開き、画面の workspace 表示が `demo/renketsu-demo/workspace` であることを確認します。ポートはサーバー表示を優先します。

2. **xlsx の確認** — workspace ルートで、対象ファイルごとに次を実行し、出力を人が読みます。

   ```powershell
   Set-Location C:\Users\yuuki\Misen\demo\renketsu-demo\workspace
   powershell.exe -NoProfile -File tools\Read-Xlsx.ps1 -Path reports\<報告ファイル>.xlsx
   ```

3. **OSキャプチャが使えない場合の手動録画待ち** — 録画ソフト側で次の保存先を指定して待機し、別の通常PowerShellから実行します。スクリプトはfresh sessionを作成し、copilot-edgeが所有する正確なEdge PIDへ表示を切り替え、画面DOMのセッション識別子と入力欄を検証します。`MANUAL CAPTURE READY session=<ID> edgePid=<PID>`が表示されるまでは録画を始めません。表示後に録画を開始してEnter、最後の停止案内で録画を停止してEnterを押します。実行中に表示回答要素が1件も増えなければテイクは失敗します。

   ```powershell
   Set-Location C:\Users\yuuki\Misen
   powershell.exe -NoProfile -File demo\renketsu-demo\Record-Demo.ps1 `
     -NoCapture `
     -OutputPath demo\renketsu-demo\recordings\manual-take.mp4 `
     -RepoRoot C:\Users\yuuki\Misen
   ```

   `ok:true`は、表示セッション一致、表示回答要素の増加、指定動画の存在・非空、抽出値の真値一致、Update-Ledgerの合計・件数一致をすべて確認できた場合だけ返します。JSONの `visibleSessionVerified:true`、`visibleActivityVerified:true`、`sessionId`、`displayEdgePid` も保存します。

   新しい素材を受け取ったら、編集前に生素材単体の動きQAを実行します。完成動画の実写差替え後は `-FinalPath` も渡し、生素材と完成動画の実写ROIを同時に検査します。2秒間隔の隣接フレーム差分、動いた組数・比率、最長静止時間の全条件を満たさない動画は使用しません。

   ```powershell
   powershell.exe -NoProfile -File demo\video\qa\Test-VideoMotion.ps1 `
     -RawPath demo\renketsu-demo\recordings\manual-take-2.mp4 `
     -RawMetadataPath demo\renketsu-demo\recordings\manual-take-2.json `
     -FfmpegPath "<ffmpeg.exeの絶対パス>"
   ```

   `Read-Xlsx.ps1` または ImportExcel/EPPlus が実機で使えない場合、元の Excel を開いて必要セルと単位をメモし、JSON を手動レビューします。値を空欄のまま転記して pass にしません。

4. **抽出 fixture の緊急コピー** — Copilot の初回拒否または接続断で、かつ人が fixture の出所・日付を確認できる場合だけ、次のように workspace 内へコピーします。これは scripted insurance であり、LLM が抽出した結果とは表示しません。

   ```powershell
   Set-Location C:\Users\yuuki\Misen\demo\renketsu-demo\workspace
   New-Item -ItemType Directory -Force work | Out-Null
   Copy-Item ..\validation\extracted.correct.json work\extracted.json
   Get-Content work\extracted.json -Raw | ConvertFrom-Json | Out-Null
   ```

   この fixture の出所と更新時刻を朝に確認します。モデルへの入力にはこのパスを含めません。

5. **台帳更新** — `work/extracted.json` を人が確認した後、同じ workspace ルートで一度だけ実行します。

   ```powershell
   powershell.exe -NoProfile -File tools\Update-Ledger.ps1 -Extracted work\extracted.json -Rates rates\レート表.csv -Ledger 集計台帳.xlsx
   ```

   一行目の JSON を保存し、`ok`、各 count、`totals` を読み上げます。失敗時に ledger を初期化して再実行しません。

6. **開く／検査する** — `集計台帳.xlsx` を `Invoke-Item .\集計台帳.xlsx` で開き、会社別と `確認事項` を目視します。保存日時と確認者を記録し、元の `reports/` と `rates/` の更新日時が変わっていないことを確認します。

## 4. 明朝チェックリスト（順序を変えない）

- [ ] **1. Test-DemoSetup** — workspace の通常ターミナルで `powershell.exe -NoProfile -File tools\Test-DemoSetup.ps1` を実行する。`workspace`、`reports/`、`rates/`、`tools/Read-Xlsx.ps1`、`tools/Update-Ledger.ps1`、`集計台帳.xlsx`、ImportExcel DLL、Node、Edgeを診断し、テンプレートの一時コピーに正解fixtureを転記して `validation/expected.json` と一致することまで確認する。`RESULT ALL OK` と時刻を記録する。
- [ ] **2. fallback end-to-end** — LLM を使わず、既知の extracted fixture を `work/` に置く scripted insurance → Update-Ledger → Excel の会社別／確認事項を最後まで通す。
- [ ] **3. Copilot lightweight connectivity** — Edge の Copilot 接続、`agentMode=true`、foreground 表示、最初の軽量な `list_files` までを確認する。ここで拒否・#0・タイムアウトなら中止。
- [ ] **4. full rehearsal** — config変更後や各 Run の開始前に、UIの「新しいセッション」または `POST /api/sessions` で必ず新規セッションを作る（`Record-Demo.ps1` は自動実行）。そのうえで同じ固定指示を変更せず **3 回連続**、各 Run **8 ターン以下**で実施する。各 Run の extracted values が、人だけが参照する `validation` の真値と全項目一致し、counts・quotes・ledger の一行 JSON が記録されることを合格条件にする。エージェントは validation を読まない。
- [ ] **5. record** — `Record-Demo.ps1 -NoCapture` の `MANUAL CAPTURE READY`に表示されたsession IDとEdge PIDを記録してから録画を開始する。Run後は `visibleSessionVerified:true` と `visibleActivityVerified:true`、Run ID、時刻、turn数、host操作、count、hash、停止理由、Excel表示結果を保存する。無加工素材を `Test-VideoMotion.ps1` へ通し、実写差替え後の60秒版も同じスクリプトの `-FinalPath` 付きで通す。いずれかがfail／未確認なら動画を披露しない。
- [ ] **6. go/no-go** — 1–5 の証跡が全て pass なら 60 秒動画を主役として披露する。ライブは上司から求められ、かつ同じ朝の全ゲートが pass している場合だけアンコールで行う。どれか一つでも fail／未確認ならライブを中止し、過去の pass 証跡に対応する録画があれば動画、なければ概念説明・進捗共有に切り替える。

次の項目は **実機だけの確認** です。現在のローカル/static 検査で確認済みとは書きません。

- Excel Desktop の版、ファイル関連付け、編集・保存権限
- Microsoft 365 Copilot のサインイン、テナント、Copilot Edge の起動と foreground 表示
- Edge の CDP／プロファイル再利用なし、既存タブ干渉なし
- ImportExcel DLL と EPPlus の読み込み、実行ポリシー、共有フォルダーからの local-copy 実行
- EDR の canary 実行、アラート／隔離の有無、アプリ／hash の事前登録要否、IT への事前照会結果

## 5. トラブルシューティング

| 症状 | その場の判断・対処 |
| --- | --- |
| 最初のターンで拒否、`#0`、または host 操作が出ない | Run を増やさずログ（Run ID、時刻、拒否文、画面）を保存。軽量接続チェックに戻り、3 回連続の full rehearsal 条件を満たせなければ中止。 |
| malformed JSON、flat args、未知キー | `args` は必ず JSON オブジェクト。config の fenced JSON 指示を再確認し、モデルに `../validation` を見せない。壊れた抽出を手で修正して pass にしない。 |
| CP932 の報告／CSV が文字化け | 原ファイルを上書きせず、PowerShell の読み込み時だけ適切な encoding を指定して再読込。どの encoding を使ったか記録し、引用が原文と一致しなければ未確認。 |
| xlsx が読めない／シートが空 | `Read-Xlsx.ps1` を対象ファイル一つで再実行。ImportExcel/EPPlus の版・DLL・権限を記録し、Excel での目視メモを人手フォールバックにする。 |
| プロンプトが 80k 付近で切れる／応答が分割される | 入力を会社単位の小さな束に分け、同じ固定指示のまま 8 ターン以内に収まるか確認。分割で values や quotes が欠けたら中止。`maxPromptChars=120000` は上限であり成功保証ではない。 |
| ImportExcel／EPPlus のロード警告、EDR 隔離 | 再試行を繰り返さず、DLL の版・場所・hash と EDR イベントを記録。ローカルコピーの scripted fallback を使い、事前登録や承認が無いまま配布 DLL を追加しない。 |
| PowerShell の実行ポリシーで止まる | `Get-ExecutionPolicy -List` とエラーを記録し、承認済みの通常ターミナル／ローカルコピーで `-ExecutionPolicy Bypass` を付けて再試行してよい。launcher 自体は変更しない。 |
| config変更後も旧指示で動く／入力位置不一致 | サーバー再起動だけでは永続セッションのsystemPromptは更新されない。`Record-Demo.ps1` は各テイク前に新規セッションを自動作成する。手動検証でもUIの「新しいセッション」または `POST /api/sessions` を実行してから固定指示を送る。 |
| `The exact Copilot Edge window was not found for PID ...` で録画前に停止 | Edgeの起動PIDが一時プロセスで、実ウィンドウを持つブラウザー本体PIDへ引き継がれた旧版の症状。別のEdgeウィンドウを選ばず停止する。現行版はCDPからブラウザー本体PIDを取得するため、`typecheck`・`build`・smoke後の `dist/server.js` でcoding-agentを再起動し、再実行する。 |
| Runは成功したのに録画中のCopilot画面が静止／別回答のまま | 録画を無効化する。旧実装は最新のEdgeウィンドウを選んだだけで、APIのfresh sessionと表示タブを対応付けていなかった。現行 `Record-Demo.ps1` はcopilot-edge所有PID、画面DOMのsession marker、表示回答要素の増加を検証する。`MANUAL CAPTURE READY`前に録画せず、完了JSONの `visibleSessionVerified`／`visibleActivityVerified` がtrueでない素材は編集しない。 |
| `gdigrab error 5`／`ddagrab`のDXGI出力なし／`CopyFromScreen`のhandle invalid | キャプチャだけの5秒試験を先に行う。3方式とも失敗する環境では本番ランを開始せず、`Record-Demo.ps1 -NoCapture`で外部録画の開始・停止を人に委ねる。スクリプトは指定動画の存在とサイズも最後に検証する。 |
| 共有フォルダー上でだけ失敗 | リポジトリを承認済みのローカル作業フォルダーへコピーし、同じ相対パスで実行。コピー元・先、時刻、hash を記録し、共有元へ書き戻さない。 |
| 会社が欠落、未提出判定が違う | `reports/` の全件 list と入力一覧を突合し、`missing` の `quote` を確認。モデルの推測で会社を追加せず、原文・ファイル名・時刻を記録して中止判断。 |
| リハーサル間で ledger がリセット／追記される | 各 Run 前後の ledger hash と保存日時を記録。既存 ledger を削除・初期化せず、Run ごとのコピー／backup で比較し、Update-Ledger を一回だけ通す。 |

## 6. ダブルクリック起動（汎用デモ起動.cmd）

`汎用デモ起動.cmd` は、このファイルの場所を基準にリポジトリを解決し、`apps/coding-agent/config.flex.json` を使って `demo/renketsu-demo/workspace` だけを作業境界として起動します。`apps/coding-agent/coding-agent.cmd` の存在、flex 設定、workspace フォルダーを確認してから呼び出すため、`validation` など workspace 外の資料は実行対象になりません。

この `coding-agent.cmd` は `launcher\launch.cmd` を経由します。初回起動または共有版の更新時には launcher が配布物をローカルへ版別同期し、manifest の SHA-256 を検証してから現在版を有効化します。検証済みの coding-agent が web サーバーを起動し、既定ブラウザーで表示します（通常は `http://127.0.0.1:3948`）。

## 実装メモ

- `workspace` を `demo/renketsu-demo` の子に固定したのは、`validation` を相対パスで隠し、`restrictToWorkspace=true` の境界を実際のデモでも保つためです。親フォルダーを workspace にする案は、fixture 混入と誤読のリスクがあるため採用しません。
- B/C の契約スキーマと Update-Ledger の引数はこの台本に固定しました。実データの会社 ID、真値、レート、fixture 名はデモ前に人が確認し、未確認の値を「確認済み」と書きません。
- ImportExcel DLL の配布・配置は、7.8.10（Apache-2.0、EPPlus.dll 同梱）と EPPlus Assembly/FileVersion 4.5.3.2（LGPL 系の legacy parser）の実機配置承認が必要です。部署の配布許可と EDR canary の結果が無い間は、正規のローカルコピーと scripted insurance を優先します。
- EDR の検知ルールそのものは文書化・開示しません。恒久的な launcher 規律（回避スイッチなし、可視で読みやすい直接起動、実行時ダウンロードなし）を守り、canary 実行日と observation log、必要ならアプリ／hash の事前登録結果だけを記録します。IT の非開示ルールを推測したり、ルールを尋ねるよう利用者に勧めたりしません。
