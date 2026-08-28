import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  deriveCompletionPolicy,
  extractPathLikeTargets,
  recordSuccessfulTool,
  recordToolOutcome,
  shouldEnterToolsClosedFinal,
  type CompletionPolicyState
} from '../src/completion-policy'
import type { ActiveToolsSelection } from '../src/active-tools'

function selection(category: ActiveToolsSelection['category'], conservativeFallback = false): ActiveToolsSelection {
  return { toolDefs: [], category, conservativeFallback, reason: 'test selection' }
}

function policy(request: string, category: ActiveToolsSelection['category'] = 'read', conservativeFallback = false): CompletionPolicyState {
  return deriveCompletionPolicy(request, selection(category, conservativeFallback))
}

function successful(state: CompletionPolicyState, tool: string, args: Record<string, unknown>): CompletionPolicyState {
  return recordSuccessfulTool(state, tool, args)
}

function testSingleRead(): void {
  let state = policy('A.txtを読んで')
  assert.equal(state.mode, 'single-read')
  assert.equal(shouldEnterToolsClosedFinal(state), false)
  state = successful(state, 'read_file', { path: 'A.txt' })
  assert.equal(shouldEnterToolsClosedFinal(state), true)
}

function testDiscoveryChainsStayOpen(): void {
  for (const request of ['作業フォルダから請求書を探して、そのファイルを読んで内容を教えて', '一覧を確認して、そのファイルを読んで', 'ファイルを探して結果をoutput.txtへ書いて']) {
    const state = policy(request)
    assert.equal(state.enabled, false)
    assert.equal(state.reason, 'disabled-discovery-chain')
    const tool = request.includes('output.txt') ? 'write_file' : request.includes('探') ? 'search_files' : 'list_files'
    assert.equal(shouldEnterToolsClosedFinal(recordSuccessfulTool(state, tool, {})), false)
  }
}

function testPureDiscoveryCanClose(): void {
  let list = policy('ワークスペースのファイルを一覧してください')
  assert.equal(list.mode, 'pure-list')
  list = successful(list, 'list_files', {})
  assert.equal(shouldEnterToolsClosedFinal(list), true)

  let search = policy('ファイル内容を検索してください')
  assert.equal(search.mode, 'pure-search')
  search = successful(search, 'search_files', { query: 'keyword' })
  assert.equal(shouldEnterToolsClosedFinal(search), true)
}

function testMultipleReads(): void {
  let state = policy('A.txtとB.txtを読んで比較して')
  assert.equal(state.mode, 'multi-read')
  state = successful(state, 'read_file', { path: 'A.txt' })
  assert.equal(shouldEnterToolsClosedFinal(state), false)
  state = successful(state, 'read_file', { path: 'B.txt' })
  assert.equal(shouldEnterToolsClosedFinal(state), true)

  let batch = policy('A.txtとB.txtを読んで比較して')
  batch = successful(batch, 'read_files', { paths: ['A.txt', 'B.txt'] })
  assert.equal(shouldEnterToolsClosedFinal(batch), true)

  let pattern = policy('A.txtとB.txtを読んで比較して')
  pattern = successful(pattern, 'read_files', { pattern: '*.txt' })
  assert.equal(shouldEnterToolsClosedFinal(pattern), false)
}

function testMultipleWrites(): void {
  let state = policy('A.txtとB.txtを作成して', 'write')
  assert.equal(state.mode, 'multi-write')
  state = successful(state, 'write_file', { path: 'A.txt', content: 'a' })
  assert.equal(shouldEnterToolsClosedFinal(state), false)
  state = successful(state, 'write_file', { path: 'B.txt', content: 'b' })
  assert.equal(shouldEnterToolsClosedFinal(state), true)
}

function testReadWriteRequiresBothRoles(): void {
  let state = policy('source.txtを読んで、結果をoutput.txtへ書いて', 'read-write')
  assert.equal(state.mode, 'read-write')
  state = successful(state, 'read_file', { path: 'source.txt' })
  assert.equal(shouldEnterToolsClosedFinal(state), false)
  state = successful(state, 'write_file', { path: 'output.txt', content: 'result' })
  assert.equal(shouldEnterToolsClosedFinal(state), true)

  const ambiguous = policy('A.txtを読んで保存して', 'read-write')
  assert.equal(ambiguous.enabled, false)
  assert.equal(ambiguous.reason, 'disabled-ambiguous-target')
}

function testSingleWriteAndPathExtraction(): void {
  let state = policy('output.txtを作成して', 'write')
  assert.equal(state.mode, 'single-write')
  state = successful(state, 'write_file', { path: 'output.txt', content: 'ok' })
  assert.equal(shouldEnterToolsClosedFinal(state), true)
  assert.deepEqual(extractPathLikeTargets('../dir\\output.txt と data.json'), ['../dir/output.txt', 'data.json'])
  assert.deepEqual(extractPathLikeTargets('概要_日本語.txtを読んで、色を教えてください。'), ['概要_日本語.txt'])
}

function testQ6ProfileContract(): void {
  const q6 = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'config.ollama.q6.json'), 'utf8')) as Record<string, any>
  assert.equal(q6.agentLoop, 'v2')
  assert.equal(q6.provider, 'ollama')
  assert.equal(q6.model, 'hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q6_K')
  assert.equal(q6.agentOptimization, 'on')
  assert.equal(q6.reasoningEffort, 'none')
  assert.deepEqual(q6.generationLimits, {
    readToolRequestMaxOutputTokens: 128,
    actionToolRequestMaxOutputTokens: 1024,
    finalResponseMaxOutputTokens: 192
  })
  assert.equal(Object.hasOwn(q6, 'num_ctx'), false)
  const q4 = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'config.ollama.json'), 'utf8')) as Record<string, any>
  assert.equal(q4.model, 'ornith-1.5:9b')
  assert.equal(q4.generationLimits.readToolRequestMaxOutputTokens, 256)
}

function testFailClosedKindsAndFailures(): void {
  for (const [request, category] of [
    ['コマンドを実行して', 'command'],
    ['実装してください', 'write'],
    ['それを処理して', 'uncertain']
  ] as const) {
    const state = policy(request, category)
    assert.equal(state.enabled, false)
    assert.equal(shouldEnterToolsClosedFinal(successful(state, 'read_file', { path: 'A.txt' })), false)
  }

  let state = policy('A.txtを読んで')
  state = recordToolOutcome(state, 'read_file', { path: 'A.txt' }, 'failed')
  assert.equal(shouldEnterToolsClosedFinal(state), false)
  state = successful(state, 'read_file', { path: 'A.txt' })
  assert.equal(shouldEnterToolsClosedFinal(state), false, 'a later success must not erase a failure')
}

function testOptimizationOffAndUncertain(): void {
  assert.equal(deriveCompletionPolicy('A.txtを読んで', selection('read'), { optimizationEnabled: false }).enabled, false)
  assert.equal(policy('A.txtを読んで', 'read', true).enabled, false)
  assert.equal(policy('A.txtを読んで', 'explicit-run-scoped').enabled, false)
}

testSingleRead()
testDiscoveryChainsStayOpen()
testPureDiscoveryCanClose()
testMultipleReads()
testMultipleWrites()
testReadWriteRequiresBothRoles()
testSingleWriteAndPathExtraction()
testQ6ProfileContract()
testFailClosedKindsAndFailures()
testOptimizationOffAndUncertain()
console.log('PASS completion-policy')
