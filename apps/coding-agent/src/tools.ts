import { exec } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import util from 'node:util'
import type { OpenAIToolSchema } from './llm'

const execAsync = util.promisify(exec)

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.tmp'])
const MAX_LIST = 500
const MAX_SEARCH_RESULTS = 200

export interface ToolContext {
  workspace: string
  restrictToWorkspace: boolean
}

export interface ToolDef {
  name: string
  description: string
  kind: 'read' | 'write' | 'command'
  parameters: Record<string, unknown>
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>
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
      await fsp.mkdir(path.dirname(abs), { recursive: true })
      await fsp.writeFile(abs, content, 'utf8')
      return `書き込み完了: ${path.relative(ctx.workspace, abs)} (${Buffer.byteLength(content)} bytes)`
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
      await fsp.writeFile(abs, next, 'utf8')
      return `編集完了: ${path.relative(ctx.workspace, abs)} (${count} 箇所)`
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
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: ctx.workspace,
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true
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
