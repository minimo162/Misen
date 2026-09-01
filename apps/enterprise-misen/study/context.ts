import { createHash } from 'node:crypto'
import { PROMPTS } from '../demo/enterprise-excel/fixtures.js'
import { HOOK_TIMEOUT_MS } from '../src/customization/hooks.js'
import { prepareAgentCustomization } from '../src/runtime/customized.js'
import { snapshotFixtureInputs } from './integrity.js'
import { FROZEN_CONFIGURATION, SELECTED_SKILL_PATH, type RuntimeContextBinding } from './schema.js'

function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
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

function canonicalWorkbookDigest(bytes: Uint8Array): string {
  const copy = Uint8Array.from(bytes)
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength)
  let end = -1
  for (let index = copy.length - 22; index >= Math.max(0, copy.length - 65_557); index--) {
    if (view.getUint32(index, true) === 0x06054b50) { end = index; break }
  }
  if (end < 0) throw new Error('fixture workbook ZIP directory is missing')
  const entries = view.getUint16(end + 10, true)
  let cursor = view.getUint32(end + 16, true)
  for (let entry = 0; entry < entries; entry++) {
    if (cursor + 46 > copy.length || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('fixture workbook ZIP directory is malformed')
    copy.fill(0, cursor + 12, cursor + 16)
    const local = view.getUint32(cursor + 42, true)
    if (local + 30 > copy.length || view.getUint32(local, true) !== 0x04034b50) throw new Error('fixture workbook ZIP local header is malformed')
    copy.fill(0, local + 10, local + 14)
    cursor += 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true)
  }
  return contextDigest(copy)
}

export async function captureRuntimeContextBinding(root: string): Promise<RuntimeContextBinding> {
  const customization = await prepareAgentCustomization(root)
  const fixtureInputs = await Promise.all([...(await snapshotFixtureInputs(root))].map(async ([rawPath, rawSha256]) => {
    const path = rawPath.replaceAll('\\', '/')
    if (!path.toLowerCase().endsWith('.xlsx')) return { path, sha256: rawSha256 }
    const { bytes } = await customization.boundary.readFileBytes(path)
    return { path, sha256: canonicalWorkbookDigest(bytes) }
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
