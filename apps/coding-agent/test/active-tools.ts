import assert from 'node:assert/strict'
import {
  checkActiveTool,
  detectMissingActiveTool,
  isToolSelected,
  selectActiveTools,
  type ActiveToolsSelection
} from '../src/active-tools'
import type { ToolDef } from '../src/tools'

function fakeTool(name: string, kind: ToolDef['kind'], description = name): ToolDef {
  return {
    name,
    description,
    kind,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() { return '' }
  }
}

const tools: readonly ToolDef[] = [
  fakeTool('list_files', 'read', 'list workspace files'),
  fakeTool('read_file', 'read', 'read one local file'),
  fakeTool('search_files', 'read', 'search local files'),
  fakeTool('get_weather', 'read', 'fetch current weather from Open-Meteo'),
  fakeTool('fetch_url', 'read', 'fetch an HTTP URL'),
  fakeTool('write_file', 'write', 'create or overwrite a local file'),
  fakeTool('edit_file', 'write', 'edit a local file'),
  fakeTool('start_process', 'command', 'start a process'),
  fakeTool('run_command', 'command', 'run a shell command')
]

function names(selection: ActiveToolsSelection): string[] {
  return selection.toolDefs.map((tool) => tool.name)
}

function testReadAndOpenRequests(): void {
  const listed = selectActiveTools({ toolDefs: tools, userInput: 'Please list and inspect the files' })
  assert.equal(listed.category, 'read')
  assert.equal(listed.conservativeFallback, false)
  assert.deepEqual(names(listed), ['list_files', 'read_file', 'search_files'])
  assert.ok(!names(listed).includes('write_file'))
  assert.ok(!names(listed).includes('run_command'))

  const opened = selectActiveTools({ toolDefs: tools, userInput: 'Open the README file' })
  assert.equal(opened.category, 'read-command')
  assert.ok(names(opened).includes('read_file'))
  assert.ok(names(opened).includes('start_process'), 'explicit open intent must retain the normal safe-open path')

  const Japanese = selectActiveTools({ toolDefs: tools, userInput: 'ファイルを検索して一覧を表示して' })
  assert.equal(Japanese.category, 'read')
  assert.deepEqual(names(Japanese), ['list_files', 'read_file', 'search_files'])
}

function testWriteRequestsExposeReadAndWrite(): void {
  const created = selectActiveTools({ toolDefs: tools, userInput: 'Create a report artifact' })
  assert.equal(created.category, 'write')
  assert.deepEqual(names(created), ['list_files', 'read_file', 'search_files', 'write_file', 'edit_file'])
  assert.ok(!names(created).includes('run_command'))

  const investigated = selectActiveTools({ toolDefs: tools, userInput: 'Read the existing report, then update it' })
  assert.equal(investigated.category, 'read-write')
  assert.deepEqual(names(investigated), ['list_files', 'read_file', 'search_files', 'write_file', 'edit_file'])
}

function testCommandAndNetworkSignals(): void {
  const command = selectActiveTools({ toolDefs: tools, userInput: 'Run the tests from the terminal' })
  assert.equal(command.category, 'command')
  assert.ok(names(command).includes('run_command'))
  assert.ok(names(command).includes('start_process'))
  assert.ok(names(command).includes('read_file'), 'command turns retain local reads for setup/inspection')
  assert.ok(!names(command).includes('write_file'))
  assert.ok(!names(command).includes('fetch_url'), 'network read tools stay hidden without network indication')

  const network = selectActiveTools({ toolDefs: tools, userInput: 'Fetch the URL with curl' })
  assert.equal(network.category, 'command')
  assert.ok(names(network).includes('fetch_url'))
  assert.ok(names(network).includes('run_command'))

  const namedCommand = selectActiveTools({ toolDefs: tools, userInput: 'Please call run_command' })
  assert.equal(namedCommand.category, 'command', 'an explicit generic tool name is a command indication')
  assert.ok(names(namedCommand).includes('run_command'))
  assert.ok(!names(namedCommand).includes('write_file'))

  const weather = selectActiveTools({ toolDefs: tools, userInput: 'Check the weather' })
  assert.equal(weather.category, 'read')
  assert.ok(names(weather).includes('get_weather'))
  assert.ok(!names(weather).includes('fetch_url'))

  for (const codingRequest of ['Fix the bug', 'Implement the feature', 'Refactor this module', 'アプリを実装してください']) {
    const coding = selectActiveTools({ toolDefs: tools, userInput: codingRequest })
    assert.ok(coding.category.includes('write'))
    assert.ok(coding.category.includes('command'))
    assert.ok(names(coding).includes('write_file'))
    assert.ok(names(coding).includes('run_command'), `${codingRequest} must retain verification commands`)
  }
}

