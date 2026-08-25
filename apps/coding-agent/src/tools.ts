import fs from 'node:fs'
import { exec } from 'node:child_process'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import util from 'node:util'
import type { OpenAIToolSchema } from './llm'
import { listManagedProcesses, readManagedProcessLog, startManagedProcess, stopManagedProcess } from './processes'
import { getWeather } from './weather'

const execAsync = util.promisify(exec)

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.tmp'])
const MAX_LIST = 500
const MAX_SEARCH_RESULTS = 200

export interface ToolContext {
  workspace: string
  restrictToWorkspace: boolean
  weatherDefaultLocation?: string
  signal?: AbortSignal
  /** Run-scoped journal key. Tests and REPL may omit it. */
  runId?: string
}

export interface ToolDef {
  name: string
  description: string
  kind: 'read' | 'write' | 'command'
  parameters: Record<string, unknown>
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>
}

export type FileChangeStatus = 'no_op' | 'applied_unverified'

export interface ToolResultMeta {
  changed?: boolean
  status?: FileChangeStatus
  path?: string
  existedBefore?: boolean
  count?: number
  beforeHash?: string
  afterHash?: string
  readBack?: boolean
  addedLines?: number
  removedLines?: number
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function lineDelta(before: string, after: string): { addedLines: number; removedLines: number } {
  const beforeLines = before === '' ? [] : before.split(/\r?\n/)
  const afterLines = after === '' ? [] : after.split(/\r?\n/)
  let prefix = 0
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix++
  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) suffix++
  return {
    removedLines: Math.max(0, beforeLines.length - prefix - suffix),
    addedLines: Math.max(0, afterLines.length - prefix - suffix)
  }
}

function formatFileChangeResult(
  action: '編集' | '書き込み',
  relativePath: string,
  before: string,
  after: string,
  count: number,
  existedBefore = true
): string {
  const changed = before !== after
  const delta = lineDelta(before, after)
  const meta: ToolResultMeta = {
    changed,
    status: changed ? 'applied_unverified' : 'no_op',
    path: relativePath,
    existedBefore,
    count,
    beforeHash: sha256(before),
    afterHash: sha256(after),
    readBack: true,
    ...delta
  }
  return [
    `${changed ? `${action}完了` : '変更なし'}: ${relativePath} (${count} 箇所)`,
    `状態: ${meta.status}`,
    `変更前ハッシュ: ${meta.beforeHash}`,
    `変更後ハッシュ: ${meta.afterHash}`,
    '再読込: 成功',
    `差分: +${meta.addedLines} -${meta.removedLines}`,
    `結果メタデータ: ${JSON.stringify(meta)}`
  ].join('\n')
}

export function parseToolResultMeta(output: string): ToolResultMeta | null {
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith('結果メタデータ:'))
  if (!line) return null
  try {
    return JSON.parse(line.slice('結果メタデータ:'.length).trim()) as ToolResultMeta
  } catch {
    return null
  }
}

interface FileSnapshot {
  before: string
  after: string
  afterHash: string
  existedBefore: boolean
  createdAt: number
}

export interface FileSnapshotInfo {
  path: string
  before: string
  after: string
  afterHash: string
  existedBefore: boolean
  createdAt: number
}

const fileSnapshots = new Map<string, FileSnapshot>()

function snapshotKey(abs: string, ctx: ToolContext): string {
  return `${ctx.runId ?? 'default'}:${abs}`
}

function recordFileSnapshot(abs: string, ctx: ToolContext, before: string, existedBefore: boolean, after: string): FileSnapshot {
  const key = snapshotKey(abs, ctx)
  const previous = fileSnapshots.get(key)
  const snapshot: FileSnapshot = {
    before: previous?.before ?? before,
    after,
    afterHash: sha256(after),
    existedBefore: previous?.existedBefore ?? existedBefore,
    createdAt: previous?.createdAt ?? Date.now()
  }
  fileSnapshots.set(key, snapshot)
  return snapshot
}

