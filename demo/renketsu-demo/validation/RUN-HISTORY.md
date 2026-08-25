# Validation run history

| Run | Reached | Result / cause | Fix before next run |
| --- | --- | --- | --- |
| 1 `run-mt968erb-83izr` | 0 model turns; bootstrap only | Failed: persisted old session kept the pre-change system prompt and input verification stopped at position 114. | `Record-Demo.ps1` and manual validation now create a fresh session through `POST /api/sessions`. |
| 2 `run-mt96wjs2-pm2r7` | 11 model decisions; 9 host-tool successes | Failed: after successful report/xlsx reads, the model repeatedly read `Update-Ledger.ps1`, never wrote extraction JSON, then falsely answered that host tools were unavailable. | Strengthen `config.demo.json`: prohibit reading tool sources/ledger, force wildcard Read-Xlsx once, immediate extraction write, and forbid false unavailable answers after successful tool results. |
