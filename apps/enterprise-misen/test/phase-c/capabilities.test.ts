import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { link as createHardLink, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'

import {
  createEnterpriseCapabilityTools,
  ENTERPRISE_CAPABILITY_TOOL_NAMES,
  ENTERPRISE_FORBIDDEN_TOOL_NAMES,
  registerEnterpriseCapabilities,
  WorkspaceBoundary,
} from '../../src/capabilities/index.js'
import { createPhaseAContext } from '../../src/runtime/phase-a.js'
import {
  createSpreadsheet,
  readSpreadsheetBytes,
  saveSpreadsheet,
  writeFormula,
  writeRangeValues,
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

async function makeWorkspace(): Promise<{ root: string; source: string; sourceHash: string }> {
  const root = await mkdtemp(join(tmpdir(), 'misen-phase-c-'))
  await mkdir(join(root, 'inputs'), { recursive: true })
  await mkdir(join(root, 'notes'), { recursive: true })
  await writeFile(join(root, 'notes', 'requirements.md'), '# Requirements\nread-only test\n', 'utf8')

  const source = join(root, 'inputs', 'template.xlsx')
  const workbook = createSpreadsheet(['Data'])
  writeRangeValues(workbook, 'Data', 'A1:C3', [
    ['Company', 'Revenue', 'Status'],
    ['Alpha', 10, 'open'],
    ['Beta', 20, 'closed'],
  ])
  await saveSpreadsheet(workbook, source)
  return { root, source, sourceHash: hash(await readSpreadsheetBytes(source)) }
}

test('Phase C exposes exactly the bounded general capability roster', async () => {
  const { root } = await makeWorkspace()
  try {
    const boundary = new WorkspaceBoundary(root)
    const tools = createEnterpriseCapabilityTools(boundary)
    assert.deepEqual(tools.map(tool => tool.name), [...ENTERPRISE_CAPABILITY_TOOL_NAMES])
    for (const forbidden of ENTERPRISE_FORBIDDEN_TOOL_NAMES) {
      assert.equal(tools.some(tool => tool.name === forbidden), false, `${forbidden} must not be exposed`)
    }

    const ctx = await createPhaseAContext()
    try {
      const dispose = registerEnterpriseCapabilities(ctx, boundary)
      try {
        assert.deepEqual(ctx.tools.schemas().map(({ name }) => name), [...ENTERPRISE_CAPABILITY_TOOL_NAMES])
      } finally {
        dispose()
      }
      assert.deepEqual(ctx.tools.schemas(), [])
    } finally {
      await ctx.fiber.dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Phase C enforces workspace-relative reads and rejects traversal, absolute, and escaping symlink paths', async t => {
  const { root } = await makeWorkspace()
  try {
    const boundary = new WorkspaceBoundary(root)
    const tools = createEnterpriseCapabilityTools(boundary)
    const list = findTool(tools, 'workspace_list_files')
    const read = findTool(tools, 'workspace_read_text')

    const rootListing = await callTool(list, { path: '.', extension: '.md' })
    assert.deepEqual(rootListing.files, [], 'workspace listing must not recurse into child directories')
    const listed = await callTool(list, { path: 'notes', extension: '.md' })
    assert.deepEqual(listed.files, ['notes/requirements.md'])
    const text = await callTool(read, { path: 'notes/requirements.md' })
    assert.match(String(text.text), /read-only test/u)

    await assert.rejects(() => callTool(read, { path: '../outside.txt' }), /workspace|relative|escape/iu)
    await assert.rejects(() => callTool(read, { path: resolve(root, 'notes', 'requirements.md') }), /absolute|relative/iu)

    const hardlinkSource = join(root, '..', `outside-${process.pid}-${Date.now()}.txt`)
    await writeFile(hardlinkSource, 'hardlink secret\n', 'utf8')
    try {
      await createHardLink(hardlinkSource, join(root, 'notes', 'hardlink.txt'))
      await assert.rejects(() => callTool(read, { path: 'notes/hardlink.txt' }), /hard-linked/iu)
    } finally {
      await rm(hardlinkSource, { force: true })
    }

    const outside = join(root, '..', 'misen-phase-c-outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'outside\n', 'utf8')
    const link = join(root, 'notes', 'outside-link')
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
      await assert.rejects(() => callTool(read, { path: 'notes/outside-link/secret.txt' }), /workspace|escape|symlink/iu)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES') throw error
      t.skip(`symlink creation is unavailable on this host (${code})`)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Phase C reads, creates, and batch-updates xlsx outputs without mutating inputs', async () => {
  const { root, source, sourceHash } = await makeWorkspace()
  try {
    const boundary = new WorkspaceBoundary(root)
    const tools = createEnterpriseCapabilityTools(boundary)
    const create = findTool(tools, 'spreadsheet_create_output')
    const read = findTool(tools, 'spreadsheet_read')
    const update = findTool(tools, 'spreadsheet_update')

    const created = await callTool(create, { source: 'inputs/template.xlsx', output: 'output/report.xlsx' })
    assert.equal(created.output, 'output/report.xlsx')
    assert.deepEqual(created.sheets, ['Data'])

    const before = await callTool(read, { workbook: 'output/report.xlsx', sheet: 'Data', range: 'A1:C3' })
    assert.deepEqual(before.values, [
      ['Company', 'Revenue', 'Status'],
      ['Alpha', 10, 'open'],
      ['Beta', 20, 'closed'],
    ])
    await assert.rejects(
      () => callTool(read, { workbook: 'output/report.xlsx', sheet: 'Data', range: 'A1:Z1000' }),
      /10000 cells/iu,
    )

    const changed = await callTool(update, {
      workbook: 'output/report.xlsx',
      sheet: 'Data',
      range: 'B2:C3',
      values: [[11, 'open'], [21, 'closed']],
    })
    assert.equal(changed.rows, 2)
    assert.equal(changed.columns, 2)

    await callTool(update, {
      workbook: 'output/report.xlsx',
      sheet: 'Data',
      range: 'D2:D2',
      values: [[{ kind: 'formula', formula: '=SUM(B2:B3)' }]],
    })
    const formulaRead = await callTool(read, { workbook: 'output/report.xlsx', sheet: 'Data', range: 'D2:D2' })
    assert.deepEqual(formulaRead.values, [[{ kind: 'formula', formula: '=SUM(B2:B3)' }]])
    for (const formula of [
      '=WEBSERVICE("https://example.invalid/probe")',
      '=[outside.xlsx]Sheet1!A1',
      "=cmd|' /C calc'!A0",
      '=UntrustedDefinedName',
    ]) {
      await assert.rejects(() => callTool(update, {
        workbook: 'output/report.xlsx',
        sheet: 'Data',
        range: 'D2:D2',
        values: [[{ kind: 'formula', formula }]],
      }), /formula|not allowed|external|network/iu)
    }
    await assert.rejects(() => callTool(update, {
      workbook: 'output/report.xlsx',
      sheet: 'Data',
      range: 'D2:D2',
      values: [[{ kind: 'formula', formula: '=SUM(B2:B3)', cachedValue: 32 }]],
    }), /cachedValue/iu)

    const after = await callTool(read, { workbook: 'output/report.xlsx', sheet: 'Data', range: 'A1:C3' })
    assert.deepEqual(after.values, [
      ['Company', 'Revenue', 'Status'],
      ['Alpha', 11, 'open'],
      ['Beta', 21, 'closed'],
    ])
    assert.equal(hash(await readSpreadsheetBytes(source)), sourceHash, 'source workbook must remain byte-identical')

    await assert.rejects(() => callTool(update, {
      workbook: 'inputs/template.xlsx',
      sheet: 'Data',
      range: 'A1',
      values: [['blocked']],
    }), /output/iu)
    await assert.rejects(() => callTool(create, { source: 'inputs/template.xlsx', output: 'output/report.txt' }), /xlsx/iu)
    await assert.rejects(() => callTool(create, { source: 'inputs/template.xlsx', output: 'output/../escape.xlsx' }), /output|workspace|escape/iu)

    const outsideWorkbook = join(root, '..', `outside-${process.pid}-${Date.now()}.xlsx`)
    const outside = createSpreadsheet(['Data'])
    writeRangeValues(outside, 'Data', 'A1:A1', [['outside']])
    await saveSpreadsheet(outside, outsideWorkbook)
    try {
      await createHardLink(outsideWorkbook, join(root, 'output', 'hardlinked.xlsx'))
      await assert.rejects(() => callTool(update, {
        workbook: 'output/hardlinked.xlsx',
        sheet: 'Data',
        range: 'A1:A1',
        values: [['blocked']],
      }), /hard-linked/iu)
    } finally {
      await rm(outsideWorkbook, { force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Phase C rejects unsafe formulas carried by source and existing output workbooks', async () => {
  const { root } = await makeWorkspace()
  try {
    const boundary = new WorkspaceBoundary(root)
    const tools = createEnterpriseCapabilityTools(boundary)
    const create = findTool(tools, 'spreadsheet_create_output')
    const update = findTool(tools, 'spreadsheet_update')

    await mkdir(join(root, 'output'), { recursive: true })
    const unsafeCases = [
      ['network', '=WEBSERVICE("https://example.invalid/probe")'],
      ['file-uri', '="file:///C:/sensitive.txt"'],
      ['external-workbook', "='[outside.xlsx]Sheet1'!A1"],
      ['cross-sheet', '=Sheet2!A1'],
      ['dde', "='cmd| /C calc'!A0"],
    ] as const

    for (const [id, formula] of unsafeCases) {
      const sourceRelative = `inputs/unsafe-${id}.xlsx`
      const unsafeSource = join(root, sourceRelative)
      const unsafeSourceWorkbook = createSpreadsheet(['Data'])
      writeRangeValues(unsafeSourceWorkbook, 'Data', 'A1:B2', [
        ['Value', 'Remote'],
        [10, null],
      ])
      writeFormula(unsafeSourceWorkbook, 'Data', 'B2', formula)
      await saveSpreadsheet(unsafeSourceWorkbook, unsafeSource)

      const copiedRelative = `output/unsafe-${id}-copy.xlsx`
      await assert.rejects(
        () => callTool(create, { source: sourceRelative, output: copiedRelative }),
        /unsafe existing formula|formula|network|external/iu,
      )
      await assert.rejects(
        () => readFile(join(root, copiedRelative)),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT',
        `${id} source formula must not publish an output`,
      )

      const outputRelative = `output/existing-unsafe-${id}.xlsx`
      const unsafeOutput = join(root, outputRelative)
      const unsafeOutputWorkbook = createSpreadsheet(['Data'])
      writeRangeValues(unsafeOutputWorkbook, 'Data', 'A1:B2', [
        ['Value', 'Remote'],
        [10, null],
      ])
      writeFormula(unsafeOutputWorkbook, 'Data', 'B2', formula)
      await saveSpreadsheet(unsafeOutputWorkbook, unsafeOutput)
      const unsafeOutputHash = hash(await readSpreadsheetBytes(unsafeOutput))

      await assert.rejects(
        () => callTool(update, {
          workbook: outputRelative,
          sheet: 'Data',
          range: 'A2:A2',
          values: [[11]],
        }),
        /unsafe existing formula|formula|network|external/iu,
      )
      assert.equal(
        hash(await readSpreadsheetBytes(unsafeOutput)),
        unsafeOutputHash,
        `${id} unsafe output must not be mutated`,
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
