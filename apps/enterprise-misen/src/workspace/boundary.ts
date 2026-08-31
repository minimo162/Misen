import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * The only filesystem boundary exposed to the Enterprise PoC capabilities.
 *
 * Callers pass workspace-relative names.  Resolution is checked twice: the
 * lexical path must stay below the selected workspace and the filesystem's
 * real path must stay below it as well.  The latter closes the common
 * symlink-escape hole without requiring a virtual filesystem or a subprocess.
 */
export class WorkspaceBoundary {
  readonly root: string
  readonly outputRoot: string

  constructor(root: string) {
    if (!isAbsolute(root)) throw new WorkspaceBoundaryError('workspace root must be absolute')
    const resolvedRoot = realpathSync(root)
    this.root = resolvedRoot
    this.outputRoot = join(resolvedRoot, 'output')
  }

  /** Resolve an existing regular file inside the workspace. */
  async resolveFile(userPath: string): Promise<string> {
    const candidate = this.resolveLexical(userPath)
    const real = await realpath(candidate)
    this.assertInside(real, 'workspace file')
    const info = await stat(real)
    if (!info.isFile()) throw new WorkspaceBoundaryError('workspace path is not a regular file')
    if (info.nlink !== 1) throw new WorkspaceBoundaryError('hard-linked workspace files are not allowed')
    return real
  }

  /**
   * Read through a validated handle and verify that the directory entry still
   * names the same file afterwards. This closes model-triggerable check/use
   * substitutions without a native helper.
   */
  async readFileBytes(userPath: string): Promise<{ absolute: string; bytes: Uint8Array }> {
    const absolute = await this.resolveFile(userPath)
    return { absolute, bytes: await this.readValidatedAbsolute(absolute) }
  }

  /** Read an existing output workbook through the same validated handle path. */
  async readOutputFileBytes(userPath: string): Promise<{ absolute: string; bytes: Uint8Array }> {
    const absolute = await this.resolveOutputFile(userPath)
    return { absolute, bytes: await this.readValidatedAbsolute(absolute) }
  }

  /**
   * Resolve a directory for listing.  Symlinks are never followed by the
   * recursive lister; an explicitly requested symlink is rejected by the
   * real-path check above.
   */
  async resolveDirectory(userPath = '.'): Promise<string> {
    const candidate = this.resolveLexical(userPath)
    const real = await realpath(candidate)
    this.assertInside(real, 'workspace directory')
    const info = await stat(real)
    if (!info.isDirectory()) throw new WorkspaceBoundaryError('workspace path is not a directory')
    return real
  }

