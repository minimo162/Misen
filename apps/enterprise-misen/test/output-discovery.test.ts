import test from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, MONTHS, PROMPTS } from '../demo/enterprise-excel/fixtures.js'
import { snapshotOutputScope, validateReport } from '../src/acceptance/validator.js'
import { runReplay } from '../src/runtime/agent.js'

const scenario = MONTHS[0]!
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function inputHashes(root: string) {
  const paths = ['master.xlsx', '月次管理レポート_template.xlsx', ...scenario.companies.map(company => `${scenario.month}/${company.company}.xlsx`)]
  return new Map(await Promise.all(paths.map(async path => [path, digest(await readFile(join(root, path)))] as const)))
}

test('Decision 438 grades the sole new xlsx without imposing filename semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-output-discovery-'))
  try {
    await fixture(root)
    const before = await inputHashes(root)
    const outputBefore = await snapshotOutputScope(root)
    const replay = await runReplay(root, '7月', PROMPTS['7月'])
    await rename(join(root, replay.output), join(root, 'output', 'report.xlsx'))
    const result = await validateReport(root, scenario, before, outputBefore)
    assert.equal(result.output, 'output/report.xlsx')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Decision 438 rejects zero, multiple, and non-xlsx new artifacts', async () => {
  for (const variant of ['zero', 'multiple', 'non-xlsx'] as const) {
    const root = await mkdtemp(join(tmpdir(), `misen-output-${variant}-`))
    try {
      await fixture(root)
      const before = await inputHashes(root)
      const outputBefore = await snapshotOutputScope(root)
      if (variant === 'multiple') {
        await copyFile(join(root, '月次管理レポート_template.xlsx'), join(root, 'output', 'one.xlsx'))
        await copyFile(join(root, '月次管理レポート_template.xlsx'), join(root, 'output', 'two.xlsx'))
      }
      if (variant === 'non-xlsx') await writeFile(join(root, 'output', 'report.txt'), 'not a workbook', 'utf8')
      await assert.rejects(
        validateReport(root, scenario, before, outputBefore),
        variant === 'non-xlsx' ? /not xlsx/u : /new output count/u,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('Decision 438 rejects mutation of a pre-existing output artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-output-preexisting-'))
  try {
    await fixture(root)
    await writeFile(join(root, 'output', 'existing.txt'), 'before', 'utf8')
    const before = await inputHashes(root)
    const outputBefore = await snapshotOutputScope(root)
    await writeFile(join(root, 'output', 'existing.txt'), 'after', 'utf8')
    await assert.rejects(validateReport(root, scenario, before, outputBefore), /pre-existing output changed/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
