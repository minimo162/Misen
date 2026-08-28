import crypto from 'node:crypto'
import { deflateSync } from 'node:zlib'
import type { ToolContext, ToolDef } from './tools'

/**
 * A small, deterministic Computer Use fixture.  The model-facing seam in this
 * file is deliberately image-only: DOM/HTML/state objects never cross the
 * `toImageOnlyInput` boundary.
 */

export const COMPUTER_USE_DEMO_ROUTE = '/computer-use-demo.html'
export const COMPUTER_USE_DEMO_TITLE = 'Synthetic Business Directory'
export const COMPUTER_USE_DEMO_PROMPT =
  '現在の業務画面のスクリーンショットだけを確認し、対応が必要な会社を開いてください。DOM テキストや内部状態は参照しないでください。'

export const COMPUTER_USE_SCREEN_MEDIA_TYPE = 'image/png' as const
export const COMPUTER_USE_SCREEN_WIDTH = 960
export const COMPUTER_USE_SCREEN_HEIGHT = 600

const DEFAULT_SEED = 53_028

export interface SyntheticCompany {
  readonly id: string
  readonly name: string
  readonly sector: string
  readonly accent: string
}

export type SyntheticCompanyStatus = 'available' | 'opened'

export interface VisibleSyntheticCompany extends SyntheticCompany {
  readonly status: SyntheticCompanyStatus
  /** Visual cue rendered in the screenshot; it is not sent to the model as text/state. */
  readonly visualCue: 'attention' | 'normal'
}

export interface SyntheticBusinessScreenSnapshot {
  readonly route: typeof COMPUTER_USE_DEMO_ROUTE
  readonly title: typeof COMPUTER_USE_DEMO_TITLE
  readonly revision: number
  readonly visibleCompanies: readonly VisibleSyntheticCompany[]
  readonly openedCompanyId: string | null
  readonly statusText: string
  readonly width: number
  readonly height: number
}

export interface SyntheticScreenRender {
  readonly route: typeof COMPUTER_USE_DEMO_ROUTE
  readonly title: typeof COMPUTER_USE_DEMO_TITLE
  readonly revision: number
  readonly stateFingerprint: string
  readonly html: string
  readonly width: number
  readonly height: number
}

export interface ScreenshotObservation {
  readonly bytes: Uint8Array
  readonly mediaType: typeof COMPUTER_USE_SCREEN_MEDIA_TYPE
  readonly width: number
  readonly height: number
  readonly capturedAt: string
  /** Opaque host precondition; stripped before any model-facing conversion. */
  readonly stateFingerprint: string
  readonly ephemeral: true
}

/** Model-facing image input.  Do not add DOM text, route state, or JSON here. */
export interface ImageOnlyScreenshotInput {
  readonly bytes: Uint8Array
  readonly mediaType: typeof COMPUTER_USE_SCREEN_MEDIA_TYPE
}

export interface ScreenshotInputProvider {
  capture(): Promise<ScreenshotObservation>
}

export interface SyntheticBusinessScreenOptions {
  /** A seed changes both card order and the visual target while preserving stable IDs. */
  readonly seed?: number
  readonly width?: number
  readonly height?: number
  readonly clock?: () => string
}

export type ComputerUseActionErrorCode =
  | 'invalid_company_id'
  | 'company_not_visible'
  | 'wrong_target'
  | 'duplicate_action'
  | 'stale_screen'
  | 'invalid_decision'

export class ComputerUseActionError extends Error {
  readonly code: ComputerUseActionErrorCode

  constructor(code: ComputerUseActionErrorCode, message: string) {
    super(message)
    this.name = 'ComputerUseActionError'
    this.code = code
  }
}

export interface OpenCompanyActionResult {
  readonly action: 'open_company'
  readonly changed: true
  readonly companyId: string
  readonly beforeRevision: number
  readonly afterRevision: number
  readonly route: typeof COMPUTER_USE_DEMO_ROUTE
}

