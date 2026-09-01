import { WorkspaceBoundary } from '../workspace/boundary.js'

export const WORKSPACE_INSTRUCTIONS_PATH = 'AGENTS.md'
export const MAX_WORKSPACE_INSTRUCTIONS_BYTES = 64 * 1024

const utf8 = new TextDecoder('utf-8', { fatal: true })

export class CustomizationLoadError extends Error {
  override readonly name = 'CustomizationLoadError'
}

function explicitError(label: string, error: unknown): CustomizationLoadError {
  const code = (error as NodeJS.ErrnoException)?.code
  const suffix = code ? ` (${code})` : ''
  return new CustomizationLoadError(`${label} could not be loaded${suffix}`)
}

export async function loadWorkspaceInstructions(boundary: WorkspaceBoundary): Promise<string | undefined> {
  try {
    const { bytes } = await boundary.readFileBytes(WORKSPACE_INSTRUCTIONS_PATH, MAX_WORKSPACE_INSTRUCTIONS_BYTES)
    const text = utf8.decode(bytes)
    return text.trim().length === 0 ? undefined : text
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if (error instanceof TypeError) throw new CustomizationLoadError('AGENTS.md is not valid UTF-8')
    throw explicitError('AGENTS.md', error)
  }
}
