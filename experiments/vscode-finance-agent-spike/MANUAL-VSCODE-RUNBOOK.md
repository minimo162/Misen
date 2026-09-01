# Manual VS Code endpoint and Agent runbook

This runbook is for VS Code 1.135.0 on the Issue #77 home development PC. It
keeps API-key entry human-controlled and uses the official Local Agent harness.

## Endpoint setup

1. Open only the prepared July `workspace` folder in VS Code. Do not open its
   parent directory or the Git repository suggested by the Git extension.
2. If the welcome dialog appears, choose **Continue without Signing In**.
3. Open the Command Palette and run **Chat: Manage Language Models**.
4. Choose **Add Models** and then **Custom Endpoint**.
5. Select the endpoint format implemented by the development endpoint:
   OpenAI Responses or OpenAI Chat Completions. Do not guess between them.
6. Enter the development endpoint URL, model identifier, and display name.
   Declare Tool Calling only if the model and endpoint actually implement it.
7. Enter the API key only through the VS Code secret-input prompt. Do not put
   the value in the repository, workspace settings, terminal, chat, screenshot,
   Issue, PR, or log.
8. Save the model and confirm that it appears in the Chat model picker while
   the role is **Agent** and the session target is **Local**.

If the model does not appear for Agent, or a minimal Agent prompt cannot call a
built-in tool, stop and report the exact non-secret error. Do not add a proxy,
extension patch, compatibility bridge, or undocumented setting.

## July run after endpoint setup

1. Keep only the July `workspace` folder open.
2. Select **Local**, **Agent**, and the configured Custom Endpoint model.
3. Send exactly:

   `7月の3社実績を取りまとめて、月次管理レポートを完成させて`

4. Approve only workspace-scoped file work and commands needed to run
   `node scripts/finance-xlsx.mjs ...`. Deny requests for other directories,
   unrelated commands, or unrelated network access.
5. Record start/end time, approvals, retries, the final response, and the main
   commands/tools used. Do not paste hidden reasoning or credentials.
6. Do not rerun on failure. Preserve the workspace for external validation.

The August run uses its separately prepared fresh `workspace` and the exact
prompt:

`8月の3社実績を取りまとめて、月次管理レポートを完成させて`

Run each month once only. These are feasibility observations, not Issue #73's
formal reliability sample.
