import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const runTag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const tempRoot = path.join(projectRoot, '.tmp', `q6-cap-${runTag}`)
const workspace = path.join(tempRoot, 'workspace')
const auditDir = path.join(tempRoot, 'audit')
const appData = path.join(tempRoot, 'appdata')
const localAppData = path.join(tempRoot, 'localappdata')
const configPath = path.join(tempRoot, 'config.json')
const outputPath = path.resolve(process.env.Q6_CAP_OUTPUT ?? path.join(projectRoot, '.tmp', 'q6-cap-comparison.json'))
const model = 'hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q6_K'
const baseURL = 'http://127.0.0.1:11434/v1'
const timeoutMs = 180_000
const prompt = '概要_日本語.txtを読んで、色を教えてください。'
const writePrompt = 'Use the host write_file tool once. Path: approved-write_日本語.txt. Content: 速度確認.'
const writeTarget = 'approved-write_日本語.txt'
const q6ProfilePath = path.join(projectRoot, 'config.ollama.q6.json')

let child = null
let serverURL = null

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function jsonRequest(url, options = {}, requestTimeoutMs = timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
  try {
    const response = await fetch(url, {
      ...options,
      signal: options.signal ?? controller.signal,
      headers: { 'content-type': 'application/json; charset=utf-8', ...(options.headers ?? {}) }
    })
    const text = await response.text()
    let body
    try { body = JSON.parse(text) } catch { body = null }
    if (!response.ok) {
      const error = new Error('http-error')
      error.code = `http-${response.status}`
      throw error
    }
    return body
  } finally {
    clearTimeout(timer)
  }
}

function originForOllama(value) {
  const parsed = new URL(value)
  return `${parsed.protocol}//${parsed.host}`
}

async function queryOllamaPs() {
  const response = await fetch(`${originForOllama(baseURL)}/api/ps`, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error('ollama-ps-failed')
  const body = await response.json()
  const models = Array.isArray(body?.models) ? body.models : []
  const selected = models.find((entry) => String(entry?.name ?? entry?.model ?? '') === model)
  return {
    loaded: Boolean(selected),
    context: selected?.context_length ?? selected?.contextLength ?? selected?.details?.context_length ?? null,
    size: selected?.size ?? selected?.size_bytes ?? null
  }
}

async function unloadModel() {
  let commandSucceeded = false
  try {
    await execFileAsync('ollama', ['stop', model], { windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 })
    commandSucceeded = true
  } catch {
    // `ollama stop` is still an explicit unload request when no model was
    // resident; keep the result safe and bounded rather than saving stderr.
  }
  return { requested: true, commandSucceeded }
}

function writeFixtures() {
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, '概要_日本語.txt'), '色: 青\n用途: Q6 cold cap 検証\n', 'utf8')
  try { fs.rmSync(path.join(workspace, writeTarget), { force: true }) } catch {}
}

function writeConfig(readCap, writeMode = false) {
  const profile = JSON.parse(fs.readFileSync(q6ProfilePath, 'utf8'))
  profile.generationLimits.readToolRequestMaxOutputTokens = readCap
  profile.auditLogDir = auditDir
  if (writeMode) {
    profile.systemPrompt = [
      'あなたはローカルOllamaのコーディング支援エージェントです。必ずhostツールで確認してから日本語で回答してください。',
      '書き込みはwrite_fileで指定された新規ファイルだけを作り、本文をそのまま保存してください。',
      'ツール呼び出しは常に一度に一つだけにし、内部思考タグや<think>を最終回答へ出力しないでください。',
      '外部通信、任意コマンド、指定外のファイル操作はしないでください。',
      'この依頼ではwrite_fileを一度だけ呼び出してから回答してください。'
    ].join('\n')
  }
  fs.mkdirSync(tempRoot, { recursive: true })
  fs.writeFileSync(configPath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
}

async function startServer(readCap, writeMode = false) {
  writeConfig(readCap, writeMode)
  const port = await freePort()
  child = spawn(process.execPath, ['dist/server.js', '--config', configPath, '--workspace', workspace], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      CODING_AGENT_NO_BROWSER: '1',
      NO_COLOR: '1'
    },
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore']
  })
  serverURL = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server-exited')
    try {
      await jsonRequest(`${serverURL}/api/sessions`, {}, 2_000)
      return serverURL
    } catch {
      await sleep(200)
    }
  }
  throw new Error('server-not-ready')
}

