import fs from 'node:fs'
import { exec, execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import util from 'node:util'
import iconv from '../vendor/npm/node_modules/iconv-lite'
import type { OpenAIToolSchema } from './llm'
import { listManagedProcesses, readManagedProcessLog, startManagedProcess, stopManagedProcess } from './processes'
import { getWeather } from './weather'

const execAsync = util.promisify(exec)
const execFileAsync = util.promisify(execFile)

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.tmp'])
const MAX_LIST = 500
const MAX_SEARCH_RESULTS = 200
const MAX_READ_FILES_CHARS = 80_000
const READ_XLSX_USAGE = 'powershell.exe -NoProfile -File tools\\Read-Xlsx.ps1 -Path <パス>'
const UPDATE_LEDGER_USAGE = 'powershell.exe -NoProfile -File tools\\Update-Ledger.ps1 -Extracted <抽出JSON> -Rates <レートCSV> -Ledger <台帳xlsx>'

export interface ToolContext {
  workspace: string
  restrictToWorkspace: boolean
  safeCommandOnly?: boolean
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

function splitCommandWords(command: string): { words: string[]; unsafe: boolean } {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let unsafe = false
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null
      else {
        if ('&|;<>`%^()'.includes(ch) || ch === '\r' || ch === '\n') unsafe = true
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (ch === '\r' || ch === '\n') unsafe = true
      if (current) {
        words.push(current)
        current = ''
      }
    } else {
      if ('&|;<>`%^()'.includes(ch) || ch === '\r' || ch === '\n') unsafe = true
      current += ch
    }
  }
  if (current) words.push(current)
  return { words, unsafe: unsafe || quote !== null }
}

function isEncodedCommandFlag(word: string): boolean {
  const match = word.match(/^[-/]([A-Za-z]+)(?=$|[:=])/u)
  if (!match) return false
  const name = match[1].toLowerCase()
  return name.length >= 1 && 'encodedcommand'.startsWith(name)
}

function quoteCommandWord(value: string): string {
  if (!/[\s"]/u.test(value)) return value
  if (value.includes('"')) throw new Error(`Read-Xlsx の引数に引用符は使用できません。${READ_XLSX_USAGE} の形式で呼んでください`)
  return `"${value}"`
}

/** Apply the run_command safety policy before the command reaches the shell. */
export function normalizeRunCommand(command: string): string {
  const trimmed = command.trim()
  if (!trimmed) throw new Error('command が必要です')
  const parsed = splitCommandWords(trimmed)
  const fileIndex = parsed.words.findIndex((word) => /^-File$/iu.test(word))
  const directScript = fileIndex < 0 ? parsed.words[0] : undefined
  const script = fileIndex >= 0 ? parsed.words[fileIndex + 1] : directScript
  const scriptArgsIndex = fileIndex >= 0 ? fileIndex + 2 : 1
  const isReadXlsx = script !== undefined && /^(?:\.\\|\.\/)?tools[\\/]Read-Xlsx\.ps1$/iu.test(script)
  const isUpdateLedger = script !== undefined && /^(?:\.\\|\.\/)?tools[\\/]Update-Ledger\.ps1$/iu.test(script)

  if (!isReadXlsx && !isUpdateLedger) return command
  const toolLabel = isReadXlsx ? 'Read-Xlsx' : 'Update-Ledger'
  const usage = isReadXlsx ? READ_XLSX_USAGE : UPDATE_LEDGER_USAGE
  if (parsed.unsafe) throw new Error(`${toolLabel} は複合コマンドにせず、${usage} の形式で呼んでください`)
  if (fileIndex >= 0 && !/^(?:powershell|powershell\.exe)$/iu.test(parsed.words[0] ?? '')) {
    throw new Error(`${toolLabel} は ${usage} の形式で呼んでください`)
  }

  if (isReadXlsx) {
    let pathWords = parsed.words.slice(scriptArgsIndex)
    if (/^-Path$/iu.test(pathWords[0] ?? '')) pathWords = pathWords.slice(1)
    pathWords = pathWords.flatMap((word) => word.split(',')).filter(Boolean)
    if (pathWords.length === 0 || pathWords.some((word) => /^-/u.test(word))) {
      throw new Error(`Read-Xlsx は ${READ_XLSX_USAGE} の形式で呼んでください`)
    }

    const normalized = pathWords.map((word) => word.replaceAll('/', '\\'))
    const reportPaths = normalized.length > 1
      ? normalized.filter((word) => !(path.win32.dirname(word) === '.' && path.win32.basename(word).toLowerCase() === '集計台帳.xlsx'))
      : normalized
    if (reportPaths.length === 0) throw new Error(`Read-Xlsx は ${READ_XLSX_USAGE} の形式で呼んでください`)
    let normalizedPath: string
    if (reportPaths.length === 1) {
      normalizedPath = reportPaths[0]
    } else {
      const directories = new Set(reportPaths.map((word) => path.win32.dirname(word).toLowerCase()))
      if (directories.size !== 1 || reportPaths.some((word) => path.win32.extname(word).toLowerCase() !== '.xlsx')) {
        throw new Error(`Read-Xlsx の複数ファイルは同じフォルダーの *.xlsx で指定してください。${READ_XLSX_USAGE} の形式で呼んでください`)
      }
      normalizedPath = path.win32.join(path.win32.dirname(reportPaths[0]), '*.xlsx')
    }
    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\\Read-Xlsx.ps1 -Path ${quoteCommandWord(normalizedPath)}`
  }

  const rest = parsed.words.slice(scriptArgsIndex)
  const named = new Map<string, string>()
  const positional: string[] = []
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]
    const match = token.match(/^-(Extracted|ExtractedPath|Rates|Ledger)$/iu)
    if (match) {
      const value = rest[++index]
      if (!value || /^-/u.test(value)) throw new Error(`Update-Ledger は ${UPDATE_LEDGER_USAGE} の形式で呼んでください`)
      const key = /^ExtractedPath$/iu.test(match[1]) ? 'extracted' : match[1].toLowerCase()
      named.set(key, value)
    } else if (/^-/u.test(token)) {
      throw new Error(`Update-Ledger に未許可の引数があります。${UPDATE_LEDGER_USAGE} の形式で呼んでください`)
    } else {
      positional.push(token)
    }
  }
  if (named.size > 0 && positional.length > 0) throw new Error(`Update-Ledger は名前付き引数だけで ${UPDATE_LEDGER_USAGE} の形式で呼んでください`)
  const extracted = (named.get('extracted') ?? positional[0])?.replaceAll('/', '\\')
  const rates = (named.get('rates') ?? positional[1])?.replaceAll('/', '\\')
  const ledger = (named.get('ledger') ?? positional[2])?.replaceAll('/', '\\')
  if (!extracted || !rates || !ledger || positional.length > 3) throw new Error(`Update-Ledger は ${UPDATE_LEDGER_USAGE} の形式で呼んでください`)
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\\Update-Ledger.ps1 -Extracted ${quoteCommandWord(extracted)} -Rates ${quoteCommandWord(rates)} -Ledger ${quoteCommandWord(ledger)}`
}

/**
 * Permit only a single workspace-contained document open.  We intentionally
 * rewrite common open aliases/Start-Process/excel into Invoke-Item so the command policy does not
 * need to allow general process creation or arbitrary arguments.
 */
export function normalizeWorkspaceOpenCommand(command: string, ctx: ToolContext): string | null {
  const parsed = splitCommandWords(command.trim())
  if (parsed.unsafe || parsed.words.length === 0) return null
  const words = parsed.words
  let candidate: string | undefined
  const executable = (words[0] ?? '').toLowerCase()
  if (executable === 'invoke-item' || executable === 'ii') {
    if (words.length === 2) candidate = words[1]
    else if (words.length === 3 && /^-(?:literal)?path$/iu.test(words[1])) candidate = words[2]
  } else if (executable === 'start-process') {
    if (words.length === 2) candidate = words[1]
    else if (words.length === 3 && /^-filepath$/iu.test(words[1])) candidate = words[2]
  } else if (['start', 'open'].includes(executable) && words.length === 2) {
    // Copilot commonly emits cmd's `start "" file` as `start " file"`, or
    // the cross-platform `open file`. Both remain a single existing workspace file.
    candidate = words[1].trimStart()
  } else if (['excel', 'excel.exe'].includes(executable) && words.length === 2 && /\.xlsx$/iu.test(words[1])) {
    candidate = words[1]
  }
  if (!candidate) return null
  let absolute: string
  try { absolute = resolveInWorkspace(candidate, ctx) } catch { throw new Error(`run_command拒否: ワークスペース外へのアクセスは禁止です: ${candidate}`) }
  if (!fs.existsSync(absolute)) throw new Error(`run_command拒否: 開く対象が存在しません: ${candidate}`)
  // The source is a tokenized value with metacharacters rejected above. A
  // quote would alter the generated single-quoted literal, so reject it too.
  if (absolute.includes("'")) throw new Error('run_command拒否: 開く対象のパスに引用符は使用できません')
  return `powershell.exe -NoProfile -Command "Invoke-Item -LiteralPath '${absolute}'"`
}

/** Shared gate for run_command and start_process. */
export function prepareHostCommand(command: string, ctx: ToolContext): string {
  const normalized = normalizeRunCommand(command)
  const safeOpen = normalizeWorkspaceOpenCommand(normalized, ctx)
  if (ctx.safeCommandOnly && !safeOpen) throw new Error('run_command拒否: この構成ではワークスペース内ファイルを開く明示許可形式だけ実行できます')
  const prepared = safeOpen ?? normalized
  assertRunCommandPolicy(prepared, ctx)
  return prepared
}

export function formatHostCommandOutput(requested: string, prepared: string, stdout: string, stderr: string): string {
  const parts = [stdout, stderr].filter((value) => value.trim().length > 0).map((value) => truncate(value))
  if (parts.length > 0) return parts.join('\n---stderr---\n')
  if (/\bInvoke-Item\s+-LiteralPath\b/iu.test(prepared)) return `アプリ起動コマンド成功: ${requested}`
  return '(出力なし)'
}

const DELETE_OPERATIONS = new Set([
  'remove-item', 'clear-content', 'del', 'erase', 'rd', 'rmdir', 'rm', 'ri', 'unlink'
])
const NETWORK_OPERATIONS = new Set([
  'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'curl', 'curl.exe', 'wget', 'wget.exe',
  'start-bitstransfer', 'bitsadmin', 'ftp', 'ssh', 'scp', 'ping', 'test-netconnection', 'resolve-dnsname'
])
const PROCESS_SERVICE_OPERATIONS = new Set([
  'start-process', 'stop-process', 'debug-process', 'taskkill', 'taskkill.exe', 'sc', 'sc.exe',
  'start-service', 'stop-service', 'restart-service', 'set-service', 'new-service', 'remove-service',
  'restart-computer', 'stop-computer', 'shutdown', 'shutdown.exe'
])
const REGISTRY_MUTATION_OPERATIONS = new Set([
  'set-itemproperty', 'new-itemproperty', 'remove-itemproperty', 'rename-itemproperty', 'clear-itemproperty'
])
const FILE_WRITE_OPERATIONS = new Set([
  'set-content', 'add-content', 'out-file', 'tee-object', 'export-csv', 'new-item', 'copy-item', 'move-item',
  'copy', 'move', 'xcopy', 'robocopy', 'mkdir', 'md', 'touch'
])

function commandWords(command: string): string[] {
  return splitCommandWords(command).words
    .flatMap((word) => {
      if (!/\s/u.test(word)) return [word]
      const nested = word.split(/\s+/u).map((part) => part.replace(/^[;&|()]+|[;&|()]+$/gu, '').toLowerCase())
      const containsOperation = nested.some((part) =>
        DELETE_OPERATIONS.has(part) || NETWORK_OPERATIONS.has(part) || PROCESS_SERVICE_OPERATIONS.has(part) ||
        REGISTRY_MUTATION_OPERATIONS.has(part) || FILE_WRITE_OPERATIONS.has(part) ||
        ['reg', 'reg.exe', 'net', 'net.exe', 'git'].includes(part) || isEncodedCommandFlag(part)
      )
      return containsOperation ? splitCommandWords(word).words : [word]
    })
    .flatMap((word) => word.split(/[;&|()]+/u))
    .map((word) => word.trim())
    .filter(Boolean)
}

function commandOperationTokens(command: string): string[] {
  return commandWords(command).map((word) => word.toLowerCase())
}

function containsPowerShellEncodedCommand(command: string): boolean {
  const words = commandWords(command)
  const powershell = words.findIndex((word) => /^(?:powershell|powershell\.exe|pwsh|pwsh\.exe)$/iu.test(word))
  return powershell >= 0 && words.slice(powershell + 1).some(isEncodedCommandFlag)
}

function assertWorkspaceWriteTarget(target: string, ctx: ToolContext): void {
  const cleaned = target.trim().replace(/^['"]|['"]$/g, '')
  if (!cleaned || /^&\d$/u.test(cleaned) || /^(?:nul|\$null)$/iu.test(cleaned)) return
  if (/[\r\n]/u.test(cleaned) || /%[^%]+%|\$\{?env:|^~(?:[\\/]|$)/iu.test(cleaned)) {
    throw new Error(`run_command拒否: 書き込み先を安全に確認できません: ${target}`)
  }
  try {
    resolveInWorkspace(cleaned, ctx)
  } catch {
    throw new Error(`run_command拒否: ワークスペース外への書き込みは禁止です: ${target}`)
  }
}

function redirectionTargets(command: string): string[] {
  const targets: string[] = []
  const pattern = /(?:\d*)>{1,2}\s*("[^"]+"|'[^']+'|[^\s;&|]+)/gu
  for (const match of command.matchAll(pattern)) targets.push(match[1])
  return targets
}

function writeOperationTargets(command: string): string[] {
  const words = commandWords(command)
  const targets: string[] = []
  for (let index = 0; index < words.length; index++) {
    const operation = words[index].toLowerCase()
    if (!FILE_WRITE_OPERATIONS.has(operation)) continue
    const tail = words.slice(index + 1)
    const copyOrMove = ['copy-item', 'move-item', 'copy', 'move', 'xcopy', 'robocopy'].includes(operation)
    const namedTargetNames = copyOrMove
      ? new Set(['-destination', '-dest'])
      : new Set(['-path', '-literalpath', '-filepath'])
    let found: string | undefined
    for (let offset = 0; offset < tail.length - 1; offset++) {
      if (namedTargetNames.has(tail[offset].toLowerCase())) {
        found = tail[offset + 1]
        break
      }
    }
    if (!found) {
      const positional = tail.filter((word) => !word.startsWith('-'))
      found = copyOrMove ? positional[1] : positional[0]
    }
    if (!found) throw new Error(`run_command拒否: ${words[index]} の書き込み先を確認できません`)
    targets.push(found)
  }
  return targets
}

function assertRunCommandPolicy(command: string, ctx: ToolContext): void {
  if (containsPowerShellEncodedCommand(command)) {
    throw new Error('run_command拒否: -EncodedCommand は許可されていません')
  }
  const operations = commandOperationTokens(command)
  const blocked = operations.find((word) => DELETE_OPERATIONS.has(word))
  if (blocked) throw new Error(`run_command拒否: 削除操作 ${blocked} は許可されていません`)
  const network = operations.find((word) => NETWORK_OPERATIONS.has(word))
  if (network) throw new Error(`run_command拒否: ネットワーク操作 ${network} は許可されていません`)
  const process = operations.find((word) => PROCESS_SERVICE_OPERATIONS.has(word))
  if (process) throw new Error(`run_command拒否: プロセス・サービス操作 ${process} は許可されていません`)
  const registry = operations.find((word) => REGISTRY_MUTATION_OPERATIONS.has(word))
  if (registry) throw new Error(`run_command拒否: レジストリ変更 ${registry} は許可されていません`)
  const registryPath = /(?:^|[\s'"(])(?:HKLM|HKCU|HKCR|HKU|HKCC):[\\/]|Registry::/iu.test(command)
  if (registryPath && operations.some((word) => FILE_WRITE_OPERATIONS.has(word) || word === 'set-item' || word === 'rename-item')) {
    throw new Error('run_command拒否: レジストリ変更は許可されていません')
  }
  const regIndex = operations.findIndex((word) => word === 'reg' || word === 'reg.exe')
  if (regIndex >= 0 && operations[regIndex + 1] !== 'query') {
    throw new Error('run_command拒否: レジストリ変更 reg は許可されていません')
  }
  const netIndex = operations.findIndex((word) => word === 'net' || word === 'net.exe')
  if (netIndex >= 0 && ['start', 'stop'].includes(operations[netIndex + 1] ?? '')) {
    throw new Error('run_command拒否: サービス操作 net は許可されていません')
  }
  if (/\[(?:System\.)?IO\.File\]::(?:WriteAllText|WriteAllBytes|AppendAllText|Create)/iu.test(command)) {
    throw new Error('run_command拒否: 低水準ファイル書き込みAPIは書き込み先を安全に確認できません')
  }
  const gitIndex = operations.findIndex((word) => word === 'git')
  if (gitIndex >= 0 && ['clean', 'rm', 'reset'].includes(operations[gitIndex + 1] ?? '')) {
    throw new Error(`run_command拒否: 破壊的なgit ${operations[gitIndex + 1]} は許可されていません`)
  }
  if (!ctx.restrictToWorkspace) return
  for (const target of [...redirectionTargets(command), ...writeOperationTargets(command)]) {
    assertWorkspaceWriteTarget(target, ctx)
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

function workspaceGlobToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//, '')
  let source = ''
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        i++
        if (normalized[i + 1] === '/') {
          i++
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (ch === '?') {
      source += '[^/]'
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`, 'i')
}

function normalizeWorkspaceGlob(pattern: string): string {
  const normalized = pattern.trim().replaceAll('\\', '/').replace(/^\.\//, '')
  if (!normalized) throw new Error('pattern が空です')
  if (path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`ワークスペース外を指すpatternは許可されていません: ${pattern}`)
  }
  // Copilot commonly names a directory when it means its immediate contents.
  // Treat a trailing slash as the documented `directory/*` glob.
  return normalized.endsWith('/') ? `${normalized}*` : normalized
}

function decodeWorkspaceText(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return iconv.decode(bytes, 'cp932')
  }
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
        glob: { type: 'string', description: 'ファイル名のパターン。例: *.ts' },
        recursive: { type: 'boolean', description: 'サブフォルダも再帰するか (既定: true)。直下だけならfalse' }
      },
      required: []
    },
    async run(args, ctx) {
      const base = args.path ? resolveInWorkspace(String(args.path), ctx) : ctx.workspace
      const re = args.glob ? wildcardToRegExp(String(args.glob)) : null
      const out: string[] = []
      if (args.recursive === false) {
        const entries = await fsp.readdir(base, { withFileTypes: true })
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'ja'))) {
          if (out.length >= MAX_LIST) break
          if (!re || re.test(entry.name)) {
            const relative = path.relative(ctx.workspace, path.join(base, entry.name)).replaceAll('\\', '/')
            out.push(entry.isDirectory() ? `${relative}/` : relative)
          }
        }
      } else {
        await walk(base, (f) => {
          if (out.length >= MAX_LIST) return
          if (!re || re.test(path.basename(f))) out.push(path.relative(ctx.workspace, f).replaceAll('\\', '/'))
        })
      }
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
    name: 'read_files',
    description: 'ワークスペース相対のglobまたは複数パスに一致するテキストファイルをまとめて読む。xlsxはRead-Xlsx.ps1の利用方法を返す',
    kind: 'read',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'ワークスペース相対glob。例: reports/*' },
        patterns: { type: 'array', description: 'ワークスペース相対globの配列' },
        paths: { type: 'array', description: 'ワークスペース相対ファイルパスの配列' },
        maxChars: { type: 'integer', description: '合計文字数予算（既定・最大 80000）', minimum: 1, maximum: MAX_READ_FILES_CHARS }
      },
      required: []
    },
    async run(args, ctx) {
      const patterns: string[] = []
      if (args.pattern !== undefined) {
        if (typeof args.pattern !== 'string') throw new Error('pattern は文字列で指定してください')
        patterns.push(normalizeWorkspaceGlob(args.pattern))
      }
      if (args.patterns !== undefined) {
        if (!Array.isArray(args.patterns) || args.patterns.some((item) => typeof item !== 'string')) throw new Error('patterns は文字列配列で指定してください')
        patterns.push(...args.patterns.map((item) => normalizeWorkspaceGlob(String(item))))
      }
      let requestedPaths: string[] = []
      if (args.paths !== undefined) {
        if (!Array.isArray(args.paths) || args.paths.some((item) => typeof item !== 'string' || !item.trim())) throw new Error('paths は空でない文字列の配列で指定してください')
        requestedPaths = args.paths.map(String)
      }
      if (patterns.length === 0 && requestedPaths.length === 0) throw new Error('pattern、patterns、paths のいずれかを指定してください')
      const maxChars = args.maxChars === undefined ? MAX_READ_FILES_CHARS : Number(args.maxChars)
      if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_READ_FILES_CHARS) throw new Error(`maxChars は1以上${MAX_READ_FILES_CHARS}以下の整数で指定してください`)

      const selected = new Map<string, { abs: string; relative: string }>()
      const addFile = (abs: string, displayPath?: string): void => {
        const checked = resolveInWorkspace(abs, ctx)
        const relative = (displayPath ?? path.relative(ctx.workspace, checked)).replaceAll('\\', '/')
        selected.set(checked.toLowerCase(), { abs: checked, relative })
      }
      for (const requested of requestedPaths) addFile(resolveInWorkspace(requested, ctx), requested.replaceAll('\\', '/'))
      if (patterns.length > 0) {
        const matchers = patterns.map(workspaceGlobToRegExp)
        await walk(ctx.workspace, (file) => {
          const relative = path.relative(ctx.workspace, file).replaceAll('\\', '/')
          if (matchers.some((matcher) => matcher.test(relative))) addFile(file, relative)
        })
      }
      const files = [...selected.values()].sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0)
      if (files.length === 0) return '(該当なし)'

      const sections: string[] = []
      const unread: string[] = []
      // Reserve enough room to name every skipped/partial file. The character
      // ceiling applies to the complete result, including headings and the list.
      const unreadReserve = Math.min(maxChars, 50 + files.reduce((sum, file) => sum + file.relative.length + 100, 0))
      const bodyBudget = maxChars - unreadReserve
      let used = 0
      let exhausted = false
      for (const file of files) {
        if (exhausted) {
          unread.push(`${file.relative}: 文字数予算を使い切ったため未読`)
          continue
        }
        let stat
        try {
          stat = await fsp.stat(file.abs)
        } catch (err) {
          unread.push(`${file.relative}: 読み取り失敗 (${(err as Error).message})`)
          continue
        }
        if (!stat.isFile()) {
          unread.push(`${file.relative}: ファイルではありません`)
          continue
        }
        const heading = `===== ${file.relative} =====\n`
        const xlsxHint = `run_commandで tools/Read-Xlsx.ps1 ${file.relative} を使ってください`
        if (path.extname(file.relative).toLowerCase() === '.xlsx') {
          const section = `${heading}${xlsxHint}\n`
          if (used + section.length <= bodyBudget) {
            sections.push(section)
            used += section.length
          } else {
            unread.push(`${file.relative}: 文字数予算を超えるためヒントを出力できませんでした`)
            exhausted = true
          }
          continue
        }
        let content: string
        try {
          content = decodeWorkspaceText(await fsp.readFile(file.abs))
        } catch (err) {
          unread.push(`${file.relative}: 読み取り失敗 (${(err as Error).message})`)
          continue
        }
        const available = bodyBudget - used
        const suffix = '\n'
        if (heading.length + content.length + suffix.length <= available) {
          sections.push(`${heading}${content}${suffix}`)
          used += heading.length + content.length + suffix.length
          continue
        }
        const marker = '\n...(文字数予算により途中打切り)\n'
        const take = Math.max(0, available - heading.length - marker.length)
        if (take > 0) {
          sections.push(`${heading}${content.slice(0, take)}${marker}`)
          used += heading.length + take + marker.length
        }
        unread.push(`${file.relative}: ${content.length - take}文字を文字数予算により未読`)
        exhausted = true
      }
      if (unread.length > 0) {
        sections.push(['===== 読めなかった/途中打切り一覧 =====', ...unread.map((item) => `- ${item}`), ''].join('\n'))
      }
      return sections.join('').slice(0, maxChars)
    }
  },
  {
    name: 'read_xlsx',
    description: 'ワークスペース内の任意のxlsxを読み、シート名・セル範囲・表内容をJSONで返す',
    kind: 'read',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'ワークスペース相対のxlsxファイルパス' }
      },
      required: ['path']
    },
    async run(args, ctx) {
      const requested = String(args.path ?? '')
      const abs = resolveInWorkspace(requested, ctx)
      if (path.extname(abs).toLowerCase() !== '.xlsx') throw new Error('read_xlsx は .xlsx ファイルだけを読み取れます')
      const stat = await fsp.stat(abs).catch(() => null)
      if (!stat?.isFile()) throw new Error(`xlsxが見つかりません: ${requested}`)
      const appRoot = path.resolve(__dirname, '..')
      const helper = path.join(appRoot, 'tools', 'Read-Xlsx.ps1')
      if (!fs.existsSync(helper)) throw new Error(`xlsx読み取りヘルパーが見つかりません: ${helper}`)
      const { stdout, stderr } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Path', abs], {
        cwd: ctx.workspace,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 10_000_000,
        signal: ctx.signal
      })
      const output = String(stdout).trim()
      if (!output) throw new Error(`xlsx読み取り結果が空です${stderr ? `: ${String(stderr).trim()}` : ''}`)
      return truncate(output, MAX_READ_FILES_CHARS)
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
      const command = prepareHostCommand(String(args.command ?? ''), ctx)
      const process = startManagedProcess(command, ctx.workspace, args.label ? String(args.label) : undefined, args.url ? String(args.url) : undefined)
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
      const requested = String(args.command ?? '')
      if (/wttr\.in/i.test(requested)) throw new Error('天気・気温の取得にwttr.inは使用できません。get_weatherツールを使ってください')
      const command = prepareHostCommand(requested, ctx)
      if (ctx.signal?.aborted) throw new Error('コマンド実行はキャンセルされました')
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: ctx.workspace,
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          signal: ctx.signal
        })
        return formatHostCommandOutput(requested, command, stdout, stderr)
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
