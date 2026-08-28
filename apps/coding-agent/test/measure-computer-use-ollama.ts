import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { runAgentTurnV2 } from '../src/agent-v2'
import type { AgentEvent, AgentIO } from '../src/agent'
import { HeadedComputerUseSurface } from '../src/computer-use-cdp'
import {
  COMPUTER_USE_DEMO_PROMPT,
  createOpenCompanyTool,
  createSyntheticBusinessScreen,
  type ScreenshotObservation
} from '../src/computer-use-demo'
import type { AgentConfig } from '../src/config'
import { selectVisionBudget } from '../src/vision-budget'
import type { ToolContext } from '../src/tools'

interface CliOptions {
  seed: number
  budget: number
  model: string
  baseURL: string
  outputDirectory: string
  captureOnly: boolean
  omitScreenshot: boolean
}

function parseArgs(args: readonly string[]): CliOptions {
  const read = (name: string): string | undefined => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  const seed = Number(read('--seed') ?? '53028')
  const budget = Number(read('--budget') ?? '512')
  if (!Number.isSafeInteger(seed)) throw new Error('--seed must be a safe integer')
  if (!Number.isSafeInteger(budget)) throw new Error('--budget must be an integer')
  return {
    seed,
    budget,
    model: read('--model') ?? process.env.OLLAMA_MODEL ?? 'ornith-1.5:9b',
    baseURL: read('--base-url') ?? 'http://127.0.0.1:11434/v1',
    outputDirectory: path.resolve(read('--output') ?? path.join('.tmp', 'computer-use-live')),
    captureOnly: args.includes('--capture-only'),
    omitScreenshot: args.includes('--omit-screenshot')
  }
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function usageFrom(events: readonly AgentEvent[]): unknown[] {
  return events
    .filter((event) => event.type === 'model.decision')
    .map((event) => event.metadata?.usage ?? null)
}

function toolCallsFrom(messages: readonly { tool_calls?: readonly { function?: { name?: string; arguments?: string } }[] }[]): Array<{ name: string; arguments: unknown }> {
  const calls: Array<{ name: string; arguments: unknown }> = []
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      let args: unknown = null
      try { args = JSON.parse(call.function?.arguments ?? 'null') } catch {}
      calls.push({ name: call.function?.name ?? '', arguments: args })
    }
  }
  return calls
}

