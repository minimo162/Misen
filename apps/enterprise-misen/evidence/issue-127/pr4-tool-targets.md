# Issue #127 PR4: D Tool target event evidence

## Scope

- Tool start events now carry the safe workspace-relative target path, not only a basename.
- The target survives SSE folding and local session persistence into the thread-store Tool part arguments.
- Absolute paths and parent traversal are omitted. UI label composition is intentionally deferred to #105.

## Operation counts and arguments

The first before sequence is the eight-call production log attached to Issue #127. The other before counts are Issue estimates because raw per-call logs were not supplied. The after column is a provider-free capability-path measurement, not a paid/live autonomous Brain run.

| Request | Before | After Issue #127 | After arguments |
| --- | ---: | ---: | --- |
| 7月の Alpha.xlsx の売上を教えて | 8 | 1 | `spreadsheet_read {"workbook":"7月/Alpha.xlsx"}` |
| 7月と8月の Alpha.xlsx の売上合計をそれぞれ | 8–9 | 2 | `spreadsheet_read {"workbook":"7月/Alpha.xlsx"}`; `spreadsheet_read {"workbook":"8月/Alpha.xlsx"}` |
| テンプレートで 8月の月次レポートを output に | 約20 | 8 | 下表 |

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

## Verification

- `npm run test:unit -- --force-build`: 116 PASS, 0 FAIL, 3 Windows EPERM SKIP.
- Unit tier: 8.97 seconds; total including forced build: 12.98 seconds. The 30-second gate remains satisfied.
- Tests cover full Japanese relative targets, output targets, traversal/absolute-path omission, SSE transport, persistence, and thread-store projection.
- The startup-preload omission tests and cache invalidation/audit tests remain in the full suite.
- Real provider operation counts remain unverified.
