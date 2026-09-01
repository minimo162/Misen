import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const enterpriseRoot = join(repoRoot, 'apps', 'enterprise-misen')
const harness = join(here, 'harness.mjs')
const fixtureModule = join(enterpriseRoot, 'dist', 'demo', 'enterprise-excel', 'fixtures.js')
const fixtures = await import(pathToFileURL(fixtureModule))
const tempParent = join(repoRoot, '.tmp')
await mkdir(tempParent, { recursive: true })

for (const [argument, month] of [['july', '7月'], ['august', '8月']]) {
  const testRoot = await mkdtemp(join(tempParent, `misen-vscode-spike-${argument}-`))
  const runRoot = join(testRoot, 'run')
  try {
    await runFile(process.execPath, [harness, 'prepare', argument, runRoot], { cwd: repoRoot })
    const workspace = join(runRoot, 'workspace')
    const scenario = fixtures.SYNTHETIC_MONTHS.find(candidate => candidate.month === month)
    assert.ok(scenario)
    const plan = {
      month,
      output: `output/monthly-report-${argument}.xlsx`,
      rows: scenario.companies.map(company => ({
        company: company.company,
        revenue: company.revenue,
        cost: company.cost,
        target: fixtures.SYNTHETIC_TARGETS[company.company],
      })),
    }
    await writeFile(join(workspace, 'work-plan.json'), JSON.stringify(plan, null, 2), 'utf8')
    await runFile(process.execPath, ['scripts/finance-xlsx.mjs', 'inspect'], { cwd: workspace })
    await assert.rejects(
      runFile(process.execPath, ['scripts/finance-xlsx.mjs', 'build', '../operator-manifest.json'], { cwd: workspace }),
      /plan must stay inside the workspace/u,
    )
    await runFile(process.execPath, ['scripts/finance-xlsx.mjs', 'build', 'work-plan.json'], { cwd: workspace })
    await runFile(process.execPath, ['scripts/finance-xlsx.mjs', 'verify', plan.output], { cwd: workspace })
    const validation = await runFile(process.execPath, [harness, 'validate', argument, runRoot], { cwd: repoRoot })
    const evidence = JSON.parse(validation.stdout)
    assert.equal(evidence.status, 'PASS')
    assert.equal(evidence.inputUnchanged, true)
    assert.deepEqual(Object.values(evidence.axes).map(axis => axis.status), Array(8).fill('PASS'))

    const manifest = JSON.parse(await readFile(join(runRoot, 'operator-manifest.json'), 'utf8'))
    assert.equal(manifest.prompt, fixtures.PROMPTS[month])
    console.log(`${month}: PASS input-unchanged readable-output eight-axes`)
  } finally {
    await rm(testRoot, { recursive: true })
  }
}