async function saveScreenshot(directory: string, label: string, screenshot: ScreenshotObservation): Promise<string> {
  await fs.mkdir(directory, { recursive: true })
  const output = path.join(directory, `${label}.png`)
  await fs.writeFile(output, screenshot.bytes)
  return output
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2))
  const dimensions = selectVisionBudget(960, 600, cli.budget)
  const screen = createSyntheticBusinessScreen({ seed: cli.seed, width: dimensions.width, height: dimensions.height })
  const surface = await HeadedComputerUseSurface.launch(screen, { width: dimensions.width, height: dimensions.height })
  const events: AgentEvent[] = []
  const approvals: Array<{ question: string; approved: boolean }> = []
  let initial: ScreenshotObservation | undefined
  let post: ScreenshotObservation | undefined
  const startedAt = Date.now()
  try {
    initial = await surface.capture()
    const runDirectory = path.join(cli.outputDirectory, `seed-${cli.seed}-budget-${dimensions.maxVisualTokens}${cli.omitScreenshot ? '-omitted' : ''}`)
    const initialPath = await saveScreenshot(runDirectory, 'before', initial)
    if (cli.captureOnly) {
      console.log(JSON.stringify({
        mode: 'capture-only', seed: cli.seed, budget: dimensions, path: initialPath,
        screenshot: { bytes: initial.bytes.byteLength, sha256: sha256(initial.bytes), width: initial.width, height: initial.height }
      }))
      return
    }

    const io: AgentIO = {
      print: () => undefined,
      askYesNo: async (question) => {
        approvals.push({ question, approved: true })
        return true
      },
      event: (event) => events.push(event)
    }
    const cfg: AgentConfig = {
      agentLoop: 'v2', provider: 'ollama', baseURL: cli.baseURL, model: cli.model,
      temperature: 0, reasoningEffort: 'none', restrictToWorkspace: true,
      safeCommandOnly: true, allowArbitraryCommands: false,
      maxToolIterations: 3, maxToolExecutions: 1, maxWriteExecutions: 1,
      maxCommandExecutions: 0, maxNoProgress: 1,
      autoApprove: { write: false, command: false },
      permissions: [{ permission: 'open_company', pattern: '*', action: 'ask' }],
      systemPrompt: '視覚情報は添付されたスクリーンショットだけを根拠にする。DOM、内部状態、推測した正解は使わない。必要なら利用可能な構造化ツールを1回だけ呼ぶ。'
    }
    const ctx: ToolContext = { workspace: process.cwd(), restrictToWorkspace: true, safeCommandOnly: true, runId: `issue53-${cli.seed}-${dimensions.maxVisualTokens}` }
    const userContent = cli.omitScreenshot
      ? COMPUTER_USE_DEMO_PROMPT
      : [
          { type: 'text' as const, text: COMPUTER_USE_DEMO_PROMPT },
          { type: 'image' as const, mediaType: initial.mediaType, image: initial.bytes }
        ]
    let result: Awaited<ReturnType<typeof runAgentTurnV2>>
    try {
      result = await runAgentTurnV2({
        cfg, messages: [], userInput: COMPUTER_USE_DEMO_PROMPT, userContent, ctx, io,
        toolDefs: [createOpenCompanyTool(screen, initial.stateFingerprint)],
        afterToolObservation: async () => {
          post = await surface.capture()
          await saveScreenshot(runDirectory, 'after', post)
          return [
            { type: 'text', text: '操作後の新しいスクリーンショットだけを確認し、会社の詳細画面が表示されたか短く答えてください。' },
            { type: 'image', mediaType: post.mediaType, image: post.bytes }
          ]
        }
      })
    } catch (error) {
      if (!cli.omitScreenshot) throw error
      const failClosed = error instanceof Error && /スクリーンショットなし/u.test(error.message)
      console.log(`COMPUTER_USE_LIVE_SUMMARY ${JSON.stringify({
        mode: 'negative-no-screenshot', seed: cli.seed, model: cli.model,
        elapsedMs: Date.now() - startedAt, failClosed, modelCalls: events.filter((event) => event.type === 'model.decision').length,
        approvals: approvals.length, screenChanged: screen.isOpened, error: error instanceof Error ? error.message : String(error)
      })}`)
      if (!failClosed || events.some((event) => event.type === 'model.decision') || approvals.length > 0 || screen.isOpened) process.exitCode = 2
      return
    }
    const toolCalls = toolCallsFrom(result.messages)
    const call = toolCalls[0]
    const selected = call?.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
      ? (call.arguments as { company_id?: unknown }).company_id
      : undefined
    const persisted = JSON.stringify({ messages: result.messages, events })
    const imageBase64 = Buffer.from(initial.bytes).toString('base64')
    const summary = {
      mode: 'live', seed: cli.seed, model: cli.model, budget: dimensions,
      elapsedMs: Date.now() - startedAt,
      screenshotOmitted: cli.omitScreenshot,
      initial: { bytes: initial.bytes.byteLength, sha256: sha256(initial.bytes), width: initial.width, height: initial.height },
      post: post ? { bytes: post.bytes.byteLength, sha256: sha256(post.bytes), width: post.width, height: post.height } : null,
      toolCalls,
      correctTarget: selected === screen.targetCompanyId,
      screenChanged: screen.isOpened && post !== undefined && sha256(initial.bytes) !== sha256(post.bytes),
      approvals: approvals.length,
      approvalEvents: events.filter((event) => event.type === 'approval.resolved' && event.approved === true).length,
      usage: usageFrom(events),
      reply: result.reply,
      confirmationVisible: /詳細|DETAIL|要確認|添付資料|未提出/iu.test(result.reply),
      aborted: result.aborted,
      persistedImageBytes: persisted.includes(imageBase64),
      persistedReasoning: /reasoning_content|<think>|<analysis>/iu.test(persisted)
    }
    console.log(`COMPUTER_USE_LIVE_SUMMARY ${JSON.stringify(summary)}`)
    if (cli.omitScreenshot) {
      if (screen.isOpened || approvals.length > 0) process.exitCode = 2
    } else if (result.aborted || toolCalls.length !== 1 || !summary.correctTarget || !summary.screenChanged || approvals.length !== 1 || !summary.confirmationVisible || summary.persistedImageBytes || summary.persistedReasoning) {
      process.exitCode = 2
    }
  } finally {
    await surface.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
