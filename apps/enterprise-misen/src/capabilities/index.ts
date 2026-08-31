import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { createFileCapabilityTools } from './file-tools.js'
import { createSpreadsheetCapabilityTools } from './spreadsheet-tools.js'
import { WorkspaceBoundary } from '../workspace/boundary.js'

/** The complete model-facing surface for the first Enterprise PoC. */
export const ENTERPRISE_CAPABILITY_TOOL_NAMES = Object.freeze([
  'workspace_list_files',
  'workspace_read_text',
  'spreadsheet_read',
  'spreadsheet_create_output',
  'spreadsheet_update',
] as const)

/** Product surfaces deliberately absent from this capability composition. */
export const ENTERPRISE_FORBIDDEN_TOOL_NAMES = Object.freeze([
  'bash',
  'run_code',
  'jobs',
  'skills',
  'shell',
  'powershell',
  'python',
  'grep',
  'glob',
  'plugin_discovery',
] as const)

export { WorkspaceBoundary, WorkspaceBoundaryError } from '../workspace/boundary.js'
export { createFileCapabilityTools } from './file-tools.js'
export { createSpreadsheetCapabilityTools } from './spreadsheet-tools.js'

/** Build all general File + Spreadsheet tools for one selected workspace. */
export function createEnterpriseCapabilityTools(boundary: WorkspaceBoundary): readonly ToolDefinition[] {
  return Object.freeze([
    ...createFileCapabilityTools(boundary),
    ...createSpreadsheetCapabilityTools(boundary),
  ])
}

/** Register the bounded capability roster with DSH's public ToolRuntime. */
export function registerEnterpriseCapabilities(ctx: Context, boundary: WorkspaceBoundary): () => void {
  const disposers = createEnterpriseCapabilityTools(boundary).map(tool => ctx.tools.register(tool))
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
