import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { clearApprovals, getApprovalResolution, listApprovals, requestApproval, resolveApproval } from './approvals'
import { runConfiguredAgentTurn } from './agent-loop'
import type { AgentEvent, AgentTurnResult } from './agent'
import { AuditLog, auditRecordFromOutcome, type AuditEventLike } from './audit-log'
import {
  SYNTHETIC_WORKSPACE_MARKER,
  SYNTHETIC_WORKSPACE_MARKER_EXPECTED,
  assertSyntheticWorkspaceMarker,
  isLoopbackHostname,
  resolveApiKey,
  type AgentConfig,
  type LlmProvider,
  type PermissionRule
} from './config'
import { TOOL_DEFS } from './tools'
import { parseRequestTelemetryRecord, type RequestTelemetryRecord } from './request-telemetry'

export const BENCHMARK_SUITE_SCHEMA = 'misen.benchmark-suite/v1' as const
export const BENCHMARK_TASK_SCHEMA = 'misen.benchmark-task/v1' as const
export const BENCHMARK_RUN_SCHEMA = 'misen.benchmark-run/v1' as const
export const BENCHMARK_RUNNER_VERSION = '1.0.0' as const

export type BenchmarkOutcome =
  | 'success'
  | 'expectation_failure'
  | 'provider_error'
  | 'timeout'
  | 'safety_rejection'
  | 'harness_error'
  | 'skipped'
  | 'unavailable'

export type BenchmarkErrorCategory = Exclude<BenchmarkOutcome, 'success'> | null

export interface BenchmarkFixtureFile {
  path: string
  content: string
}

export interface BenchmarkFixture {
  files: BenchmarkFixtureFile[]
}

export type BenchmarkExpectation =
  | { type: 'final_status'; value: 'success' | 'aborted' }
  | { type: 'file_exists'; path: string }
  | { type: 'file_not_exists'; path: string }
  | { type: 'file_text_contains'; path: string; text: string }
  | { type: 'text_regex'; pattern: string; flags?: string; path?: string }
  | { type: 'json_value'; path: string; pointer: string; equals: unknown }
  | { type: 'json_structure'; path: string; requiredPointers: string[] }
  | { type: 'tool_used'; tool: string; minCount?: number }
  | { type: 'tool_not_used'; tool: string }
  | { type: 'safety_rejection'; expected: boolean }

export interface BenchmarkMockStep {
  tool?: string
  args?: Record<string, unknown>
  answer?: string
  delayMs?: number
  error?: string
  status?: number
}

export interface BenchmarkTask {
  schemaVersion: typeof BENCHMARK_TASK_SCHEMA
  id: string
  title: string
  description: string
  prompt: string
  fixture?: BenchmarkFixture
  fixtureRef?: string
  timeoutMs: number
  tags: string[]
  category: string
  expectations: BenchmarkExpectation[]
  approvalExpectation?: 'approved' | 'denied' | 'not_requested'
  mock?: { steps: BenchmarkMockStep[] }
}

export interface BenchmarkSuite {
  schemaVersion: typeof BENCHMARK_SUITE_SCHEMA
  id: string
  version: string
  title: string
  fixtures?: Record<string, BenchmarkFixture>
  tasks: BenchmarkTask[]
}

export interface BenchmarkExpectationDetail {
  type: string
  path: string | null
  passed: boolean
  detail: string
}

export interface BenchmarkTokenUsage {
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  reasoning_tokens: number | null
  cached_input_tokens: number | null
}

export interface BenchmarkRunResult {
  benchmark_schema_version: typeof BENCHMARK_RUN_SCHEMA
  runner_version: typeof BENCHMARK_RUNNER_VERSION
  suite_schema_version: typeof BENCHMARK_SUITE_SCHEMA
  task_schema_version: typeof BENCHMARK_TASK_SCHEMA
  suite_id: string
  suite_version: string
  task_id: string
  run_id: string
  timestamp: string
  git_commit_sha: string
  provider: LlmProvider
  model: string
  endpoint_category: 'loopback' | 'local' | 'local_bridge' | 'external' | 'unknown'
  configuration: {
    agent_loop: 'v2'
    /** Added by runner 1.0.0 Issue #56; absent in older v1 JSONL is unknown. */
    agent_optimization?: 'on' | 'off'
    temperature: number | null
    reasoning_effort: string | null
    max_model_decisions: number | null
    max_host_executions: number | null
    metadata: Record<string, string>
  }
  repeat_index: number
  seed: number | null
  seed_guaranteed: boolean
  final_status: 'success' | 'aborted' | 'unknown'
  final_outcome: BenchmarkOutcome
  expectations: {
    passed: number | null
    total: number | null
    details: BenchmarkExpectationDetail[]
  }
  pass: boolean
  elapsed_ms: number | null
  time_to_first_action_ms: number | null
  model_call_count: number | null
  model_response_count: number | null
  tool_call_count: number | null
  tool_events: {
    succeeded: number | null
    failed: number | null
    rejected: number | null
    invalid: number | null
  }
  retry_count: number | null
  approval_count: number | null
  approval_result: 'approved' | 'denied' | 'mixed' | 'not_required' | 'unknown'
  approval_events: {
    approved: number | null
    denied: number | null
    unknown: number | null
  }
  safety_rejection: boolean | null
  guard_rejection_count: number | null
  human_intervention_count: number | null
  token_usage: BenchmarkTokenUsage | null
  request_telemetry: RequestTelemetryRecord[]
  error_category: BenchmarkErrorCategory
}

export interface BenchmarkAggregate {
  suite_id: string
  suite_version: string
  provider: string
  model: string
  agent_optimization: 'on' | 'off' | 'unknown'
  attempted_runs: number
  completed_runs: number
  passed_runs: number
  completion_rate: number | null
  pass_rate: number | null
  expectation_pass_rate: number | null
  tool_validity_rate: number | null
  approval_success_rate: number | null
  safety_rejection_count: number
  average_elapsed_ms: number | null
  median_elapsed_ms: number | null
  average_time_to_first_action_ms: number | null
  median_time_to_first_action_ms: number | null
  average_model_calls: number | null
  average_tool_calls: number | null
  average_retries: number | null
  request_telemetry: {
    reported_requests: number
    average_request_elapsed_ms: number | null
    average_working_messages: number | null
    average_exposed_tools: number | null
    average_tool_schema_bytes: number | null
    average_tool_result_context_bytes: number | null
    total_pruned_items: number
  } | null
  token_usage: {
    reported_runs: number
    input_tokens: number | null
    output_tokens: number | null
    total_tokens: number | null
    reasoning_tokens: number | null
    cached_input_tokens: number | null
  } | null
  outcomes: Record<BenchmarkOutcome, number>
}

export interface BenchmarkLogger {
  log(message: string): void
  error(message: string): void
}

export interface RunBenchmarkOptions {
  suite: BenchmarkSuite
  outputDirectory: string
  provider: LlmProvider
  model: string
  repeat: number
  timeoutMs?: number
  baseConfig: AgentConfig
  autoApproveSynthetic: boolean
  metadata?: Record<string, string>
  mock?: boolean
  logger?: BenchmarkLogger
  knownSecrets?: string[]
}

export interface RunBenchmarkSummary {
  results: BenchmarkRunResult[]
  aggregates: BenchmarkAggregate[]
  jsonlPath: string
  runsCsvPath: string
  summaryCsvPath: string
  markdownPath: string
}

type CapturedEvent = AgentEvent & AuditEventLike & { eventId: string; at: number; runId: string }

class FatalBenchmarkError extends Error {}
class AuditAppendError extends FatalBenchmarkError {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} は空でない文字列で指定してください`)
  return value
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} は空でない文字列の配列で指定してください`)
  }
  return value as string[]
}

function normalizeRelativePath(value: string, label: string): string {
  const normalized = value.replaceAll('\\', '/')
  if (!normalized || normalized.includes('\u0000') || normalized.includes(':') || path.isAbsolute(normalized) || /^[A-Za-z]:/u.test(normalized)) throw new Error(`${label} は安全な相対パスで指定してください`)
  if (normalized.split('/').includes('..')) throw new Error(`${label} はfixture外を参照できません`)
  const resolved = path.posix.normalize(normalized)
  if (resolved === '.' || resolved === '..' || resolved.startsWith('../') || resolved.includes('/../')) throw new Error(`${label} はfixture外を参照できません`)
  return resolved
}

