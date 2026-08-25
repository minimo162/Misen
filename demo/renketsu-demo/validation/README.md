# 正解 fixture の検証

`extracted.correct.json` は、提出ファイルから LLM が抽出したと仮定する正解値です。値は各提出ファイルの元単位で保持します。`expected.json` は同じ値をレート表で百万円 JPY に正規化した台帳入力値と合計です。

PowerShell の生成器とは別実装の Node 検証を実行してください。

```powershell
node demo/renketsu-demo/validation/verify-expectations.mjs
```

検証器は、レート、19 提出（国内 4 / 海外 15）、OS16 未提出、通貨・拡張子の組合せ、issue 種別、テキスト source の quote 部分文字列、各社の正規化値、合計値を確認します。XLSX の quote はセル値として構造的に確認します。
