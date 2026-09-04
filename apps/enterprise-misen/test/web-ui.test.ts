import test from 'node:test'
import { strict as assert } from 'node:assert'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture } from '../demo/enterprise-excel/fixtures.js'
import { createDemoServer, type AgentRunner } from '../src/web/server.js'

async function start(root: string, runner: AgentRunner) {
  const server = createDemoServer(root, runner, undefined, { sessionDirectory: join(root, '.test-data', 'sessions') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { server, base: `http://127.0.0.1:${address.port}` }
}

async function runSession(base: string, prompt: string, clientId: string) {
  const created = await fetch(`${base}/sessions`, { method: 'POST', headers: { origin: base } })
  assert.equal(created.status, 201)
  const session = await created.json() as { id: string }
  return fetch(`${base}/run`, { method: 'POST', redirect: 'manual', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ prompt, clientId, sessionId: session.id }) })
}

test('assistant-ui composition keeps the conversation surface restrained and safe', async () => {
  const componentNames = [
    'thread.aui.tsx',
    'thread-list.aui.tsx',
    'tool-fallback.aui.tsx',
    'tool-group.aui.tsx',
    'markdown-text.tsx',
    'file.tsx',
    'tooltip-icon-button.tsx',
  ]
  const client = await readFile(join(process.cwd(), 'src', 'web', 'client.tsx'), 'utf8')
  const attachment = await readFile(join(process.cwd(), 'src', 'web', 'components', 'attachment.aui.tsx'), 'utf8')
  const projectControls = await readFile(join(process.cwd(), 'src', 'web', 'project-controls.tsx'), 'utf8')
  const source = [
    client,
    attachment,
    projectControls,
    ...await Promise.all(componentNames.map(name => readFile(join(process.cwd(), 'src', 'web', 'components', 'assistant-ui', 'elements', name), 'utf8'))),
  ].join('\n')
  const styles = await readFile(join(process.cwd(), 'src', 'web', 'client.css'), 'utf8')
  const clientBuild = await readFile(join(process.cwd(), 'scripts', 'build-client.mjs'), 'utf8')
  const server = await readFile(join(process.cwd(), 'src', 'web', 'server.ts'), 'utf8')
  const registry = JSON.parse(await readFile(join(process.cwd(), 'components.json'), 'utf8')) as { registries: Record<string, string> }
  const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as { dependencies: Record<string, string> }

  assert.equal(registry.registries['@assistant-ui'], 'https://r.assistant-ui.com/styles/{style}/{name}.json')
  assert.match(source, /useExternalStoreRuntime</)
  assert.match(source, /adapters:\s*\{\s*threadList,\s*attachments:\s*misenAttachmentAdapter\s*\}/u)
  assert.match(source, /ExternalStoreThreadListAdapter/)
  assert.match(source, /onSwitchToNewThread/)
  assert.match(source, /onSwitchToThread/)
  assert.match(source, /isDisabled:\s*readOnly/u)
  assert.match(source, /isSendDisabled/)
  assert.match(source, /eventAppliesToActiveSession/)
  assert.match(source, /beginSessionSelection/)
  assert.doesNotMatch(source, /useState<(?:ToolEvent|UiArtifact)\[\]>|expandedRunId|runIdRef|shouldShowThinkingPlaceholder|runIdFromMessage|processEventsForRun|HistoryPanel|ProcessRows/u)

  assert.match(source, /ThreadPrimitive\.Viewport/)
  assert.match(source, /ThreadPrimitive\.ViewportFooter/)
  assert.match(source, /ThreadPrimitive\.ScrollToBottom/)
  assert.match(source, /autoScroll/)
  assert.match(source, /turnAnchor="top"/)
  assert.match(source, /ComposerPrimitive\.Input/)
  assert.match(source, /ComposerPrimitive\.Send/)
  assert.match(source, /ComposerPrimitive\.Cancel/)
  assert.match(source, /ComposerPrimitive\.AddAttachment/)
  assert.match(source, /ComposerPrimitive\.AttachmentDropzone/)
  assert.match(source, /持ち込んだファイルはこの PC の作業フォルダーに置かれ、外へは出ません/u)
  assert.doesNotMatch(source, /onClick=\{(?:onCancel|cancel)\}/u)

  assert.match(source, /MessagePrimitive\.GroupedParts/)
  assert.match(source, /ToolGroup/)
  assert.match(source, /件の操作/u)
  assert.match(source, /MessagePrimitive\.Error/)
  assert.match(source, /metadata\?\.custom/)
  assert.match(source, /\/download\/\$\{encodeURIComponent\(artifact\.id\)\}/u)
  assert.match(source, /type:\s*'file'/u)
  assert.match(source, /sourceType:\s*'url'/u)
  assert.match(source, /<File \{\.\.\.part\}/u)
  for (const label of ['ファイル一覧を確認', '業務ガイドを確認', 'Excelを確認', 'Wordを確認', 'PowerPointを確認', 'Officeの内容を確認', 'Officeの要素を検索', 'Officeファイルを検証', 'Officeファイルを作成', 'Officeの書式・値を更新', 'Officeの要素を追加', 'Officeの要素を削除', 'Officeの要素を移動', 'Officeの要素を入れ替え', 'Officeファイルを一括更新', '表データを取り込み']) assert.match(source, new RegExp(label, 'u'))

  assert.match(source, /ThreadListPrimitive\.Root/)
  assert.match(source, /ThreadListPrimitive\.New/)
  assert.match(source, /ThreadListPrimitive\.ItemByIndex/)
  assert.match(source, /ThreadListItemPrimitive\.Root/)
  assert.match(source, /ThreadListItemPrimitive\.Trigger/)
  assert.match(source, /ThreadListItemPrimitive\.Title/)
  assert.match(source, /新しいチャット/u)
  assert.match(source, /ThreadListItemPrimitive\.Delete/u)
  assert.match(source, /onDelete:\s*deleteSession/u)
  assert.match(client, /bg-muted\/30/u)
  assert.match(client, /rounded-lg/u)
  assert.match(client, /PanelLeftIcon/u)
  assert.match(client, /ThreadListRoot/u)
  assert.match(client, /ThreadListItems/u)
  assert.doesNotMatch(client, /ThreadListSearch|<ThreadList\s*\/>/u)
  assert.doesNotMatch(source, /onRename|ThreadListItemPrimitive\.(?:Archive|Unarchive)/u)
  assert.doesNotMatch(source, /adapters:\s*\{[^}]*(?:speech|dictation|voice|feedback)/u)
  for (const label of ['プロジェクト', 'フォルダーを選ぶ…', 'エクスプローラーで開く', '承認', '毎回確認', 'このセッションは自動', 'このプロジェクトのファイルは PC から出ません']) assert.match(source, new RegExp(label, 'u'))

  assert.doesNotMatch(source, /viewportRef|scrollHeight|scrollTop|clientHeight/)
  assert.doesNotMatch(source, /assistant-cloud|AssistantCloud|pi-web|Vercel AI SDK|react-ai-sdk|useChatRuntime/iu)
  assert.doesNotMatch(source, /ModelSelector|BranchPicker|ActionBarPrimitive\.(?:Edit|Reload)|ComposerPrimitive\.Dictate|MicIcon|ReasoningRoot|AssistantCloud/u)
  for (const forbidden of ['@assistant-ui/react-ui', '@assistant-ui/react-ai-sdk', 'assistant-cloud', 'ai', '@ai-sdk/react', 'tailwindcss', 'shadcn']) assert.equal(pkg.dependencies[forbidden], undefined, forbidden)

  assert.match(styles, /@import "tailwindcss"/u)
  assert.match(styles, /@source "\.\/\*\*\/\*\.\{ts,tsx\}"/u)
  assert.match(styles, /@custom-variant dark/u)
  assert.match(styles, /--background:\s*oklch/u)
  assert.match(styles, /--font-sans:\s*"BIZ UDPGothic"/u)
  assert.match(clientBuild, /@tailwindcss\/postcss/u)
  assert.match(clientBuild, /plugins:\s*\[tailwindPlugin\]/u)
  assert.match(source, /sticky bottom-0/u)
  assert.doesNotMatch(styles, /position:\s*fixed/u)
  assert.match(source, /aui-tool-group/u)
  assert.match(source, /aui-thread-root/u)
  assert.match(server, /<link rel="icon" href="data:,">/u)
  assert.doesNotMatch(source, /[▣↗◌✓↑■›⌄↓]/u)
})