function parseFixture(value: unknown, label: string): BenchmarkFixture {
  if (!isRecord(value) || !Array.isArray(value.files)) throw new Error(`${label}.files が必要です`)
  const files = value.files.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`${label}.files[${index}] が不正です`)
    return {
      path: normalizeRelativePath(requireString(candidate.path, `${label}.files[${index}].path`), `${label}.files[${index}].path`),
      content: typeof candidate.content === 'string' ? candidate.content : (() => { throw new Error(`${label}.files[${index}].content は文字列で指定してください`) })()
    }
  })
  if (new Set(files.map((file) => file.path.toLowerCase())).size !== files.length) throw new Error(`${label}.files のpathが重複しています`)
  return { files }
}

function parseExpectation(value: unknown, label: string): BenchmarkExpectation {
  if (!isRecord(value)) throw new Error(`${label} が不正です`)
  const type = requireString(value.type, `${label}.type`)
  if (type === 'final_status') {
    if (value.value !== 'success' && value.value !== 'aborted') throw new Error(`${label}.value が不正です`)
    return { type, value: value.value }
  }
  if (type === 'file_exists' || type === 'file_not_exists') {
    return { type, path: normalizeRelativePath(requireString(value.path, `${label}.path`), `${label}.path`) }
  }
  if (type === 'file_text_contains') {
    return {
      type,
      path: normalizeRelativePath(requireString(value.path, `${label}.path`), `${label}.path`),
      text: requireString(value.text, `${label}.text`)
    }
  }
  if (type === 'text_regex') {
    const pattern = requireString(value.pattern, `${label}.pattern`)
    const flags = value.flags === undefined ? undefined : requireString(value.flags, `${label}.flags`)
    try { new RegExp(pattern, flags) } catch { throw new Error(`${label} の正規表現が不正です`) }
    const expectation: BenchmarkExpectation = { type, pattern, ...(flags ? { flags } : {}) }
    if (value.path !== undefined) expectation.path = normalizeRelativePath(requireString(value.path, `${label}.path`), `${label}.path`)
    return expectation
  }
  if (type === 'json_value') {
    if (!Object.prototype.hasOwnProperty.call(value, 'equals')) throw new Error(`${label}.equals が必要です`)
    return {
      type,
      path: normalizeRelativePath(requireString(value.path, `${label}.path`), `${label}.path`),
      pointer: requireString(value.pointer, `${label}.pointer`),
      equals: value.equals
    }
  }
  if (type === 'json_structure') {
    return {
      type,
      path: normalizeRelativePath(requireString(value.path, `${label}.path`), `${label}.path`),
      requiredPointers: requireStringArray(value.requiredPointers, `${label}.requiredPointers`)
    }
  }
  if (type === 'tool_used') {
    const minCount = value.minCount === undefined ? undefined : Number(value.minCount)
    if (minCount !== undefined && (!Number.isInteger(minCount) || minCount < 1)) throw new Error(`${label}.minCount が不正です`)
    return { type, tool: requireString(value.tool, `${label}.tool`), ...(minCount ? { minCount } : {}) }
  }
  if (type === 'tool_not_used') return { type, tool: requireString(value.tool, `${label}.tool`) }
  if (type === 'safety_rejection') {
    if (typeof value.expected !== 'boolean') throw new Error(`${label}.expected はbooleanで指定してください`)
    return { type, expected: value.expected }
  }
  throw new Error(`${label}.type は未対応です: ${type}`)
}

function parseMock(value: unknown, label: string): { steps: BenchmarkMockStep[] } | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || !Array.isArray(value.steps) || value.steps.length === 0) throw new Error(`${label}.steps が必要です`)
  return {
    steps: value.steps.map((candidate, index) => {
      if (!isRecord(candidate)) throw new Error(`${label}.steps[${index}] が不正です`)
      const tool = candidate.tool === undefined ? undefined : requireString(candidate.tool, `${label}.steps[${index}].tool`)
      const answer = candidate.answer === undefined ? undefined : String(candidate.answer)
      const error = candidate.error === undefined ? undefined : String(candidate.error)
      const populated = [tool !== undefined, answer !== undefined, error !== undefined].filter(Boolean).length
      if (populated !== 1) throw new Error(`${label}.steps[${index}] はtool / answer / errorのいずれか1つだけを指定してください`)
      if (candidate.args !== undefined && !isRecord(candidate.args)) throw new Error(`${label}.steps[${index}].args が不正です`)
      const delayMs = candidate.delayMs === undefined ? undefined : Number(candidate.delayMs)
      if (delayMs !== undefined && (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000)) throw new Error(`${label}.steps[${index}].delayMs が不正です`)
      const status = candidate.status === undefined ? undefined : Number(candidate.status)
      if (status !== undefined && (!Number.isInteger(status) || status < 400 || status > 599)) throw new Error(`${label}.steps[${index}].status が不正です`)
      return {
        ...(tool ? { tool } : {}),
        ...(candidate.args ? { args: candidate.args } : {}),
        ...(answer !== undefined ? { answer } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(delayMs !== undefined ? { delayMs } : {}),
        ...(status !== undefined ? { status } : {})
      }
    })
  }
}

export function parseBenchmarkSuite(value: unknown): BenchmarkSuite {
  if (!isRecord(value)) throw new Error('benchmark suite はJSONオブジェクトで指定してください')
  if (value.schemaVersion !== BENCHMARK_SUITE_SCHEMA) throw new Error(`suite schemaVersion は ${BENCHMARK_SUITE_SCHEMA} で指定してください`)
  const fixtures: Record<string, BenchmarkFixture> = {}
  if (value.fixtures !== undefined) {
    if (!isRecord(value.fixtures)) throw new Error('fixtures はオブジェクトで指定してください')
    for (const [id, fixture] of Object.entries(value.fixtures)) fixtures[requireString(id, 'fixture id')] = parseFixture(fixture, `fixtures.${id}`)
  }
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) throw new Error('tasks が必要です')
  const tasks = value.tasks.map((candidate, index): BenchmarkTask => {
    if (!isRecord(candidate)) throw new Error(`tasks[${index}] が不正です`)
    if (candidate.schemaVersion !== BENCHMARK_TASK_SCHEMA) throw new Error(`tasks[${index}].schemaVersion は ${BENCHMARK_TASK_SCHEMA} で指定してください`)
    const timeoutMs = Number(candidate.timeoutMs)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new Error(`tasks[${index}].timeoutMs が不正です`)
    const fixture = candidate.fixture === undefined ? undefined : parseFixture(candidate.fixture, `tasks[${index}].fixture`)
    const fixtureRef = candidate.fixtureRef === undefined ? undefined : requireString(candidate.fixtureRef, `tasks[${index}].fixtureRef`)
    if ((fixture ? 1 : 0) + (fixtureRef ? 1 : 0) !== 1) throw new Error(`tasks[${index}] はfixtureまたはfixtureRefを1つ指定してください`)
    if (fixtureRef && !fixtures[fixtureRef]) throw new Error(`tasks[${index}].fixtureRef が見つかりません: ${fixtureRef}`)
    if (!Array.isArray(candidate.expectations) || candidate.expectations.length === 0) throw new Error(`tasks[${index}].expectations が必要です`)
    const approvalExpectation = candidate.approvalExpectation
    if (approvalExpectation !== undefined && approvalExpectation !== 'approved' && approvalExpectation !== 'denied' && approvalExpectation !== 'not_requested') {
      throw new Error(`tasks[${index}].approvalExpectation が不正です`)
    }
    return {
      schemaVersion: BENCHMARK_TASK_SCHEMA,
      id: requireString(candidate.id, `tasks[${index}].id`),
      title: requireString(candidate.title, `tasks[${index}].title`),
      description: requireString(candidate.description, `tasks[${index}].description`),
      prompt: requireString(candidate.prompt, `tasks[${index}].prompt`),
      ...(fixture ? { fixture } : {}),
      ...(fixtureRef ? { fixtureRef } : {}),
      timeoutMs,
      tags: requireStringArray(candidate.tags, `tasks[${index}].tags`),
      category: requireString(candidate.category, `tasks[${index}].category`),
      expectations: candidate.expectations.map((expectation, expectationIndex) => parseExpectation(expectation, `tasks[${index}].expectations[${expectationIndex}]`)),
      ...(approvalExpectation ? { approvalExpectation } : {}),
      ...(candidate.mock !== undefined ? { mock: parseMock(candidate.mock, `tasks[${index}].mock`)! } : {})
    }
  })
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new Error('task id が重複しています')
  return {
    schemaVersion: BENCHMARK_SUITE_SCHEMA,
    id: requireString(value.id, 'suite.id'),
    version: requireString(value.version, 'suite.version'),
    title: requireString(value.title, 'suite.title'),
    ...(Object.keys(fixtures).length ? { fixtures } : {}),
    tasks
  }
}

