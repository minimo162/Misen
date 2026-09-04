import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFrozenFixtureWorkbook } from './fixture-workbooks.js'

/**
 * Synthetic-only fixture data for the first Excel vertical slice.
 *
 * The OfficeKit-era workbook bytes are frozen verbatim so changing the Office
 * engine cannot weaken or silently rewrite the July/August business fixtures.
 */
export interface CompanyFixture {
  readonly company: string
  readonly revenue: number
  readonly cost: number
  readonly asOf: string
}

export interface MonthFixture {
  readonly month: string
  readonly companies: readonly CompanyFixture[]
}

export const SYNTHETIC_MONTHS: readonly MonthFixture[] = Object.freeze([
  {
    month: '7月',
    companies: [
      { company: 'Alpha', revenue: 1200, cost: 700, asOf: '2024-07-31' },
      { company: 'Beta', revenue: 950, cost: 500, asOf: '2024-07-31' },
      { company: 'Gamma', revenue: 1100, cost: 650, asOf: '2024-07-31' },
    ],
  },
  {
    month: '8月',
    companies: [
      { company: 'Alpha', revenue: 1300, cost: 760, asOf: '2024-08-31' },
      { company: 'Beta', revenue: 1020, cost: 560, asOf: '2024-08-31' },
      { company: 'Gamma', revenue: 1150, cost: 690, asOf: '2024-08-31' },
    ],
  },
])

export const SYNTHETIC_TARGETS: Readonly<Record<string, number>> = Object.freeze({
  Alpha: 400,
  Beta: 455,
  Gamma: 380,
})

const HANDOFF = `# Monthly management report handoff

## Task purpose

Complete a monthly management report from three company actuals workbooks.
The report is a synthetic technical PoC for a capability-constrained local
agent; it is not a production finance policy.

## Input workbook roles

- Each workbook under a month directory is one company's actuals workbook.
  Its **Actuals** sheet contains the company name, revenue, cost, and as-of date.
- **master.xlsx** contains the company-level minimum profit targets.
- **月次管理レポート_template.xlsx** supplies the output layout
  and formatting.

## Normal business rules

- Profit is revenue minus cost.
- A company is **On target** when profit is at least its master target;
  otherwise its status is **Review**.
- Source workbooks are read-only inputs. The completed report is written under
  the output directory.

## Output template meaning

The report sheet lists each discovered company with revenue, cost, a local
spreadsheet formula, and status. The total row uses formulas over the company rows;
the template footer and existing styles must remain intact.

## Completion criteria

- All three company workbooks are represented.
- Values, formulas, number formats, and template styling are preserved in the
  newly saved output workbook.
- Input workbook hashes are unchanged.
- The same behavior works for both July and August fixture directories without
  changing the runtime code, system prompt, or tool implementation.
`

const WORKSPACE_INSTRUCTIONS = `# Enterprise Finance Workspace

- Treat source workbooks as read-only inputs.
- Inspect Office structure with office_get (use depth when children matter) and office_query before choosing a path or selector to edit.
- Create deliverables with office_create_output, then modify only files under output with office_set, office_add, office_remove, office_move, office_swap, office_batch, or office_import.
- Use OfficeCLI element paths, selectors, element types, and string properties. A batch may contain at most 200 items.
- Run office_inspect with validate before reporting completion. Never overwrite a source file.
- Do not reveal credentials or claim that a failed check passed.
`

const MONTHLY_REPORT_SKILL = `---
name: monthly-report
description: Create and verify the synthetic July or August monthly management report from company actuals, master targets, and the approved workbook template.
---

# Monthly management report

Use this Skill when the user asks for the synthetic monthly management report.

- Each company workbook provides company, revenue, cost, and reporting date.
- The master workbook provides the minimum profit target for each company.
- Profit is revenue minus cost. Status is On target when profit meets or exceeds the company's target; otherwise it is Review.
- Inspect the template with office_get --depth and office_query before editing. Use OfficeCLI paths such as /Report/A5 and selectors such as cell:has(formula).
- Copy the approved template with office_create_output, then use office_set or an atomic office_batch (at most 200 items) for values, formulas, and formatting.
- Preserve the footer, styles, and number formats. Use spreadsheet formulas for row profit and totals.
- Write only under output and finish with office_inspect mode=validate plus office_get readback of the changed ranges.

This Skill is business guidance. It does not grant tools, process execution, network access, or permission to mutate input files.
`

/**
 * Create the complete synthetic workspace used by the vertical-slice tests.
 * Existing files are overwritten only at these explicitly named fixture paths;
 * no arbitrary workspace path is touched and no child process is started.
 */
export async function createEnterpriseFixtureWorkspace(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
  await mkdir(join(root, 'output'), { recursive: true })
  await mkdir(join(root, '.agents', 'skills', 'monthly-report'), { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), WORKSPACE_INSTRUCTIONS, 'utf8')
  await writeFile(join(root, '.agents', 'skills', 'monthly-report', 'SKILL.md'), MONTHLY_REPORT_SKILL, 'utf8')
  await writeFile(join(root, '業務引継ぎ.md'), HANDOFF, 'utf8')
  await writeFrozenFixtureWorkbook(join(root, 'master.xlsx'), 'master.xlsx')
  await writeFrozenFixtureWorkbook(join(root, '月次管理レポート_template.xlsx'), '月次管理レポート_template.xlsx')

  for (const month of SYNTHETIC_MONTHS) {
    const monthDirectory = join(root, month.month)
    await mkdir(monthDirectory, { recursive: true })
    for (const company of month.companies) {
      await writeFrozenFixtureWorkbook(join(monthDirectory, `${company.company}.xlsx`), `${month.month}/${company.company}.xlsx`)
    }
  }
}

export const HANDOFF_MARKERS = Object.freeze([
  'Task purpose',
  'Input workbook roles',
  'Normal business rules',
  'Output template meaning',
  'Completion criteria',
])

/** Compatibility exports used by the Pi replay and independent acceptance. */
export const MONTHS = SYNTHETIC_MONTHS
export const PROMPTS = Object.freeze({
  '7月': '7月の3社実績を取りまとめて、月次管理レポートを完成させて',
  '8月': '8月の3社実績を取りまとめて、月次管理レポートを完成させて',
})
export const fixture = createEnterpriseFixtureWorkspace