async function stopServer() {
  if (!child || child.exitCode !== null) return
  const processChild = child
  await new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      try { processChild.kill('SIGKILL') } catch {}
      finish()
    }, 5_000)
    processChild.once('close', finish)
    try { processChild.kill('SIGTERM') } catch { finish() }
  })
  child = null
  serverURL = null
}

function safeError(error) {
  if (error?.name === 'AbortError') return 'timeout'
  return typeof error?.code === 'string' ? error.code : 'request-failed'
}

function eventsFor(response) {
  return Array.isArray(response?.run?.events) ? response.run.events : []
}

function requestTelemetry(events) {
  return events
    .filter((event) => event.type === 'model.decision')
    .map((event) => event.metadata?.requestTelemetry)
    .filter((record) => record && typeof record === 'object')
    .map((record) => ({
      generationPhase: record.generationPhase ?? null,
      exposedToolCount: Number.isInteger(record.exposedToolCount) ? record.exposedToolCount : null,
      toolSchemaBytes: Number.isInteger(record.toolSchemaBytes) ? record.toolSchemaBytes : null,
      requestedMaxOutputTokens: Number.isInteger(record.requestedMaxOutputTokens) ? record.requestedMaxOutputTokens : null
    }))
}

function safeSummary(response, elapsedMs, extra = {}) {
  const events = eventsFor(response)
  const rawEventText = events.map((event) => JSON.stringify(event)).join('\n')
  const toolCallNames = events
    .filter((event) => event.type === 'tool.requested')
    .map((event) => String(event.tool ?? ''))
  const warningCount = events.filter((event) => event.type === 'run.warning').length
  const failureCount = events.filter((event) => ['tool.failed', 'tool.denied', 'run.failed'].includes(event.type)).length
  const safetyRejectionCount = events.filter((event) => event.type === 'tool.denied').length
  const approvalRequestedCount = events.filter((event) => event.type === 'approval.requested' && event.metadata?.approval?.id).length
  const approvalResolvedCount = events.filter((event) => event.type === 'approval.resolved' && event.metadata?.approval?.id && event.approved === true).length
  const truncation = /truncat|切り詰め|省略|argument.{0,20}(?:cut|trim)|args.{0,20}(?:cut|trim)/iu.test(rawEventText)
  const reply = String(response?.reply ?? '')
  const expected = extra.expected ?? 'read'
  const finalReplyEstablished = expected === 'write' ? response?.aborted !== true : response?.aborted !== true && reply.includes('青')
  const successfulRead = events.some((event) => event.type === 'tool.succeeded' && String(event.tool ?? '').endsWith('read_file'))
  const successfulWrite = events.some((event) => event.type === 'tool.succeeded' && String(event.tool ?? '').endsWith('write_file'))
  return {
    ...extra,
    elapsedMs,
    aborted: response?.aborted === true,
    modelDecisionCount: events.filter((event) => event.type === 'model.decision').length,
    toolCallNames,
    requestTelemetry: requestTelemetry(events),
    warningCount,
    failureCount,
    safetyRejectionCount,
    approvalRequestedCount,
    approvalResolvedCount,
    truncation,
    argsTruncated: truncation,
    successfulRead,
    successfulWrite,
    finalReplyEstablished,
    pass: (expected === 'write' ? successfulWrite && finalReplyEstablished : successfulRead && finalReplyEstablished) && warningCount === 0 && failureCount === 0 && safetyRejectionCount === 0 && !truncation
  }
}