export function loadBenchmarkSuite(input: string, appRoot = path.resolve(__dirname, '..')): BenchmarkSuite {
  const direct = path.resolve(input)
  const candidate = fs.existsSync(direct) ? direct : path.join(appRoot, 'benchmark', 'suites', `${input}.json`)
  if (!fs.existsSync(candidate)) throw new Error(`benchmark suite が見つかりません: ${input}`)
  return parseBenchmarkSuite(JSON.parse(fs.readFileSync(candidate, 'utf8')) as unknown)
}

function taskFixture(suite: BenchmarkSuite, task: BenchmarkTask): BenchmarkFixture {
  if (task.fixture) return task.fixture
  const fixture = task.fixtureRef ? suite.fixtures?.[task.fixtureRef] : undefined
  if (!fixture) throw new FatalBenchmarkError(`fixture が見つかりません: ${task.fixtureRef ?? task.id}`)
  return fixture
}

async function createSyntheticWorkspace(suite: BenchmarkSuite, task: BenchmarkTask, outputDirectory: string, runId: string): Promise<string> {
  const workspacesDirectory = path.join(outputDirectory, 'workspaces')
  assertNoReparseComponents(workspacesDirectory)
  const workspace = path.join(workspacesDirectory, runId)
  await fsp.mkdir(workspace, { recursive: false })
  await fsp.writeFile(path.join(workspace, SYNTHETIC_WORKSPACE_MARKER), `${JSON.stringify(SYNTHETIC_WORKSPACE_MARKER_EXPECTED, null, 2)}\n`, 'utf8')
  for (const file of taskFixture(suite, task).files) {
    const destination = path.resolve(workspace, file.path)
    const relative = path.relative(workspace, destination)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new FatalBenchmarkError(`fixture path がworkspace外です: ${file.path}`)
    await fsp.mkdir(path.dirname(destination), { recursive: true })
    await fsp.writeFile(destination, file.content, 'utf8')
  }
  assertSyntheticWorkspaceMarker(workspace)
  return workspace
}

function endpointCategory(cfg: AgentConfig): BenchmarkRunResult['endpoint_category'] {
  if (cfg.provider === 'external-openai') return 'external'
  if (cfg.provider === 'ollama') return 'local'
  if (cfg.provider === 'copilot-edge') return 'local_bridge'
  try {
    return isLoopbackHostname(new URL(cfg.baseURL).hostname) ? 'loopback' : 'external'
  } catch {
    return 'unknown'
  }
}

const READ_ONLY_PERMISSIONS = new Set(TOOL_DEFS.filter((tool) => tool.kind === 'read').map((tool) => tool.name))

function benchmarkPermissions(rules: readonly PermissionRule[] | undefined): PermissionRule[] {
  return (rules ?? []).map((rule) => {
    const barePermission = rule.permission.replace(/^host\./u, '').split('.')[0]
    if (rule.action === 'allow' && !READ_ONLY_PERMISSIONS.has(barePermission)) {
      return { ...rule, action: 'ask' }
    }
    return { ...rule }
  })
}

function prepareRunConfig(options: RunBenchmarkOptions, workspace: string, mockBaseURL?: string): AgentConfig {
  if (!options.mock && options.baseConfig.provider !== options.provider) {
    throw new FatalBenchmarkError(`--provider ${options.provider} とconfigのprovider ${String(options.baseConfig.provider)} が一致しません`)
  }
  const config: AgentConfig = {
    ...options.baseConfig,
    agentLoop: 'v2',
    provider: options.provider,
    model: options.model,
    restrictToWorkspace: true,
    safeCommandOnly: true,
    autoApprove: { write: false, command: false },
    permissions: benchmarkPermissions(options.baseConfig.permissions),
    ...(mockBaseURL ? { baseURL: mockBaseURL, apiKey: options.baseConfig.apiKey ?? 'benchmark-loopback-token' } : {}),
    ...(options.provider === 'external-openai'
      ? { externalProvider: { ...options.baseConfig.externalProvider, syntheticWorkspace: workspace } }
      : {})
  }
  if (config.provider === 'external-openai') {
    if (options.baseConfig.provider !== 'external-openai' || options.baseConfig.externalProvider?.enabled !== true) {
      throw new FatalBenchmarkError('external-openai benchmark は明示有効化済みのexternal-openai configが必要です')
    }
  } else {
    let parsed: URL
    try { parsed = new URL(config.baseURL) } catch { throw new FatalBenchmarkError(`${config.provider} benchmark のbaseURLが不正です`) }
    if (!isLoopbackHostname(parsed.hostname)) throw new FatalBenchmarkError('remote endpointはprovider=external-openaiのsynthetic boundaryを通してください')
  }
  return config
}

function normalizedTool(tool: string | undefined): string {
  if (!tool) return 'unknown'
  return tool.startsWith('host.') ? tool : `host.${tool}`
}

function safetyText(text: string): boolean {
  return /permission denied|ワークスペース外|合成ワークスペース|外部AI|ワークスペース制限|安全なコマンド制限|破壊的|junction|シンボリックリンク|再解析点|hard guard|run_command拒否|start_process拒否|任意コマンド実行は設定で明示的に有効化されていない|ネットワーク通信を行うhostツールは利用できません|許可されていないhostツール/iu.test(text)
}

function safetyEvent(event: CapturedEvent): boolean {
  if (event.authority !== 'authoritative') return false
  if (event.type === 'tool.denied') return true
  if (event.type === 'run.warning' && event.metadata?.safetyBoundary === 'external-synthetic-workspace') return true
  if (event.type !== 'tool.failed' && event.type !== 'run.warning') return false
  const text = `${event.error ?? ''}\n${event.output ?? ''}`
  return safetyText(text)
}

function invalidEvent(event: CapturedEvent): boolean {
  return /\[validation error\]|引数を検証/iu.test(`${event.error ?? ''}\n${event.output ?? ''}`)
}

function jsonPointer(value: unknown, pointer: string): { found: boolean; value: unknown } {
  if (pointer === '') return { found: true, value }
  if (!pointer.startsWith('/')) return { found: false, value: undefined }
  let current = value
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    if (Array.isArray(current)) {
      const index = Number(key)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return { found: false, value: undefined }
      current = current[index]
    } else if (isRecord(current) && Object.prototype.hasOwnProperty.call(current, key)) {
      current = current[key]
    } else {
      return { found: false, value: undefined }
    }
  }
  return { found: true, value: current }
}

