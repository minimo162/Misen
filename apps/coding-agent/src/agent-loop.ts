import { runAgentTurn, type AgentTurnResult, type TextBackend } from './agent'
import { runAgentTurnV2, type AgentV2Options } from './agent-v2'

export interface ConfiguredAgentTurnOptions extends AgentV2Options {
  backend?: TextBackend
}

export function runConfiguredAgentTurn(opts: ConfiguredAgentTurnOptions): Promise<AgentTurnResult> {
  if ((opts.cfg.agentLoop ?? 'v1') === 'v2') return runAgentTurnV2(opts)
  return runAgentTurn(opts)
}