const BASE_COMPANIES: readonly SyntheticCompany[] = Object.freeze([
  { id: 'co-amber-17', name: 'A社', sector: 'Retail', accent: '#2563eb' },
  { id: 'co-bronze-29', name: 'B社', sector: 'Manufacturing', accent: '#7c3aed' },
  { id: 'co-cobalt-41', name: 'C社', sector: 'Logistics', accent: '#0891b2' },
  { id: 'co-delta-53', name: 'D社', sector: 'Services', accent: '#059669' }
])

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}

function mixSeed(input: number): number {
  // A tiny integer mixer is enough for a fixture; no cryptographic property is
  // needed, only stable output across processes and runtimes.
  let value = input | 0
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b)
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b)
  return (value ^ (value >>> 16)) | 0
}

function seededOrder(seed: number): SyntheticCompany[] {
  const ordered = [...BASE_COMPANIES]
  let state = mixSeed(seed)
  for (let index = ordered.length - 1; index > 0; index--) {
    state = Math.imul(state ^ (state >>> 13), 0x5bd1e995)
    state = state | 0
    const swapIndex = positiveModulo(state, index + 1)
    const current = ordered[index]
    ordered[index] = ordered[swapIndex]
    ordered[swapIndex] = current
  }
  return ordered
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character] ?? character)
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(320, Math.min(1920, Math.floor(value as number)))
}

/**
 * In-memory deterministic business screen.  `targetCompanyId` is intentionally
 * not included in snapshots or model input; only the visual attention treatment
 * communicates the target to an image-capable model.
 */
export class SyntheticBusinessScreen {
  readonly route = COMPUTER_USE_DEMO_ROUTE
  readonly title = COMPUTER_USE_DEMO_TITLE
  readonly width: number
  readonly height: number
  readonly seed: number
  /** Test/orchestration seam; never serialize this value into model input. */
  readonly targetCompanyId: string

  private readonly companies: readonly SyntheticCompany[]
  private readonly companyById: ReadonlyMap<string, SyntheticCompany>
  private readonly clock: () => string
  private openedCompanyId: string | null = null
  private revision = 0

  constructor(options: SyntheticBusinessScreenOptions = {}) {
    this.seed = Number.isFinite(options.seed) ? Math.trunc(options.seed as number) : DEFAULT_SEED
    this.width = normalizeDimension(options.width, COMPUTER_USE_SCREEN_WIDTH)
    this.height = normalizeDimension(options.height, COMPUTER_USE_SCREEN_HEIGHT)
    this.companies = Object.freeze(seededOrder(this.seed))
    this.companyById = new Map(this.companies.map((company) => [company.id, company]))
    const targetIndex = positiveModulo(mixSeed(this.seed ^ 0x53_0f), this.companies.length)
    this.targetCompanyId = this.companies[targetIndex].id
    this.clock = options.clock ?? (() => new Date().toISOString())
  }

  get currentRevision(): number {
    return this.revision
  }

  get isOpened(): boolean {
    return this.openedCompanyId !== null
  }

  snapshot(): SyntheticBusinessScreenSnapshot {
    const visibleCompanies = this.companies.map((company) => ({
      ...company,
      status: this.openedCompanyId === company.id ? 'opened' as const : 'available' as const,
      visualCue: company.id === this.targetCompanyId ? 'attention' as const : 'normal' as const
    }))
    return {
      route: this.route,
      title: this.title,
      revision: this.revision,
      visibleCompanies,
      openedCompanyId: this.openedCompanyId,
      statusText: this.openedCompanyId === null ? 'No company is open' : `Opened ${this.openedCompanyId}`,
      width: this.width,
      height: this.height
    }
  }

  render(): SyntheticScreenRender {
    const snapshot = this.snapshot()
    return {
      route: this.route,
      title: this.title,
      revision: this.revision,
      stateFingerprint: this.stateFingerprint(),
      html: renderScreenHtml(snapshot),
      width: this.width,
      height: this.height
    }
  }

  captureScreenshot(): ScreenshotObservation {
    return {
      bytes: encodeScreenPng(this.snapshot()),
      mediaType: COMPUTER_USE_SCREEN_MEDIA_TYPE,
      width: this.width,
      height: this.height,
      capturedAt: this.clock(),
      stateFingerprint: this.stateFingerprint(),
      ephemeral: true
    }
  }

