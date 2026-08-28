import path from 'node:path'
import { generateBenchmarkReports, loadBenchmarkSuite, runBenchmark } from './benchmark'
import { loadConfig, type AgentConfig, type AgentOptimizationMode, type LlmProvider } from './config'

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function values(flag: string): string[] {
  const found: string[] = []
  for (let index = 0; index < process.argv.length; index++) {
    if (process.argv[index] === flag && process.argv[index + 1]) found.push(process.argv[index + 1])
  }
  return found
}

function has(flag: string): boolean {
  return process.argv.includes(flag)
}

function required(flag: string): string {
  const found = value(flag)
  if (!found || found.startsWith('--')) throw new Error(`${flag} が必要です`)
  return found
}

function positiveInteger(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} は1以上の整数で指定してください`)
  return parsed
}

function provider(raw: string): LlmProvider {
  if (raw !== 'openai' && raw !== 'copilot-edge' && raw !== 'ollama' && raw !== 'external-openai') {
    throw new Error('--provider は openai / copilot-edge / ollama / external-openai で指定してください')
  }
  return raw
}

function optimization(raw: string | undefined): AgentOptimizationMode | undefined {
  if (raw === undefined) return undefined
  if (raw !== 'on' && raw !== 'off') throw new Error('--optimization は on または off で指定してください')
  return raw
}

function metadata(): Record<string, string> {
  const result: Record<string, string> = {}
  for (const entry of values('--metadata')) {
    const separator = entry.indexOf('=')
    if (separator <= 0) throw new Error('--metadata は key=value で指定してください')
    const key = entry.slice(0, separator).trim()
    const entryValue = entry.slice(separator + 1).trim()
    if (!key || !entryValue) throw new Error('--metadata は空でない key=value で指定してください')
    result[key] = entryValue
  }
  return result
}

function mockConfig(model: string): AgentConfig {
  return {
    agentLoop: 'v2',
    provider: 'openai',
    baseURL: 'http://127.0.0.1:1/v1',
    apiKey: 'benchmark-loopback-token',
    model,
    temperature: 0,
    restrictToWorkspace: true,
    safeCommandOnly: true,
    maxToolIterations: 8,
    maxToolExecutions: 6,
    maxWriteExecutions: 3,
    maxCommandExecutions: 0,
    maxNoProgress: 2,
    allowArbitraryCommands: false,
    autoApprove: { write: false, command: false },
    permissions: [
      { permission: 'list_files', pattern: '*', action: 'allow' },
      { permission: 'read_file', pattern: '*', action: 'allow' },
      { permission: 'read_files', pattern: '*', action: 'allow' },
      { permission: 'search_files', pattern: '*', action: 'allow' },
      { permission: 'write_file', pattern: '*', action: 'ask' },
      { permission: 'write_file.overwrite', pattern: '*', action: 'ask' },
      { permission: 'start_process', pattern: '*', action: 'deny' },
      { permission: 'run_command', pattern: '*', action: 'deny' }
    ]
  }
}

function printHelp(): void {
  console.log([
    'Misen Benchmark Phase 1',
    '',
    'Run a suite:',
    '  node dist/benchmark.js --suite synthetic-smoke --config config.json --provider ollama --model model-id --repeat 2 --output .tmp/benchmark',
    '',
    'Credential-free deterministic loopback:',
    '  node dist/benchmark.js --suite synthetic-smoke --provider openai --model benchmark-loopback --repeat 2 --output .tmp/benchmark --mock --auto-approve-synthetic',
    '',
    'Regenerate CSV/Markdown from JSONL:',
    '  node dist/benchmark.js --summarize .tmp/benchmark/results.jsonl --output .tmp/benchmark',
    '',
    'Options: --timeout-ms N, --optimization on|off, --metadata key=value (repeatable), --auto-approve-synthetic'
  ].join('\n'))
}

async function main(): Promise<void> {
  if (has('--help') || has('-h')) { printHelp(); return }
  const outputDirectory = path.resolve(required('--output'))
  const summarize = has('--summarize') ? required('--summarize') : undefined
  if (summarize) {
    const reports = await generateBenchmarkReports(path.resolve(summarize), outputDirectory)
    console.log(`BENCHMARK_SUMMARY regenerated=${reports.aggregates.length} jsonl=${reports.jsonlPath}`)
    return
  }
  const suite = loadBenchmarkSuite(required('--suite'))
  const selectedProvider = provider(required('--provider'))
  const selectedModel = required('--model')
  const mock = has('--mock')
  if (mock && selectedProvider !== 'openai') throw new Error('--mock は既存openai providerのloopback fixtureとしてだけ実行できます')
  const configPath = value('--config')
  if (!mock && !configPath) throw new Error('実provider benchmark は --config が必要です')
  const loadedConfig = mock ? mockConfig(selectedModel) : loadConfig(path.resolve(configPath!))
  const selectedOptimization = optimization(value('--optimization'))
  const baseConfig = selectedOptimization === undefined
    ? loadedConfig
    : { ...loadedConfig, agentOptimization: selectedOptimization }
  const summary = await runBenchmark({
    suite,
    outputDirectory,
    provider: selectedProvider,
    model: selectedModel,
    repeat: positiveInteger(value('--repeat'), 1, '--repeat'),
    ...(value('--timeout-ms') ? { timeoutMs: positiveInteger(value('--timeout-ms'), 1, '--timeout-ms') } : {}),
    baseConfig,
    autoApproveSynthetic: has('--auto-approve-synthetic'),
    metadata: metadata(),
    mock
  })
  process.exitCode = summary.results.every((result) => result.pass) ? 0 : 1
}

main().catch((error) => {
  console.error(`BENCHMARK_FAILED category=harness_error detail=${(error as Error).message || String(error)}`)
  process.exitCode = 1
})