function testUncertainAndPolicyInput(): void {
  const uncertain = selectActiveTools({ toolDefs: tools, userInput: 'Help me with this' })
  assert.equal(uncertain.category, 'uncertain')
  assert.equal(uncertain.conservativeFallback, true)
  assert.strictEqual(uncertain.toolDefs, tools, 'uncertain requests retain the exact policy-filtered input')

  const policyFiltered = tools.filter((tool) => tool.name !== 'run_command')
  const widened = selectActiveTools({ toolDefs: policyFiltered, userInput: 'No recognizable intent here: fixture_abc task_123' })
  assert.equal(widened.conservativeFallback, true)
  assert.strictEqual(widened.toolDefs, policyFiltered)
  assert.ok(!names(widened).includes('run_command'), 'selector must not reintroduce policy-disabled tools')

  const bareOpen = selectActiveTools({ toolDefs: tools, userInput: '開く' })
  assert.equal(bareOpen.conservativeFallback, true)
  assert.strictEqual(bareOpen.toolDefs, tools)

  const mixedUnknown = selectActiveTools({ toolDefs: tools, userInput: 'Read README and copy it to backup.txt' })
  assert.equal(mixedUnknown.category, 'uncertain')
  assert.equal(mixedUnknown.conservativeFallback, true)
  assert.strictEqual(mixedUnknown.toolDefs, tools, 'an unknown additional clause must widen instead of hiding a needed tool')

  for (const request of ['Read README & copy it to backup.txt', "Read README\ncopy it to backup.txt", 'READMEを読んで、およびバックアップにも反映']) {
    const separated = selectActiveTools({ toolDefs: tools, userInput: request })
    assert.equal(separated.conservativeFallback, true, `${request} must preserve the policy-filtered fallback`)
    assert.strictEqual(separated.toolDefs, tools)
  }

  const disabled = selectActiveTools({ toolDefs: tools, userInput: 'Help me with this', optimizationEnabled: false })
  assert.equal(disabled.category, 'full')
  assert.equal(disabled.conservativeFallback, false)
  assert.strictEqual(disabled.toolDefs, tools)

  const nonWork = selectActiveTools({ toolDefs: tools, userInput: 'List files', mode: 'ask' })
  assert.equal(nonWork.category, 'full')
  assert.strictEqual(nonWork.toolDefs, tools)
}

function testExplicitRunScopedAndMissingToolFailSafe(): void {
  const scoped = [tools[0], tools[7]] as const
  const explicit = selectActiveTools({
    toolDefs: scoped,
    userInput: 'Delete everything and run a shell command',
    explicitRunScoped: true
  })
  assert.equal(explicit.category, 'explicit-run-scoped')
  assert.equal(explicit.conservativeFallback, false)
  assert.strictEqual(explicit.toolDefs, scoped, 'explicit run-scoped defs must be preserved verbatim')
  assert.deepEqual(names(explicit), ['list_files', 'start_process'])

  assert.equal(isToolSelected(explicit, 'start_process'), true)
  assert.equal(isToolSelected('host__start_process', explicit), true)
  assert.equal(isToolSelected(explicit, 'run_command'), false)

  const missing = detectMissingActiveTool(explicit, 'run_command')
  assert.equal(missing.selected, false)
  assert.equal(missing.missing, true)
  assert.equal(missing.conservativeRetryRecommended, true)
  assert.match(missing.reason, /retry|abort/u)
  assert.strictEqual(explicit.toolDefs, scoped, 'missing-tool inspection must not widen or mutate the set')

  const present = checkActiveTool('start_process', explicit)
  assert.equal(present.selected, true)
  assert.equal(present.missing, false)
  assert.equal(present.conservativeRetryRecommended, false)
}

function testExplicitToolNameIsNeverDropped(): void {
  const namedWrite = selectActiveTools({ toolDefs: tools, userInput: 'Use write_file with the supplied path' })
  assert.equal(namedWrite.category, 'write')
  assert.ok(names(namedWrite).includes('write_file'))
  assert.ok(!names(namedWrite).includes('run_command'))

  const namedCommand = selectActiveTools({ toolDefs: tools, userInput: 'Please use run_command' })
  assert.equal(namedCommand.category, 'command')
  assert.ok(names(namedCommand).includes('run_command'))
}

function main(): void {
  testReadAndOpenRequests()
  testWriteRequestsExposeReadAndWrite()
  testCommandAndNetworkSignals()
  testUncertainAndPolicyInput()
  testExplicitRunScopedAndMissingToolFailSafe()
  testExplicitToolNameIsNeverDropped()
  console.log('PASS active-tools')
}

main()