async function scoreExpectations(task: BenchmarkTask, workspace: string, agentResult: AgentTurnResult | null, events: CapturedEvent[], observedSafetyRejection: boolean): Promise<BenchmarkExpectationDetail[]> {
  const details: BenchmarkExpectationDetail[] = []
  const add = (type: string, pathValue: string | null, passed: boolean, detail: string): void => {
    details.push({ type, path: pathValue, passed, detail })
  }
  for (const expectation of task.expectations) {
    if (expectation.type === 'final_status') {
      const actual = agentResult === null ? 'unknown' : agentResult.aborted ? 'aborted' : 'success'
      add(expectation.type, null, actual === expectation.value, `final status: ${actual}`)
      continue
    }
    if (expectation.type === 'file_exists' || expectation.type === 'file_not_exists') {
      const exists = fs.existsSync(path.join(workspace, expectation.path))
      const passed = expectation.type === 'file_exists' ? exists : !exists
      add(expectation.type, expectation.path, passed, passed ? 'path condition matched' : 'path condition mismatched')
      continue
    }
    if (expectation.type === 'file_text_contains') {
      let passed = false
      try { passed = (await fsp.readFile(path.join(workspace, expectation.path), 'utf8')).includes(expectation.text) } catch {}
      add(expectation.type, expectation.path, passed, passed ? 'required text found' : 'required text not found')
      continue
    }
    if (expectation.type === 'text_regex') {
      let target = agentResult?.reply ?? ''
      if (expectation.path) {
        try { target = await fsp.readFile(path.join(workspace, expectation.path), 'utf8') } catch { target = '' }
      }
      const passed = new RegExp(expectation.pattern, expectation.flags).test(target)
      add(expectation.type, expectation.path ?? null, passed, passed ? 'regex matched' : 'regex did not match')
      continue
    }
    if (expectation.type === 'json_value' || expectation.type === 'json_structure') {
      let parsed: unknown
      try { parsed = JSON.parse(await fsp.readFile(path.join(workspace, expectation.path), 'utf8')) as unknown } catch { parsed = undefined }
      if (expectation.type === 'json_value') {
        const found = jsonPointer(parsed, expectation.pointer)
        const passed = found.found && JSON.stringify(found.value) === JSON.stringify(expectation.equals)
        add(expectation.type, expectation.path, passed, passed ? 'JSON value matched' : 'JSON value mismatched or missing')
      } else {
        const passed = expectation.requiredPointers.every((pointer) => jsonPointer(parsed, pointer).found)
        add(expectation.type, expectation.path, passed, passed ? 'required JSON structure found' : 'required JSON structure missing')
      }
      continue
    }
    if (expectation.type === 'tool_used' || expectation.type === 'tool_not_used') {
      const expectedTool = normalizedTool(expectation.tool)
      const count = events.filter((event) => event.type === 'tool.requested' && normalizedTool(event.tool) === expectedTool).length
      const passed = expectation.type === 'tool_used' ? count >= (expectation.minCount ?? 1) : count === 0
      add(expectation.type, null, passed, `observed ${count} request(s) for ${expectedTool}`)
      continue
    }
    add(expectation.type, null, observedSafetyRejection === expectation.expected, observedSafetyRejection ? 'safety rejection observed' : 'safety rejection not observed')
  }
  if (task.approvalExpectation) {
    const requested = events.filter((event) => event.type === 'approval.requested')
    const resolved = events.filter((event) => event.type === 'approval.resolved' && typeof event.approved === 'boolean')
    const actual = requested.length === 0 ? 'not_requested' : resolved.some((event) => event.approved === false) ? 'denied' : resolved.some((event) => event.approved === true) ? 'approved' : 'unknown'
    add('approval_expectation', null, actual === task.approvalExpectation, `approval result: ${actual}`)
  }
  return details
}

function usageFromEvents(events: CapturedEvent[]): BenchmarkTokenUsage | null {
  const reported = events
    .filter((event) => event.type === 'model.decision' && isRecord(event.metadata?.usage))
    .map((event) => event.metadata!.usage as Record<string, unknown>)
  if (reported.length === 0) return null
  const sum = (key: string): number | null => {
    const values = reported.map((usage) => usage[key]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    return values.length === 0 ? null : values.reduce((total, value) => total + value, 0)
  }
  const usage: BenchmarkTokenUsage = {
    input_tokens: sum('inputTokens'),
    output_tokens: sum('outputTokens'),
    total_tokens: sum('totalTokens'),
    reasoning_tokens: sum('reasoningTokens'),
    cached_input_tokens: sum('cachedInputTokens')
  }
  return Object.values(usage).some((value) => value !== null) ? usage : null
}

export function requestTelemetryFromEvents(events: Array<Pick<CapturedEvent, 'type' | 'metadata'>>): RequestTelemetryRecord[] {
  return events.flatMap((event) => {
    if (event.type !== 'model.decision' && event.type !== 'run.warning') return []
    const candidate = event.metadata?.requestTelemetry
    if (candidate === undefined) return []
    return [parseRequestTelemetryRecord(candidate)]
  })
}

function safeMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  if (!metadata) return {}
  const safe: Record<string, string> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (/api.?key|authorization|credential|password|secret|token/iu.test(key)) throw new Error(`sensitive metadata key は保存できません: ${key}`)
    safe[key] = value
  }
  return safe
}

function gitCommitSha(cwd: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', shell: false, windowsHide: true })
  return result.status === 0 && /^[0-9a-f]{40}$/iu.test(result.stdout.trim()) ? result.stdout.trim() : 'unknown'
}

function candidateSecretValues(options: RunBenchmarkOptions, cfg: AgentConfig): Array<string | undefined> {
  return [
    ...(options.knownSecrets ?? []),
    resolveApiKey(options.baseConfig),
    resolveApiKey(cfg),
    process.env.MISEN_BENCH_SECRET_MARKER
  ]
}

function assertSupportedSecretValues(options: RunBenchmarkOptions, cfg: AgentConfig): void {
  if (candidateSecretValues(options, cfg).some((value) => typeof value === 'string' && value.length > 0 && value.length < 4)) {
    throw new FatalBenchmarkError('Benchmark credential/secret markerは安全な完全一致redactionのため4文字以上でなければなりません')
  }
}

function knownSecretValues(options: RunBenchmarkOptions, cfg: AgentConfig): string[] {
  const values = candidateSecretValues(options, cfg)
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length >= 4))]
}

function redactText(value: string, secrets: readonly string[]): string {
  let redacted = value
  for (const secret of secrets) redacted = redacted.split(secret).join('[REDACTED]')
  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/giu, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key|authorization|credential|password|secret|token)(\s*[=:]\s*)[^\s,;]+/giu, '$1$2[REDACTED]')
}

function redactArtifactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactText(value, secrets)
  if (Array.isArray(value)) return value.map((item) => redactArtifactValue(item, secrets))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, redactArtifactValue(item, secrets)]))
  }
  return value
}

function classifyUnavailable(error: unknown): boolean {
  return /apiKey|apiKeyEnv|秘密情報|credential|config|baseURL|明示有効化/iu.test((error as Error).message ?? String(error))
}

function approvalDecisionMap(events: CapturedEvent[]): Map<string, boolean> {
  const byCall = new Map<string, boolean>()
  for (const event of events) {
    if (event.type !== 'approval.resolved' || typeof event.approved !== 'boolean') continue
    byCall.set(event.callId ?? event.eventId, event.approved)
  }
  return byCall
}

function approvalResult(events: CapturedEvent[]): BenchmarkRunResult['approval_result'] {
  const requested = events.filter((event) => event.type === 'approval.requested')
  if (requested.length === 0) return 'not_required'
  const byCall = approvalDecisionMap(events)
  if (byCall.size === 0) return 'unknown'
  const values = [...byCall.values()]
  if (values.every(Boolean)) return 'approved'
  if (values.every((value) => !value)) return 'denied'
  return 'mixed'
}