async function runRead(server, cold, runNumber, unload = null) {
  const session = await jsonRequest(`${server}/api/sessions`, { method: 'POST', body: '{}' }, 10_000)
  const startedAt = performance.now()
  try {
    const response = await jsonRequest(`${server}/api/turn`, {
      method: 'POST',
      body: JSON.stringify({ message: prompt, mode: 'work', sessionId: session.id })
    }, timeoutMs)
    return safeSummary(response, Math.round(performance.now() - startedAt), { cold, run: runNumber, unload })
  } catch (error) {
    return {
      cold,
      run: runNumber,
      unload,
      elapsedMs: Math.round(performance.now() - startedAt),
      aborted: true,
      modelDecisionCount: 0,
      toolCallNames: [],
      requestTelemetry: [],
      warningCount: 0,
      failureCount: 0,
      safetyRejectionCount: 0,
      approvalRequestedCount: 0,
      approvalResolvedCount: 0,
      truncation: false,
      argsTruncated: false,
      successfulRead: false,
      successfulWrite: false,
      finalReplyEstablished: false,
      pass: false,
      error: safeError(error)
    }
  }
}

async function resolveWriteApprovals(state, server, sessionId) {
  while (!state.done && !state.error) {
    try {
      const sessions = await jsonRequest(`${server}/api/sessions`, {}, 10_000)
      const current = (sessions?.sessions ?? []).find((entry) => entry.id === sessionId)
      const runId = current?.latestRun?.id
      const pending = await jsonRequest(`${server}/api/approvals`, {}, 10_000)
      for (const approval of pending?.approvals ?? []) {
        if (!runId || approval.runId !== runId) continue
        const binding = approval.binding ?? {}
        const permitted = path.resolve(String(approval.scope ?? '')) === path.resolve(workspace)
          && String(approval.toolName ?? '').endsWith('write_file')
          && binding.path === writeTarget
          && binding.existedBefore === false
          && !String(binding.command ?? '')
        await jsonRequest(`${server}/api/approvals/resolve`, {
          method: 'POST',
          body: JSON.stringify({ id: approval.id, approved: permitted })
        }, 10_000)
        if (!permitted) state.error = 'unexpected-approval'
      }
    } catch (error) {
      if (safeError(error) === 'timeout') state.error = 'approval-timeout'
    }
    if (!state.done && !state.error) await sleep(150)
  }
}

async function runApprovedWrite(server) {
  try {
    fs.rmSync(path.join(workspace, writeTarget), { force: true })
    const session = await jsonRequest(`${server}/api/sessions`, { method: 'POST', body: '{}' }, 10_000)
    const state = { done: false, error: null }
    const approvalWorker = resolveWriteApprovals(state, server, session.id)
    const startedAt = performance.now()
    let response
    try {
      response = await jsonRequest(`${server}/api/turn`, {
        method: 'POST',
        body: JSON.stringify({ message: writePrompt, mode: 'work', sessionId: session.id })
      }, timeoutMs)
    } catch (error) {
      state.error = safeError(error)
    } finally {
      state.done = true
      await approvalWorker
    }
    if (!response || state.error) return { pass: false, error: state.error ?? 'request-failed', elapsedMs: Math.round(performance.now() - startedAt) }
    const summary = safeSummary(response, Math.round(performance.now() - startedAt), { approved: true, expected: 'write' })
    const written = fs.existsSync(path.join(workspace, writeTarget)) && fs.readFileSync(path.join(workspace, writeTarget), 'utf8').includes('速度確認')
    return { ...summary, approved: true, written, pass: summary.pass && written && summary.approvalRequestedCount === 1 && summary.approvalResolvedCount === 1 }
  } catch (error) {
    return { pass: false, error: safeError(error) }
  }
}

function allStable(results) {
  return results.length === 3 && results.every((result) => result.pass && !result.truncation && !result.argsTruncated && result.finalReplyEstablished && result.warningCount === 0 && result.safetyRejectionCount === 0)
}

