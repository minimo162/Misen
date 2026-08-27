# Misen Benchmark Phase 1

Misen Benchmarkは、同じ合成task suiteを既存provider/modelへ渡し、Misen本体のエージェント経路で得た事実を比較するCLI基盤です。ランキングUIやLLM-as-a-judgeは含みません。

```text
task definition
→ runConfiguredAgentTurn / agentLoop v2
→ validate / hooks / permission / approval / precondition recheck
→ ToolDef.run / workspace・command hard guard
→ authoritative AgentEvent / append-only audit
→ deterministic scoring
→ JSONL
→ runs.csv / summary.csv / summary.md
```

Benchmarkはtoolを直接実行せず、approval・permission・precondition・hard guard・auditを無効化しません。すべてのrunは通常ディレクトリの合成workspaceで実行され、`.company-apps-synthetic.json` markerを開始時と自動承認直前に再検証します。`external-openai`は通常実行と同じく明示有効化済みconfig、環境変数credential、各model request直前のsynthetic boundary再検証が必要です。

## Credentialなしのmock E2E

`synthetic-smoke`は、既存`openai` providerへin-process loopback OpenAI互換fixtureを接続します。Benchmark専用providerではありません。5 task（read、approval付きwrite、複数tool、workspace境界拒否、JSON artifact）を2回ずつ実行する例です。

```powershell
npm run benchmark:mock -- `
  --suite synthetic-smoke `
  --repeat 2 `
  --output .tmp/benchmark `
  --auto-approve-synthetic `
  --metadata gpu=fixture `
  --metadata quant=fixture
```

`--auto-approve-synthetic`はapprovalを無効化しません。marker検証後に既存approval storeへrequestを作成し、policy provenance付きresolveを行い、通常のapproval eventとprecondition再確認を通します。元configの非read permissionが`allow`でもBenchmark内では`ask`へ正規化し、この経路を迂回させません。フラグなしでは要求されたapprovalをpolicy denyし、対話待ちでrunを停止させません。

## 実provider

実providerでは`--config`、`--provider`、`--model`が必須で、CLIのproviderとconfigのproviderは一致しなければなりません。providerを替える比較ではproviderごとの安全なconfigを用意し、同じsuite/outputへ順番に追記してください。

```powershell
npm run benchmark -- `
  --suite synthetic-smoke `
  --config .\config.ollama.json `
  --provider ollama `
  --model ornith-1.5:9b `
  --repeat 3 `
  --output .tmp/benchmark-compare `
  --timeout-ms 120000 `
  --auto-approve-synthetic `
  --metadata gpu=RTX5090 `
  --metadata quant=Q4_K_M `
  --metadata context=32768
```

`openai`はPhase 1ではloopback endpointだけを受け付けます。remote OpenAI互換endpointは、Issue #45の境界を持つ`external-openai` configで実行してください。credentialがない実通信を成功として捏造せず、利用不能は`unavailable`、通信失敗は`provider_error`として記録します。

## Suite / task schema

suiteは`misen.benchmark-suite/v1`、taskは`misen.benchmark-task/v1`を明記します。task idはsuite内で一意かつ安定させます。fixtureはtaskへinline指定するか、suiteの`fixtures`を`fixtureRef`で参照します。fixture pathは相対パスだけです。

```json
{
  "schemaVersion": "misen.benchmark-suite/v1",
  "id": "example",
  "version": "1.0.0",
  "title": "Example suite",
  "fixtures": {
    "basic": { "files": [{ "path": "input.txt", "content": "synthetic\n" }] }
  },
  "tasks": [{
    "schemaVersion": "misen.benchmark-task/v1",
    "id": "read-basic",
    "title": "Read fixture",
    "description": "Read-only deterministic task.",
    "prompt": "input.txtを読んでください。",
    "fixtureRef": "basic",
    "timeoutMs": 30000,
    "tags": ["read"],
    "category": "read",
    "expectations": [
      { "type": "final_status", "value": "success" },
      { "type": "tool_used", "tool": "host.read_file" },
      { "type": "file_exists", "path": "input.txt" }
    ],
    "approvalExpectation": "not_requested"
  }]
}
```

Phase 1で利用できるexpectationは次のとおりです。

- `final_status`: `success` / `aborted`
- `file_exists` / `file_not_exists`
- `file_text_contains`
- `text_regex`: `path`指定時はfile、省略時はfinal reply
- `json_value`: RFC 6901 JSON Pointerと完全一致値
- `json_structure`: 必須JSON Pointerの存在
- `tool_used` / `tool_not_used`
- `safety_rejection`
- task-level `approvalExpectation`: `approved` / `denied` / `not_requested`

`mock.steps`はcredentialなしのloopback検証用fixtureです。実providerへは送信されず、採点にも使われません。

## Result

`results.jsonl`がsource of truthで、task × repeatごとに1行をappendします。同じJSONLから次を再生成できます。

```powershell
node dist/benchmark.js `
  --summarize .tmp/benchmark/results.jsonl `
  --output .tmp/benchmark
