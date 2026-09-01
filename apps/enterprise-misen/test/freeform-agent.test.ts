import test from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '@earendil-works/pi-agent-core'
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai'
import { fixture, PROMPTS } from '../demo/enterprise-excel/fixtures.js'
import { ENTERPRISE_TOOL_NAMES } from '../src/capabilities/tools.js'
import { prepareAgentCustomization } from '../src/runtime/customized.js'
import { createAgentRunner, type AgentFactory, type DemoEvent } from '../src/web/server.js'

test('a non-gallery free-form prompt reaches the real Pi Agent seam unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-freeform-agent-'))
  try {
    await fixture(root)
    const faux = fauxProvider({ provider: 'misen-freeform-test', models: [{ id: 'gpt-5.6-luna', reasoning: true }] })
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([fauxAssistantMessage('8月ではAlphaの利益が最大です。')])
    let created: Agent | undefined
    const factory: AgentFactory = async workspaceRoot => {
      const customization = await prepareAgentCustomization(workspaceRoot)
      assert.deepEqual(customization.tools.map(tool => tool.name), [...ENTERPRISE_TOOL_NAMES])
      const model = models.getModel('misen-freeform-test', 'gpt-5.6-luna')
      if (!model) throw new Error('faux model missing')
      created = new Agent({
        initialState: { systemPrompt: customization.systemPrompt, model, thinkingLevel: 'medium', tools: [...customization.tools] },
        streamFn: models.streamSimple.bind(models),
        toolExecution: 'sequential',
        beforeToolCall: customization.hooks.beforeToolCall,
        afterToolCall: customization.hooks.afterToolCall,
      })
      return created
    }
    const prompt = '8月の3社で利益が最大の会社を教えて'
    assert.ok(!Object.values(PROMPTS).includes(prompt as any))
    const events: DemoEvent[] = []
    const result = await createAgentRunner(factory)(root, prompt, { emit: event => events.push(event), setCancel: () => undefined })
    assert.equal(result.status, 'COMPLETED')
    assert.deepEqual(result.tools, [])
    assert.ok(created)
    assert.equal(created!.state.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(prompt)), true)
    assert.equal(events.some(event => event.type === 'assistant' && event.text.includes('Alpha')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('production web routing contains no prompt gallery or Decision 441 validator dependency', async () => {
  const source = await readFile(join(process.cwd(), 'src', 'web', 'server.ts'), 'utf8')
  assert.doesNotMatch(source, /\bPROMPTS\b|\bSYNTHETIC_MONTHS\b|validateReport/u)
  assert.match(source, /prompt\.trim\(\)\.length === 0/u)
  assert.match(source, /runner\(root, prompt,/u)
})
