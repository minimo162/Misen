import { exec } from 'node:child_process'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import util from 'node:util'
import type { OpenAIToolSchema } from './llm'
import { listManagedProcesses, readManagedProcessLog, startManagedProcess, stopManagedProcess } from './processes'

const execAsync = util.promisify(exec)

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.tmp'])
const MAX_LIST = 500
const MAX_SEARCH_RESULTS = 200

export interface ToolContext {
  workspace: string
  restrictToWorkspace: boolean
  signal?: AbortSignal
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
  count: number
): string {
  const changed = before !== after
  const delta = lineDelta(before, after)
  const meta: ToolResultMeta = {
    changed,
    status: changed ? 'applied_unverified' : 'no_op',
    path: relativePath,
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
  createdAt: number
}

export interface FileSnapshotInfo {
  path: string
  before: string
  after: string
  afterHash: string
  createdAt: number
}

const fileSnapshots = new Map<string, FileSnapshot>()

export function getFileSnapshot(p: string, ctx: ToolContext): FileSnapshotInfo | null {
  const abs = resolveInWorkspace(p, ctx)
  const snapshot = fileSnapshots.get(abs)
  return snapshot ? { path: p, ...snapshot } : null
}

export async function rollbackFileChange(
  change: Pick<ToolResultMeta, 'path' | 'afterHash'>,
  ctx: ToolContext
): Promise<{ path: string; status: 'rolled_back'; hash: string }> {
  if (!change.path || !change.afterHash) throw new Error('ロールバック対象のハッシュがありません')
  const abs = resolveInWorkspace(change.path, ctx)
  const snapshot = fileSnapshots.get(abs)
  const before = snapshot?.before ?? (typeof (change as { beforeContent?: unknown }).beforeContent === 'string' ? String((change as { beforeContent?: unknown }).beforeContent) : null)
  const expected = snapshot?.afterHash ?? change.afterHash
  if (before === null || expected !== change.afterHash) throw new Error('このRunに変更前スナップショットがありません')
  const current = await fsp.readFile(abs, 'utf8')
  if (sha256(current) !== change.afterHash) throw new Error('変更後の内容からファイルが変更されています。競合を確認してください')
  await fsp.writeFile(abs, before, 'utf8')
  const restored = await fsp.readFile(abs, 'utf8')
  const hash = sha256(restored)
  fileSnapshots.delete(abs)
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

function resolveInWorkspace(p: string, ctx: ToolContext): string {
  if (!p) throw new Error('パスが空です')
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(ctx.workspace, p)
  if (ctx.restrictToWorkspace && path.relative(ctx.workspace, abs).startsWith('..')) {
    throw new Error(`ワークスペース外のパスは許可されていません: ${p}`)
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

export const TOOL_DEFS: ToolDef[] = [
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
      try {
        before = await fsp.readFile(abs, 'utf8')
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e.code !== 'ENOENT') throw err
      }
      await fsp.mkdir(path.dirname(abs), { recursive: true })
      await fsp.writeFile(abs, content, 'utf8')
      const readBack = await fsp.readFile(abs, 'utf8')
      fileSnapshots.set(abs, { before, after: readBack, afterHash: sha256(readBack), createdAt: Date.now() })
      const result = formatFileChangeResult('書き込み', path.relative(ctx.workspace, abs), before, readBack, 1)
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
      const replaceAll = Boolean(args.replace_all)
      const src = await fsp.readFile(abs, 'utf8')
      const count = src.split(oldStr).length - 1
      if (count === 0) throw new Error('old_string が見つかりません')
      if (count > 1 && !replaceAll) throw new Error(`${count} 件一致しました。replace_all=true を指定するか対象範囲を狭めてください`)
      const next = replaceAll ? src.split(oldStr).join(newStr) : src.replace(oldStr, newStr)
      if (next === src) { fileSnapshots.set(abs, { before: src, after: src, afterHash: sha256(src), createdAt: Date.now() }); return formatFileChangeResult('編集', path.relative(ctx.workspace, abs), src, src, count) }
      await fsp.writeFile(abs, next, 'utf8')
      const readBack = await fsp.readFile(abs, 'utf8')
      if (readBack !== next) throw new Error('編集後の再読込内容が一致しません')
      fileSnapshots.set(abs, { before: src, after: readBack, afterHash: sha256(readBack), createdAt: Date.now() })
      return formatFileChangeResult('編集', path.relative(ctx.workspace, abs), src, readBack, count)
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

export function openAITools(): OpenAIToolSchema[] {
  return TOOL_DEFS.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
}