async function runOne(
  options: RunBenchmarkOptions,
  task: BenchmarkTask,
  repeatIndex: number,
  auditLog: AuditLog,
  mockBaseURL?: string
): Promise<BenchmarkRunResult> {
  const runId = crypto.randomUUID()
  const startedAt = Date.now()
  const workspace = await createSyntheticWorkspace(options.suite, task, options.outputDirectory, runId)
  const events: CapturedEvent[] = []
  let sequence = 0
  let config: AgentConfig
  try {
    config = prepareRunConfig(options, workspace, mockBaseURL)
  } catch (error) {
    await fsp.rm(workspace, { recursive: true, force: true })
    throw error
  }
  try {
  const secrets = knownSecretValues(options, config)
  const controller = new AbortController()
  let timedOut = false
  let agentResult: AgentTurnResult | null = null
  let runError: unknown
  const printed: string[] = []

  const capture = (event: AgentEvent): void => {
    const captured: CapturedEvent = {
      ...event,
      eventId: `${runId}-event-${++sequence}`,
      at: Date.now(),
      runId
    }
    events.push(captured)
    if (captured.type === 'tool.succeeded' || captured.type === 'tool.failed' || captured.type === 'tool.denied') {
      try {
        const record = auditRecordFromOutcome({ sessionId: `benchmark-${options.suite.id}`, runId, event: captured, history: events })
        if (!record) throw new Error('terminal tool eventからaudit recordを生成できません')
        const redactedRecord = redactArtifactValue(record, secrets) as typeof record
        auditLog.append(redactedRecord, `${runId}:${captured.callId ?? captured.eventId}`)
      } catch (error) {
        throw new AuditAppendError(`監査ログ追記に失敗しました: ${(error as Error).message}`)
      }
    }
  }

  const timeoutMs = options.timeoutMs ?? task.timeoutMs
  const agentPromise = runConfiguredAgentTurn({
    cfg: config,
    messages: [],
    userInput: `[MISEN_BENCHMARK_TASK_ID:${task.id}]\n${task.prompt}`,
    ctx: { workspace, restrictToWorkspace: true, safeCommandOnly: true, signal: controller.signal, runId },
    io: {
      print: (message) => { printed.push(redactText(message, secrets)) },
      askYesNo: async (question, binding) => {
        assertSyntheticWorkspaceMarker(workspace)
        const pending = requestApproval({
          question,
          runId,
          toolName: binding?.toolName,
          scope: workspace,
          expiresAt: Date.now() + Math.min(timeoutMs, 60_000),
          binding: { ...binding, runId }
        })
        const snapshot = listApprovals().find((entry) => entry.runId === runId && entry.binding?.callId === binding?.callId)
        if (!snapshot) throw new FatalBenchmarkError('approval stateを取得できません')
        const approved = options.autoApproveSynthetic === true
        resolveApproval(
          snapshot.id,
          approved,
          approved ? 'synthetic benchmark auto-approval' : 'synthetic benchmark requires --auto-approve-synthetic',
          { actor: 'policy', automatic: true }
        )
        const result = await pending
        const resolution = getApprovalResolution(snapshot.id)
        capture({
          type: 'approval.resolved',
          tool: binding?.toolName,
          summary: question,
          approved: result,
          origin: 'host',
          namespace: 'app',
          authority: 'authoritative',
          callId: binding?.callId,
          metadata: { approval: { id: snapshot.id, provenance: resolution?.provenance ?? { actor: 'policy', automatic: true } } }
        })
        return result
      },
      event: capture,
      signal: controller.signal
    }
  }).then((result) => ({ kind: 'result' as const, result }), (error: unknown) => ({ kind: 'error' as const, error }))

  let timeoutHandle: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<{ kind: 'timeout' }>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
    timeoutHandle.unref()
  })
  const first = await Promise.race([agentPromise, timeoutPromise])
  if (first.kind === 'timeout') {
    timedOut = true
    controller.abort()
    const grace = await Promise.race([
      agentPromise,
      new Promise<{ kind: 'grace_expired' }>((resolve) => {
        const handle = setTimeout(() => resolve({ kind: 'grace_expired' }), 2_000)
        handle.unref()
      })
    ])
    if (grace.kind === 'grace_expired') throw new FatalBenchmarkError('timeout後にagent executionが停止しなかったためsuiteを停止しました')
    if (grace.kind === 'error') runError = grace.error
  } else if (first.kind === 'result') {
    agentResult = first.result
  } else {
    runError = first.error
  }
  if (timeoutHandle) clearTimeout(timeoutHandle)

  const safetyRejected = events.some(safetyEvent)
  const expectationDetails = await scoreExpectations(task, workspace, agentResult, events, safetyRejected)
  const expectsSafety = task.expectations.some((expectation) => expectation.type === 'safety_rejection' && expectation.expected)
  if (safetyRejected && !expectsSafety) expectationDetails.push({ type: 'unexpected_safety_rejection', path: null, passed: false, detail: 'unexpected safety rejection observed' })
  const expectationPass = expectationDetails.every((detail) => detail.passed)
  const providerLogError = runError !== undefined || printed.some((message) => /^\[error\]/u.test(message))
  const loggedUnavailable = printed.some((message) => /apiKey|apiKeyEnv|秘密情報|credential|baseURL|明示有効化/iu.test(message))

  let outcome: BenchmarkOutcome
  if (runError instanceof AuditAppendError || runError instanceof FatalBenchmarkError) outcome = 'harness_error'
  else if (timedOut) outcome = 'timeout'
  else if (safetyRejected) outcome = 'safety_rejection'
  else if ((runError && classifyUnavailable(runError)) || loggedUnavailable) outcome = 'unavailable'
  else if (providerLogError) outcome = 'provider_error'
  else if (!expectationPass || agentResult?.aborted === true) outcome = 'expectation_failure'
  else outcome = 'success'

  const firstAction = events.find((event) => event.type === 'tool.requested') ?? events.find((event) => event.type === 'model.decision')
  const requestedCalls = events.filter((event) => event.type === 'tool.requested')
  const modelToolCallCount = (agentResult?.messages ?? []).reduce((total, message) => total + (message.role === 'assistant' ? (message.tool_calls?.length ?? 0) : 0), 0)
  const invalidToolResults = (agentResult?.messages ?? []).filter((message) => message.role === 'tool' && /\[validation error\]|引数を検証/iu.test(message.content ?? '')).length
  const invalidEventCalls = new Set(events.filter(invalidEvent).map((event) => event.callId ?? event.eventId)).size
  const invalidToolCalls = Math.max(
    invalidEventCalls,
    invalidToolResults,
    Math.max(0, modelToolCallCount - requestedCalls.length)
  )
  const guardRejectionCalls = new Set(events
    .filter((event) => safetyEvent(event) && (event.type === 'tool.denied' || event.type === 'tool.failed' || event.type === 'run.warning'))
    .map((event) => event.callId ?? event.eventId))
  const modelWaitCount = events.filter((event) => event.type === 'model.wait').length
  const boundaryRejectedBeforeRequest = events.some((event) => event.type === 'run.warning' && event.metadata?.safetyBoundary === 'external-synthetic-workspace') && events.every((event) => event.type !== 'model.decision')
  const requestedApprovalCalls = new Set(events.filter((event) => event.type === 'approval.requested').map((event) => event.callId ?? event.eventId))
  const approvalDecisions = approvalDecisionMap(events)
  const result: BenchmarkRunResult = {
    benchmark_schema_version: BENCHMARK_RUN_SCHEMA,
    runner_version: BENCHMARK_RUNNER_VERSION,
    suite_schema_version: BENCHMARK_SUITE_SCHEMA,
    task_schema_version: BENCHMARK_TASK_SCHEMA,
    suite_id: options.suite.id,
    suite_version: options.suite.version,
    task_id: task.id,
    run_id: runId,
    timestamp: new Date(startedAt).toISOString(),
    git_commit_sha: gitCommitSha(path.resolve(__dirname, '..')),
    provider: options.provider,
    model: options.model,
    endpoint_category: endpointCategory(config),
    configuration: {
      agent_loop: 'v2',
      agent_optimization: config.agentOptimization === 'off' ? 'off' : 'on',
      temperature: typeof config.temperature === 'number' ? config.temperature : null,
      reasoning_effort: config.reasoningEffort ?? null,
      max_model_decisions: typeof config.maxToolIterations === 'number' ? config.maxToolIterations : null,
      max_host_executions: typeof config.maxToolExecutions === 'number' ? config.maxToolExecutions : null,
      metadata: safeMetadata(options.metadata)
    },
    repeat_index: repeatIndex,
    seed: null,
    seed_guaranteed: false,
    final_status: agentResult === null ? 'unknown' : agentResult.aborted ? 'aborted' : 'success',
    final_outcome: outcome,
    expectations: {
      passed: expectationDetails.filter((detail) => detail.passed).length,
      total: expectationDetails.length,
      details: expectationDetails
    },
    pass: expectationPass && (outcome === 'success' || (outcome === 'safety_rejection' && expectsSafety)),
    elapsed_ms: Date.now() - startedAt,
    time_to_first_action_ms: firstAction ? Math.max(0, firstAction.at - startedAt) : null,
    model_call_count: Math.max(0, modelWaitCount - (boundaryRejectedBeforeRequest ? 1 : 0)),
    model_response_count: events.filter((event) => event.type === 'model.decision').length,
    tool_call_count: Math.max(modelToolCallCount, requestedCalls.length),
    tool_events: {
      succeeded: events.filter((event) => event.type === 'tool.succeeded').length,
      failed: events.filter((event) => event.type === 'tool.failed' && !invalidEvent(event)).length,
      rejected: events.filter((event) => event.type === 'tool.denied').length,
      invalid: invalidToolCalls
    },
    retry_count: 0,
    approval_count: requestedApprovalCalls.size,
    approval_result: approvalResult(events),
    approval_events: {
      approved: [...approvalDecisions.values()].filter(Boolean).length,
      denied: [...approvalDecisions.values()].filter((value) => !value).length,
      unknown: Math.max(0, requestedApprovalCalls.size - approvalDecisions.size)
    },
    safety_rejection: safetyRejected,
    guard_rejection_count: guardRejectionCalls.size,
    human_intervention_count: 0,
    token_usage: usageFromEvents(events),
    request_telemetry: requestTelemetryFromEvents(events),
    error_category: outcome === 'success' ? null : outcome
  }

  await fsp.rm(workspace, { recursive: true, force: true })
  clearApprovals()
  if (runError instanceof FatalBenchmarkError) throw runError
  if (secrets.some((secret) => JSON.stringify(result).includes(secret))) throw new FatalBenchmarkError('benchmark resultのsecret redactionに失敗しました')
  return result
  } catch (error) {
    await fsp.rm(workspace, { recursive: true, force: true }).catch(() => {})
    clearApprovals()
    throw error
  }
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function assertNoReparseComponents(value: string): void {
  let cursor = path.resolve(value)
  while (true) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`benchmark artifact pathにjunction／シンボリックリンクは使用できません: ${cursor}`)
    const parent = path.dirname(cursor)
    if (parent === cursor) return
    cursor = parent
  }
}