export async function getFilePrecondition(p: string, ctx: ToolContext): Promise<{ existedBefore: boolean; beforeHash?: string }> {
  const abs = resolveInWorkspace(p, ctx)
  try {
    const content = await fsp.readFile(abs, 'utf8')
    return { existedBefore: true, beforeHash: sha256(content) }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return { existedBefore: false }
    throw err
  }
}

export function getFileSnapshot(p: string, ctx: ToolContext): FileSnapshotInfo | null {
  const abs = resolveInWorkspace(p, ctx)
  const snapshot = fileSnapshots.get(snapshotKey(abs, ctx))
  return snapshot ? { path: p, ...snapshot } : null
}

export async function rollbackFileChange(
  change: Pick<ToolResultMeta, 'path' | 'afterHash' | 'existedBefore'> & { beforeContent?: string },
  ctx: ToolContext
): Promise<{ path: string; status: 'rolled_back'; hash: string }> {
  if (!change.path || !change.afterHash) throw new Error('ロールバック対象のハッシュがありません')
  const abs = resolveInWorkspace(change.path, ctx)
  const snapshot = fileSnapshots.get(snapshotKey(abs, ctx))
  const beforeContent = typeof change.beforeContent === 'string' ? change.beforeContent : null
  const before = snapshot?.before ?? beforeContent
  const existedBefore = snapshot?.existedBefore ?? change.existedBefore ?? before !== null
  const expected = snapshot?.afterHash ?? change.afterHash
  if (before === null || expected !== change.afterHash) throw new Error('このRunに変更前スナップショットがありません')
  let current = ''
  try { current = await fsp.readFile(abs, 'utf8') } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code !== 'ENOENT') throw err
  }
  if (sha256(current) !== change.afterHash) throw new Error('変更後の内容からファイルが変更されています。競合を確認してください')
  if (existedBefore) {
    await fsp.writeFile(abs, before, 'utf8')
  } else {
    await fsp.rm(abs, { force: true })
  }
  const restored = existedBefore ? await fsp.readFile(abs, 'utf8') : ''
  const hash = sha256(restored)
  fileSnapshots.delete(snapshotKey(abs, ctx))
  return { path: change.path, status: 'rolled_back', hash }
}

function truncate(s: string, max = 8000): string {
  return s.length <= max ? s : s.slice(0, max) + `\n...(省略: 全${s.length}文字)`
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

function realPathWithMissingTail(abs: string): string {
  let cursor = abs
  const tail: string[] = []
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) return abs
    tail.unshift(path.basename(cursor))
    cursor = parent
  }
  const real = fs.realpathSync.native(cursor)
  return path.resolve(real, ...tail)
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function resolveInWorkspace(p: string, ctx: ToolContext): string {
  if (!p) throw new Error('パスが空です')
  const workspaceAbs = path.resolve(ctx.workspace)
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(workspaceAbs, p)
  if (ctx.restrictToWorkspace) {
    const rootReal = realPathWithMissingTail(workspaceAbs)
    const candidateReal = realPathWithMissingTail(abs)
    if (!isWithin(rootReal, candidateReal)) {
      throw new Error(`ワークスペース外のパスは許可されていません: ${p}`)
    }
  }
  return abs
}

async function walk(dir: string, cb: (file: string) => void, depth = 0): Promise<void> {
  if (depth > 12) return
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (IGNORED_DIRS.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) await walk(full, cb, depth + 1)
    else if (e.isFile()) cb(full)
  }
}

export const HOST_TOOL_PREFIX = 'host.'

export function qualifiedToolName(name: string): string {
  return name.startsWith(HOST_TOOL_PREFIX) ? name : `${HOST_TOOL_PREFIX}${name}`
}

export function bareToolName(name: string): string {
  return name.startsWith(HOST_TOOL_PREFIX) ? name.slice(HOST_TOOL_PREFIX.length) : name
}

export function findHostTool(name: string): ToolDef | undefined {
  if (!name.startsWith(HOST_TOOL_PREFIX)) return undefined
  return TOOL_DEFS.find((tool) => tool.name === bareToolName(name))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function schemaTypeMatches(value: unknown, type: unknown): boolean {
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'object') return isRecord(value)
  if (type === 'array') return Array.isArray(value)
  return true
}

