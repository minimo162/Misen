import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture } from '../dist/demo/enterprise-excel/fixtures.js'
import { enterpriseTools } from '../dist/src/capabilities/tools.js'
import { OfficeCliSpreadsheet } from '../dist/src/spreadsheet/officecli.js'
import { WorkspaceBoundary } from '../dist/src/workspace/boundary.js'

function summary(samples) {
  const total = samples.reduce((sum, value) => sum + value, 0)
  return {
    n: samples.length,
    meanMs: Number((total / samples.length).toFixed(2)),
    minMs: Number(Math.min(...samples).toFixed(2)),
    maxMs: Number(Math.max(...samples).toFixed(2)),
  }
}

async function timed(action) {
  const startedAt = performance.now()
  await action()
  return performance.now() - startedAt
}

const root = await mkdtemp(join(tmpdir(), 'misen-officecli-benchmark-'))
try {
  await fixture(root)
  const client = new OfficeCliSpreadsheet()
  await client.ensureVersion()
  const tools = enterpriseTools(new WorkspaceBoundary(root), client)
  const byName = name => tools.find(tool => tool.name === name)
  const read = byName('spreadsheet_read')
  const create = byName('office_create_output')
  const update = byName('office_set')

  const readSamples = []
  for (let index = 0; index < 10; index++) readSamples.push(await timed(() => read.execute(`read-${index}`, { workbook: 'master.xlsx', sheet: 'Targets', range: 'A1:C4' }, undefined)))

  const createSamples = []
  for (let index = 0; index < 5; index++) createSamples.push(await timed(() => create.execute(`create-${index}`, { source: '月次管理レポート_template.xlsx', output: `output/create-${index}.xlsx` }, undefined)))

  await create.execute('create-update', { source: '月次管理レポート_template.xlsx', output: 'output/update.xlsx' }, undefined)
  const updateSamples = []
  for (let index = 0; index < 10; index++) updateSamples.push(await timed(() => update.execute(`update-${index}`, { file: 'output/update.xlsx', path: '/Report/B2', properties: { value: index % 2 === 0 ? 'July 2024' : 'August 2024', type: 'string' } }, undefined)))

  console.log(JSON.stringify({ engine: 'OfficeCLI', version: '1.0.147', read: summary(readSamples), create: summary(createSamples), update: summary(updateSamples) }, null, 2))
} finally {
  await rm(root, { recursive: true, force: true })
}