  /** Resolve an existing or new .xlsx path under workspace/output only. */
  async resolveOutputFile(userPath: string): Promise<string> {
    const candidate = this.resolveLexical(userPath)
    this.assertInside(candidate, 'output path')
    const outputRelative = relative(this.outputRoot, candidate)
    if (!outputRelative || outputRelative.startsWith('..' + sep) || outputRelative === '..') {
      throw new WorkspaceBoundaryError('writes are limited to workspace/output')
    }
    if (!/\.xlsx$/iu.test(candidate)) {
      throw new WorkspaceBoundaryError('spreadsheet output must use the .xlsx extension')
    }

    // Validate every existing ancestor.  This rejects a symlinked output
    // directory even when the final output file does not exist yet.
    let cursor = candidate
    while (cursor !== this.root) {
      try {
        const info = await lstat(cursor)
        if (info.isSymbolicLink()) throw new WorkspaceBoundaryError('symlink paths are not allowed')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const parent = resolve(cursor, '..')
      if (parent === cursor) break
      cursor = parent
    }

    try {
      const real = await realpath(candidate)
      this.assertInside(real, 'output path')
      const info = await stat(real)
      if (!info.isFile()) throw new WorkspaceBoundaryError('output path is not a regular file')
      if (info.nlink !== 1) throw new WorkspaceBoundaryError('hard-linked output files are not allowed')
      return real
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return candidate
    }
  }

  /** Ensure the output directory exists without leaving the workspace. */
  async ensureOutputDirectory(): Promise<void> {
    await mkdir(this.outputRoot, { recursive: true })
    const real = await realpath(this.outputRoot)
    this.assertInside(real, 'output directory')
  }

  /**
   * Commit bytes through a private temporary file and a same-directory rename
   * replacement. Existing symlink/hardlink targets are never opened for
   * writing. A normal rename error leaves the last-known-good destination in
   * place because the destination is never unlinked first. This is
   * failure-safe namespace replacement, not a power-loss-durable transaction:
   * Node/libuv does not fsync the directory entry here and abrupt power loss,
   * open-handle/ACL interference, or filesystem failure remains outside this
   * boundary's guarantee.
   */
  async writeOutputFileBytes(userPath: string, bytes: Uint8Array, overwrite = false): Promise<string> {
    await this.ensureOutputDirectory()
    const destination = await this.resolveOutputFile(userPath)
    const parent = dirname(destination)
    const parentRealBefore = await realpath(parent)
    this.assertInside(parentRealBefore, 'output parent')

    let exists = false
    try {
      exists = (await lstat(destination)).isFile()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (exists && !overwrite) throw new WorkspaceBoundaryError('output already exists')

    const temporary = join(parent, `.misen-${randomUUID()}.tmp`)
    let committed = false
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }

      const parentRealAfter = await realpath(parent)
      this.assertInside(parentRealAfter, 'output parent')
      if (parentRealAfter !== parentRealBefore) throw new WorkspaceBoundaryError('output parent changed during write')

      if (!overwrite) {
        try {
          await lstat(destination)
          throw new WorkspaceBoundaryError('output appeared during write')
        } catch (error) {
          if (error instanceof WorkspaceBoundaryError) throw error
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      await this.commitTemporaryFile(temporary, destination)
      committed = true
      return destination
    } finally {
      if (!committed) await unlink(temporary).catch(() => undefined)
    }
  }

  /**
   * Same-directory commit seam. The default is Node's rename replacement;
   * tests may subclass the boundary to inject a deterministic commit failure
   * without changing production behavior or adding a runtime hook.
   */
  protected async commitTemporaryFile(temporary: string, destination: string): Promise<void> {
    await rename(temporary, destination)
  }

  /** Return a workspace-relative, stable POSIX display path. */
  displayPath(absolutePath: string): string {
    this.assertInside(absolutePath, 'workspace path')
    return relative(this.root, absolutePath).split(sep).join('/') || '.'
  }

  /** Enumerate regular files directly below one requested directory. */
  async listFiles(userPath = '.'): Promise<string[]> {
    const start = await this.resolveDirectory(userPath)
    const result: string[] = []
    const entries = await readdir(start, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile()) continue
      result.push(this.displayPath(join(start, entry.name)))
    }
    return result
  }

  private resolveLexical(userPath: string): string {
    if (typeof userPath !== 'string' || userPath.length === 0) {
      throw new WorkspaceBoundaryError('workspace path must be a non-empty relative path')
    }
    if (userPath.includes('\0')) throw new WorkspaceBoundaryError('workspace path contains a NUL byte')
    if (userPath.split(/[\\/]+/u).some(segment => segment === '..')) {
      throw new WorkspaceBoundaryError('path traversal segments are not allowed')
    }
    if (isAbsolute(userPath)) throw new WorkspaceBoundaryError('absolute paths are not allowed')
    const candidate = resolve(this.root, userPath)
    this.assertInside(candidate, 'workspace path')
    return candidate
  }

  private async readValidatedAbsolute(absolute: string): Promise<Uint8Array> {
    const handle = await open(absolute, 'r')
    try {
      const before = await handle.stat()
      if (!before.isFile()) throw new WorkspaceBoundaryError('workspace path is not a regular file')
      if (before.nlink !== 1) throw new WorkspaceBoundaryError('hard-linked workspace files are not allowed')
      const bytes = new Uint8Array(await handle.readFile())
      const namedReal = await realpath(absolute)
      this.assertInside(namedReal, 'workspace file')
      const after = await stat(namedReal)
      if (after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino) {
        throw new WorkspaceBoundaryError('workspace file changed during read')
      }
      return bytes
    } finally {
      await handle.close()
    }
  }

  private assertInside(candidate: string, label: string): void {
    const rel = relative(this.root, candidate)
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
      throw new WorkspaceBoundaryError(`${label} escapes the selected workspace`)
    }
  }
}

export class WorkspaceBoundaryError extends Error {
  override readonly name = 'WorkspaceBoundaryError'
}