export function validateToolArgs(def: ToolDef, args: unknown): string | null {
  if (!isRecord(args)) return 'args はJSONオブジェクトで指定してください'
  const schema = def.parameters as { properties?: Record<string, { type?: string; maxLength?: number; minimum?: number; maximum?: number }>; required?: string[] }
  const properties = schema.properties ?? {}
  const unknown = Object.keys(args).filter((key) => !(key in properties))
  if (unknown.length) return `未許可の引数です: ${unknown.join(', ')}`
  for (const required of schema.required ?? []) {
    if (!(required in args)) return `必須引数がありません: ${required}`
  }
  for (const [key, value] of Object.entries(args)) {
    const rule = properties[key] ?? {}
    if (!schemaTypeMatches(value, rule.type)) return `${key} の型が不正です（期待: ${rule.type ?? 'unknown'}）`
    if (typeof value === 'string') {
      const maxLength = rule.maxLength ?? (key === 'content' ? 1_000_000 : key === 'command' ? 20_000 : 8_000)
      if (value.length > maxLength) return `${key} が長すぎます（上限 ${maxLength} 文字）`
    }
    if (typeof value === 'number') {
      if (rule.minimum !== undefined && value < rule.minimum) return `${key} が小さすぎます`
      if (rule.maximum !== undefined && value > rule.maximum) return `${key} が大きすぎます`
    }
  }
  return null
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'get_weather',
    description: '現在の天気と今日の最高・最低気温をOpen-Meteoから取得する。locationを省略すると設定された既定地域を使う。天気・気温の確認にrun_commandで外部天気サイトを直接呼ばず、このツールを使う',
    kind: 'read',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: '市区町村名（任意。例: 広島市）' }
      },
      required: []
    },
    async run(args, ctx) {
      const location = String(args.location ?? '').trim() || ctx.weatherDefaultLocation?.trim()
      if (!location) throw new Error('地域名が必要です（例: 広島市）。locationを指定するか、設定にweather.defaultLocationを追加してください')
      return getWeather(location, ctx.signal)
    }
  },
  {
    name: 'list_files',
    description: 'ワークスペース内のファイル一覧を返す',
    kind: 'read',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '起点ディレクトリ (既定: ワークスペースルート)' },
        glob: { type: 'string', description: 'ファイル名のパターン。例: *.ts' }
      },
      required: []
    },
    async run(args, ctx) {
      const base = args.path ? resolveInWorkspace(String(args.path), ctx) : ctx.workspace
      const re = args.glob ? wildcardToRegExp(String(args.glob)) : null
      const out: string[] = []
      await walk(base, (f) => {
        if (out.length >= MAX_LIST) return
        if (!re || re.test(path.basename(f))) out.push(path.relative(ctx.workspace, f).replaceAll('\\', '/'))
      })
      return out.length === 0 ? '(該当なし)' : truncate(out.join('\n'))
    }
  },
  {
    name: 'read_file',
    description: 'テキストファイルを行番号付きで読む',
    kind: 'read',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'ファイルパス' },
        offset: { type: 'number', description: '開始行 (1始まり)' },
        limit: { type: 'number', description: '読み取り行数 (既定 2000)' }
      },
      required: ['path']
    },
    async run(args, ctx) {
      const abs = resolveInWorkspace(String(args.path), ctx)
      const text = await fsp.readFile(abs, 'utf8')
      const lines = text.split('\n')
      const offset = Math.max(1, Number(args.offset ?? 1))
      const limit = Math.max(1, Number(args.limit ?? 2000))
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const body = slice.map((l, i) => `${offset + i}: ${l}`).join('\n')
      return truncate(body, 100_000)
    }
  },
  {
    name: 'write_file',
    description: 'テキストファイルを新規作成または上書きする',
    kind: 'write',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'ファイルパス' },
        content: { type: 'string', description: '書き込む内容' }
      },
      required: ['path', 'content']
    },
    async run(args, ctx) {
      const abs = resolveInWorkspace(String(args.path), ctx)
      const content = String(args.content ?? '')
      if (!content.trim()) throw new Error('content が空です。JSON 直後のコードフェンスに内容を記述してください')
      let before = ''
      let existedBefore = true
      try {
        before = await fsp.readFile(abs, 'utf8')
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e.code !== 'ENOENT') throw err
        existedBefore = false
      }
      await fsp.mkdir(path.dirname(abs), { recursive: true })
      await fsp.writeFile(abs, content, 'utf8')
      const readBack = await fsp.readFile(abs, 'utf8')
      recordFileSnapshot(abs, ctx, before, existedBefore, readBack)
      const result = formatFileChangeResult('書き込み', path.relative(ctx.workspace, abs), before, readBack, 1, existedBefore)
      return `${result}\nサイズ: ${Buffer.byteLength(readBack)} bytes`
    }
  },
  {
    name: 'edit_file',
    description: 'ファイル内の文字列を置換する',
    kind: 'write',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'ファイルパス' },
        old_string: { type: 'string', description: '置換対象の文字列 (完全一致)' },
        new_string: { type: 'string', description: '置換後の文字列' },
        replace_all: { type: 'boolean', description: '全件置換するか (既定 false)' }
      },
      required: ['path', 'old_string', 'new_string']
    },
    async run(args, ctx) {
      const abs = resolveInWorkspace(String(args.path), ctx)
      const oldStr = String(args.old_string ?? '')
      const newStr = String(args.new_string ?? '')
      if (!oldStr) throw new Error('old_string が空です')
      const replaceAll = args.replace_all === undefined ? false : args.replace_all
      if (typeof replaceAll !== 'boolean') throw new Error('replace_all はbooleanで指定してください')
      const src = await fsp.readFile(abs, 'utf8')
      const count = src.split(oldStr).length - 1
      if (count === 0) throw new Error('old_string が見つかりません')
      if (count > 1 && !replaceAll) throw new Error(`${count} 件一致しました。replace_all=true を指定するか対象範囲を狭めてください`)
      const next = replaceAll ? src.split(oldStr).join(newStr) : src.replace(oldStr, newStr)
      if (next === src) { recordFileSnapshot(abs, ctx, src, true, src); return formatFileChangeResult('編集', path.relative(ctx.workspace, abs), src, src, count, true) }
      await fsp.writeFile(abs, next, 'utf8')
      const readBack = await fsp.readFile(abs, 'utf8')
      if (readBack !== next) throw new Error('編集後の再読込内容が一致しません')
      recordFileSnapshot(abs, ctx, src, true, readBack)
      return formatFileChangeResult('編集', path.relative(ctx.workspace, abs), src, readBack, count, true)
    }
  },
  {
    name: 'search_files',
    description: '正規表現でワークスペース内のファイル内容を検索する',
    kind: 'read',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '正規表現' },
        path: { type: 'string', description: '検索起点ディレクトリ' },
        include: { type: 'string', description: 'ファイルパスのパターン。例: *.ts' }
      },
      required: ['query']
    },
    async run(args, ctx) {
      const query = String(args.query ?? '')
      if (!query) throw new Error('query が必要です')
      let re: RegExp
      try {
        re = new RegExp(query)
      } catch {
        throw new Error(`正規表現が不正です: ${query}`)
      }
      const base = args.path ? resolveInWorkspace(String(args.path), ctx) : ctx.workspace
      const include = args.include ? wildcardToRegExp(String(args.include)) : null
      const files: string[] = []
      await walk(base, (f) => {
        if (!include || include.test(f)) files.push(f)
      })
      const results: string[] = []
      for (const f of files) {
        if (results.length >= MAX_SEARCH_RESULTS) break
        let stat
        try {
          stat = await fsp.stat(f)
        } catch {
          continue
        }
        if (stat.size > 2_000_000) continue
        let text: string
        try {
          text = await fsp.readFile(f, 'utf8')
        } catch {
          continue
        }
        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= MAX_SEARCH_RESULTS) break
          if (re.test(lines[i])) {
            results.push(`${path.relative(ctx.workspace, f).replaceAll('\\', '/')}:${i + 1}: ${truncate(lines[i], 300)}`)
          }
        }
      }
      return results.length === 0 ? '(該当なし)' : truncate(results.join('\n'))
    }
  },
  {
    name: 'start_process',
    description: 'ワークスペース内で長時間動くプロセス（ローカル開発サーバーなど）を起動し、プロセスIDを返す。開始後はread_process_logでログを確認し、不要になったらstop_processで終了する',
    kind: 'command',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '起動するコマンド' },
        label: { type: 'string', description: '画面表示用の名前（任意）' },
        url: { type: 'string', description: 'プレビューURL（http/https、任意）' }
      },
      required: ['command']
    },
    async run(args, ctx) {
      const process = startManagedProcess(String(args.command ?? ''), ctx.workspace, args.label ? String(args.label) : undefined, args.url ? String(args.url) : undefined)
      return JSON.stringify(process)
    }
  },
  {
    name: 'list_processes',
    description: '起動中または直近に終了した管理対象プロセスの一覧を返す',
    kind: 'read',
    parameters: { type: 'object', properties: {}, required: [] },
    async run() {
      return JSON.stringify(listManagedProcesses())
    }
  },
  {
    name: 'read_process_log',
    description: '管理対象プロセスの追加ログを読む。前回のnext_offsetをoffsetに渡すと重複を避けられる',
    kind: 'read',
    parameters: {
      type: 'object',
      properties: {
        process_id: { type: 'string', description: 'start_processが返したプロセスID' },
        offset: { type: 'number', description: '前回のnext_offset（既定: 0）' }
      },
      required: ['process_id']
    },
    async run(args) {
      return JSON.stringify(readManagedProcessLog(String(args.process_id ?? ''), Number(args.offset ?? 0)))
    }
  },
  {
    name: 'stop_process',
    description: '管理対象プロセスを停止する。ローカルプレビューを終了するときに使う',
    kind: 'command',
    parameters: {
      type: 'object',
      properties: { process_id: { type: 'string', description: '停止するプロセスID' } },
      required: ['process_id']
    },
    async run(args) {
      return JSON.stringify(await stopManagedProcess(String(args.process_id ?? '')))
    }
  },
  {
    name: 'run_command',
    description: 'ユーザーのマシン上でシェルコマンドを実行し標準出力と標準エラーを返す (タイムアウト 60秒・あなたのサンドボックスとは別の環境です)',
    kind: 'command',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '実行するコマンド' }
      },
      required: ['command']
    },
    async run(args, ctx) {
      const command = String(args.command ?? '')
      if (!command.trim()) throw new Error('command が必要です')
      if (/wttr\.in/i.test(command)) throw new Error('天気・気温の取得にwttr.inは使用できません。get_weatherツールを使ってください')
      if (ctx.signal?.aborted) throw new Error('コマンド実行はキャンセルされました')
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: ctx.workspace,
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          signal: ctx.signal
        })
        const parts = [stdout, stderr].filter((s) => s.trim().length > 0).map((s) => truncate(s))
        return parts.length > 0 ? parts.join('\n---stderr---\n') : '(出力なし)'
      } catch (err) {
        const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string }
        const tail = [e.stdout ?? '', e.stderr ?? '']
          .filter((s) => s.trim())
          .map((s) => truncate(s))
          .join('\n---\n')
        throw new Error(`終了コード ${e.code ?? '?'}: ${tail || e.message || '実行に失敗しました'}`)
      }
    }
  }
]

export function openAITools(options: { allowArbitraryCommands?: boolean } = {}): OpenAIToolSchema[] {
  const defs = options.allowArbitraryCommands ? TOOL_DEFS : TOOL_DEFS.filter((tool) => tool.name !== 'run_command')
  return defs.map((t) => ({
    type: 'function' as const,
    function: { name: qualifiedToolName(t.name), description: t.description, parameters: { ...t.parameters, additionalProperties: false } }
  }))
}
