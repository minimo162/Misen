import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, MONTHS, PROMPTS } from '../demo/enterprise-excel/fixtures.js'
import { runReplay } from '../src/runtime/agent.js'
import { snapshotOutputScope, validateReport } from '../src/acceptance/validator.js'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

for (const scenario of MONTHS) {
  const startedAt = performance.now()
  const root = await mkdtemp(join(tmpdir(), 'misen-pi-'))
  try {
    await fixture(root)
    const inputs = new Map(await Promise.all([
      'master.xlsx',
      '月次管理レポート_template.xlsx',
      ...scenario.companies.map(company => `${scenario.month}/${company.company}.xlsx`),
    ].map(async path => [path, hash(await readFile(join(root, path)))] as const)))
    const outputBefore = await snapshotOutputScope(root)
    const month = scenario.month as '7月' | '8月'
    const replay = await runReplay(root, month, PROMPTS[month])
    const validation = await validateReport(root, scenario, inputs, outputBefore)
    assert.equal(validation.passed, true, JSON.stringify(validation.axes))
    assert.equal(replay.events.filter(event => event.type === 'tool_execution_start').length, 9, 'Pi tool loop including progressive Skill read')
    console.log(`${scenario.month}: PASS ${Object.entries(validation.axes).map(([axis, result]) => `${axis}=${result.status}`).join(' ')} new-output-count input-hashes elapsedMs=${Math.round(performance.now() - startedAt)}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
