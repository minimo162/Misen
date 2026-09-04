# Issue #127 PR3: F session read cache evidence

## Scope

- A session-local gateway wraps the approved Tool roster immediately before execution because #98 has no implemented common gateway in this tree.
- Identical read Tool name plus canonicalized arguments reuses the preceding successful result. Failed reads are not cached.
- Any write Tool execution clears every read entry before mutation. A blocked Tool never reaches this gateway and therefore does not invalidate the cache.
- Cached results carry `cached: true` through Pi events, local session persistence, the metadata-only JSONL audit, and the Japanese UI label `同じ結果を再利用`.

## Operation counts and arguments

The first before sequence is the eight-call production log attached to Issue #127. The other before counts are Issue estimates because raw per-call logs were not supplied. The after column is a provider-free capability-path measurement; repeated identical reads additionally avoid physical Tool execution through the cache. No paid/live autonomous Brain run was made.

| Request | Before | After A–C+E+B+F | After arguments |
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

- `npm run test:unit -- --force-build`: 115 PASS, 0 FAIL, 3 Windows EPERM SKIP.
- Unit tier: 8.73 seconds; total including forced build: 12.70 seconds. The 30-second gate remains satisfied.
- Tests cover canonical argument ordering, same-session hits, cross-session isolation, failed-read retry, write invalidation, `cached: true` persistence/audit, and the Japanese reuse label.
- The startup-preload limit tests introduced by PR2 remain in the full unit suite.
- Real provider operation counts remain unverified.
