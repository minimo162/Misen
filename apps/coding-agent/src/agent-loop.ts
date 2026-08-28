import { runAgentTurn, type AgentTurnResult, type TextBackend } from './agent'
import { runAgentTurnV2, type AgentV2Options } from './agent-v2'
import { containsAgentImage, normalizeAgentUserContent } from './multimodal'

export interface ConfiguredAgentTurnOptions extends AgentV2Options {
  backend?: TextBackend
}

export function runConfiguredAgentTurn(opts: ConfiguredAgentTurnOptions): Promise<AgentTurnResult> {
  const normalizedUserContent = opts.userContent === undefined
    ? undefined
    : normalizeAgentUserContent(opts.userContent, opts.userInput)
  if ((opts.cfg.agentLoop ?? 'v1') !== 'v2' && containsAgentImage(normalizedUserContent)) {
    throw new Error('このagentLoop/providerは画像入力に対応していません。v2の画像対応providerを指定してください')
  }
  if ((opts.cfg.agentLoop ?? 'v1') === 'v2') {
    return runAgentTurnV2({ ...opts, ...(normalizedUserContent === undefined ? {} : { userContent: normalizedUserContent }) })
  }
  return runAgentTurn(opts)
}
