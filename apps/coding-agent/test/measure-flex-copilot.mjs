import fs from 'node:fs'
import path from 'node:path'

const baseURL = process.argv[2] ?? 'http://127.0.0.1:3951'
const workspace = path.resolve(process.argv[3] ?? '.tmp/flex-copilot-performance')
const outputPath = path.resolve(process.argv[4] ?? '.tmp/flex-copilot-performance-result.json')

fs.mkdirSync(workspace, { recursive: true })
const ensureFixture = (name, content) => {
  const target = path.join(workspace, name)
  try { if (fs.readFileSync(target, 'utf8') === content) return } catch {}
  fs.writeFileSync(target, content, 'utf8')
}
ensureFixture('概要.txt', '色: 青\n用途: 区間計測\n')
ensureFixture('検索資料.txt', '計測キーワード: 赤\n')
ensureFixture('表示用.csv', '項目,値\n速度,確認\n')
try { fs.rmSync(path.join(workspace, '計測メモ.txt'), { force: true }) } catch {}

const tasks = [
  { type: 'list', request: 'ここ直下、何ある？', expectedTool: 'list_files' },
  { type: 'read', request: '概要.txtを読んで、色を教えて', expectedTool: ['read_file', 'read_files'] },
  { type: 'search', request: '「赤」を全ファイルから探して', expectedTool: 'search_files' },
  { type: 'write', request: '計測メモ.txtを新しく作って、本文を「速度確認」にして', expectedTool: 'write_file' },
  { type: 'open', request: '表示用.csvを実際に開いて', expectedTool: ['start_process', 'run_command'] }
]

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(options.headers ?? {}) }
  })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = { text } }
  if (!response.ok) throw new Error(`${response.status} ${url}: ${JSON.stringify(body)}`)
  return body
}

