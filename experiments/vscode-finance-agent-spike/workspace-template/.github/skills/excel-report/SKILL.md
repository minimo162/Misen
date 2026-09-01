---
name: excel-report
description: Complete the synthetic monthly management report from company actuals, master targets, and the supplied XLSX template without changing inputs.
---

# Monthly management report

Use this Skill when the user asks to complete the monthly management report in
this workspace.

## Business meaning

- The requested month directory contains one `Actuals` workbook per company.
- `master.xlsx` maps each company to its minimum profit target.
- `月次管理レポート_template.xlsx` defines the report sheet, layout,
  formatting, and footer.
- Profit is Revenue minus Cost.
- Status is `On target` when Profit is greater than or equal to that company's
  master target; otherwise it is `Review`.
- Put each discovered company on one report row with its associated Revenue and
  Cost. Profit must be a local spreadsheet formula on that row.
- Revenue, Cost, and Profit totals must be spreadsheet formulas over the actual
  company rows.
- The Month value must identify the requested reporting month.

## Deliverable contract

- Save exactly one new `.xlsx` deliverable under `output/`.
- Do not change source workbooks or the template.
- Preserve the template sheet, footer, styles, number formats, row heights, and
  column widths.
- Do not add unrelated sheets or content.
- Verify that the saved workbook is readable before claiming success.

## Available deterministic XLSX helper

`scripts/finance-xlsx.mjs` is a narrow binary-workbook adapter built on
`@office-kit/xlsx`. It is not an Agent runtime or a general-purpose Finance
tool API.

It can:

- inspect the populated cells of the workbooks visible in this workspace;
- build a report from a JSON plan you author from the discovered business data;
- reopen a candidate output and summarize it for verification.

Run `node scripts/finance-xlsx.mjs help` for its exact interface. Choose the
commands needed for the task; the Skill does not prescribe a fixed tool-call
sequence. The build command rejects plans outside the workspace, output paths
outside `output/`, existing outputs, duplicate companies, and invalid numeric
data. It derives status from each supplied target and the business rule.
