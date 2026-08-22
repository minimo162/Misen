import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentConfig } from './config'

type WsLike = {
  addEventListener(type: string, cb: (ev: { data: unknown }) => void, options?: { once: boolean }): void
  send(data: string): void
  close(): void
}

interface CdpTarget {
  id?: string
  type?: string
  url?: string
  webSocketDebuggerUrl?: string
}

export interface CopilotSettings {
  url: string
  cdpPort: number
  maxPromptChars: number
  pollIntervalMs: number
  responseTimeoutSec: number
  stallTimeoutSec: number
  displayMode: 'minimized' | 'foreground'
  endMarker: string
}

export function resolveCopilotSettings(cfg: AgentConfig): CopilotSettings {
  const c = cfg.copilot ?? {}
  return {
    url: c.url ?? 'https://m365.cloud.microsoft/chat/',
    cdpPort: c.cdpPort ?? 9444,
    maxPromptChars: c.maxPromptChars ?? 60000,
    pollIntervalMs: Math.max(500, c.pollIntervalMs ?? 2000),
    responseTimeoutSec: c.responseTimeoutSec ?? 300,
    stallTimeoutSec: c.stallTimeoutSec ?? 120,
    displayMode: c.displayMode === 'foreground' ? 'foreground' : 'minimized',
    endMarker: c.endMarker ?? 'AGENT_END'
  }
}

const VISIBLE_JS = `const __vis=e=>{if(!e)return false;const d=e.ownerDocument,w=d.defaultView,cs=w.getComputedStyle(e);if(cs.display==='none'||cs.visibility==='hidden')return false;const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return true;if(!(d.visibilityState==='hidden'||w.innerWidth===0||w.innerHeight===0))return false;try{if(typeof e.checkVisibility==='function')return e.checkVisibility({visibilityProperty:true});}catch(x){}return true;};`
const DOCS_JS = `const __docs=[document];for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)__docs.push(f.contentDocument);}catch(e){}}`

const INPUT_READY_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const sels = ${JSON.stringify(['#m365-chat-editor-target-element', '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]'])};
  for (const d of __docs) for (const s of sels) {
    const el = d.querySelector(s);
    if (__vis(el)) return JSON.stringify({ ready: true, url: location.href });
  }
  return JSON.stringify({ ready: false, url: location.href });
})()`

const SCREEN_STATE_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const sels = ${JSON.stringify(['#m365-chat-editor-target-element', '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]'])};
  let input = null;
  for (const d of __docs) { input = sels.map(s => ({ s, el: d.querySelector(s) })).find(x => __vis(x.el)); if (input) break; }
  const buttons = __docs.flatMap(d => Array.from(d.querySelectorAll('button,[role="button"],a')));
  const stopButton = buttons.find(el => /^(停止|stop)$/i.test((el.getAttribute('aria-label') || el.title || '').trim()) && !el.disabled && __vis(el));
  const signIn = buttons.find(el => /sign\\s*in|log\\s*in|サインイン|ログイン/i.test((el.innerText || el.textContent || el.getAttribute('aria-label') || el.title || '').trim()));
  const url = String(location.href || '');
  const signinRequired = /(?:login|signin|sign-in|auth)/i.test(url) || (!input && !!signIn);
  const selectors = ['[data-testid="markdown-reply"]','[data-content="ai-message"]','[class*="ai-message" i]','[role="article"][data-author="assistant"],[role="article"][aria-label*="Copilot" i]','[data-message-author-role="assistant"]'];
  let text = '';
  for (let i = 0; i < selectors.length; i++) {
    const nodes = document.querySelectorAll(selectors[i]);
    for (let k = nodes.length - 1; k >= 0; k--) {
      const t = ((nodes[k].innerText || '') || (nodes[k].textContent || '')).trim();
      if (t) { text = t; break; }
    }
    if (text) break;
  }
  return JSON.stringify({ inputReady: !!input, generating: !!stopButton, signinRequired, url, text });
})()`