test('SSE preserves the Brain visible final answer instead of overwriting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-ui-sse-'))
  await fixture(root)
  const runner: AgentRunner = async (_root, _prompt, context) => {
    context?.emit({ type: 'tool', phase: 'start', id: 't1', name: 'spreadsheet_read', detail: '8月/Alpha.xlsx' })
    context?.emit({ type: 'assistant', text: '月次' })
    context?.emit({ type: 'tool', phase: 'end', id: 't1', name: 'spreadsheet_read', status: 'success' })
    context?.emit({ type: 'assistant', text: 'Brainが返した最終回答です。', done: true })
    return { tools: ['spreadsheet_read'], status: 'COMPLETED' }
  }
  const { server, base } = await start(root, runner)
  const stream = await fetch(`${base}/events`)
  const reader = stream.body!.getReader()
  const decoder = new TextDecoder()
  let received = ''
  const done = new Promise<void>((resolve, reject) => {
    const read = async () => {
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) return resolve()
          received += decoder.decode(chunk.value, { stream: true })
          if (received.includes('"status":"COMPLETED"')) return resolve()
        }
      } catch (error) { reject(error) }
    }
    void read()
  })
  try {
    const response = await runSession(base, '8月の利益状況を説明して', 'ui-test-1')
    assert.equal(response.status, 303)
    await done
    assert.match(received, /event: user/)
    assert.match(received, /event: tool/)
    assert.match(received, /event: assistant/)
    assert.match(received, /spreadsheet_read/)
    assert.match(received, /Brainが返した最終回答です/u)
    assert.doesNotMatch(received, /月次管理レポートを作成しました/u)
    assert.doesNotMatch(received, /chain.of.thought|provider_payload|api[_-]?key/iu)
  } finally {
    await reader.cancel()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('SSE uses the controlled success fallback only when the Brain emits no visible text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-ui-fallback-'))
  await fixture(root)
  const runner: AgentRunner = async () => ({ tools: [], status: 'COMPLETED' })
  const { server, base } = await start(root, runner)
  const stream = await fetch(`${base}/events`)
  const reader = stream.body!.getReader()
  const decoder = new TextDecoder()
  let received = ''
  const done = (async () => {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      received += decoder.decode(chunk.value, { stream: true })
      if (received.includes('"status":"COMPLETED"')) return
    }
  })()
  try {
    const response = await runSession(base, '自由形式の質問', 'ui-fallback-1')
    assert.equal(response.status, 303)
    await done
    assert.match(received, /処理が完了しました/u)
    assert.doesNotMatch(received, /PASS|月次管理レポートを作成しました/u)
  } finally {
    await reader.cancel()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('cancel endpoint invokes the current Pi run and never exposes an arbitrary artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-ui-cancel-'))
  await fixture(root)
  await writeFile(join(root, 'output', 'safe.xlsx'), 'safe')
  let cancel: (() => void) | undefined
  let released = false
  let markRunnerStarted!: () => void
  const runnerStarted = new Promise<void>(resolve => { markRunnerStarted = resolve })
  const runner: AgentRunner = async (_root, _prompt, context) => {
    await new Promise<void>(resolve => {
      cancel = () => { released = true; resolve() }
      context?.setCancel(cancel)
      markRunnerStarted()
    })
    return { tools: [], status: 'CANCELLED' }
  }
  const { server, base } = await start(root, runner)
  const stream = await fetch(`${base}/events`)
  const reader = stream.body!.getReader()
  const decoder = new TextDecoder()
  let received = ''
  const watch = (async () => {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      received += decoder.decode(part.value, { stream: true })
      if (received.includes('"status":"CANCELLED"')) break
    }
  })()
  try {
    const run = runSession(base, 'この処理を開始して', 'ui-cancel-1')
    await runnerStarted
    const cancelResponse = await fetch(`${base}/cancel`, { method: 'POST', headers: { origin: base } })
    assert.equal(cancelResponse.status, 202)
    await run
    await watch
    assert.equal(released, true)
    assert.match(received, /CANCELLED/)
    const download = await fetch(`${base}/download`)
    assert.equal(download.status, 404)
    const state = await (await fetch(`${base}/state`)).json() as { artifacts: unknown[] }
    assert.deepEqual(state.artifacts, [])
  } finally {
    await reader.cancel()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
