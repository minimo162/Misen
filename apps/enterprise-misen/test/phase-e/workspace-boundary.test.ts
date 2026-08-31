import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { WorkspaceBoundary } from '../../src/workspace/boundary.js'

const BYTES_OLD = new TextEncoder().encode('last-known-good\n')
const BYTES_NEW = new TextEncoder().encode('replacement\n')

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function tempEntries(outputRoot: string): Promise<string[]> {
  return (await readdir(outputRoot)).filter(name => /^\.misen-[0-9a-f-]+\.tmp$/iu.test(name)).sort()
}

/** Test-only deterministic commit failure; production has no failure hook. */
class CommitFailureBoundary extends WorkspaceBoundary {
  protected override async commitTemporaryFile(): Promise<void> {
    throw new Error('simulated commit failure')
  }
}

test('WorkspaceBoundary replaces output directly and leaves no temporary file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-boundary-success-'))
  try {
    const boundary = new WorkspaceBoundary(root)
    await boundary.writeOutputFileBytes('output/report.xlsx', BYTES_OLD)
    const before = await boundary.readOutputFileBytes('output/report.xlsx')
    assert.deepEqual([...before.bytes], [...BYTES_OLD])

    await boundary.writeOutputFileBytes('output/report.xlsx', BYTES_NEW, true)
    const after = await boundary.readOutputFileBytes('output/report.xlsx')
    assert.deepEqual([...after.bytes], [...BYTES_NEW])
    assert.deepEqual(await tempEntries(join(root, 'output')), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('WorkspaceBoundary pre-commit refusal preserves an existing output and creates no temp', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-boundary-precommit-'))
  try {
    const boundary = new WorkspaceBoundary(root)
    await boundary.writeOutputFileBytes('output/report.xlsx', BYTES_OLD)
    await assert.rejects(
      () => boundary.writeOutputFileBytes('output/report.xlsx', BYTES_NEW),
      /output already exists/iu,
    )
    assert.deepEqual([...await boundary.readOutputFileBytes('output/report.xlsx').then(result => result.bytes)], [...BYTES_OLD])
    assert.deepEqual(await tempEntries(join(root, 'output')), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('WorkspaceBoundary commit failure preserves byte-identical last-known-good output and cleans temp', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-boundary-failure-'))
  try {
    const boundary = new WorkspaceBoundary(root)
    await boundary.writeOutputFileBytes('output/report.xlsx', BYTES_OLD)
    const oldHash = sha256(await readFile(join(root, 'output', 'report.xlsx')))

    const failing = new CommitFailureBoundary(root)
    await assert.rejects(
      () => failing.writeOutputFileBytes('output/report.xlsx', BYTES_NEW, true),
      /simulated commit failure/iu,
    )
    const destination = await readFile(join(root, 'output', 'report.xlsx'))
    assert.equal(sha256(destination), oldHash)
    assert.deepEqual([...destination], [...BYTES_OLD])
    assert.deepEqual(await tempEntries(join(root, 'output')), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('WorkspaceBoundary keeps input bytes unchanged while publishing output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-boundary-input-'))
  try {
    await mkdir(join(root, 'inputs'), { recursive: true })
    const inputPath = join(root, 'inputs', 'template.xlsx')
    await writeFile(inputPath, BYTES_OLD)
    const inputHash = sha256(await readFile(inputPath))
    const boundary = new WorkspaceBoundary(root)
    await boundary.writeOutputFileBytes('output/report.xlsx', await readFile(inputPath))
    assert.equal(sha256(await readFile(inputPath)), inputHash)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('WorkspaceBoundary rejects hard-linked and symlinked output paths before replacement', async t => {
  const root = await mkdtemp(join(tmpdir(), 'misen-boundary-links-'))
  const outside = join(root, '..', `misen-boundary-outside-${process.pid}-${Date.now()}.xlsx`)
  try {
    await mkdir(join(root, 'output'), { recursive: true })
    await writeFile(outside, BYTES_OLD)
    const boundary = new WorkspaceBoundary(root)

    const hardlinked = join(root, 'output', 'hardlinked.xlsx')
    await link(outside, hardlinked)
    await assert.rejects(
      () => boundary.writeOutputFileBytes('output/hardlinked.xlsx', BYTES_NEW, true),
      /hard-linked/iu,
    )
    assert.deepEqual([...await readFile(outside)], [...BYTES_OLD])
    assert.deepEqual(await tempEntries(join(root, 'output')), [])

    const symlinked = join(root, 'output', 'symlinked.xlsx')
    try {
      await symlink(outside, symlinked, 'file')
      await assert.rejects(
        () => boundary.writeOutputFileBytes('output/symlinked.xlsx', BYTES_NEW, true),
        /symlink/iu,
      )
      assert.deepEqual([...await readFile(outside)], [...BYTES_OLD])
      assert.deepEqual(await tempEntries(join(root, 'output')), [])
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES') throw error
      t.skip(`symlink creation is unavailable on this host (${code})`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { force: true })
  }
})
