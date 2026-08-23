import path from 'node:path'
import { loadConfig } from './config'
import { startRepl } from './repl'

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function positionalWorkspace(): string | undefined {
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config' || a === '--workspace') {
      i++
      continue
    }
    if (!a.startsWith('-')) return a
  }
  return undefined
}

async function main(): Promise<void> {
  const cfg = loadConfig(argValue('--config'))
  const workspaceArg = argValue('--workspace') ?? positionalWorkspace()
  const workspace = workspaceArg ? path.resolve(workspaceArg) : process.cwd()
  await startRepl(cfg, { workspace, restrictToWorkspace: cfg.restrictToWorkspace ?? true, weatherDefaultLocation: cfg.weather?.defaultLocation })
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
