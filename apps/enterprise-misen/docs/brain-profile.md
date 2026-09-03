# Deployment-managed Brain profile

Issue #93 B, aligned with the Issue #86 "replaceable Brain boundary" principle:

> Brain is replaceable by deployment configuration, but Brain routing is not model-controlled and
> not arbitrary-user-controlled.

## Where the profile lives

One per-user file, never on the share and never in the package:

```text
%LOCALAPPDATA%\Misen\config\settings.json
```

`launcher/launch.ps1` passes the path to the server through `MISEN_SETTINGS_PATH`. On the first
start the launcher writes the commented template (`SETTINGS_TEMPLATE` in
`src/runtime/brain-profile.ts`), opens it in Notepad, and stops with a Japanese message. The user
fills in the file and double-clicks `Misen起動.cmd` again. We chose the template-and-stop path over
a Web UI settings page because #86 rules out a credential storage UI and any route that carries the
secret through the browser or HTTP; a file the user owns under their own profile is the smallest
deployment-managed boundary that works offline.

## Shape

```jsonc
{
  "schema": "misen-settings/1",
  "brain": {
    "provider": "openai",              // "openai" | "anthropic" | "openai-compatible"
    "model": "gpt-5.6-luna",           // catalog id for official providers, any id for openai-compatible
    "apiKey": "sk-...",                // or { "env": "OPENAI_API_KEY" } for a deployment-injected variable
    "baseUrl": "http://127.0.0.1:11434/v1", // openai-compatible only (required there, rejected elsewhere)
    "thinkingLevel": "medium",         // optional
    "contextWindow": 32768,            // openai-compatible only, optional
    "maxTokens": 8192                  // openai-compatible only, optional
  }
}
```

Rules enforced by `parseBrainSettings` (all failures are `BrainProfileError` with Japanese text and
never include the key):

- exactly one provider and one model; unknown keys, unknown providers, and placeholder keys fail closed;
- official providers (`openai`, `anthropic`) only accept models from Pi's official catalog and only use
  the official endpoint (`baseUrl` is rejected);
- `openai-compatible` requires an `http`/`https` `baseUrl` without userinfo, query, or fragment;
- `apiKey` is required for official providers; an `openai-compatible` endpoint may be keyless, in which
  case the fixed, non-secret token `misen-no-credential` is sent because Pi refuses to run without one;
- `{ "env": "NAME" }` resolves at load time and fails before any provider request when the variable is unset.

## How the runtime uses it

`createBrain(profile)` (`src/runtime/brain.ts`) composes one Pi provider through the public
`createProvider` seam with a credential resolver that reads only the profile. Ambient environment
variables such as `OPENAI_API_KEY` are never consulted, so a stale key on the machine can never be
used silently. `liveAgent` (`src/runtime/live.ts`) passes the key to Pi only through `getApiKey`,
keeps `maxRetries: 0`, and has no fallback provider or model. The current `openai/gpt-5.6-luna`
behaviour is the template's default profile, no longer a source-coded constant.

The exact tool roster (`ENTERPRISE_TOOL_NAMES`), `WorkspaceBoundary`, the mutation and safe-formula
guards, the typed hooks, and the Security Authority prompt are untouched by the profile.

## Secret boundary

The credential is held behind a non-enumerable closure on the frozen profile, so
`JSON.stringify(profile)`, `describeBrainProfile(profile)` (the audit identity), error messages,
Agent state, SSE events, session files, and `settings-cli.js` output cannot contain it. The tests in
`test/brain-profile.test.ts` and `test/brain-live.test.ts` assert this with a loopback fake
OpenAI-compatible server: the key appears exactly once, in the `Authorization` header of the one
provider request, and a hostile prompt asking to change `baseUrl`/`model` reaches the Brain only as
user text. `launcher/test/launch.test.mjs` asserts that the share tree never gains a settings file.

## Operator commands

```text
node app\dist\src\runtime\settings-cli.js ensure --settings <path>   # template when missing (exit 3), else validate
node app\dist\src\runtime\settings-cli.js check  --settings <path>   # validate only (exit 4 on problems)
```

`npm run live` and `npm run study:live` use the same profile through `liveAgent`; set
`MISEN_SETTINGS_PATH` to point them at a specific settings file.
