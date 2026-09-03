import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export const OFFICECLI_VERSION = '1.0.147'
export const OFFICECLI_COMMIT = 'b94f3906fd52d450c64f8e40370e376b9e15079e'
export const OFFICECLI_WINDOWS_X64_SHA256 = '724056e5ff079c3585df79c8afc386f08ef7d5f956cf4e2723534e129aab6e80'
export const OFFICECLI_RELEASE_ARTIFACT = 'officecli-win-x64.exe'
export const OFFICECLI_RELEASE_URL = 'https://github.com/iOfficeAI/OfficeCLI/releases/tag/v1.0.147'

export interface OfficeCliProcessOptions {
  readonly executable?: string
  readonly prefixArgs?: readonly string[]
  readonly timeoutMs?: number
  readonly maximumOutputBytes?: number
  readonly spawnProcess?: typeof spawn
}

export interface OfficeCliInvocation {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly stdin?: string
  readonly signal?: AbortSignal
}

export interface OfficeCliProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export class OfficeCliProcessError extends Error {
  override readonly name = 'OfficeCliProcessError'
  constructor(
    message: string,
    readonly code: string,
    readonly exitCode: number | null = null,
    readonly stdout = '',
    readonly stderr = '',
  ) {
    super(message)
  }
}

export function resolveOfficeCliExecutable(explicit?: string): string {
  const value = explicit ?? process.env.MISEN_OFFICECLI_PATH
  if (!value) throw new OfficeCliProcessError('OfficeCLI executable is not configured', 'missing_binary')
  return value
}

export function buildOfficeCliInvocation(executable: string, args: readonly string[], cwd?: string, stdin?: string, signal?: AbortSignal): OfficeCliInvocation {
  return Object.freeze({ executable, args: Object.freeze([...args]), cwd, stdin, signal })
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export class OfficeCliProcess {
  readonly executable: string
  readonly timeoutMs: number
  readonly maximumOutputBytes: number
  private readonly spawnProcess: typeof spawn
  private readonly prefixArgs: readonly string[]

  constructor(options: OfficeCliProcessOptions = {}) {
    this.executable = resolveOfficeCliExecutable(options.executable)
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.maximumOutputBytes = options.maximumOutputBytes ?? 32 * 1024 * 1024
    this.spawnProcess = options.spawnProcess ?? spawn
    this.prefixArgs = Object.freeze([...(options.prefixArgs ?? [])])
  }

  async run(args: readonly string[], options: { readonly cwd?: string; readonly stdin?: string; readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}): Promise<OfficeCliProcessResult> {
    if (options.signal?.aborted) throw abortError('OfficeCLI invocation was cancelled')
    const invocation = buildOfficeCliInvocation(this.executable, [...this.prefixArgs, ...args], options.cwd, options.stdin, options.signal)
    const child = this.spawnProcess(invocation.executable, [...invocation.args], {
      cwd: invocation.cwd,
      env: {
        ...process.env,
        ...(invocation.cwd ? { TEMP: invocation.cwd, TMP: invocation.cwd } : {}),
        OFFICECLI_NO_AUTO_RESIDENT: '1',
        OFFICECLI_SKIP_UPDATE: '1',
        OFFICECLI_RESIDENT_FLUSH: 'each',
      },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams

    return await new Promise<OfficeCliProcessResult>((resolvePromise, rejectPromise) => {
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let outputBytes = 0
      let settled = false
      let terminationCode: string | undefined
      let stdinError: Error | undefined
      const timeout = setTimeout(() => {
        terminationCode = 'timeout'
        child.kill('SIGKILL')
      }, options.timeoutMs ?? this.timeoutMs)
      timeout.unref()

      const finish = (error?: Error, result?: OfficeCliProcessResult) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        invocation.signal?.removeEventListener('abort', onAbort)
        if (error) rejectPromise(error)
        else resolvePromise(result!)
      }
      const onAbort = () => {
        terminationCode = 'cancelled'
        child.kill('SIGKILL')
      }
      invocation.signal?.addEventListener('abort', onAbort, { once: true })

      const collect = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
        if (settled) return
        if (kind === 'stdout') stdoutChunks.push(chunk)
        else stderrChunks.push(chunk)
        outputBytes += chunk.byteLength
        if (outputBytes > this.maximumOutputBytes) {
          terminationCode = 'output_limit'
          child.kill('SIGKILL')
        }
      }
      child.stdout.on('data', chunk => collect('stdout', Buffer.from(chunk)))
      child.stderr.on('data', chunk => collect('stderr', Buffer.from(chunk)))
      child.stdin.on('error', error => { stdinError = error })
      child.once('error', error => {
        const code = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing_binary' : 'spawn_error'
        finish(new OfficeCliProcessError(error.message, code, null, Buffer.concat(stdoutChunks).toString('utf8'), Buffer.concat(stderrChunks).toString('utf8')))
      })
      child.once('close', code => {
        const out = Buffer.concat(stdoutChunks).toString('utf8')
        const err = Buffer.concat(stderrChunks).toString('utf8')
        if (terminationCode === 'cancelled') return finish(abortError('OfficeCLI invocation was cancelled'))
        if (terminationCode === 'timeout') return finish(new OfficeCliProcessError('OfficeCLI invocation timed out', 'timeout', code, out, err))
        if (terminationCode === 'output_limit') return finish(new OfficeCliProcessError('OfficeCLI output exceeded the configured limit', 'output_limit', code, out, err))
        if (stdinError && code === 0) return finish(new OfficeCliProcessError(stdinError.message, 'stdin_error', code, out, err))
        finish(undefined, { exitCode: code ?? 1, stdout: out, stderr: err })
      })

      if (invocation.stdin === undefined) child.stdin.end()
      else child.stdin.end(invocation.stdin, 'utf8')
    })
  }
}