  /**
   * Opaque version binding for host-side approval/precondition checks.  The
   * underlying state is never sent to the model; callers should compare this
   * value immediately before invoking the structured action.
   */
  stateFingerprint(): string {
    const visible = this.companies.map((company) => ({
      id: company.id,
      status: this.openedCompanyId === company.id ? 'opened' : 'available',
      attention: company.id === this.targetCompanyId
    }))
    return crypto.createHash('sha256').update(JSON.stringify({ revision: this.revision, visible }), 'utf8').digest('hex')
  }

  openCompany(companyId: string): OpenCompanyActionResult {
    const normalized = typeof companyId === 'string' ? companyId.trim() : ''
    if (!normalized) throw new ComputerUseActionError('invalid_company_id', 'company_id は空にできません')

    if (this.openedCompanyId !== null) {
      throw new ComputerUseActionError('duplicate_action', 'この画面では open_company は既に実行済みです')
    }

    if (!this.companyById.has(normalized)) {
      throw new ComputerUseActionError('company_not_visible', '指定された会社カードは現在の画面に表示されていません')
    }

    if (normalized !== this.targetCompanyId) {
      throw new ComputerUseActionError('wrong_target', '画像で選択された会社カードと一致しません')
    }

    const beforeRevision = this.revision
    this.openedCompanyId = normalized
    this.revision++
    return {
      action: 'open_company',
      changed: true,
      companyId: normalized,
      beforeRevision,
      afterRevision: this.revision,
      route: this.route
    }
  }
}

export function createSyntheticBusinessScreen(options: SyntheticBusinessScreenOptions = {}): SyntheticBusinessScreen {
  return new SyntheticBusinessScreen(options)
}

export function renderSyntheticBusinessScreen(screen: SyntheticBusinessScreen): SyntheticScreenRender {
  return screen.render()
}

export class SyntheticScreenshotProvider implements ScreenshotInputProvider {
  constructor(private readonly screen: SyntheticBusinessScreen) {}

  async capture(): Promise<ScreenshotObservation> {
    return this.screen.captureScreenshot()
  }
}

export function createScreenshotInputProvider(screen: SyntheticBusinessScreen): ScreenshotInputProvider {
  return new SyntheticScreenshotProvider(screen)
}

/** Convert an observation into the only shape that may be handed to a model. */
export function toImageOnlyInput(observation: ScreenshotObservation): ImageOnlyScreenshotInput {
  return {
    bytes: observation.bytes.slice(),
    mediaType: observation.mediaType
  }
}

/** Alias kept explicit for callers that prefer the screenshot-oriented name. */
export const screenshotToImageOnlyInput = toImageOnlyInput

export function createOpenCompanyTool(screen: SyntheticBusinessScreen, expectedFingerprint = screen.stateFingerprint()): ToolDef {
  return {
    name: 'open_company',
    description: '現在表示中の会社カードを識別子で開く構造化操作。現在の画面状態を検証してから1回だけ実行する',
    kind: 'write',
    requiresImage: true,
    parameters: {
      type: 'object',
      properties: {
        company_id: {
          type: 'string',
          description: '現在の画面に表示された会社の識別子',
          minLength: 1,
          maxLength: 128
        }
      },
      required: ['company_id'],
      additionalProperties: false
    },
    async run(args, _ctx: ToolContext): Promise<string> {
      // This is intentionally checked at execution time, after any approval
      // wait in the host safety chain.  A screenshot must not authorize an
      // action against a newer visible state.
      if (screen.stateFingerprint() !== expectedFingerprint) {
        throw new ComputerUseActionError('stale_screen', 'スクリーンショット取得後に画面状態が変わったため実行しませんでした')
      }
      const value = args.company_id
      if (typeof value !== 'string') throw new ComputerUseActionError('invalid_company_id', 'company_id は文字列で指定してください')
      const result = screen.openCompany(value)
      const metadata = {
        changed: result.changed,
        status: 'applied_unverified' as const,
        action: result.action,
        companyId: result.companyId,
        beforeRevision: result.beforeRevision,
        afterRevision: result.afterRevision,
        route: result.route
      }
      return ['open_company: succeeded', `結果メタデータ: ${JSON.stringify(metadata)}`].join('\n')
    }
  }
}

