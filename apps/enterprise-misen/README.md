# Enterprise Misen Pi demo

Run `npm ci --ignore-scripts`, then `npm run acceptance`. The deterministic replay uses Pi's public `Agent` and faux stream provider to exercise user, tool call, tool result, follow-up, and final response. `npm run live` requires `OPENAI_API_KEY`; it uses only `openaiProvider`, `gpt-5.6-luna`, and `thinkingLevel: 'medium'`.

The loopback-only demo is `npm run demo -- C:\absolute\workspace`. Its React conversation surface is built from assistant-ui External Store primitives and Misen-owned SSE state. It has no model picker, terminal, plugins, settings, shell, Web/MCP, arbitrary browser path, Assistant Cloud configuration, or raw reasoning/provider display. Downloads are restricted to `output/` through the workspace boundary.

Misen is the security root for Capability, Resource, Mutation, Secret/Network, and High-impact side effect authority. Pi permissions do not replace those controls. Side effects are absent and fail closed by the five-tool allowlist.
