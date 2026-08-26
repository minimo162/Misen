import { loadConfig } from './config'
import { CopilotEdgeClient } from './copilot'
import { createOpenAICompatibleBridgeServer } from './openai-bridge'

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const token = String(process.env.COPILOT_BRIDGE_TOKEN ?? '').trim()
const port = Number(argument('--port') ?? process.env.COPILOT_BRIDGE_PORT ?? 3952)
const cfg = loadConfig(argument('--config'))
if (cfg.provider !== 'copilot-edge') throw new Error('bridge configはprovider=copilot-edgeだけ対応しています')
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('bridge portが不正です')

const client = new CopilotEdgeClient(cfg)
const server = createOpenAICompatibleBridgeServer(token, { complete: (prompt, signal) => client.complete(prompt, signal) })
server.listen(port, '127.0.0.1', () => console.log(`copilot-openai-bridge listening on http://127.0.0.1:${port}/v1`))

let closing = false
const close = (): void => {
  if (closing) return
  closing = true
  server.abortAll()
  client.close()
  server.close(() => {
    process.exit(0)
  })
  const forcedExit = setTimeout(() => process.exit(1), 5000)
  forcedExit.unref()
}
process.on('SIGINT', close)
process.on('SIGTERM', close)