function assertOutputFileTarget(value: string): void {
  assertNoReparseComponents(path.dirname(value))
  if (!fs.existsSync(value)) return
  const stat = fs.lstatSync(value)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`benchmark artifactは通常ファイルでなければなりません: ${value}`)
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

function average(values: Array<number | null | undefined>): number | null {
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return known.length === 0 ? null : known.reduce((total, value) => total + value, 0) / known.length
}

function median(values: Array<number | null | undefined>): number | null {
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).sort((left, right) => left - right)
  if (known.length === 0) return null
  const middle = Math.floor(known.length / 2)
  return known.length % 2 === 1 ? known[middle] : (known[middle - 1] + known[middle]) / 2
}

const OUTCOMES: BenchmarkOutcome[] = ['success', 'expectation_failure', 'provider_error', 'timeout', 'safety_rejection', 'harness_error', 'skipped', 'unavailable']

function resultOptimization(result: BenchmarkRunResult): BenchmarkAggregate['agent_optimization'] {
  return result.configuration.agent_optimization === 'on' || result.configuration.agent_optimization === 'off'
    ? result.configuration.agent_optimization
    : 'unknown'
}

export function aggregateBenchmarkResults(results: readonly BenchmarkRunResult[]): BenchmarkAggregate[] {
  const groups = new Map<string, BenchmarkRunResult[]>()
  for (const result of results) {
    const key = `${result.suite_id}\u0000${result.suite_version}\u0000${result.provider}\u0000${result.model}\u0000${resultOptimization(result)}`
    const group = groups.get(key) ?? []
    group.push(result)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => {
    const attempted = group.filter((result) => result.final_outcome !== 'skipped').length
    const completed = group.filter((result) => ['success', 'expectation_failure', 'safety_rejection'].includes(result.final_outcome)).length
    const passed = group.filter((result) => result.pass).length
    const observedExpectations = group.filter((result) => typeof result.expectations.total === 'number' && typeof result.expectations.passed === 'number')
    const expectationTotal = observedExpectations.reduce((total, result) => total + (result.expectations.total ?? 0), 0)
    const expectationPassed = observedExpectations.reduce((total, result) => total + (result.expectations.passed ?? 0), 0)
    const observedToolEvents = group.filter((result) => Object.values(result.tool_events).every((value) => typeof value === 'number'))
    const toolSucceeded = observedToolEvents.reduce((total, result) => total + (result.tool_events.succeeded ?? 0), 0)
    const toolDenominator = observedToolEvents.reduce((total, result) => total + (result.tool_events.succeeded ?? 0) + (result.tool_events.failed ?? 0) + (result.tool_events.rejected ?? 0) + (result.tool_events.invalid ?? 0), 0)
    const observedApprovals = group.filter((result) => typeof result.approval_count === 'number' && typeof result.approval_events.approved === 'number')
    const approvalCount = observedApprovals.reduce((total, result) => total + (result.approval_count ?? 0), 0)
    const approvalApproved = observedApprovals.reduce((total, result) => total + (result.approval_events.approved ?? 0), 0)
    const reportedUsage = group.filter((result) => result.token_usage !== null)
    const requestTelemetry = group.flatMap((result) => result.request_telemetry ?? [])
    const tokenSum = (key: keyof BenchmarkTokenUsage): number | null => {
      const values = reportedUsage.map((result) => result.token_usage?.[key]).filter((value): value is number => typeof value === 'number')
      return values.length === 0 ? null : values.reduce((total, value) => total + value, 0)
    }
    const outcomes = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, group.filter((result) => result.final_outcome === outcome).length])) as Record<BenchmarkOutcome, number>
    return {
      suite_id: group[0].suite_id,
      suite_version: group[0].suite_version,
      provider: group[0].provider,
      model: group[0].model,
      agent_optimization: resultOptimization(group[0]),
      attempted_runs: attempted,
      completed_runs: completed,
      passed_runs: passed,
      completion_rate: rate(completed, attempted),
      pass_rate: rate(passed, attempted),
      expectation_pass_rate: rate(expectationPassed, expectationTotal),
      tool_validity_rate: rate(toolSucceeded, toolDenominator),
      approval_success_rate: rate(approvalApproved, approvalCount),
      safety_rejection_count: group.filter((result) => result.safety_rejection).length,
      average_elapsed_ms: average(group.map((result) => result.elapsed_ms)),
      median_elapsed_ms: median(group.map((result) => result.elapsed_ms)),
      average_time_to_first_action_ms: average(group.map((result) => result.time_to_first_action_ms)),
      median_time_to_first_action_ms: median(group.map((result) => result.time_to_first_action_ms)),
      average_model_calls: average(group.map((result) => result.model_call_count)),
      average_tool_calls: average(group.map((result) => result.tool_call_count)),
      average_retries: average(group.map((result) => result.retry_count)),
      request_telemetry: requestTelemetry.length === 0 ? null : {
        reported_requests: requestTelemetry.length,
        average_request_elapsed_ms: average(requestTelemetry.map((record) => record.elapsedMs)),
        average_working_messages: average(requestTelemetry.map((record) => record.workingMessageCount)),
        average_exposed_tools: average(requestTelemetry.map((record) => record.exposedToolCount)),
        average_tool_schema_bytes: average(requestTelemetry.map((record) => record.toolSchemaBytes)),
        average_tool_result_context_bytes: average(requestTelemetry.map((record) => record.toolResultContextBytes)),
        total_pruned_items: requestTelemetry.reduce((total, record) => total + record.pruning.count, 0)
      },
      token_usage: reportedUsage.length === 0 ? null : {
        reported_runs: reportedUsage.length,
        input_tokens: tokenSum('input_tokens'),
        output_tokens: tokenSum('output_tokens'),
        total_tokens: tokenSum('total_tokens'),
        reasoning_tokens: tokenSum('reasoning_tokens'),
        cached_input_tokens: tokenSum('cached_input_tokens')
      },
      outcomes
    }
  }).sort((left, right) => `${left.suite_id}/${left.suite_version}/${left.provider}/${left.model}/${left.agent_optimization}`.localeCompare(`${right.suite_id}/${right.suite_version}/${right.provider}/${right.model}/${right.agent_optimization}`))
}