async function resolveApprovalsUntil(done, sessionId, task) {
  while (!done.value) {
    try {
      const sessionList = await jsonRequest(`${baseURL}/api/sessions`)
      const currentSession = (sessionList.sessions ?? []).find((entry) => entry.id === sessionId)
      const expectedRunId = currentSession?.latestRun?.id ?? null
      const pending = await jsonRequest(`${baseURL}/api/approvals`)
      for (const approval of pending.approvals ?? []) {
        if (!expectedRunId || approval.runId !== expectedRunId || path.resolve(String(approval.scope ?? '')) !== workspace) continue
        const toolName = String(approval.toolName ?? '')
        const binding = approval.binding ?? {}
        const permitted = task.type === 'write'
          ? toolName.endsWith('write_file') && binding.path === '計測メモ.txt' && binding.existedBefore === false
          : task.type === 'open'
            ? ['host.start_process', 'host.run_command'].includes(toolName) && /(?:^|[\\/])表示用\.csv(?:["']|$)/u.test(String(binding.command ?? ''))
            : false
        await jsonRequest(`${baseURL}/api/approvals/resolve`, {
          method: 'POST', body: JSON.stringify({
            id: approval.id,
            approved: permitted,
            reason: permitted ? 'performance benchmark fixture approval' : 'performance benchmark rejected an unexpected approval'
          })
        })
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

const results = []
for (const task of tasks) {
  const sessionStartedAt = performance.now()
  const session = await jsonRequest(`${baseURL}/api/sessions`, { method: 'POST', body: '{}' })
  const sessionCreationApiMs = Math.round(performance.now() - sessionStartedAt)
  const done = { value: false }
  const approvalWorker = resolveApprovalsUntil(done, session.id, task)
  const startedAt = performance.now()
  let response
  try {
    response = await jsonRequest(`${baseURL}/api/turn`, {
      method: 'POST', body: JSON.stringify({ message: task.request, mode: 'work', sessionId: session.id })
    })
  } finally {
    done.value = true
    await approvalWorker
  }
  const endToEndMs = Math.round(performance.now() - startedAt)
  const events = response.run?.events ?? []
  const modelEvents = events.filter((event) => event.type === 'model.decision')
  const allToolEvents = events.filter((event) => event.type === 'tool.succeeded')
  const toolEvents = allToolEvents.filter((event) => event.callId !== 'host-bootstrap-0')
  const expected = Array.isArray(task.expectedTool) ? task.expectedTool : [task.expectedTool]
  const matchingPool = task.type === 'list' ? allToolEvents : toolEvents
  const matchedTool = matchingPool.find((event) => expected.some((name) => String(event.tool ?? '').endsWith(name)))
  let semanticOk = response.aborted !== true && Boolean(matchedTool)
  if (task.type === 'list') semanticOk = semanticOk && ['検索資料.txt', '概要.txt', '表示用.csv'].every((name) => String(response.reply ?? '').includes(name))
  if (task.type === 'read') semanticOk = semanticOk && String(response.reply ?? '').includes('青')
  if (task.type === 'search') semanticOk = semanticOk && (String(response.reply ?? '').includes('検索資料') || String(matchedTool?.output ?? '').includes('検索資料'))
  if (task.type === 'write') semanticOk = semanticOk && fs.existsSync(path.join(workspace, '計測メモ.txt')) && fs.readFileSync(path.join(workspace, '計測メモ.txt'), 'utf8').includes('速度確認')
  const modelPhases = modelEvents.map((event) => ({
    durationMs: event.durationMs ?? null,
    interpretationLayer: event.metadata?.interpretationLayer ?? null,
    interpretationMethod: event.metadata?.interpretationMethod ?? null,
    interpretationRepairs: event.metadata?.interpretationRepairs ?? [],
    layer1Ms: event.metadata?.layer1Ms ?? null,
    converterMs: event.metadata?.converterMs ?? null,
    ...(event.metadata?.copilot ?? {})
  }))
  const result = {
    ...task,
    sessionId: session.id,
    runId: response.run?.id ?? null,
    ok: semanticOk,
    aborted: response.aborted === true,
    sessionCreationApiMs,
    endToEndMs,
    modelPhases,
    toolExecutionMs: toolEvents.map((event) => ({ tool: event.tool, durationMs: event.durationMs ?? null })),
    reply: String(response.reply ?? '').slice(0, 300)
  }
  results.push(result)
  console.log(`FLEX_REAL_TIMING\t${task.type}\t${semanticOk ? 'PASS' : 'FAIL'}\t${endToEndMs}ms\t${JSON.stringify(modelPhases)}`)
}

const phaseKeys = ['connectionMs', 'sessionCreationMs', 'inputReadyMs', 'modelSelectionMs', 'prePromptReadyMs', 'promptWriteMs', 'baselineReadMs', 'sendMs', 'generationWaitMs', 'completionRetrievalMs', 'layer1Ms', 'converterMs']
const phaseTotals = Object.fromEntries(phaseKeys.map((key) => [key, results.flatMap((result) => result.modelPhases.map((phase) => Number(phase[key] ?? 0))).reduce((sum, value) => sum + value, 0)]))
const summary = {
  measuredAt: new Date().toISOString(),
  baseURL,
  workspace,
  success: results.filter((result) => result.ok).length,
  total: results.length,
  endToEndMinMs: Math.min(...results.map((result) => result.endToEndMs)),
  endToEndMaxMs: Math.max(...results.map((result) => result.endToEndMs)),
  phaseTotals,
  dominantPhase: Object.entries(phaseTotals).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
  interpretationLayers: results.flatMap((result) => result.modelPhases).reduce((counts, phase) => {
    const layer = phase.interpretationLayer ?? 'unknown'
    counts[layer] = (counts[layer] ?? 0) + 1
    return counts
  }, {}),
  results
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2) + '\n', 'utf8')
console.log('FLEX_REAL_TIMING_SUMMARY ' + JSON.stringify({ success: summary.success, total: summary.total, endToEndMinMs: summary.endToEndMinMs, endToEndMaxMs: summary.endToEndMaxMs, phaseTotals, dominantPhase: summary.dominantPhase, interpretationLayers: summary.interpretationLayers }))
if (summary.success !== summary.total) process.exitCode = 1