```

- `results.jsonl`: run schema、suite/task/run id、Git SHA、provider/model、non-secret metadata、repeat、outcome、expectation detail、timing、model/tool/approval/retry/guard/token facts
- `runs.csv`: run detail
- `summary.csv`: suite/version/provider/model aggregate（異なるsuite versionを混在させない）
- `summary.md`: 人が読むaggregate
- `audit/audit.jsonl`: 通常のredacted append-only terminal tool audit

合成workspace本文、API key、Authorization header、credential、raw provider error/responseはresultへ保存しません。生成workspaceは採点後に削除します。完全一致redactionを安全に行えない4文字未満の非空credential/secret markerはartifact作成前に拒否します。`--metadata`のkeyに`secret`、`token`、`key`、`authorization`、`credential`等を使うと拒否します。

## Outcome

- `success`: 通常完了し、すべてのdeterministic expectationがpass
- `expectation_failure`: modelは応答したが期待値不一致、反復上限等でtask未達
- `provider_error`: model/provider request失敗
- `timeout`: taskまたはCLI timeout。abort後に停止しないagentはsuite-level fail-closed
- `safety_rejection`: permission/workspace/hard guardが拒否。negative taskが明示期待した場合は`pass=true`になり得る
- `harness_error`: schema/output/audit等Benchmark基盤の障害
- `skipped`: 実行しなかったrun用の予約分類
- `unavailable`: config/credential/endpoint前提が利用不能

`modelが失敗した事実`、`Misenが安全に拒否した事実`、`Benchmark基盤が壊れた事実`を同じfailureへまとめません。

## Metric definitions

- attempted/completed/pass rate: skippedを分母から除外し、provider error/timeout/harness errorは未完走として区別
- deterministic expectation pass rate: expectation pass数 ÷ 評価したexpectation数
- tool validity: `tool.succeeded` ÷ terminal tool event。failed/rejected/invalidを分母に含む
- approval success: approved approval数 ÷ requested approval数
- elapsed: run開始から採点前までのwall-clock
- time-to-first-action: run開始から最初のauthoritative host `tool.requested`。toolがない場合は最初の`model.decision`
- model calls: `model.wait`（request attempt）数
- tool calls: `tool.requested`数
- retries: Phase 1のv2 requestは`maxRetries: 0`なので0。provider内部の不明な再試行は推測しない
- token usage: provider/SDKが報告したusageだけを加算。推定しない
- human intervention: CLI Phase 1は対話承認を行わないため0。自動承認は別のapproval provenance/metadataで判別

取得不能値はJSONでは`null`、CSV/Markdownでは空欄または`—`です。unknownを0として平均や率の分母へ入れず、分母0を0%と表示しません。seedはprovider保証がない限り`null`、`seed_guaranteed=false`です。

## 公平な比較

同じsuite/version、Git SHA、prompt、timeout、repeat、temperature/sampling、context、量子化、hardware条件を揃えてください。自動取得できない条件は`--metadata`で事実だけを記録し、不明なら記録しません。完走率や速度が高いモデルが、自由記述品質、業務知識、全般的な安全性を含めて優れているとは断定できません。Phase 1の数字は、そのdeterministic synthetic suiteと記録済み条件に対する実測です。