export interface ComputerUseToolCall {
  readonly toolCallId: string
  readonly toolName: 'open_company'
  readonly input: { readonly company_id: string }
}

export interface ComputerUseToolExecution {
  execute(call: ComputerUseToolCall, tool: ToolDef): Promise<unknown>
}

export interface ComputerUseLoopOptions {
  readonly screen: SyntheticBusinessScreen
  readonly screenshotProvider?: ScreenshotInputProvider
  readonly decideTarget: (image: ImageOnlyScreenshotInput) => Promise<{ company_id: string }> | { company_id: string }
  /** Root wires this callback to executeV2ToolCall (approval, precondition, guards, and audit). */
  readonly execute: (call: ComputerUseToolCall, tool: ToolDef) => Promise<unknown>
  readonly reobserve?: (image: ImageOnlyScreenshotInput) => Promise<unknown> | unknown
  readonly signal?: AbortSignal
}

export interface ComputerUseLoopResult {
  readonly initialScreenshot: ScreenshotObservation
  readonly decision: { readonly company_id: string }
  readonly action: ComputerUseToolCall
  readonly actionResult: unknown
  readonly postActionScreenshot: ScreenshotObservation
  readonly reobservation: unknown
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Computer Use demo はキャンセルされました')
}

/**
 * Deterministic orchestration seam for
 * screenshot -> image-only decision -> host execution -> screenshot ->
 * Vision re-observation.  It intentionally delegates execution to the host;
 * calling `tool.run` here would bypass approval and audit policy.
 */
export async function runComputerUseDemo(options: ComputerUseLoopOptions): Promise<ComputerUseLoopResult> {
  const provider = options.screenshotProvider ?? createScreenshotInputProvider(options.screen)
  assertNotAborted(options.signal)
  const initialScreenshot = await provider.capture()
  assertNotAborted(options.signal)
  const decisionValue = await options.decideTarget(toImageOnlyInput(initialScreenshot))
  if (!decisionValue || typeof decisionValue.company_id !== 'string' || decisionValue.company_id.trim() === '') {
    throw new ComputerUseActionError('invalid_decision', '画像から有効な company_id を決定できませんでした')
  }
  const decision = { company_id: decisionValue.company_id.trim() }
  const tool = createOpenCompanyTool(options.screen, initialScreenshot.stateFingerprint)
  const action: ComputerUseToolCall = {
    toolCallId: `computer-use-open-${options.screen.currentRevision + 1}`,
    toolName: 'open_company',
    input: decision
  }
  assertNotAborted(options.signal)
  const actionResult = await options.execute(action, tool)
  assertNotAborted(options.signal)
  const postActionScreenshot = await provider.capture()
  assertNotAborted(options.signal)
  const reobservation = options.reobserve
    ? await options.reobserve(toImageOnlyInput(postActionScreenshot))
    : undefined
  return { initialScreenshot, decision, action, actionResult, postActionScreenshot, reobservation }
}

function renderScreenHtml(snapshot: SyntheticBusinessScreenSnapshot): string {
  const cards = snapshot.visibleCompanies.map((company) => {
    const attention = company.visualCue === 'attention'
    const cue = attention ? '<span class="attention-badge">要確認</span>' : '<span class="done-badge">完了</span>'
    const state = company.status === 'opened' ? 'OPEN' : attention ? '要確認' : '完了'
    return [
      `<article class="company-card ${attention ? 'attention-card' : ''} ${company.status === 'opened' ? 'opened-card' : ''}" data-company-id="${escapeHtml(company.id)}">`,
      `<div class="card-top"><span class="company-id">${escapeHtml(company.id)}</span>${cue}</div>`,
      `<h2>${escapeHtml(company.name)}</h2>`,
      `<p>${escapeHtml(company.sector)}</p>`,
      '<span class="action-hint">structured action: open_company</span>',
      `<span class="card-state">${state}</span>`,
      '</article>'
    ].join('')
  }).join('')
  const opened = snapshot.openedCompanyId
    ? snapshot.visibleCompanies.find((company) => company.id === snapshot.openedCompanyId)
    : undefined
  const detail = opened
    ? `<section id="company-detail" class="detail-panel" aria-live="polite"><p class="detail-kicker">COMPANY DETAIL</p><h2>${escapeHtml(opened.name)} 詳細</h2><p class="detail-id">${escapeHtml(opened.id)}</p><dl><div><dt>状態</dt><dd>要確認</dd></div><div><dt>理由</dt><dd>添付資料未提出</dd></div></dl></section>`
    : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(snapshot.title)}</title>
