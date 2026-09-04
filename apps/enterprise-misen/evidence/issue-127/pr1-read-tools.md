# Issue #127 PR1: E+B read Tool evidence

## Scope

- E: `workspace_list_files {}` is valid and defaults to `.`. Omitted `path` returns a bounded recursive tree.
- B: a missing folder returns real sibling folder candidates. `spreadsheet_read` and xlsx `office_get` return the sheet list and first-sheet values in one Tool result.
- A/C/F/D are intentionally outside this first PR.

## Operation counts and arguments

The first request's before sequence is the eight-call production log attached to Issue #127. The other two before counts are the estimates in the Issue body; their raw per-call logs were not supplied. The after column is a provider-free capability-path measurement: it records the minimum Tool calls now sufficient for the request, not an autonomous Brain run. No paid or live provider request was made.

| Request | Before | After E+B | After arguments |
| --- | ---: | ---: | --- |
| 7月の Alpha.xlsx の売上を教えて | 8 | 1 | `spreadsheet_read {"workbook":"7月/Alpha.xlsx"}` |
| 7月と8月の Alpha.xlsx の売上合計をそれぞれ | 8–9 | 2 | `spreadsheet_read {"workbook":"7月/Alpha.xlsx"}`; `spreadsheet_read {"workbook":"8月/Alpha.xlsx"}` |
| テンプレートで 8月の月次レポートを output に | 約20 | 8 | 下表 |

The bounded eight-call report path is:

| # | Tool | Arguments |
| ---: | --- | --- |
| 1 | `workspace_list_files` | `{}` |
| 2 | `spreadsheet_read` | `{"workbook":"8月/Alpha.xlsx"}` |
| 3 | `spreadsheet_read` | `{"workbook":"8月/Beta.xlsx"}` |
| 4 | `spreadsheet_read` | `{"workbook":"8月/Gamma.xlsx"}` |
| 5 | `spreadsheet_read` | `{"workbook":"master.xlsx"}` |
| 6 | `office_create_output` | `{"source":"月次管理レポート_template.xlsx","output":"output/8月-月次管理レポート.xlsx"}` |
| 7 | `office_batch` | `{"file":"output/8月-月次管理レポート.xlsx","items":"月・3社値・式・合計の bounded batch"}` |
| 8 | `office_inspect` | `{"file":"output/8月-月次管理レポート.xlsx","mode":"validate"}` |

The exact eight production calls supplied for the first request were:

1. `workspace_list_files {}` → failed
2. `workspace_list_files {"path":"."}`
3. `workspace_list_files {"path":"."}`
4. `workspace_read_text {"path":".agents/skills/monthly-report/SKILL.md"}`
5. `workspace_read_text {"path":"業務引継ぎ.md"}`
6. `spreadsheet_read {"workbook":"master.xlsx"}` → unrelated
7. `workspace_list_files {"path":"7月"}`
8. `spreadsheet_read {"workbook":"7月/Alpha.xlsx"}`

## Verification

- `npm run test:unit -- --force-build`: 107 PASS, 0 FAIL, 3 Windows EPERM SKIP.
- Unit tier: 8.69 seconds; total including forced build: 11.09 seconds. The 30-second gate remains satisfied.
- New tests cover omitted path, recursive listing, 300-entry truncation, sibling candidates, `spreadsheet_read`, and xlsx `office_get` defaults.
- A/C の先読み自体は後続 PR の対象であり、この PR では先読み上限テストは未適用です。
- The host has no pinned OfficeCLI executable, so real OfficeCLI integration is unverified in this PR. The read contract is tested with deterministic OfficeCLI-compatible JSON and an independently valid minimal xlsx package.
