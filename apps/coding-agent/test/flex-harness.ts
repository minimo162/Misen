import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractJsonReply } from '../src/agent'
import { convertCopilotResponse, interpretCopilotResponseDeterministically } from '../src/converter'
import { prepareHostCommand, qualifiedToolName, TOOL_DEFS, validateToolArgs, type ToolContext } from '../src/tools'

type TaskType = 'list' | 'read' | 'open' | 'write' | 'search'
type Result = { type: TaskType; utterance: string; target: string; ok: boolean; ms: number; detail: string }

function tool(name: string) {
  const found = TOOL_DEFS.find((entry) => entry.name === name)
  if (!found) throw new Error(`missing tool: ${name}`)
  return found
}

function summarize(results: Result[], label: string): void {
  const grouped: Record<string, { success: number; total: number; stable: boolean; minMs: number; maxMs: number }> = {}
  for (const type of ['list', 'read', 'open', 'write', 'search'] as const) {
    const selected = results.filter((result) => result.type === type)
    const times = selected.map((result) => result.ms)
    const success = selected.filter((result) => result.ok).length
    grouped[type] = { success, total: selected.length, stable: selected.length > 0 && success === selected.length, minMs: Math.min(...times), maxMs: Math.max(...times) }
  }
  console.log(`${label}_SUMMARY ${JSON.stringify(grouped)}`)
  if (Object.values(grouped).some((entry) => !entry.stable)) process.exitCode = 1
}

async function measured(result: Omit<Result, 'ok' | 'ms' | 'detail'>, operation: () => Promise<string>, expected: (output: string) => boolean): Promise<Result> {
  const started = Date.now()
  try {
    const output = await operation()
    const ok = expected(output)
    return { ...result, ok, ms: Date.now() - started, detail: ok ? 'ok' : output.slice(0, 160) }
  } catch (error) {
    return { ...result, ok: false, ms: Date.now() - started, detail: String((error as Error).message ?? error).slice(0, 160) }
  }
}

