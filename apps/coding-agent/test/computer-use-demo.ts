import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  COMPUTER_USE_DEMO_PROMPT,
  COMPUTER_USE_DEMO_ROUTE,
  COMPUTER_USE_SCREEN_MEDIA_TYPE,
  ComputerUseActionError,
  createOpenCompanyTool,
  createScreenshotInputProvider,
  createSyntheticBusinessScreen,
  renderSyntheticBusinessScreen,
  runComputerUseDemo,
  toImageOnlyInput,
  type ImageOnlyScreenshotInput,
  type ScreenshotObservation
} from '../src/computer-use-demo'
import type { ToolContext, ToolDef } from '../src/tools'

const ctx: ToolContext = { workspace: process.cwd(), restrictToWorkspace: true }

function expectActionError(action: () => unknown, code: ComputerUseActionError['code']): void {
  assert.throws(action, (error: unknown) => error instanceof ComputerUseActionError && error.code === code)
}

async function expectAsyncActionError(action: () => Promise<unknown>, code: ComputerUseActionError['code']): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof ComputerUseActionError && error.code === code)
}

function targetAndWrong(screen: ReturnType<typeof createSyntheticBusinessScreen>): { target: string; wrong: string } {
  const target = screen.targetCompanyId
  const wrong = screen.snapshot().visibleCompanies.find((company) => company.id !== target)?.id
  assert.ok(wrong)
  return { target, wrong }
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function testFixtureStateAndDeterminism(): Promise<void> {
  const first = createSyntheticBusinessScreen({ seed: 53028, clock: () => '2026-08-28T00:00:00.000Z' })
  const second = createSyntheticBusinessScreen({ seed: 53028, clock: () => '2026-08-28T00:00:00.000Z' })
  const variants = Array.from({ length: 12 }, (_, offset) => createSyntheticBusinessScreen({ seed: 53029 + offset, clock: () => '2026-08-28T00:00:00.000Z' }))
  const firstSnapshot = first.snapshot()
  assert.equal(firstSnapshot.route, COMPUTER_USE_DEMO_ROUTE)
  assert.equal(firstSnapshot.revision, 0)
  assert.equal(firstSnapshot.openedCompanyId, null)
  assert.equal(firstSnapshot.visibleCompanies.filter((company) => company.visualCue === 'attention').length, 1)
  assert.equal(firstSnapshot.visibleCompanies.filter((company) => company.status === 'available').length, 4)
  assert.equal(first.targetCompanyId, firstSnapshot.visibleCompanies.find((company) => company.visualCue === 'attention')?.id)
  assert.ok(!COMPUTER_USE_DEMO_PROMPT.includes(first.targetCompanyId))
  assert.ok(!COMPUTER_USE_DEMO_PROMPT.includes('B社'))
  assert.equal(hashBytes(first.captureScreenshot().bytes), hashBytes(second.captureScreenshot().bytes), 'same seed must render identical PNG bytes')
  const firstOrder = firstSnapshot.visibleCompanies.map((company) => company.id)
  assert.ok(variants.some((variant) => !variant.snapshot().visibleCompanies.map((company) => company.id).every((id, index) => id === firstOrder[index])), 'seed range must produce a different card order')
  assert.equal(renderSyntheticBusinessScreen(first).route, COMPUTER_USE_DEMO_ROUTE)
}

async function testWrongTargetAndStalePrecondition(): Promise<void> {
  const screen = createSyntheticBusinessScreen({ seed: 53028, clock: () => '2026-08-28T00:00:00.000Z' })
  const { wrong } = targetAndWrong(screen)
  const tool = createOpenCompanyTool(screen, screen.stateFingerprint())
  await expectAsyncActionError(() => tool.run({ company_id: wrong }, ctx), 'wrong_target')
  assert.equal(screen.snapshot().openedCompanyId, null)
  const staleTool = createOpenCompanyTool(screen, screen.stateFingerprint())
  // A new run/screenshot version invalidates the old approval binding even if
  // the visible card order did not change.
  screen.openCompany(screen.targetCompanyId)
  await expectAsyncActionError(() => staleTool.run({ company_id: screen.targetCompanyId }, ctx), 'stale_screen')
}

async function testActionDuplicateAndPostState(): Promise<void> {
  const screen = createSyntheticBusinessScreen({ seed: 8, clock: () => '2026-08-28T00:00:00.000Z' })
  const { target } = targetAndWrong(screen)
  const before = screen.captureScreenshot()
  const tool = createOpenCompanyTool(screen, before.stateFingerprint)
  const output = await tool.run({ company_id: target }, ctx)
  assert.match(output, /open_company: succeeded/u)
  assert.match(output, /"changed":true/u)
  const after = screen.captureScreenshot()
  assert.equal(screen.snapshot().openedCompanyId, target)
  assert.equal(screen.snapshot().revision, 1)
  assert.notEqual(hashBytes(before.bytes), hashBytes(after.bytes), 'state change must alter the screenshot')
  const duplicateTool = createOpenCompanyTool(screen, after.stateFingerprint)
  await expectAsyncActionError(() => duplicateTool.run({ company_id: target }, ctx), 'duplicate_action')
  assert.equal(screen.snapshot().revision, 1)
}

async function testImageOnlyAdapterAndNegativeOmission(): Promise<void> {
  const screen = createSyntheticBusinessScreen({ seed: 91, clock: () => '2026-08-28T00:00:00.000Z' })
  const provider = createScreenshotInputProvider(screen)
  const observation = await provider.capture()
  assert.equal(observation.mediaType, COMPUTER_USE_SCREEN_MEDIA_TYPE)
  assert.equal(observation.ephemeral, true)
  assert.equal(observation.stateFingerprint, screen.stateFingerprint())
  const image = toImageOnlyInput(observation)
  assert.deepEqual(Object.keys(image).sort(), ['bytes', 'mediaType'])
  assert.equal(image.mediaType, COMPUTER_USE_SCREEN_MEDIA_TYPE)
  assert.notEqual(image.bytes, observation.bytes, 'adapter should not hand out the mutable observation buffer')
  assert.equal(image.bytes.length, observation.bytes.length)
  // The model-facing object must not contain target ID, route, DOM, or state.
  const serialized = JSON.stringify(image)
  assert.ok(!serialized.includes(screen.targetCompanyId))
  assert.ok(!serialized.includes(COMPUTER_USE_DEMO_ROUTE))
}

async function testLoopSequenceAndNormalExecutionSeam(): Promise<void> {
  const screen = createSyntheticBusinessScreen({ seed: 53028, clock: () => '2026-08-28T00:00:00.000Z' })
  const phases: string[] = []
  let decisionInput: ImageOnlyScreenshotInput | undefined
  let actionTool: ToolDef | undefined
  let captureCount = 0
  const provider = {
    capture: async () => {
      captureCount++
      phases.push(captureCount === 1 ? 'screenshot' : 'post-screenshot')
      return screen.captureScreenshot()
    }
  }
  const result = await runComputerUseDemo({
    screen,
    screenshotProvider: provider,
    decideTarget: (image) => {
      phases.push('decision')
      decisionInput = image
      assert.deepEqual(Object.keys(image).sort(), ['bytes', 'mediaType'])
      return { company_id: screen.targetCompanyId }
    },
    execute: async (call, tool) => {
      phases.push('execute')
      actionTool = tool
      assert.equal(call.toolName, 'open_company')
      // This callback is where the host wires executeV2ToolCall.  The demo
      // helper must not call tool.run on its own.
      return tool.run(call.input, ctx)
    },
    reobserve: (image) => {
      phases.push('reobserve')
      assert.deepEqual(Object.keys(image).sort(), ['bytes', 'mediaType'])
      return { visualStateConfirmed: true }
    }
  })
  assert.deepEqual(phases, ['screenshot', 'decision', 'execute', 'post-screenshot', 'reobserve'])
  assert.ok(decisionInput)
  assert.equal(actionTool?.name, 'open_company')
  assert.equal(screen.snapshot().openedCompanyId, screen.targetCompanyId)
  assert.equal(result.action.input.company_id, screen.targetCompanyId)
  assert.deepEqual(result.reobservation, { visualStateConfirmed: true })
  assert.equal(result.initialScreenshot.stateFingerprint !== result.postActionScreenshot.stateFingerprint, true)
}

async function testToolContractNoTargetLeak(): Promise<void> {
  const screen = createSyntheticBusinessScreen({ seed: 53028 })
  const tool = createOpenCompanyTool(screen, screen.stateFingerprint())
  const schema = JSON.stringify(tool.parameters)
  assert.equal(tool.kind, 'write')
  assert.equal(tool.requiresImage, true)
  assert.equal(tool.name, 'open_company')
  assert.ok(!tool.description.includes(screen.targetCompanyId))
  assert.ok(!schema.includes(screen.targetCompanyId))
  assert.ok(!tool.description.includes('B社'))
  assert.ok(!schema.includes('B社'))
  assert.ok(!COMPUTER_USE_DEMO_PROMPT.includes('FOCUS'))
  assert.ok(!COMPUTER_USE_DEMO_PROMPT.includes('安定 ID'))
  await expectAsyncActionError(() => tool.run({ company_id: 'unknown-id' }, ctx), 'company_not_visible')
}

async function main(): Promise<void> {
  await testFixtureStateAndDeterminism()
  await testWrongTargetAndStalePrecondition()
  await testActionDuplicateAndPostState()
  await testImageOnlyAdapterAndNegativeOmission()
  await testLoopSequenceAndNormalExecutionSeam()
  await testToolContractNoTargetLeak()
  console.log('computer-use-demo tests passed')
}

void main()