function chooseCap(resultsByCap) {
  const cap128 = resultsByCap.get(128) ?? []
  const cap256 = resultsByCap.get(256) ?? []
  if (allStable(cap128)) return { cap: 128, status: 'PASS', reason: '128 cold 3/3 met all stability criteria' }
  const marginMs = cap256.map((result) => timeoutMs - result.elapsedMs)
  if (allStable(cap256) && marginMs.every((value) => value >= 5_000)) return { cap: 256, status: 'PASS', reason: '128 was unstable; 256 cold 3/3 retained at least 5s margin' }
  return { cap: 256, status: 'HOLD', reason: 'Neither cap met the complete cold stability and margin criteria' }
}

async function main() {
  fs.mkdirSync(auditDir, { recursive: true })
  fs.mkdirSync(appData, { recursive: true })
  fs.mkdirSync(localAppData, { recursive: true })
  writeFixtures()
  if (process.env.Q6_ONLY_WRITE === '1') {
    const cap = Number(process.env.Q6_WRITE_CAP ?? 128)
    await startServer(cap, true)
    let approvedWrite
    try { approvedWrite = await runApprovedWrite(serverURL) } finally { await stopServer() }
    const summary = { measuredAt: new Date().toISOString(), model, contextTokens: 4096, reasoningEffort: 'none', optimization: 'on', timeoutMs, promptKind: 'approved-write-only', adoptedReadCap: cap, coldStatus: 'NOT_MEASURED', warm: null, approvedWrite, allColdRunsCompleted: false }
    await fsp.mkdir(path.dirname(outputPath), { recursive: true })
    await fsp.writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
    console.log(`Q6_CAP_SUMMARY ${JSON.stringify({ adoptedReadCap: cap, coldStatus: 'NOT_MEASURED', outputPath, approvedWrite: approvedWrite.pass === true })}`)
    return
  }
  const resultsByCap = new Map([[128, []], [256, []]])
  for (const cap of [128, 256]) {
    await stopServer()
    await startServer(cap)
    for (let run = 1; run <= 3; run++) {
      const unload = await unloadModel()
      const result = await runRead(serverURL, true, run, unload)
      resultsByCap.get(cap).push({ cap, ...result })
      console.log(`Q6_COLD cap=${cap} run=${run} status=${result.pass ? 'PASS' : 'FAIL'} elapsedMs=${result.elapsedMs} marginMs=${timeoutMs - result.elapsedMs}`)
    }
    await stopServer()
  }
  const choice = chooseCap(resultsByCap)
  await startServer(choice.cap)
  let warm
  try {
    let warmObservedLoaded = false
    try { warmObservedLoaded = (await queryOllamaPs()).loaded } catch {}
    warm = await runRead(serverURL, false, 1, null)
    warm = { ...warm, warmObservedLoaded }
  } finally {
    await stopServer()
  }
  await startServer(choice.cap, true)
  let approvedWrite
  try {
    approvedWrite = await runApprovedWrite(serverURL)
  } finally {
    await stopServer()
  }
  const allResults = [...resultsByCap.get(128), ...resultsByCap.get(256)]
  const summary = {
    measuredAt: new Date().toISOString(),
    model,
    contextTokens: 4096,
    reasoningEffort: 'none',
    optimization: 'on',
    timeoutMs,
    promptKind: 'fixed-natural-language-read',
    cold: {
      cap128: resultsByCap.get(128),
      cap256: resultsByCap.get(256)
    },
    adoptedReadCap: choice.cap,
    coldStatus: choice.status,
    adoptionReason: choice.reason,
    warm,
    approvedWrite,
    allColdRunsCompleted: allResults.length === 6
  }
  await fsp.mkdir(path.dirname(outputPath), { recursive: true })
  await fsp.writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  console.log(`Q6_CAP_SUMMARY ${JSON.stringify({ adoptedReadCap: choice.cap, coldStatus: choice.status, outputPath, cap128: resultsByCap.get(128).map((result) => result.pass), cap256: resultsByCap.get(256).map((result) => result.pass), warm: warm.pass === true, approvedWrite: approvedWrite.pass === true })}`)
}

try {
  await main()
} catch (error) {
  console.error(`Q6_CAP_FAILURE ${safeError(error)}`)
  process.exitCode = 1
} finally {
  await stopServer()
}
