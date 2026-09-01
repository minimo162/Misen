import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { WorkspaceBoundary } from '../workspace/boundary.js'

export const MAX_SESSION_ARTIFACTS = 64
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

export type OutputScopeSnapshot = ReadonlyMap<string, string>

export interface DiscoveredArtifact {
  readonly path: string
  readonly filename: string
  readonly bytes: Uint8Array
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const ordinal = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

async function outputPaths(boundary: WorkspaceBoundary): Promise<string[]> {
  return (await boundary.listOutputFiles())
    .filter(path => /\.xlsx$/iu.test(path))
    .sort(ordinal)
}

/**
 * Capture only bounded, regular .xlsx files under the authorized output scope.
 * WorkspaceBoundary rejects an escaped/symlinked output root; its lister ignores
 * symlink entries, so an arbitrary host path can never become an artifact.
 */
export async function snapshotOutputArtifacts(boundary: WorkspaceBoundary): Promise<OutputScopeSnapshot> {
  const snapshot = new Map<string, string>()
  for (const path of await outputPaths(boundary)) {
    const resource = await boundary.readOutputFileBytes(path, MAX_ARTIFACT_BYTES)
    snapshot.set(path, digest(resource.bytes))
  }
  return snapshot
}

/** Return newly created or changed authorized workbooks, with bytes frozen for download. */
export async function discoverOutputArtifacts(
  boundary: WorkspaceBoundary,
  before: OutputScopeSnapshot,
  maximumArtifacts: number,
): Promise<DiscoveredArtifact[]> {
  if (!Number.isSafeInteger(maximumArtifacts) || maximumArtifacts < 0 || maximumArtifacts > MAX_SESSION_ARTIFACTS) {
    throw new Error('artifact capacity')
  }
  const discovered: DiscoveredArtifact[] = []
  for (const path of await outputPaths(boundary)) {
    const resource = await boundary.readOutputFileBytes(path, MAX_ARTIFACT_BYTES)
    if (before.get(path) === digest(resource.bytes)) continue
    if (discovered.length >= maximumArtifacts) throw new Error('artifact capacity')
    discovered.push({
      path,
      filename: basename(resource.absolute.replace(/\\/gu, '/')),
      bytes: Uint8Array.from(resource.bytes),
    })
  }
  return discovered
}