<style>
:root{font-family:Inter,Segoe UI,Arial,sans-serif;color:#172033;background:#f5f7fb}*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:linear-gradient(135deg,#f8fafc,#e8eef8)}
main{max-width:960px;margin:0 auto;padding:20px 32px 24px}header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
h1{margin:0;font-size:28px;letter-spacing:.01em}.subtitle{margin:8px 0 0;color:#58657a}.route{font:12px ui-monospace,monospace;color:#73819a}
.notice{margin:16px 0 12px;padding:11px 14px;border-radius:12px;background:#fff;border:1px solid #dbe2ef;box-shadow:0 8px 18px #51648612}
.company-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.company-card{position:relative;padding:14px;border:2px solid #d8e0ed;border-radius:15px;background:#fff;min-height:132px;box-shadow:0 8px 18px #51648614}
.company-card.attention-card{border-color:#dc2626;box-shadow:0 0 0 4px #fecaca88,0 12px 24px #51648620}.company-card.opened-card{border-color:#16a34a;background:#f0fdf4}
.card-top{display:flex;justify-content:space-between;align-items:center}.company-id{font:600 12px ui-monospace,monospace;color:#58657a}.attention-badge,.done-badge{padding:4px 8px;border-radius:999px;color:#fff;font-size:11px;font-weight:800;letter-spacing:.08em}.attention-badge{background:#dc2626}.done-badge{background:#16a34a}
h2{margin:10px 0 2px;font-size:21px}.company-card p{margin:0;color:#64748b}.action-hint{display:inline-block;margin-top:10px;padding:6px 9px;border:1px solid #cdd7e7;border-radius:8px;background:#f8fafc;color:#64748b;font:600 10px ui-monospace,monospace}.card-state{float:right;margin-top:17px;color:#64748b;font:600 11px ui-monospace,monospace}
.detail-panel{margin-top:18px;padding:18px 20px;border-radius:14px;background:#172033;color:#fff;border-left:7px solid #dc2626;box-shadow:0 10px 24px #17203338}.detail-kicker{margin:0;color:#fca5a5;font:700 11px ui-monospace,monospace;letter-spacing:.14em}.detail-panel h2{margin:7px 0 0;font-size:26px}.detail-id{margin:2px 0 12px;color:#cbd5e1;font:600 12px ui-monospace,monospace}.detail-panel dl{display:flex;gap:30px;margin:0}.detail-panel dt{color:#cbd5e1;font-size:12px}.detail-panel dd{margin:2px 0 0;color:#fecaca;font-weight:800}.detail-panel dl>div{min-width:170px}
.status{margin-top:18px;padding:12px 14px;border-radius:10px;background:#172033;color:#fff;font:600 13px ui-monospace,monospace}
@media(max-width:680px){main{padding:20px}.company-grid{grid-template-columns:1fr}header{display:block}.route{display:block;margin-top:8px}}
</style></head>
<body><main id="computer-use-demo" data-route="${snapshot.route}" data-revision="${snapshot.revision}" data-synthetic="true">
<header><div><h1>${escapeHtml(snapshot.title)}</h1><p class="subtitle">Visual business card fixture</p></div><span class="route">${escapeHtml(snapshot.route)}</span></header>
<div class="notice">スクリーンショットで対応が必要な会社を確認してください。操作は表示中の会社識別子で検証されます。</div>
${opened ? detail : `<section id="company-grid" class="company-grid" aria-label="Company cards">${cards}</section>`}
<div id="screen-status" class="status" role="status">${escapeHtml(snapshot.statusText)}</div>
</main></body></html>`
}

type Rgba = [number, number, number, number]

function parseColor(value: string, fallback: Rgba): Rgba {
  const match = value.match(/^#([0-9a-f]{6})$/iu)
  if (!match) return fallback
  return [
    Number.parseInt(match[1].slice(0, 2), 16),
    Number.parseInt(match[1].slice(2, 4), 16),
    Number.parseInt(match[1].slice(4, 6), 16),
    255
  ]
}

function fillRect(pixels: Uint8Array, width: number, height: number, x: number, y: number, rectWidth: number, rectHeight: number, color: Rgba): void {
  const left = Math.max(0, Math.floor(x))
  const top = Math.max(0, Math.floor(y))
  const right = Math.min(width, Math.ceil(x + rectWidth))
  const bottom = Math.min(height, Math.ceil(y + rectHeight))
  for (let row = top; row < bottom; row++) {
    for (let column = left; column < right; column++) {
      const offset = (row * width + column) * 4
      pixels[offset] = color[0]
      pixels[offset + 1] = color[1]
      pixels[offset + 2] = color[2]
      pixels[offset + 3] = color[3]
    }
  }
}

function strokeRect(pixels: Uint8Array, width: number, height: number, x: number, y: number, rectWidth: number, rectHeight: number, thickness: number, color: Rgba): void {
  fillRect(pixels, width, height, x, y, rectWidth, thickness, color)
  fillRect(pixels, width, height, x, y + rectHeight - thickness, rectWidth, thickness, color)
  fillRect(pixels, width, height, x, y, thickness, rectHeight, color)
  fillRect(pixels, width, height, x + rectWidth - thickness, y, thickness, rectHeight, color)
}

// Compact 5x7 bitmap font for the ASCII labels present in the fixture.
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  'C': ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  'I': ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  'J': ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  'Q': ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  'V': ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  'W': ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  'Y': ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  'Z': ['11111', '00001', '00010', '00100', '01000', '10000', '11111']
}

function drawText(pixels: Uint8Array, width: number, height: number, text: string, x: number, y: number, scale: number, color: Rgba): void {
  let cursor = Math.floor(x)
  for (const character of text.toUpperCase()) {
    const glyph = GLYPHS[character] ?? GLYPHS[' ']
    for (let row = 0; row < glyph.length; row++) {
      for (let column = 0; column < glyph[row].length; column++) {
        if (glyph[row][column] === '1') fillRect(pixels, width, height, cursor + column * scale, y + row * scale, scale, scale, color)
      }
    }
    cursor += 6 * scale
  }
}

function encodeScreenPng(snapshot: SyntheticBusinessScreenSnapshot): Uint8Array {
  const { width, height } = snapshot
  const pixels = new Uint8Array(width * height * 4)
  fillRect(pixels, width, height, 0, 0, width, height, [246, 248, 252, 255])
  fillRect(pixels, width, height, 0, 0, width, 76, [23, 32, 51, 255])
  drawText(pixels, width, height, 'BUSINESS DIRECTORY', 32, 18, 4, [255, 255, 255, 255])
  drawText(pixels, width, height, 'REVIEW QUEUE', 34, 52, 2, [191, 211, 238, 255])

  const margin = 32
  const gap = 18
  const detailHeight = snapshot.openedCompanyId ? 170 : 0
  const cardWidth = Math.floor((width - margin * 2 - gap) / 2)
  const cardHeight = snapshot.openedCompanyId
    ? 132
    : Math.max(150, Math.floor((height - 76 - margin * 2 - gap - 34) / 2))
  snapshot.visibleCompanies.forEach((company, index) => {
    const column = index % 2
    const row = Math.floor(index / 2)
    const x = margin + column * (cardWidth + gap)
    const y = 96 + row * (cardHeight + gap)
    const cardFill: Rgba = company.status === 'opened' ? [236, 253, 245, 255] : [255, 255, 255, 255]
    fillRect(pixels, width, height, x, y, cardWidth, cardHeight, cardFill)
    const needsAttention = company.visualCue === 'attention' && company.status !== 'opened'
    const border = company.status === 'opened'
      ? [22, 163, 74, 255] as Rgba
      : needsAttention
        ? [220, 38, 38, 255] as Rgba
        : parseColor(company.accent, [216, 224, 237, 255])
    strokeRect(pixels, width, height, x, y, cardWidth, cardHeight, needsAttention ? 5 : 3, border)
    fillRect(pixels, width, height, x + 22, y + 20, 14, 14, parseColor(company.accent, [37, 99, 235, 255]))
    drawText(pixels, width, height, company.id, x + 46, y + 20, 2, [88, 101, 122, 255])
    drawText(pixels, width, height, company.name, x + 22, y + 57, 4, [23, 32, 51, 255])
    drawText(pixels, width, height, company.sector, x + 22, y + (snapshot.openedCompanyId ? 87 : 94), 2, [100, 116, 139, 255])
    if (needsAttention) {
      fillRect(pixels, width, height, x + cardWidth - 122, y + 16, 98, 24, [220, 38, 38, 255])
      drawText(pixels, width, height, 'WARNING', x + cardWidth - 116, y + 22, 2, [255, 255, 255, 255])
    }
    const statusColor: Rgba = company.status === 'opened' ? [22, 101, 52, 255] : [100, 116, 139, 255]
    drawText(pixels, width, height, company.status === 'opened' ? 'OPEN' : needsAttention ? 'REVIEW' : 'DONE', x + 22, y + cardHeight - 24, 2, statusColor)
  })
  if (snapshot.openedCompanyId) {
    const detailY = height - detailHeight - 26
    fillRect(pixels, width, height, margin, detailY, width - margin * 2, detailHeight, [23, 32, 51, 255])
    fillRect(pixels, width, height, margin, detailY, 8, detailHeight, [220, 38, 38, 255])
    const opened = snapshot.visibleCompanies.find((company) => company.id === snapshot.openedCompanyId)
    drawText(pixels, width, height, 'COMPANY DETAIL', margin + 26, detailY + 18, 2, [252, 165, 165, 255])
    drawText(pixels, width, height, opened?.id ?? snapshot.openedCompanyId, margin + 26, detailY + 46, 3, [255, 255, 255, 255])
    drawText(pixels, width, height, 'DETAIL OPENED', margin + 26, detailY + 81, 2, [203, 213, 225, 255])
    drawText(pixels, width, height, 'NEEDS REVIEW', margin + 280, detailY + 81, 2, [254, 202, 202, 255])
    drawText(pixels, width, height, 'ATTACHMENT MISSING', margin + 280, detailY + 111, 2, [254, 202, 202, 255])
  } else {
    fillRect(pixels, width, height, margin, height - 36, width - margin * 2, 2, [216, 224, 237, 255])
    drawText(pixels, width, height, 'STATE: READY', margin, height - 27, 2, [88, 101, 122, 255])
  }
  return encodePngRgba(width, height, pixels)
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, 'ascii')
  const payload = Buffer.concat([typeBytes, Buffer.from(data)])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(payload), 0)
  return new Uint8Array(Buffer.concat([length, payload, checksum]))
}

function encodePngRgba(width: number, height: number, pixels: Uint8Array): Uint8Array {
  const rows = new Uint8Array(height * (width * 4 + 1))
  for (let row = 0; row < height; row++) {
    const source = row * width * 4
    const target = row * (width * 4 + 1)
    rows[target] = 0 // PNG filter: none
    rows.set(pixels.subarray(source, source + width * 4), target + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return new Uint8Array(Buffer.concat([
    signature,
    Buffer.from(pngChunk('IHDR', ihdr)),
    Buffer.from(pngChunk('IDAT', new Uint8Array(deflateSync(rows, { level: 9 })))),
    Buffer.from(pngChunk('IEND', new Uint8Array()))
  ]))
}
