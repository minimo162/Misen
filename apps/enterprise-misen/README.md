# Enterprise Misen Pi demo

Run `npm ci --ignore-scripts`, then `npm test`. The deterministic replay uses Pi's public `Agent` and faux stream provider to exercise user, tool call, tool result, follow-up, and final response. `npm run live` uses the deployment-managed Brain profile in `%LOCALAPPDATA%\Misen\config\settings.json` (or `MISEN_SETTINGS_PATH`); see `docs/brain-profile.md`. The template's default profile is `openai` / `gpt-5.6-luna` / `thinkingLevel: 'medium'` with `maxRetries: 0` and no fallback.

## Tests

Tests are split into three tiers (Issue #93). The tier is chosen by file name under `test/`.

| command | what runs | needs | typical time |
| --- | --- | --- | --- |
| `npm test` / `npm run test:unit` | `*.test.ts` that are not integration or study | nothing (OfficeCLI is pointed at a non-existent sentinel so any accidental call fails) | under 10 s |
| `npm run test:integration` | `*.integration.test.ts` | `MISEN_OFFICECLI_PATH` pointing at the pinned OfficeCLI executable | a few minutes |
| `npm run test:live` | `acceptance/live.js` against the configured Brain | provider credential | manual only |
| `npm run test:study` | `*.study.test.ts` (Issue #73 frozen-study observer) | OfficeCLI | informational, see below |
| `npm run test:all` | unit + integration | OfficeCLI | |

`npm run build` is incremental: it hashes `src/`, `test/`, `acceptance/`, `study/`, `demo/`, `tsconfig.json`, the lockfile and the client bundler, and skips `tsc` and the client bundle when nothing changed since the last successful build (`dist/.build-stamp.json`). Compiled tests whose source was removed or renamed are pruned. Use `npm run build:force` to rebuild anyway, or `npm run clean` to delete `dist/`.

To obtain OfficeCLI for the integration tier:

```powershell
npm run acquire:officecli-runtime -- --output C:\staging\misen-officecli-v1.0.147
$env:MISEN_OFFICECLI_PATH = 'C:\staging\misen-officecli-v1.0.147\officecli.exe'
npm run test:integration
```

The study tier asserts the frozen fixture digest of the Issue #73 reliability study. That digest predates the OfficeCLI migration (#89), so the tier currently fails on `main`; it is kept out of `test:unit` and `test:integration` on purpose because #73 is frozen and must not be edited in unrelated work.

The loopback-only demo is `npm run demo -- C:\absolute\workspace`. Its React conversation surface is built entirely from `@assistant-ui/react` headless primitives over the External Store Runtime: conversation messages, Tool activity (`tool-call` parts folded by `ToolGroup`), validated artifacts (`metadata.custom.artifacts`), running/error status (`MessagePrimitive.Error`), Stop (`ComposerPrimitive.Cancel`), and the local-only conversation history (`ThreadListPrimitive` with `adapters.threadList`) are all derived from one `ThreadStore` that a pure reducer (`src/web/thread-store.ts`) folds SSE events into. It has no model picker, terminal, plugins, settings, shell, Web/MCP, arbitrary browser path, Assistant Cloud configuration, or raw reasoning/provider display. Downloads are restricted to `output/` through the workspace boundary.

PDF files are handled by `pdf_read` (pdf.js text and metadata), `pdf_render` (PDFium WebAssembly, one page at a time) and `pdf_create_output` (pdf-lib copy / merge / extract below `output/`); see `docs/pdf.md`. `prepare-runtime` installs production dependencies with `--omit=optional` so pdf.js's optional native canvas is never bundled.

Misen is the security root for Capability, Resource, Mutation, Secret/Network, and High-impact side effect authority. Pi permissions do not replace those controls. Side effects are absent and fail closed by the fixed tool allowlist (`ENTERPRISE_TOOL_NAMES` in `src/capabilities/tools.ts`).
