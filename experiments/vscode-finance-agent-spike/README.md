# VS Code Finance Agent feasibility spike

This experiment supports Issue #77. It tests whether the standard VS Code
Local Agent harness, an official project Skill, and one deterministic XLSX
helper can complete the same synthetic July/August task as Enterprise Misen.

The directory is split deliberately:

- `workspace-template/` is copied into a fresh run directory and opened as the
  VS Code workspace. Its scoped `AGENTS.md` does not affect the repository.
- `harness.mjs` is operator-only preparation and acceptance code. Keep the
  generated run's parent directory and manifest out of the VS Code workspace.
- The existing Decision 441 validator remains a comparison oracle only. It is
  not part of the Finance Skill or a proposed production validator.

No custom extension, Agent runtime, chat UI, endpoint proxy, or authentication
bridge is introduced by this experiment.

## Operator commands

Build the existing Enterprise Misen package first so the synthetic fixture and
Decision 441 oracle are available:

```powershell
Set-Location apps/enterprise-misen
npm ci
npm run build
```

From the repository root, prepare a new run whose target path does not exist:

```powershell
node experiments/vscode-finance-agent-spike/harness.mjs prepare july .tmp/issue-77/july
node experiments/vscode-finance-agent-spike/harness.mjs prepare august .tmp/issue-77/august
```

Open only `<run>/workspace` in VS Code. Do not open the parent directory. After
the Agent run, validate from outside the workspace:

```powershell
node experiments/vscode-finance-agent-spike/harness.mjs validate july .tmp/issue-77/july
```

Run the deterministic preparation/helper/oracle regression for both months:

```powershell
node experiments/vscode-finance-agent-spike/test.mjs
```

The exact user prompts remain the Decision 441 prompts:

- July: `7月の3社実績を取りまとめて、月次管理レポートを完成させて`
- August: `8月の3社実績を取りまとめて、月次管理レポートを完成させて`

