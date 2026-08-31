# Enterprise Excel vertical-slice fixture

This directory contains the dummy-only July/August workspaces used by the
independent Phase D acceptance. `fixtures.ts` creates a complete workspace
with:

```text
<workspace>/
  業務引継ぎ.md
  master.xlsx
  月次管理レポート_template.xlsx
  7月/Alpha.xlsx
      /Beta.xlsx
      /Gamma.xlsx
  8月/Alpha.xlsx
      /Beta.xlsx
      /Gamma.xlsx
  output/
```

The fixture generator is development/test data only. It uses the pinned
`@office-kit/xlsx` API in-process and does not start a child process or access a
network. Source workbooks are never used as output destinations.

The business handoff describes the purpose, workbook roles, normal rules,
template meaning, and completion criteria. It deliberately does not prescribe
the order of Agent tool calls. The deterministic Phase D replay uses the public
tools to discover the three workbook files and processes either month through
the same scripted Agent Loop path. This is mechanical evidence; live Brain
autonomy and generalization remain NOT RUN.
