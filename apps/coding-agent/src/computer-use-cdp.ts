import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  COMPUTER_USE_SCREEN_MEDIA_TYPE,
  type ScreenshotInputProvider,
  type ScreenshotObservation,
  type SyntheticBusinessScreen
} from './computer-use-demo'

interface CdpTarget {
  id?: string
  type?: string
  webSocketDebuggerUrl?: string
}

interface PendingCall {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

class CdpConnection {
  private sequence = 0
  private readonly pending = new Map<number, PendingCall>()

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      let value: unknown
      try { value = JSON.parse(String(event.data)) } catch { return }
      if (!value || typeof value !== 'object') return
      const response = value as { id?: unknown; result?: unknown; error?: unknown }
      if (!Number.isSafeInteger(response.id)) return
      const call = this.pending.get(response.id as number)
      if (!call) return
      this.pending.delete(response.id as number)
      clearTimeout(call.timer)
      if (response.error !== undefined) call.reject(new Error(`CDP error: ${JSON.stringify(response.error).slice(0, 300)}`))
      else call.resolve(response.result)
    })
    socket.addEventListener('close', () => {
      for (const call of this.pending.values()) {
        clearTimeout(call.timer)
        call.reject(new Error('CDP connection closed'))
      }
      this.pending.clear()
    })
  }

  static async connect(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    if (!/^ws:\/\/127\.0\.0\.1:\d+\//u.test(url) && !/^ws:\/\/localhost:\d+\//u.test(url)) {
      throw new Error('Computer Use CDP must be loopback-only')
    }
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timeout')), timeoutMs)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')) }, { once: true })
    })
    return new CdpConnection(socket)
  }

  method<T = Record<string, unknown>>(name: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP method timeout: ${name}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      this.socket.send(JSON.stringify({ id, method: name, params }))
    })
  }

  close(): void {
    this.socket.close()
  }
}

function edgeExecutable(): string {
  const candidates = [
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ].filter((value): value is string => Boolean(value))
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (!found) throw new Error('Microsoft Edge executable was not found')
  return found
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function waitForDevTools(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Edge DevTools did not start on loopback port ${port}`)
}

async function createPageTarget(port: number): Promise<CdpTarget> {
  const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(5000)
  })
  if (created.ok) return await created.json() as CdpTarget
  const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`Could not list Edge CDP targets (${response.status})`)
  const targets = await response.json() as CdpTarget[]
  const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
  if (!page) throw new Error('Could not create an isolated Edge page target')
  return page
}

async function waitForDocumentReady(cdp: CdpConnection, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await cdp.method<{ result?: { value?: unknown } }>('Runtime.evaluate', {
      expression: 'document.readyState',
      returnByValue: true
    }, 2000)
    if (result.result?.value === 'complete') return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Synthetic business screen did not finish rendering')
}

export interface HeadedComputerUseSurfaceOptions {
  width?: number
  height?: number
}

/**
 * Dedicated, loopback-only headed Edge surface for the Issue #53 fixture.
 * It never attaches to a user's existing browser profile or tab.
 */
export class HeadedComputerUseSurface implements ScreenshotInputProvider {
  private constructor(
    private readonly screen: SyntheticBusinessScreen,
    private readonly cdp: CdpConnection,
    private readonly edge: ChildProcess,
    private readonly profileDirectory: string,
    readonly port: number,
    readonly targetId: string,
    readonly width: number,
    readonly height: number
  ) {}

  static async launch(screen: SyntheticBusinessScreen, options: HeadedComputerUseSurfaceOptions = {}): Promise<HeadedComputerUseSurface> {
    const width = Math.max(640, Math.min(1920, Math.trunc(options.width ?? screen.width)))
    const height = Math.max(480, Math.min(1080, Math.trunc(options.height ?? screen.height)))
    const port = await freeLoopbackPort()
    const profileDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'misen-issue53-edge-'))
    const edge = spawn(edgeExecutable(), [
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profileDirectory}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      `--window-size=${width},${height}`,
      'about:blank'
    ], { shell: false, windowsHide: false, stdio: 'ignore' })
    try {
      await waitForDevTools(port)
      const target = await createPageTarget(port)
      if (!target.webSocketDebuggerUrl || !target.id) throw new Error('Edge CDP page target is incomplete')
      const cdp = await CdpConnection.connect(target.webSocketDebuggerUrl)
      await cdp.method('Page.enable')
      await cdp.method('Runtime.enable')
      await cdp.method('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      const surface = new HeadedComputerUseSurface(screen, cdp, edge, profileDirectory, port, target.id, width, height)
      await surface.renderCurrentState()
      return surface
    } catch (error) {
      edge.kill()
      await fsp.rm(profileDirectory, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async renderCurrentState(): Promise<void> {
    const html = this.screen.render().html
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    await this.cdp.method('Page.navigate', { url })
    await waitForDocumentReady(this.cdp)
    await this.cdp.method('Page.bringToFront')
  }

  async capture(): Promise<ScreenshotObservation> {
    await this.renderCurrentState()
    const response = await this.cdp.method<{ data?: unknown }>('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false
    })
    if (typeof response.data !== 'string' || response.data.length === 0) throw new Error('CDP screenshot payload was empty')
    const bytes = new Uint8Array(Buffer.from(response.data, 'base64'))
    if (bytes.byteLength < 8 || !Buffer.from(bytes.subarray(1, 4)).equals(Buffer.from('PNG', 'ascii'))) {
      throw new Error('CDP screenshot was not a PNG')
    }
    return {
      bytes,
      mediaType: COMPUTER_USE_SCREEN_MEDIA_TYPE,
      width: this.width,
      height: this.height,
      capturedAt: new Date().toISOString(),
      stateFingerprint: this.screen.stateFingerprint(),
      ephemeral: true
    }
  }

  async close(): Promise<void> {
    try { await this.cdp.method('Page.close', {}, 2000) } catch {}
    this.cdp.close()
    if (!this.edge.killed) this.edge.kill()
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await fsp.rm(this.profileDirectory, { recursive: true, force: true })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }
}
