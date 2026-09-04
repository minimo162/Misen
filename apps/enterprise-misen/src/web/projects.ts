import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const MAX_RECENT_PROJECTS = 5
export const UNC_REJECTION = '共有フォルダーは直接使えません。手元にコピーしてください'

export type ProjectState = { schema: 'misen-projects/1'; recent: string[]; last: string }

export function defaultProjectStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const localAppData = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return join(localAppData, 'Misen', 'state', 'projects.json')
}

export function isUncPath(path: string): boolean { return /^(?:\\\\|\/\/)/u.test(path) }

async function normalizedDirectory(path: string): Promise<string> {
  if (isUncPath(path)) throw new ProjectSelectionError(UNC_REJECTION)
  if (!isAbsolute(path)) throw new ProjectSelectionError('作業フォルダーを選べませんでした。')
  let real: string
  try { real = await realpath(path) } catch { throw new ProjectSelectionError('作業フォルダーが見つかりません。') }
  if (!(await stat(real)).isDirectory()) throw new ProjectSelectionError('作業フォルダーが見つかりません。')
  return real
}

export class ProjectSelectionError extends Error {
  override readonly name = 'ProjectSelectionError'
}

export class ProjectStore {
  private recent: string[] = []
  private initialized = false
  currentRoot: string

  constructor(readonly path: string, initialRoot: string) { this.currentRoot = initialRoot }

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.currentRoot = await normalizedDirectory(this.currentRoot)
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as Partial<ProjectState>
      if (value.schema === 'misen-projects/1' && Array.isArray(value.recent)) {
        for (const candidate of value.recent) {
          if (typeof candidate !== 'string' || isUncPath(candidate)) continue
          try { this.recent.push(await normalizedDirectory(candidate)) } catch { /* stale entries are ignored */ }
        }
      }
    } catch { /* first launch or malformed local state */ }
    this.recent = this.unique([this.currentRoot, ...this.recent])
    this.initialized = true
    await this.save()
  }

  snapshot(): { current: string; name: string; recent: { path: string; name: string }[] } {
    return { current: this.currentRoot, name: basename(this.currentRoot), recent: this.recent.map(path => ({ path, name: basename(path) })) }
  }

  async selectRemembered(path: string): Promise<string> {
    await this.initialize()
    if (isUncPath(path)) throw new ProjectSelectionError(UNC_REJECTION)
    const matched = this.recent.find(candidate => candidate.toLocaleLowerCase() === path.toLocaleLowerCase())
    if (!matched) throw new ProjectSelectionError('記憶されていない作業フォルダーは選べません。')
    return await this.selectValidated(matched)
  }

  async selectPicked(path: string): Promise<string> {
    await this.initialize()
    return await this.selectValidated(path)
  }

  private async selectValidated(path: string): Promise<string> {
    const selected = await normalizedDirectory(path)
    await mkdir(join(selected, 'output'), { recursive: true })
    this.currentRoot = selected
    this.recent = this.unique([selected, ...this.recent])
    await this.save()
    return selected
  }

  private unique(paths: string[]): string[] {
    const seen = new Set<string>()
    return paths.filter(path => { const key = path.toLocaleLowerCase(); if (seen.has(key)) return false; seen.add(key); return true }).slice(0, MAX_RECENT_PROJECTS)
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const state: ProjectState = { schema: 'misen-projects/1', recent: this.recent, last: this.currentRoot }
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', 'utf8')
    await import('node:fs/promises').then(fs => fs.rename(temporary, this.path))
  }
}