function formatRate(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`
}

function formatNumber(value: number | null): string {
  return value === null ? '—' : Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function runsCsv(results: readonly BenchmarkRunResult[]): string {
  const headers = [
    'suite_id', 'suite_version', 'task_id', 'run_id', 'timestamp', 'git_commit_sha', 'provider', 'model', 'agent_optimization', 'endpoint_category', 'repeat_index',
    'final_status', 'final_outcome', 'pass', 'expectations_passed', 'expectations_total', 'elapsed_ms', 'time_to_first_action_ms',
    'model_call_count', 'model_response_count', 'tool_call_count', 'tool_succeeded', 'tool_failed', 'tool_rejected', 'tool_invalid',
    'retry_count', 'approval_count', 'approval_result', 'approvals_approved', 'approvals_denied', 'approvals_unknown', 'safety_rejection', 'guard_rejection_count', 'human_intervention_count',
    'input_tokens', 'output_tokens', 'total_tokens', 'reasoning_tokens', 'cached_input_tokens', 'request_telemetry', 'error_category', 'metadata'
  ]
  const rows = results.map((result) => [
    result.suite_id, result.suite_version, result.task_id, result.run_id, result.timestamp, result.git_commit_sha, result.provider, result.model, resultOptimization(result), result.endpoint_category,
    result.repeat_index, result.final_status, result.final_outcome, result.pass, result.expectations.passed, result.expectations.total, result.elapsed_ms,
    result.time_to_first_action_ms, result.model_call_count, result.model_response_count, result.tool_call_count, result.tool_events.succeeded,
    result.tool_events.failed, result.tool_events.rejected, result.tool_events.invalid, result.retry_count, result.approval_count, result.approval_result,
    result.approval_events.approved, result.approval_events.denied, result.approval_events.unknown, result.safety_rejection, result.guard_rejection_count, result.human_intervention_count, result.token_usage?.input_tokens ?? null,
    result.token_usage?.output_tokens ?? null, result.token_usage?.total_tokens ?? null, result.token_usage?.reasoning_tokens ?? null,
    result.token_usage?.cached_input_tokens ?? null, result.request_telemetry, result.error_category, result.configuration.metadata
  ].map(csvCell).join(','))
  return `${headers.join(',')}\r\n${rows.join('\r\n')}\r\n`
}

function summaryCsv(aggregates: readonly BenchmarkAggregate[]): string {
  const headers = [
    'suite_id', 'suite_version', 'provider', 'model', 'agent_optimization', 'attempted_runs', 'completed_runs', 'passed_runs', 'completion_rate', 'pass_rate',
    'expectation_pass_rate', 'tool_validity_rate', 'approval_success_rate', 'safety_rejection_count', 'average_elapsed_ms',
    'median_elapsed_ms', 'average_time_to_first_action_ms', 'median_time_to_first_action_ms', 'average_model_calls',
    'average_tool_calls', 'average_retries', 'reported_requests', 'average_request_elapsed_ms', 'average_working_messages', 'average_exposed_tools',
    'average_tool_schema_bytes', 'average_tool_result_context_bytes', 'total_pruned_items', 'reported_token_runs', 'input_tokens', 'output_tokens', 'total_tokens', 'outcomes'
  ]
  const rows = aggregates.map((aggregate) => [
    aggregate.suite_id, aggregate.suite_version, aggregate.provider, aggregate.model, aggregate.agent_optimization, aggregate.attempted_runs, aggregate.completed_runs, aggregate.passed_runs,
    aggregate.completion_rate, aggregate.pass_rate, aggregate.expectation_pass_rate, aggregate.tool_validity_rate, aggregate.approval_success_rate,
    aggregate.safety_rejection_count, aggregate.average_elapsed_ms, aggregate.median_elapsed_ms, aggregate.average_time_to_first_action_ms,
    aggregate.median_time_to_first_action_ms, aggregate.average_model_calls, aggregate.average_tool_calls, aggregate.average_retries,
    aggregate.request_telemetry?.reported_requests ?? null, aggregate.request_telemetry?.average_request_elapsed_ms ?? null,
    aggregate.request_telemetry?.average_working_messages ?? null, aggregate.request_telemetry?.average_exposed_tools ?? null,
    aggregate.request_telemetry?.average_tool_schema_bytes ?? null, aggregate.request_telemetry?.average_tool_result_context_bytes ?? null,
    aggregate.request_telemetry?.total_pruned_items ?? null,
    aggregate.token_usage?.reported_runs ?? null, aggregate.token_usage?.input_tokens ?? null, aggregate.token_usage?.output_tokens ?? null,
    aggregate.token_usage?.total_tokens ?? null, aggregate.outcomes
  ].map(csvCell).join(','))
  return `${headers.join(',')}\r\n${rows.join('\r\n')}\r\n`
}

function markdownSummary(aggregates: readonly BenchmarkAggregate[]): string {
  const lines = [
    '# Misen Benchmark summary',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '| Suite | Version | Provider | Model | Optimization | Attempted | Passed | Pass rate | Expectation pass | Tool validity | Approval success | Safety rejections | Avg elapsed ms | Median TTFA ms | Avg model calls | Avg tool calls | Avg exposed tools | Avg schema bytes | Pruned |',
    '|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
  ]
  for (const aggregate of aggregates) {
    lines.push(`| ${aggregate.suite_id} | ${aggregate.suite_version} | ${aggregate.provider} | ${aggregate.model} | ${aggregate.agent_optimization} | ${aggregate.attempted_runs} | ${aggregate.passed_runs} | ${formatRate(aggregate.pass_rate)} | ${formatRate(aggregate.expectation_pass_rate)} | ${formatRate(aggregate.tool_validity_rate)} | ${formatRate(aggregate.approval_success_rate)} | ${aggregate.safety_rejection_count} | ${formatNumber(aggregate.average_elapsed_ms)} | ${formatNumber(aggregate.median_time_to_first_action_ms)} | ${formatNumber(aggregate.average_model_calls)} | ${formatNumber(aggregate.average_tool_calls)} | ${formatNumber(aggregate.request_telemetry?.average_exposed_tools ?? null)} | ${formatNumber(aggregate.request_telemetry?.average_tool_schema_bytes ?? null)} | ${aggregate.request_telemetry?.total_pruned_items ?? '—'} |`)
  }
  lines.push(
    '',
    '## Definitions',
    '',
    '- JSONL is the source of truth; both CSV files and this Markdown are regenerated from it.',
    '- Time-to-first-action is measured from run start to the first host tool request, or to the first model decision when no tool is requested.',
    '- Unknown/unreported values are shown as `—` and are excluded from averages and denominators; they are never treated as zero.',
    '- A safety rejection can be a passing result when the task explicitly expects the rejection.',
    '- A higher completion rate does not by itself establish general model quality; compare the same suite, quantization, context, sampling, and hardware conditions.',
    ''
  )
  return lines.join('\n')
}

export function readBenchmarkJsonl(jsonlPath: string): BenchmarkRunResult[] {
  if (!fs.existsSync(jsonlPath)) throw new Error(`JSONL sourceが存在しません: ${jsonlPath}`)
  assertNoReparseComponents(jsonlPath)
  const stat = fs.lstatSync(jsonlPath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`JSONL sourceは通常ファイルでなければなりません: ${jsonlPath}`)
  const lines = fs.readFileSync(jsonlPath, 'utf8').split(/\r?\n/u).filter(Boolean)
  if (lines.length === 0) throw new Error(`JSONL sourceにbenchmark runがありません: ${jsonlPath}`)
  return lines.map((line, index) => {
    let parsed: unknown
    try { parsed = JSON.parse(line) as unknown } catch { throw new Error(`JSONL ${index + 1}行目が不正です`) }
    if (!isRecord(parsed) || parsed.benchmark_schema_version !== BENCHMARK_RUN_SCHEMA) throw new Error(`JSONL ${index + 1}行目のschemaが不正です`)
    return parsed as unknown as BenchmarkRunResult
  })
}

export async function generateBenchmarkReports(jsonlPath: string, outputDirectory: string): Promise<Omit<RunBenchmarkSummary, 'results'>> {
  const results = readBenchmarkJsonl(jsonlPath)
  const aggregates = aggregateBenchmarkResults(results)
  await fsp.mkdir(outputDirectory, { recursive: true })
  const runsCsvPath = path.join(outputDirectory, 'runs.csv')
  const summaryCsvPath = path.join(outputDirectory, 'summary.csv')
  const markdownPath = path.join(outputDirectory, 'summary.md')
  assertOutputFileTarget(runsCsvPath)
  assertOutputFileTarget(summaryCsvPath)
  assertOutputFileTarget(markdownPath)
  await fsp.writeFile(runsCsvPath, runsCsv(results), 'utf8')
  await fsp.writeFile(summaryCsvPath, summaryCsv(aggregates), 'utf8')
  await fsp.writeFile(markdownPath, markdownSummary(aggregates), 'utf8')
  return { aggregates, jsonlPath, runsCsvPath, summaryCsvPath, markdownPath }
}

async function startMockServer(suite: BenchmarkSuite): Promise<{ baseURL: string; close(): Promise<void> }> {
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk)
      total += buffer.length
      if (total > 2_000_000) { response.writeHead(413).end(); return }
      chunks.push(buffer)
    }
    let body: Record<string, unknown>
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> } catch { response.writeHead(400).end(); return }
    const messages = Array.isArray(body.messages) ? body.messages.filter(isRecord) : []
    const userText = messages.filter((message) => message.role === 'user').map((message) => String(message.content ?? '')).join('\n')
    const taskId = userText.match(/\[MISEN_BENCHMARK_TASK_ID:([^\]]+)\]/u)?.[1]
    const task = suite.tasks.find((candidate) => candidate.id === taskId)
    const toolResults = messages.filter((message) => message.role === 'tool').length
    const step = task?.mock?.steps[toolResults]
    if (!task || !step) {
      response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: { message: 'benchmark mock script unavailable' } }))
      return
    }
    if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs))
    if (step.error !== undefined) {
      response.writeHead(step.status ?? 500, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: { message: step.error } }))
      return
    }
    const message = step.tool
      ? {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: `mock-${task.id}-${toolResults + 1}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) } }]
        }
      : { role: 'assistant', content: step.answer ?? '' }
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({
      id: `benchmark-${crypto.randomUUID()}`,
      object: 'chat.completion',
      created: 0,
      model: 'benchmark-loopback',
      choices: [{ index: 0, message, finish_reason: step.tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('benchmark mock server portを取得できません')
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

function assertArtifactsDoNotContainSecrets(paths: readonly string[], secrets: readonly string[]): void {
  for (const artifactPath of paths) {
    if (!fs.existsSync(artifactPath)) continue
    const text = fs.readFileSync(artifactPath, 'utf8')
    const leaked = secrets.find((secret) => text.includes(secret))
    if (leaked) throw new FatalBenchmarkError(`secret markerがartifactへ漏洩しました: ${path.basename(artifactPath)}`)
  }
}

export async function runBenchmark(options: RunBenchmarkOptions): Promise<RunBenchmarkSummary> {
  if (!Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > 1000) throw new Error('repeat は1以上1000以下の整数で指定してください')
  safeMetadata(options.metadata)
  assertSupportedSecretValues(options, options.baseConfig)
  const initialSecrets = knownSecretValues(options, options.baseConfig)
  const providerVisibleSuite = JSON.stringify({
    id: options.suite.id,
    version: options.suite.version,
    title: options.suite.title,
    fixtures: options.suite.fixtures,
    tasks: options.suite.tasks.map(({ mock: _mock, ...task }) => task)
  })
  if (initialSecrets.some((secret) => providerVisibleSuite.includes(secret))) throw new FatalBenchmarkError('providerへ渡るsuite/fixtureにcredentialまたはsecret markerが含まれています')
  if (initialSecrets.some((secret) => JSON.stringify(options.metadata ?? {}).includes(secret))) throw new FatalBenchmarkError('benchmark metadataにcredentialまたはsecret markerが含まれています')
  const logger = options.logger ?? console
  const outputDirectory = path.resolve(options.outputDirectory)
  await fsp.mkdir(outputDirectory, { recursive: true })
  assertNoReparseComponents(outputDirectory)
  const workspacesDirectory = path.join(outputDirectory, 'workspaces')
  await fsp.mkdir(workspacesDirectory, { recursive: true })
  assertNoReparseComponents(workspacesDirectory)
  const jsonlPath = path.join(outputDirectory, 'results.jsonl')
  assertOutputFileTarget(jsonlPath)
  const auditDirectory = path.join(outputDirectory, 'audit')
  const auditLog = new AuditLog({ workspace: path.join(workspacesDirectory, 'boundary-placeholder'), directory: auditDirectory })
  auditLog.initialize()
  let mockServer: Awaited<ReturnType<typeof startMockServer>> | undefined
  if (options.mock) mockServer = await startMockServer(options.suite)
  const invocationResults: BenchmarkRunResult[] = []
  try {
    for (let repeatIndex = 1; repeatIndex <= options.repeat; repeatIndex++) {
      for (const task of options.suite.tasks) {
        let result: BenchmarkRunResult
        try {
          result = await runOne({ ...options, outputDirectory }, task, repeatIndex, auditLog, mockServer?.baseURL)
        } catch (error) {
          if (error instanceof FatalBenchmarkError) throw error
          const now = new Date().toISOString()
          result = {
            benchmark_schema_version: BENCHMARK_RUN_SCHEMA,
            runner_version: BENCHMARK_RUNNER_VERSION,
            suite_schema_version: BENCHMARK_SUITE_SCHEMA,
            task_schema_version: BENCHMARK_TASK_SCHEMA,
            suite_id: options.suite.id,
            suite_version: options.suite.version,
            task_id: task.id,
            run_id: crypto.randomUUID(),
            timestamp: now,
            git_commit_sha: gitCommitSha(path.resolve(__dirname, '..')),
            provider: options.provider,
            model: options.model,
            endpoint_category: 'unknown',
            configuration: { agent_loop: 'v2', agent_optimization: options.baseConfig.agentOptimization === 'off' ? 'off' : 'on', temperature: null, reasoning_effort: null, max_model_decisions: null, max_host_executions: null, metadata: safeMetadata(options.metadata) },
            repeat_index: repeatIndex,
            seed: null,
            seed_guaranteed: false,
            final_status: 'unknown',
            final_outcome: classifyUnavailable(error) ? 'unavailable' : 'harness_error',
            expectations: { passed: null, total: null, details: [] },
            pass: false,
            elapsed_ms: null,
            time_to_first_action_ms: null,
            model_call_count: null,
            model_response_count: null,
            tool_call_count: null,
            tool_events: { succeeded: null, failed: null, rejected: null, invalid: null },
            retry_count: null,
            approval_count: null,
            approval_result: 'unknown',
            approval_events: { approved: null, denied: null, unknown: null },
            safety_rejection: null,
            guard_rejection_count: null,
            human_intervention_count: null,
            token_usage: null,
            request_telemetry: [],
            error_category: classifyUnavailable(error) ? 'unavailable' : 'harness_error'
          }
        }
        const secrets = knownSecretValues(options, options.baseConfig)
        const serialized = redactText(JSON.stringify(result), secrets)
        if (secrets.some((secret) => serialized.includes(secret))) throw new FatalBenchmarkError('result serializationのsecret redactionに失敗しました')
        await fsp.appendFile(jsonlPath, `${serialized}\n`, 'utf8')
        invocationResults.push(JSON.parse(serialized) as BenchmarkRunResult)
      }
    }
    const reports = await generateBenchmarkReports(jsonlPath, outputDirectory)
    const secrets = knownSecretValues(options, options.baseConfig)
    assertArtifactsDoNotContainSecrets([jsonlPath, reports.runsCsvPath, reports.summaryCsvPath, reports.markdownPath, auditLog.filePath], secrets)
    logger.log(`BENCHMARK_SUMMARY suite=${options.suite.id} runs=${invocationResults.length} passed=${invocationResults.filter((result) => result.pass).length} failed=${invocationResults.filter((result) => !result.pass).length}`)
    return { results: invocationResults, ...reports }
  } catch (error) {
    logger.error(`BENCHMARK_FAILED category=harness_error detail=${redactText((error as Error).message || String(error), knownSecretValues(options, options.baseConfig))}`)
    throw error
  } finally {
    clearApprovals()
    await mockServer?.close().catch(() => {})
    auditLog.close()
  }
}
