import { createHash } from 'node:crypto'
import { PROMPTS } from '../demo/enterprise-excel/fixtures.js'
import { HOOK_TIMEOUT_MS } from '../src/customization/hooks.js'
import { prepareAgentCustomization } from '../src/runtime/customized.js'
import { openSpreadsheetBytes, titles, values } from '../src/spreadsheet/engine.js'
import { snapshotFixtureInputs } from './integrity.js'
import { FROZEN_CONFIGURATION, SELECTED_SKILL_PATH, type RuntimeContextBinding } from './schema.js'

const FIXTURE_SEMANTIC_RANGE = 'A1:Z200'

function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item instanceof Date) {
      if (Number.isNaN(item.getTime())) throw new TypeError('context fingerprint contains an invalid Date')
      return item.toISOString()
    }
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('context fingerprint contains a non-finite number')
      return item
    }
    if (Array.isArray(item)) return item.map(normalize)
    if (!item || typeof item !== 'object') throw new TypeError('context fingerprint contains an unsupported value')
    return Object.fromEntries(Object.entries(item)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalize(child)]))
  }
  return JSON.stringify(normalize(value))
}

export function contextDigest(value: unknown): string {
  return createHash('sha256').update(value instanceof Uint8Array ? value : typeof value === 'string' ? value : canonical(value)).digest('hex')
}

async function semanticWorkbookDigest(bytes: Uint8Array): Promise<string> {
  const workbook = await openSpreadsheetBytes(bytes)
  const sheets = titles(workbook).map(title => ({
    title,
    values: values(workbook, title, FIXTURE_SEMANTIC_RANGE),
  }))
  return contextDigest({ range: FIXTURE_SEMANTIC_RANGE, sheets })
}

export async function captureRuntimeContextBinding(root: string): Promise<RuntimeContextBinding> {
  const customization = await prepareAgentCustomization(root)
  const fixtureInputs = await Promise.all([...(await snapshotFixtureInputs(root))].map(async ([rawPath, rawSha256]) => {
    const path = rawPath.replaceAll('\\', '/')
    if (!path.toLowerCase().endsWith('.xlsx')) return { path, sha256: rawSha256 }
    const { bytes } = await customization.boundary.readFileBytes(path)
    return { path, sha256: await semanticWorkbookDigest(bytes) }
  }))
  fixtureInputs.sort((left, right) => left.path.localeCompare(right.path))
  const instructions = await customization.boundary.readFileBytes('AGENTS.md')
  const selectedSkill = await customization.boundary.readFileBytes(SELECTED_SKILL_PATH)
  const skillCatalog = customization.skills.map(skill => ({ name: skill.name, description: skill.description, path: skill.path }))
  const toolContract = customization.tools.map(tool => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    executionMode: tool.executionMode,
  }))
  const hookConfiguration = { names: customization.hooks.hooks.map(hook => hook.name), timeoutMs: HOOK_TIMEOUT_MS }
  return Object.freeze({
    promptsSha256: contextDigest(PROMPTS),
    fixtureInputsSha256: contextDigest(fixtureInputs),
    systemPromptSha256: contextDigest(customization.systemPrompt),
    workspaceInstructionsSha256: contextDigest(instructions.bytes),
    skillCatalogSha256: contextDigest(skillCatalog),
    selectedSkillBodySha256: contextDigest(selectedSkill.bytes),
    toolContractSha256: contextDigest(toolContract),
    hookConfigurationSha256: contextDigest(hookConfiguration),
  })
}

export function assertFrozenRuntimeContext(binding: RuntimeContextBinding): void {
  if (canonical(binding) !== canonical(FROZEN_CONFIGURATION.context)) throw new Error('runtime context differs from frozen study configuration')
}
