import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { listHyperlinks, setHyperlink } from '@office-kit/xlsx/worksheet'

import { createEnterpriseCapabilityTools, WorkspaceBoundary } from '../../src/capabilities/index.js'
import {
  createSpreadsheet,
  openSpreadsheet,
  readSpreadsheetBytes,
  requireWorksheet,
  saveSpreadsheet,
  writeCell,
} from '../../src/spreadsheet/engine.js'

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function findTool(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find(candidate => candidate.name === name)
  if (tool === undefined) throw new Error(`missing capability tool ${name}`)
  return tool
}

async function callTool(tool: ToolDefinition, args: unknown): Promise<Record<string, unknown>> {
  const exec = { signal: new AbortController().signal } as ToolRunContext
  return await tool.execute(args, exec) as Record<string, unknown>
}

async function makeWorkbook(path: string, configure?: (workbook: ReturnType<typeof createSpreadsheet>) => void): Promise<void> {
  const workbook = createSpreadsheet(['Data'])
  writeCell(workbook, 'Data', 'A1', 'fixture')
  configure?.(workbook)
  await saveSpreadsheet(workbook, path)
}

test('spreadsheet capabilities reject external hyperlink and workbook relationship surfaces before create output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-external-create-'))
  try {
    await mkdir(join(root, 'inputs'), { recursive: true })
    const boundary = new WorkspaceBoundary(root)
    const create = findTool(createEnterpriseCapabilityTools(boundary), 'spreadsheet_create_output')
    const cases: ReadonlyArray<{ id: string; configure: (workbook: ReturnType<typeof createSpreadsheet>) => void }> = [
      {
        id: 'url-hyperlink',
        configure: workbook => setHyperlink(requireWorksheet(workbook, 'Data'), 'A1', { target: 'https://example.invalid/report' }),
      },
      {
        id: 'external-reference',
        configure: workbook => { workbook.externalReferences = [{ rId: 'rIdExternalLink' }] },
      },
      {
        id: 'external-links-passthrough',
        configure: workbook => { workbook.passthrough = new Map([['xl/externalLinks/externalLink1.xml', new TextEncoder().encode('<externalLink/>')]]) },
      },
      {
        id: 'connections-passthrough',
        configure: workbook => { workbook.passthrough = new Map([['xl/connections.xml', new TextEncoder().encode('<connections/>')]]) },
      },
      {
        id: 'external-link-relationship',
        configure: workbook => {
          workbook.workbookRelsExtras = [{
            id: 'rIdExternalLink',
            type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink',
            target: 'externalLinks/externalLink1.xml',
          }]
        },
      },
      {
        id: 'connections-relationship',
        configure: workbook => {
          workbook.workbookRelsExtras = [{
            id: 'rIdConnections',
            type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/connections',
            target: 'connections.xml',
          }]
        },
      },
      {
        id: 'query-table-relationship',
        configure: workbook => {
          requireWorksheet(workbook, 'Data').relsExtras = [{
            id: 'rIdQueryTable',
            type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/queryTable',
            target: 'queryTables/queryTable1.xml',
          }]
        },
      },
      {
        id: 'generic-external-url-relationship',
        configure: workbook => {
          workbook.workbookRelsExtras = [{
            id: 'rIdCustomUrl',
            type: 'urn:example:custom-relationship',
            target: 'https://example.invalid/external.bin',
          }]
        },
      },
      {
        id: 'generic-external-file-relationship',
        configure: workbook => {
          requireWorksheet(workbook, 'Data').relsExtras = [{
            id: 'rIdCustomFile',
            type: 'urn:example:custom-relationship',
            target: '\\\\server\\share\\external.bin',
          }]
        },
      },
    ]

    for (const { id, configure } of cases) {
      const sourcePath = join(root, 'inputs', `${id}.xlsx`)
      const outputRelative = `output/${id}.xlsx`
      await makeWorkbook(sourcePath, configure)
      const sourceHash = hash(await readSpreadsheetBytes(sourcePath))
      await assert.rejects(
        () => callTool(create, { source: `inputs/${id}.xlsx`, output: outputRelative }),
        /external|connection|querytable/iu,
        `${id} must be rejected`,
      )
      await assert.rejects(
        () => readFile(join(root, outputRelative)),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT',
        `${id} must not publish an output`,
      )
      assert.equal(hash(await readSpreadsheetBytes(sourcePath)), sourceHash, `${id} source must stay unchanged`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('spreadsheet capabilities reject external surfaces on update while preserving the existing output bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-external-update-'))
  try {
    await mkdir(join(root, 'inputs'), { recursive: true })
    const sourcePath = join(root, 'inputs', 'template.xlsx')
    await makeWorkbook(sourcePath)
    const boundary = new WorkspaceBoundary(root)
    const tools = createEnterpriseCapabilityTools(boundary)
    const create = findTool(tools, 'spreadsheet_create_output')
    const update = findTool(tools, 'spreadsheet_update')
    await callTool(create, { source: 'inputs/template.xlsx', output: 'output/report.xlsx' })

    const outputPath = join(root, 'output', 'report.xlsx')
    const outputWorkbook = await openSpreadsheet(outputPath)
    setHyperlink(requireWorksheet(outputWorkbook, 'Data'), 'A1', { target: 'https://example.invalid/report' })
    await saveSpreadsheet(outputWorkbook, outputPath)
    const outputHash = hash(await readFile(outputPath))
    await assert.rejects(
      () => callTool(update, {
        workbook: 'output/report.xlsx',
        sheet: 'Data',
        range: 'A1:A1',
        values: [['blocked']],
      }),
      /external hyperlink/iu,
    )
    assert.equal(hash(await readFile(outputPath)), outputHash, 'rejected update must preserve output bytes')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('location-only internal hyperlinks remain accepted and round-trip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'misen-internal-hyperlink-'))
  try {
    await mkdir(join(root, 'inputs'), { recursive: true })
    const sourcePath = join(root, 'inputs', 'internal.xlsx')
    await makeWorkbook(sourcePath, workbook => {
      setHyperlink(requireWorksheet(workbook, 'Data'), 'A1', { location: "'Data'!A1", display: 'jump' })
    })
    const boundary = new WorkspaceBoundary(root)
    const create = findTool(createEnterpriseCapabilityTools(boundary), 'spreadsheet_create_output')
    await callTool(create, { source: 'inputs/internal.xlsx', output: 'output/internal.xlsx' })
    const output = await openSpreadsheet(join(root, 'output', 'internal.xlsx'))
    const links = listHyperlinks(requireWorksheet(output, 'Data'))
    assert.equal(links.length, 1)
    assert.equal(links[0]?.target, undefined)
    assert.equal(links[0]?.location, "'Data'!A1")
    assert.equal(links[0]?.display, 'jump')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
