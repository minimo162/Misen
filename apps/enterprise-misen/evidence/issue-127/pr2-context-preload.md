# Issue #127 PR2: A+C startup context evidence

## Scope

- The session prompt preloads a bounded workspace tree, root `AGENTS.md`, Skill bodies, and directly referenced relative documents.
- Every workspace-supplied value remains an identified JSON data envelope and untrusted guidance.
- Tree: 300 entries / 16 KiB. Skill bodies: 8 KiB each / 32 KiB total. Referenced documents: 32 KiB total. Omitted content is explicit.
- The two existing Misen Security Authority sentences are unchanged. The base prompt now directs the Brain to read only necessary files and use a Skill only for user-requested applicable work.

## Operation counts and arguments

The first before sequence is the eight-call production log attached to Issue #127. The other before counts are Issue estimates because raw per-call logs were not supplied. The after column is a provider-free capability-path measurement, not a paid/live autonomous Brain run.

| Request | Before | After A–C+E+B | After arguments |
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

The exact first-request before sequence remains recorded in `pr1-read-tools.md`.

## Verification

- `npm run test:unit`: 110 PASS, 0 FAIL, 3 Windows EPERM SKIP.
- Unit tier: 8.50 seconds; total including build: 10.89 seconds. The 30-second gate remains satisfied.
- Tests cover tree count and serialized-size truncation, Skill per-item and aggregate omission, referenced-document aggregate omission, one-level reference behavior, `.agents`/`output` visibility, unchanged authority, and absence of read guidance for preloaded Skill bodies.
- Real provider operation counts remain unverified; no paid/live provider request was made.
