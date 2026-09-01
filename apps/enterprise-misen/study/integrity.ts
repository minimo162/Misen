import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export async function snapshotFixtureInputs(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>()
  async function visit(relativeDirectory: string): Promise<void> {
    const entries = await readdir(join(root, relativeDirectory), { withFileTypes: true })
    for (const entry of entries) {
      const relativePath = join(relativeDirectory, entry.name)
      if (relativeDirectory === '' && entry.name === 'output') continue
      if (entry.isDirectory()) await visit(relativePath)
      else if (entry.isFile()) hashes.set(relativePath, digest(await readFile(join(root, relativePath))))
      else throw new Error('unsupported fixture filesystem entry')
    }
  }
  await visit('')
  return hashes
}

export function sameFixtureInputs(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): boolean {
  return before.size === after.size && [...before].every(([path, hash]) => after.get(path) === hash)
}