async function deterministicCorpus(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flex-harness-'))
  const ctx: ToolContext = { workspace: root, restrictToWorkspace: true, safeCommandOnly: true }
  try {
    for (const dir of ['reports', 'rates', 'tools', '雑多 フォルダ', '空フォルダ']) fs.mkdirSync(path.join(root, dir), { recursive: true })
    fs.writeFileSync(path.join(root, '概要.txt'), 'キックオフ日: 2026-08-27\n合言葉: 若葉')
    fs.writeFileSync(path.join(root, 'reports', '北.csv'), '項目,値\n売上,120\n検索札,青')
    fs.writeFileSync(path.join(root, 'rates', '為替.csv'), '通貨,円\nUSD,150\n検索札,赤')
    fs.writeFileSync(path.join(root, 'tools', '案内.txt'), '検索札: 緑')
    fs.writeFileSync(path.join(root, '雑多 フォルダ', '日本語メモ.md'), '- 一つ\n- 二つ')
    const workbook = path.resolve(__dirname, '..', '..', '..', 'demo', 'renketsu-demo', 'workspace', '集計台帳.xlsx')
    fs.copyFileSync(workbook, path.join(root, '雑多 フォルダ', '任意台帳.xlsx'))

    const cases: Array<Promise<Result>> = [
      measured({ type: 'list', utterance: 'ここ直下、何ある？', target: 'workspace root' }, () => tool('list_files').run({ path: '.', recursive: false }, ctx), (o) => o.includes('概要.txt') && o.includes('reports/') && !o.includes('reports/北.csv')),
      measured({ type: 'list', utterance: 'reports のCSVを一覧でお願いします', target: 'reports' }, () => tool('list_files').run({ path: 'reports', glob: '*.csv' }, ctx), (o) => o.includes('reports/北.csv')),
      measured({ type: 'list', utterance: '雑多フォルダ見せて', target: '雑多 フォルダ' }, () => tool('list_files').run({ path: '雑多 フォルダ' }, ctx), (o) => o.includes('日本語メモ.md') && o.includes('任意台帳.xlsx')),
      measured({ type: 'read', utterance: '概要、読んで', target: '概要.txt' }, () => tool('read_files').run({ paths: ['概要.txt'] }, ctx), (o) => o.includes('若葉')),
      measured({ type: 'read', utterance: '為替CSVのUSDはいくらでしょうか', target: 'rates/為替.csv' }, () => tool('read_files').run({ pattern: 'rates/為替.csv' }, ctx), (o) => o.includes('USD,150')),
      measured({ type: 'read', utterance: '任意台帳のシート内容お願い', target: '雑多 フォルダ/任意台帳.xlsx' }, () => tool('read_xlsx').run({ path: '雑多 フォルダ/任意台帳.xlsx' }, ctx), (o) => o.includes('"ok":true') && o.includes('sheets')),
      measured({ type: 'read', utterance: 'ない資料も一応見て', target: '存在しない.txt' }, () => tool('read_files').run({ pattern: '存在しない.txt' }, ctx), (o) => o === '(該当なし)'),
      measured({ type: 'open', utterance: '概要を開いてください', target: '概要.txt' }, async () => prepareHostCommand('Invoke-Item 概要.txt', ctx), (o) => o.includes('Invoke-Item -LiteralPath')),
      measured({ type: 'open', utterance: '北.csv開いて', target: 'reports/北.csv' }, async () => prepareHostCommand('Start-Process -FilePath reports/北.csv', ctx), (o) => o.includes('Invoke-Item -LiteralPath')),
      measured({ type: 'open', utterance: '任意台帳ひらく', target: '雑多 フォルダ/任意台帳.xlsx' }, async () => prepareHostCommand('excel.exe "雑多 フォルダ/任意台帳.xlsx"', ctx), (o) => o.includes('Invoke-Item -LiteralPath')),
      measured({ type: 'write', utterance: '日付メモを新規で', target: '雑多 フォルダ/日付.txt' }, () => tool('write_file').run({ path: '雑多 フォルダ/日付.txt', content: '2026-08-27' }, ctx), (o) => o.includes('書き込み完了')),
      measured({ type: 'write', utterance: 'ratesに一言置いてください', target: 'rates/一言.txt' }, () => tool('write_file').run({ path: 'rates/一言.txt', content: '確認しました' }, ctx), (o) => o.includes('書き込み完了')),
      measured({ type: 'write', utterance: 'toolsへ箇条書きメモ', target: 'tools/箇条書き.md' }, () => tool('write_file').run({ path: 'tools/箇条書き.md', content: '- alpha\n- beta' }, ctx), (o) => o.includes('書き込み完了')),
      measured({ type: 'search', utterance: '青ってどこ？', target: '青' }, () => tool('search_files').run({ query: '青' }, ctx), (o) => o.includes('reports/北.csv')),
      measured({ type: 'search', utterance: '「赤」を全ファイル横断で探してください', target: '赤' }, () => tool('search_files').run({ query: '赤' }, ctx), (o) => o.includes('rates/為替.csv')),
      measured({ type: 'search', utterance: '緑 検索', target: '緑' }, () => tool('search_files').run({ query: '緑' }, ctx), (o) => o.includes('tools/案内.txt'))
    ]
    const results = await Promise.all(cases)
    for (const result of results) console.log(`DETERMINISTIC\t${result.type}\t${result.ok ? 'PASS' : 'FAIL'}\t${result.ms}ms\t${result.target}\t${result.utterance}\t${result.detail}`)
    summarize(results, 'DETERMINISTIC')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

type LiveCase = { type: TaskType; utterance: string; target: string; raw: string; expectedTool: string; expectedArgs: Record<string, unknown> }

const LAYER_CASES: LiveCase[] = [
  { type: 'list', utterance: 'reports見せて', target: 'reports', raw: '{"tool":"list_files","path":"reports"}', expectedTool: 'host.list_files', expectedArgs: { path: 'reports' } },
  { type: 'list', utterance: 'rates のCSV一覧をお願いします', target: 'rates', raw: 'TOOL: host.list_files\nARGS: {"path":"rates","glob":"*.csv"}', expectedTool: 'host.list_files', expectedArgs: { path: 'rates', glob: '*.csv' } },
  { type: 'list', utterance: '雑多フォルダ何ある？', target: '雑多 フォルダ', raw: '雑多 フォルダを列挙します。list_files の path は「雑多 フォルダ」です。', expectedTool: 'host.list_files', expectedArgs: { path: '雑多 フォルダ' } },
  { type: 'read', utterance: '概要読んで', target: '概要.txt', raw: '{"tool":"read_files","paths":["概要.txt"]}', expectedTool: 'host.read_files', expectedArgs: { paths: ['概要.txt'] } },
  { type: 'read', utterance: '為替CSVを拝見できますか', target: 'rates/為替.csv', raw: 'host.read_files を pattern=rates/為替.csv で呼びます。', expectedTool: 'host.read_files', expectedArgs: { pattern: 'rates/為替.csv' } },
  { type: 'read', utterance: '台帳の中身お願い', target: '雑多 フォルダ/任意台帳.xlsx', raw: 'xlsxなので read_xlsx。path は 雑多 フォルダ/任意台帳.xlsx', expectedTool: 'host.read_xlsx', expectedArgs: { path: '雑多 フォルダ/任意台帳.xlsx' } },
  { type: 'read', utterance: 'ない資料ある？', target: '存在しない.txt', raw: '{"tool":"host.read_files","args":{"pattern":"存在しない.txt"}}', expectedTool: 'host.read_files', expectedArgs: { pattern: '存在しない.txt' } },
  { type: 'open', utterance: '概要を開いてください', target: '概要.txt', raw: '{"tool":"start_process","command":"Invoke-Item 概要.txt"}', expectedTool: 'host.start_process', expectedArgs: { command: 'Invoke-Item 概要.txt' } },
  { type: 'open', utterance: '北.csv開いて', target: 'reports/北.csv', raw: 'start_process を使う。command は Start-Process -FilePath reports/北.csv', expectedTool: 'host.start_process', expectedArgs: { command: 'Start-Process -FilePath reports/北.csv' } },
  { type: 'open', utterance: '台帳ひらく', target: '雑多 フォルダ/任意台帳.xlsx', raw: '{"tool":"run_command","args":{"command":"excel.exe \\"雑多 フォルダ/任意台帳.xlsx\\""}}', expectedTool: 'host.run_command', expectedArgs: { command: 'excel.exe "雑多 フォルダ/任意台帳.xlsx"' } },
  { type: 'write', utterance: '日付メモ作って', target: '雑多 フォルダ/日付.txt', raw: '{"tool":"write_file","path":"雑多 フォルダ/日付.txt","content":"2026-08-27"}', expectedTool: 'host.write_file', expectedArgs: { path: '雑多 フォルダ/日付.txt', content: '2026-08-27' } },
  { type: 'write', utterance: '一言置いてください', target: 'rates/一言.txt', raw: 'host.write_file / path=rates/一言.txt / content=確認しました', expectedTool: 'host.write_file', expectedArgs: { path: 'rates/一言.txt', content: '確認しました' } },
  { type: 'write', utterance: '箇条書きメモよろしく', target: 'tools/箇条書き.md', raw: 'write_file で tools/箇条書き.md に「- alpha\n- beta」を新規作成。', expectedTool: 'host.write_file', expectedArgs: { path: 'tools/箇条書き.md', content: '- alpha\n- beta' } },
  { type: 'search', utterance: '青どこ', target: '青', raw: '{"tool":"search_files","query":"青"}', expectedTool: 'host.search_files', expectedArgs: { query: '青' } },
  { type: 'search', utterance: '赤を横断検索してください', target: '赤', raw: 'TOOL host.search_files ARGS {"query":"赤"}', expectedTool: 'host.search_files', expectedArgs: { query: '赤' } },
  { type: 'search', utterance: '緑 検索', target: '緑', raw: 'search_filesを使って。query=緑', expectedTool: 'host.search_files', expectedArgs: { query: '緑' } }
]

const NEGATIVE_CASES = [
  '該当するファイルはありません。',
  'ファイル名が指定されていないため、利用者への確認が必要です。',
  '処理は完了しました。',
  'list_files はファイル一覧を取得するツールです。今回は操作しません。',
  'run_command の実行は安全境界により拒否されました。',
  '書き込み先が不明なので write_file はまだ呼び出せません。',
  '{"tool":"host.unknown_tool","args":{"path":"推測.txt"}}',
  '開く対象が分かりません。対象ファイルを指定してください。',
  '例: {"tool":"host.list_files","args":{"path":"reports"}} ですが今回は操作しません。'
]

const LAYER_DEFS = TOOL_DEFS.map((entry) => ({ name: qualifiedToolName(entry.name), description: entry.description, parameters: entry.parameters }))

function validatedDecision(output: string | null, expectedTool?: string, expectedArgs: Record<string, unknown> = {}): boolean {
  const parsed = output ? extractJsonReply(output) : null
  const normalizedTool = parsed?.tool ? qualifiedToolName(parsed.tool) : undefined
  const def = normalizedTool ? TOOL_DEFS.find((entry) => qualifiedToolName(entry.name) === normalizedTool) : undefined
  const args = parsed?.args ?? {}
  const argsMatch = Object.entries(expectedArgs).every(([key, value]) => JSON.stringify(args[key]) === JSON.stringify(value))
  return normalizedTool === expectedTool && argsMatch && Boolean(def) && validateToolArgs(def!, args) === null
}

const JSONREPAIR_CASES: Array<{ name: string; raw: string; expectedTool?: string; expectedArgs?: Record<string, unknown>; reject?: boolean }> = [
  { name: 'unquoted-keys', raw: "{tool:'list_files',path:'reports'}", expectedTool: 'host.list_files', expectedArgs: { path: 'reports' } },
  { name: 'single-quotes', raw: "{'tool':'read_file','path':'概要.txt'}", expectedTool: 'host.read_file', expectedArgs: { path: '概要.txt' } },
  { name: 'trailing-object-comma', raw: '{"tool":"search_files","query":"赤",}', expectedTool: 'host.search_files', expectedArgs: { query: '赤' } },
  { name: 'trailing-array-comma', raw: '{"tool":"read_files","paths":["a.txt",]}', expectedTool: 'host.read_files', expectedArgs: { paths: ['a.txt'] } },
  { name: 'block-comment', raw: '{"tool":"list_files",/* target */"path":"reports"}', expectedTool: 'host.list_files', expectedArgs: { path: 'reports' } },
  { name: 'line-comment', raw: '{"tool":"list_files",// target\n"path":"reports"}', expectedTool: 'host.list_files', expectedArgs: { path: 'reports' } },
  { name: 'fenced-json', raw: '```json\n{"tool":"list_files","path":"reports"}\n```', expectedTool: 'host.list_files', expectedArgs: { path: 'reports' } },
  { name: 'smart-quotes', raw: '{“tool”:“read_file”,“path”:“概要.txt”}', expectedTool: 'host.read_file', expectedArgs: { path: '概要.txt' } },
  { name: 'nbsp-whitespace', raw: '{\u00a0"tool"\u00a0:\u00a0"list_files",\u00a0"path"\u00a0:\u00a0"reports"\u00a0}', expectedTool: 'host.list_files', expectedArgs: { path: 'reports' } },
  { name: 'bom-prefix', raw: '\ufeff{"tool":"list_files","path":"reports"}', expectedTool: 'host.list_files', expectedArgs: { path: 'reports' } },
  { name: 'missing-comma', raw: '{"tool":"list_files" "path":"reports"}', expectedTool: 'host.list_files', expectedArgs: { path: 'reports' } },
  { name: 'missing-colon', raw: '{"tool" "list_files","path":"reports"}', expectedTool: 'host.list_files', expectedArgs: { path: 'reports' } },
  { name: 'truncated-object', raw: '{"tool":"list_files","path":"reports"', expectedTool: 'host.list_files', expectedArgs: { path: 'reports' } },
  { name: 'truncated-args', raw: '{"tool":"read_files","args":{"paths":["a.txt"]', expectedTool: 'host.read_files', expectedArgs: { paths: ['a.txt'] } },
  { name: 'escaped-json-string', raw: '{\\"tool\\":\\"list_files\\",\\"path\\":\\"reports\\"}', expectedTool: 'host.list_files', expectedArgs: { path: 'reports' } },
  { name: 'jsonp-wrapper', raw: 'callback({"tool":"list_files","path":"reports"});', expectedTool: 'host.list_files', expectedArgs: { path: 'reports' } },
  { name: 'number-long-rejected-by-schema', raw: '{"tool":"search_files","query":"赤","max_results":NumberLong(20)}', reject: true },
  { name: 'number-int-rejected-by-schema', raw: '{"tool":"search_files","query":"赤","max_results":NumberInt(20)}', reject: true },
  { name: 'concatenated-string', raw: '{"tool":"list_files","path":"rep" + "orts"}', expectedTool: 'host.list_files', expectedArgs: { path: 'reports' } },
  { name: 'ellipsis-array', raw: '{"tool":"read_files","paths":["a.txt", ...]}', expectedTool: 'host.read_files', expectedArgs: { paths: ['a.txt'] } },
  { name: 'python-true', raw: '{"tool":"list_files","path":"reports","recursive":True}', expectedTool: 'host.list_files', expectedArgs: { path: 'reports', recursive: true } },
  { name: 'python-false', raw: '{"tool":"list_files","path":"reports","recursive":False}', expectedTool: 'host.list_files', expectedArgs: { path: 'reports', recursive: false } },
  { name: 'python-none-rejected', raw: '{"tool":"list_files","path":None}', reject: true },
  { name: 'undefined-rejected', raw: '{"tool":"list_files","path":undefined}', reject: true },
  { name: 'nan-rejected', raw: '{"tool":"search_files","query":"赤","max_results":NaN}', reject: true },
  { name: 'infinity-rejected', raw: '{"tool":"search_files","query":"赤","max_results":Infinity}', reject: true },
  { name: 'ground-prose-json', raw: '次を実行します。{"tool":"list_files","path":"reports"} 以上です。', expectedTool: 'host.list_files', expectedArgs: { path: 'reports' } },
  { name: 'multiple-candidates-last', raw: '{"answer":"草稿"}\n訂正: {"tool":"list_files","path":"reports"}', expectedTool: 'host.list_files', expectedArgs: { path: 'reports' } },
  { name: 'japanese-open-quote', raw: '{"tool":"write_file","path":"メモ.txt","content":「確認」}', expectedTool: 'host.write_file', expectedArgs: { path: 'メモ.txt', content: '「確認」' } },
  { name: 'incomplete-optional-tail-rejected', raw: '{"tool":"list_files","args":{"path":"reports","recursive":"', reject: true }
]

async function layer1Corpus(): Promise<void> {
  const results: Result[] = []
  for (const item of LAYER_CASES) {
    const started = Date.now()
    const converted = interpretCopilotResponseDeterministically(item.raw, LAYER_DEFS)
    const ok = validatedDecision(converted?.content ?? null, item.expectedTool, item.expectedArgs)
    results.push({ type: item.type, utterance: item.utterance, target: item.target, ok, ms: Date.now() - started, detail: converted ? `${converted.method}:${converted.repairs.join(',')}:${converted.content.slice(0, 140)}` : '(null)' })
  }
  for (const result of results) console.log(`LAYER1\t${result.type}\t${result.ok ? 'PASS' : 'FAIL'}\t${result.ms}ms\t${result.target}\t${result.detail}`)
  summarize(results, 'LAYER1')

  let falsePositive = 0
  for (const raw of NEGATIVE_CASES) {
    const converted = interpretCopilotResponseDeterministically(raw, LAYER_DEFS)
    const parsed = converted ? extractJsonReply(converted.content) : null
    const ok = !parsed?.tool && typeof parsed?.answer === 'string' && parsed.answer.trim().length > 0
    if (!ok) falsePositive++
    console.log(`LAYER1_NEGATIVE\t${ok ? 'PASS' : 'FAIL'}\t${converted?.method ?? 'null'}\t${raw}`)
  }
  console.log(`LAYER1_NEGATIVE_SUMMARY ${JSON.stringify({ total: NEGATIVE_CASES.length, falsePositive })}`)
  if (falsePositive !== 0) process.exitCode = 1

  let repairFailures = 0
  for (const item of JSONREPAIR_CASES) {
    const converted = interpretCopilotResponseDeterministically(item.raw, LAYER_DEFS)
    const parsed = converted ? extractJsonReply(converted.content) : null
    const validTool = parsed?.tool ? validatedDecision(converted!.content, item.expectedTool, item.expectedArgs ?? {}) : false
    const ok = item.reject ? !validTool : validTool
    if (!ok) repairFailures++
    console.log(`LAYER1_JSONREPAIR\t${ok ? 'PASS' : 'FAIL'}\t${item.name}\t${converted?.method ?? 'null'}\t${converted?.repairs.join(',') ?? ''}\t${converted?.content.slice(0, 120) ?? '(null)'}`)
  }
  console.log(`LAYER1_JSONREPAIR_SUMMARY ${JSON.stringify({ total: JSONREPAIR_CASES.length, failures: repairFailures })}`)
  if (repairFailures !== 0) process.exitCode = 1
}

async function liveConverterCorpus(): Promise<void> {
  const model = process.env.FLEX_CONVERTER_MODEL || 'Qwen3.5-4B-Q4_K_M.gguf'
  const settings = { enabled: true, baseURL: 'http://127.0.0.1:8080/v1', model, timeoutMs: 30000, apiKey: 'company-apps-flex-local' }
  const defs = TOOL_DEFS.map((entry) => ({ name: qualifiedToolName(entry.name), description: entry.description, parameters: entry.parameters }))
  const cases: LiveCase[] = [
    { type: 'list', utterance: 'reports見せて', target: 'reports', raw: '{"tool":"list_files","path":"reports"}', expectedTool: 'host.list_files', expectedArgs: { path: 'reports' } },
    { type: 'list', utterance: 'rates のCSV一覧をお願いします', target: 'rates', raw: 'TOOL: host.list_files\nARGS: {"path":"rates","glob":"*.csv"}', expectedTool: 'host.list_files', expectedArgs: { path: 'rates', glob: '*.csv' } },
    { type: 'list', utterance: '雑多フォルダ何ある？', target: '雑多 フォルダ', raw: '雑多 フォルダを列挙します。list_files の path は「雑多 フォルダ」です。', expectedTool: 'host.list_files', expectedArgs: { path: '雑多 フォルダ' } },
    { type: 'read', utterance: '概要読んで', target: '概要.txt', raw: '{"tool":"read_files","paths":["概要.txt"]}', expectedTool: 'host.read_files', expectedArgs: { paths: ['概要.txt'] } },
    { type: 'read', utterance: '為替CSVを拝見できますか', target: 'rates/為替.csv', raw: 'host.read_files を pattern=rates/為替.csv で呼びます。', expectedTool: 'host.read_files', expectedArgs: { pattern: 'rates/為替.csv' } },
    { type: 'read', utterance: '台帳の中身お願い', target: '雑多 フォルダ/任意台帳.xlsx', raw: 'xlsxなので read_xlsx。path は 雑多 フォルダ/任意台帳.xlsx', expectedTool: 'host.read_xlsx', expectedArgs: { path: '雑多 フォルダ/任意台帳.xlsx' } },
    { type: 'read', utterance: 'ない資料ある？', target: '存在しない.txt', raw: '{"tool":"host.read_files","args":{"pattern":"存在しない.txt"}}', expectedTool: 'host.read_files', expectedArgs: { pattern: '存在しない.txt' } },
    { type: 'open', utterance: '概要を開いてください', target: '概要.txt', raw: '{"tool":"start_process","command":"Invoke-Item 概要.txt"}', expectedTool: 'host.start_process', expectedArgs: { command: 'Invoke-Item 概要.txt' } },
    { type: 'open', utterance: '北.csv開いて', target: 'reports/北.csv', raw: 'start_process を使う。command は Start-Process -FilePath reports/北.csv', expectedTool: 'host.start_process', expectedArgs: { command: 'Start-Process -FilePath reports/北.csv' } },
    { type: 'open', utterance: '台帳ひらく', target: '雑多 フォルダ/任意台帳.xlsx', raw: '{"tool":"run_command","args":{"command":"excel.exe \\"雑多 フォルダ/任意台帳.xlsx\\""}}', expectedTool: 'host.run_command', expectedArgs: { command: 'excel.exe "雑多 フォルダ/任意台帳.xlsx"' } },
    { type: 'write', utterance: '日付メモ作って', target: '雑多 フォルダ/日付.txt', raw: '{"tool":"write_file","path":"雑多 フォルダ/日付.txt","content":"2026-08-27"}', expectedTool: 'host.write_file', expectedArgs: { path: '雑多 フォルダ/日付.txt', content: '2026-08-27' } },
    { type: 'write', utterance: '一言置いてください', target: 'rates/一言.txt', raw: 'host.write_file / path=rates/一言.txt / content=確認しました', expectedTool: 'host.write_file', expectedArgs: { path: 'rates/一言.txt', content: '確認しました' } },
    { type: 'write', utterance: '箇条書きメモよろしく', target: 'tools/箇条書き.md', raw: 'write_file で tools/箇条書き.md に「- alpha\n- beta」を新規作成。', expectedTool: 'host.write_file', expectedArgs: { path: 'tools/箇条書き.md', content: '- alpha\n- beta' } },
    { type: 'search', utterance: '青どこ', target: '青', raw: '{"tool":"search_files","query":"青"}', expectedTool: 'host.search_files', expectedArgs: { query: '青' } },
    { type: 'search', utterance: '赤を横断検索してください', target: '赤', raw: 'TOOL host.search_files ARGS {"query":"赤"}', expectedTool: 'host.search_files', expectedArgs: { query: '赤' } },
    { type: 'search', utterance: '緑 検索', target: '緑', raw: 'search_filesを使って。query=緑', expectedTool: 'host.search_files', expectedArgs: { query: '緑' } }
  ]
  const results: Result[] = []
  for (const item of cases) {
    const started = Date.now()
    try {
      const output = await convertCopilotResponse(settings, item.raw, defs)
      const parsed = output ? extractJsonReply(output) : null
      const normalizedTool = parsed?.tool ? qualifiedToolName(parsed.tool) : undefined
      const def = normalizedTool ? TOOL_DEFS.find((entry) => qualifiedToolName(entry.name) === normalizedTool) : undefined
      const args = parsed?.args ?? {}
      const argsMatch = Object.entries(item.expectedArgs).every(([key, value]) => JSON.stringify(args[key]) === JSON.stringify(value))
      const ok = normalizedTool === item.expectedTool && argsMatch && Boolean(def) && validateToolArgs(def!, args) === null
      results.push({ type: item.type, utterance: item.utterance, target: item.target, ok, ms: Date.now() - started, detail: output?.slice(0, 180) ?? '(null)' })
    } catch (error) {
      results.push({ type: item.type, utterance: item.utterance, target: item.target, ok: false, ms: Date.now() - started, detail: String((error as Error).message ?? error).slice(0, 180) })
    }
  }
  for (const result of results) console.log(`LIVE_CONVERTER\t${result.type}\t${result.ok ? 'PASS' : 'FAIL'}\t${result.ms}ms\t${result.target}\t${result.utterance}\t${result.detail}`)
  summarize(results, 'LIVE_CONVERTER')

  const negativeCases = [
    '該当するファイルはありません。',
    'ファイル名が指定されていないため、利用者への確認が必要です。',
    '処理は完了しました。',
    'list_files はファイル一覧を取得するツールです。今回は操作しません。',
    'run_command の実行は安全境界により拒否されました。',
    '書き込み先が不明なので write_file はまだ呼び出せません。',
    '{"tool":"host.unknown_tool","args":{"path":"推測.txt"}}',
    '開く対象が分かりません。対象ファイルを指定してください。'
  ]
  let falsePositive = 0
  for (const raw of negativeCases) {
    const started = Date.now()
    let detail = ''
    let ok = false
    try {
      const output = await convertCopilotResponse(settings, raw, defs)
      const parsed = output ? extractJsonReply(output) : null
      ok = !parsed?.tool && typeof parsed?.answer === 'string' && parsed.answer.trim().length > 0
      detail = output?.slice(0, 180) ?? '(null)'
    } catch (error) {
      detail = String((error as Error).message ?? error).slice(0, 180)
    }
    if (!ok) falsePositive++
    console.log(`NEGATIVE_CONVERTER\t${ok ? 'PASS' : 'FAIL'}\t${Date.now() - started}ms\t${raw}\t${detail}`)
  }
  console.log(`NEGATIVE_CONVERTER_SUMMARY ${JSON.stringify({ model, total: negativeCases.length, falsePositive })}`)
  if (falsePositive !== 0) process.exitCode = 1
}

async function main(): Promise<void> {
  await deterministicCorpus()
  await layer1Corpus()
  if (process.argv.includes('--live')) await liveConverterCorpus()
}

main().catch((error) => { console.error(error); process.exit(1) })