const FRESH_CHAT_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const buttons = __docs.flatMap(d => Array.from(d.querySelectorAll('button, [role="button"], a, [tabindex]')));
  const candidates = [];
  for (const b of buttons) {
    const label = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim();
    if (!label) continue;
    let score = 0;
    if (/^(新しいチャット|New chat)$/i.test(label)) score += 1000;
    else if (/新しいチャット|New chat/i.test(label)) score += 400;
    else if (/チャット|chat/i.test(label)) score += 80;
    if (/その他|履歴|検索|ライブラリ|more|history|search|library/i.test(label)) score -= 300;
    if (score <= 0) continue;
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
    if (!__vis(b)) continue;
    candidates.push({ el: b, label, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  if (candidates[0]) { candidates[0].el.click(); return JSON.stringify({ clicked: true }); }
  return JSON.stringify({ clicked: false });
})()`

const CLICK_SEND_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const buttons = __docs.flatMap(d => Array.from(d.querySelectorAll('button, [role="button"]')));
  const exclude = /stop|cancel|停止|キャンセル|regenerate|再生成|attach|添付|microphone|voice|ボイス|音声|new chat|新しいチャット|clear|クリア|close|閉じる|search|検索|library|ライブラリ|file|ファイル/;
  const clickable = [];
  for (const b of buttons) {
    const label = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim();
    if (!label) continue;
    const lower = label.toLowerCase();
    let score = 0;
    if (/^(送信|send)$/i.test(label)) score += 1000;
    else if (/送信|send/i.test(lower)) score += 400;
    if (score <= 0) continue;
    if (exclude.test(lower)) continue;
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
    if (!__vis(b)) continue;
    clickable.push({ el: b, score });
  }
  clickable.sort((a, b) => b.score - a.score);
  if (clickable[0]) { clickable[0].el.click(); return JSON.stringify({ clicked: true }); }
  return JSON.stringify({ clicked: false });
})()`

const EDITOR_LENGTH_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const sels = ${JSON.stringify(['#m365-chat-editor-target-element', '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]'])};
  for (const d of __docs) for (const s of sels) {
    const el = d.querySelector(s);
    if (__vis(el)) return String((el.textContent || '').length);
  }
  return '-1';
})()`

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

class CdpConnection {
  private ws: WsLike
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

  private constructor(ws: WsLike) {
    this.ws = ws
    ws.addEventListener('message', (ev) => this.onMessage(String(ev.data)))
  }

  static async connect(url: string, timeoutMs = 15000): Promise<CdpConnection> {
    const ctor = (globalThis as Record<string, unknown>).WebSocket as (new (url: string) => WsLike) | undefined
    if (!ctor) throw new Error('この Node.js には標準 WebSocket がありません (v22+ を使用してください)')
    const ws = new ctor(url)
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP WebSocket 接続タイムアウト')), timeoutMs)
      ws.addEventListener('open', () => { clearTimeout(t); resolve() }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP WebSocket 接続に失敗しました')) }, { once: true })
    })
    return new CdpConnection(ws)
  }

  private onMessage(raw: string): void {
    let obj: { id?: number; error?: unknown; result?: unknown }
    try {
      obj = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof obj.id !== 'number') return
    const p = this.pending.get(obj.id)
    if (!p) return
    this.pending.delete(obj.id)
    clearTimeout(p.timer)
    if (obj.error !== undefined) p.reject(new Error(`CDP エラー: ${JSON.stringify(obj.error).slice(0, 300)}`))
    else p.resolve(obj.result)
  }

  async method(name: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<any> {
    const id = this.nextId++
    const p = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 応答タイムアウト: ${name}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
    this.ws.send(JSON.stringify({ id, method: name, params }))
    return p
  }

  async evalJs(expression: string, timeoutMs = 30000): Promise<unknown> {
    const r = await this.method(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      timeoutMs
    )
    if (r && typeof r === 'object' && 'exceptionDetails' in r && r.exceptionDetails) {
      throw new Error('JavaScript evaluation failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
    }
    const rr = r as { result?: { value?: unknown } }
    return rr?.result?.value
  }

  close(): void {
    try { this.ws.close() } catch { }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('CDP 接続を切断しました'))
    }
    this.pending.clear()
  }
}

function isLocalUrl(url: string | undefined): boolean {
  if (!url) return true
  try {
    return ['127.0.0.1', 'localhost', '::1'].includes(new URL(url).host.toLowerCase())
  } catch {
    return false
  }
}

async function devToolsUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

function findEdgePath(): string {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[]
  for (const root of roots) {
    const p = path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    if (fs.existsSync(p)) return p
  }
  throw new Error('Microsoft Edge が見つかりません。Edge をインストールしてください。')
}

export class CopilotEdgeClient {
  readonly name = 'copilot-edge'
  private s: CopilotSettings
  private cdp: CdpConnection | null = null

  constructor(cfg: AgentConfig) {
    this.s = resolveCopilotSettings(cfg)
  }

  private async ensureEdge(): Promise<void> {
    if (await devToolsUp(this.s.cdpPort)) return
    const args = [
      `--remote-debugging-port=${this.s.cdpPort}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-allow-origins=*',
      `--user-data-dir=${path.join(process.env.APPDATA ?? process.env.USERPROFILE ?? '.', 'CompanyApps', 'coding-agent', 'edge-profile')}`,
      '--no-first-run',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion,msEdgeTranslate'
    ]
    if (this.s.displayMode === 'minimized') args.push('--window-position=-32000,-32000', '--window-size=1280,900')
    args.push(this.s.url)
    spawn(findEdgePath(), args, { detached: true, stdio: 'ignore' }).unref()
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (await devToolsUp(this.s.cdpPort)) return
      await sleep(500)
    }
    throw new Error(`Edge DevTools Protocol が起動しませんでした (port=${this.s.cdpPort})。専用プロファイルの Edge ウィンドウをすべて閉じてから再実行してください。`)
  }

  private async listTargets(): Promise<CdpTarget[]> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.s.cdpPort}/json`, { signal: AbortSignal.timeout(5000) })
      const raw = (await res.json()) as CdpTarget[]
      return Array.isArray(raw) ? raw : []
    } catch {
      return []
    }
  }

  private async ensurePage(): Promise<void> {
    const host = (() => { try { return new URL(this.s.url).host } catch { return '' } })()
    for (let attempt = 0; attempt < 3; attempt++) {
      const targets = await this.listTargets()
      const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && !isLocalUrl(t.url))
      const preferred = pages.find((t) => (host && t.url?.includes(host)) || t.url?.toLowerCase().includes('copilot'))
      const fallback = pages.find((t) => /^https?:/i.test(t.url ?? ''))
      const picked = preferred ?? fallback
      if (picked) {
        this.cdp?.close()
        this.cdp = await CdpConnection.connect(picked.webSocketDebuggerUrl!)
        return
      }
      const created = await fetch(`http://127.0.0.1:${this.s.cdpPort}/json/new?${encodeURIComponent(this.s.url)}`, {
        method: 'PUT',
        signal: AbortSignal.timeout(5000)
      }).catch(() => null)
      if (!created?.ok) {
        await fetch(`http://127.0.0.1:${this.s.cdpPort}/json/new?${encodeURIComponent(this.s.url)}`, {
          signal: AbortSignal.timeout(5000)
        }).catch(() => null)
      }
      await sleep(2000)
    }
    throw new Error('Copilot ページ (CDP ターゲット) を取得できませんでした。')
  }

  private async assertTrustedOrigin(): Promise<void> {
    const actual = String(await this.evalWithReconnect('(() => location.origin)()'))
    const u = new URL(this.s.url)
    if (u.protocol !== 'https' || !u.host) throw new Error(`copilot.url は https の絶対 URL で指定してください: ${this.s.url}`)
    const expected = `https://${u.host.toLowerCase()}`
    if (actual.toLowerCase().split(':')[0] !== 'https' || !actual.toLowerCase().includes(u.host.toLowerCase())) {
      throw new Error(`Copilot の送信先が設定と一致しません (expected=${expected}, actual=${actual})`)
    }
  }

  private async evalWithReconnect(expr: string, timeoutMs = 20000): Promise<unknown> {
    if (!this.cdp) throw new Error('Copilot ページ未接続です')
    return this.cdp.evalJs(expr, timeoutMs)
  }

  private async waitInputReady(timeoutSec: number): Promise<void> {
    const deadline = Date.now() + timeoutSec * 1000
    while (Date.now() < deadline) {
      const raw = await this.evalWithReconnect(INPUT_READY_JS, 15000)
      const state = JSON.parse(String(raw)) as { ready: boolean; url: string }
      if (/login|signin|sign-in|auth/i.test(state.url)) {
        throw new Error('Copilot へのサインインが必要です。Edge ウィンドウでサインインしてから再実行してください。')
      }
      if (state.ready) return
      await sleep(2000)
    }
    throw new Error('Copilot の入力欄が準備できませんでした (タイムアウト)。')
  }

  private async freshChat(): Promise<void> {
    const raw = await this.evalWithReconnect(FRESH_CHAT_JS)
    if (!(JSON.parse(String(raw)) as { clicked: boolean }).clicked) {
      await this.cdpMethod('Page.navigate', { url: this.s.url })
      await sleep(3000)
    } else {
      await sleep(800)
    }
  }

  private async cdpMethod(name: string, params: Record<string, unknown>, timeoutMs = 30000): Promise<void> {
    if (!this.cdp) throw new Error('Copilot ページ未接続です')
    await this.cdp.method(name, params, timeoutMs)
  }

  private async editorLength(): Promise<number> {
    const raw = await this.evalWithReconnect(EDITOR_LENGTH_JS)
    const n = Number(raw)
    return Number.isFinite(n) ? n : -1
  }

  private async insertPrompt(prompt: string): Promise<void> {
    if (prompt.length > this.s.maxPromptChars) {
      throw new Error(`依頼文が上限 ${this.s.maxPromptChars} 文字を超えています (${prompt.length} 文字)`)
    }
    if ((await this.editorLength()) > 0) {
      await this.clearEditor()
    }
    const chunkSize = 3000
    for (let i = 0; i < prompt.length; i += chunkSize) {
      const chunk = prompt.slice(i, i + chunkSize)
      const expectedGrowth = Math.floor(chunk.length * 0.9)
      let ok = false
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        const before = Math.max(0, await this.editorLength())
        await this.cdpMethod('Input.insertText', { text: chunk })
        await sleep(300)
        const after = await this.editorLength()
        if (after - before >= expectedGrowth) ok = true
        else await sleep(500)
      }
      if (!ok) throw new Error(`依頼文の入力が位置 ${i} で反映されませんでした`)
    }
    const len = await this.editorLength()
    if (len < prompt.length * 0.9) throw new Error(`依頼文の入力を確認できませんでした (期待 ${prompt.length} / 実際 ${len})`)
  }

  private async clearEditor(): Promise<void> {
    await this.focusEditor()
    await this.cdpMethod('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    await this.cdpMethod('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    await sleep(120)
    await this.cdpMethod('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await this.cdpMethod('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await sleep(200)
  }

  private async focusEditor(): Promise<void> {
    const js = `(() => {
      ${VISIBLE_JS}
      ${DOCS_JS}
      const sels = ${JSON.stringify(['#m365-chat-editor-target-element', '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]'])};
      for (const d of __docs) for (const s of sels) {
        const el = d.querySelector(s);
        if (__vis(el)) { el.focus(); return 'ok'; }
      }
      return 'ng';
    })()`
    if ((await this.evalWithReconnect(js)) !== 'ok') throw new Error('入力欄にフォーカスできませんでした')
  }

  private async clickSend(): Promise<void> {
    const raw = await this.evalWithReconnect(CLICK_SEND_JS)
    if (!(JSON.parse(String(raw)) as { clicked: boolean }).clicked) {
      throw new Error('有効な送信ボタンが見つかりませんでした')
    }
  }

  private async waitResponse(): Promise<string> {
    const start = Date.now()
    let lastText = ''
    let lastChange = Date.now()
    let sawAnyText = false
    while (Date.now() - start < this.s.responseTimeoutSec * 1000) {
      const raw = await this.evalWithReconnect(SCREEN_STATE_JS, 15000)
      const st = JSON.parse(String(raw)) as { text: string; generating: boolean; signinRequired: boolean }
      if (st.signinRequired) throw new Error('Copilot へのサインインが必要です。')
      if (st.text !== lastText) {
        if (st.text) sawAnyText = true
        lastText = st.text
        lastChange = Date.now()
      }
      const hasMarker = this.s.endMarker.length > 0 && lastText.includes(this.s.endMarker)
      const quietFor = Date.now() - lastChange
      if (hasMarker && quietFor >= 2500) return this.cleanResponse(lastText)
      if (!st.generating && sawAnyText && quietFor >= 8000) return this.cleanResponse(lastText)
      if (!st.generating && sawAnyText && quietFor > this.s.stallTimeoutSec * 1000) {
        throw new Error('Copilot の応答が停滞したため諦めました')
      }
      await sleep(this.s.pollIntervalMs)
    }
    throw new Error(`Copilot の応答がタイムアウトしました (${this.s.responseTimeoutSec}秒)`)
  }

  private cleanResponse(text: string): string {
    return text.split('\n').filter((l) => l.trim() !== this.s.endMarker).join('\n').trim()
  }

  async complete(prompt: string): Promise<string> {
    await this.ensureEdge()
    await this.ensurePage()
    await this.assertTrustedOrigin()
    await this.freshChat()
    await this.waitInputReady(120)
    await this.insertPrompt(prompt)
    await this.clickSend()
    return this.waitResponse()
  }

  close(): void {
    this.cdp?.close()
    this.cdp = null
  }
}
