# Third-party notices — Enterprise Misen initial PoC

The authoritative resolved versions, registry URLs, integrity hashes, and
dependency edges are in `package-lock.json`; `evidence/sbom.cdx.json` is the
production CycloneDX inventory. Dependency scripts are disabled by `.npmrc`.

## Direct runtime dependencies

| Component | Version | License | Unpacked size / files | Source |
| --- | --- | --- | ---: | --- |
| `@deepseek-ai/cordis` | 4.0.2 | MIT | 239,076 B / 32 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-agent` | 0.1.2-alpha.2 | MIT | 159,542 B / 25 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-agent-loop` | 0.1.2-alpha.2 | MIT | 97,298 B / 13 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-attachment` | 0.1.2-alpha.2 | MIT | 54,261 B / 21 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-authorization` | 0.1.2-alpha.2 | MIT | 70,504 B / 13 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-brand` | 0.1.2-alpha.2 | MIT | 13,356 B / 9 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-code-runtime` | 0.1.2-alpha.2 | MIT | 41,626 B / 10 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-credentials` | 0.1.2-alpha.2 | MIT | 63,575 B / 13 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-fs` | 0.1.2-alpha.2 | MIT | 45,420 B / 10 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-invariants` | 0.1.2-alpha.2 | MIT | 35,188 B / 9 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-launch-environment` | 0.1.2-alpha.2 | MIT | 21,533 B / 9 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-llm` | 0.1.2-alpha.2 | MIT | 321,053 B / 37 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-llm-pi-ai` | 0.1.2-alpha.2 | MIT | 210,413 B / 19 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-llm-retry` | 0.1.2-alpha.2 | MIT | 60,442 B / 17 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-scope` | 0.1.2-alpha.2 | MIT | 44,912 B / 11 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-sandbox` | 0.1.2-alpha.2 | MIT | 55,017 B / 11 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-session` | 0.1.2-alpha.2 | MIT | 274,466 B / 27 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-session-persistence` | 0.1.2-alpha.2 | MIT | 129,664 B / 14 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-session-projection` | 0.1.2-alpha.2 | MIT | 82,718 B / 13 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-settings` | 0.1.2-alpha.2 | MIT | 119,021 B / 15 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-system-prompt` | 0.1.2-alpha.2 | MIT | 56,671 B / 9 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-timeout` | 0.1.2-alpha.2 | MIT | 29,710 B / 9 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-tools` | 0.1.2-alpha.2 | MIT | 490,379 B / 27 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-typert-protocol` | 0.1.2-alpha.2 | MIT | 72,039 B / 15 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-user-approval` | 0.1.2-alpha.2 | MIT | 72,324 B / 13 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-util-values` | 0.1.2-alpha.2 | MIT | 22,110 B / 9 | https://github.com/deepseek-ai/deepseek-harness |
| `@office-kit/xlsx` | 0.9.0 | MIT | 2,913,466 B / 220 | https://github.com/office-kit/xlsx |

The live provider's resolved transitive package is
`@earendil-works/pi-ai@0.84.4` (MIT, 4,142,646 B / 746 files), sourced from
https://github.com/earendil-works/pi. Its provider SDK dependencies remain
registry-pinned in `package-lock.json`; they are used only through DSH's
standard adapter. The final production SBOM contains 131 unique package
versions from 132 installed production locations. Its SHA-256 is
`5510490db476cf21a8948c706c7d45cb08aeacc015943ad23c4c6016b654c288`;
the exact lockfile SHA-256 is
`ef961cc8d790f1ce9425c5128c8632099ee9e7781b8477fe7d3afcc34c779208`.

DSH provenance for the pinned alpha release: tag `dsh-v0.1.2-alpha.2`, commit
`0a53fb55bea101816fa226bb964ae2bed71c343b`.

## Resolved production transitive packages

DSH/Cordis additionally resolves `@deepseek-ai/cosmokit@1.8.3`,
`@deepseek-ai/dsh-util-crypto@0.1.2-alpha.2`,
`@deepseek-ai/schemastery@3.18.2`, `@standard-schema/spec@1.1.0`, and
`zod@4.5.4`. These packages are MIT. Several direct DSH packages in the table
are public peer/service contracts required by the standard provider graph;
they do not add model-facing capabilities beyond the separately audited
five-tool roster.

Office Kit resolves `fast-xml-parser@5.11.1`, `fflate@0.8.3`, and
`saxes@6.0.0`; their transitives are `@nodable/entities@3.0.0`,
`fast-xml-builder@1.3.1`, `is-unsafe@2.0.2`,
`path-expression-matcher@1.6.2`, `strnum@2.4.2`, `anynum@1.0.1`,
`xml-naming@0.3.0`, and `xmlchars@2.2.0`. All are MIT except Saxes, which is
ISC. Exact integrity values are retained in the lockfile/SBOM.

The npm tarballs for `@nodable/entities@3.0.0` and `saxes@6.0.0` do not carry
a standalone license file. Their upstream license texts are therefore retained
for redistribution in [`LICENSES/Nodable-entities-MIT.txt`](LICENSES/Nodable-entities-MIT.txt)
and [`LICENSES/saxes-ISC.txt`](LICENSES/saxes-ISC.txt).

Development-only dependencies are TypeScript 6.0.3 (Apache-2.0) and
`@types/node@24.13.3` (MIT). `dsh-attachment` is retained as a direct runtime
dependency because the standard `dsh-llm-pi-ai` package declares it as a
production peer. Misen mounts no attachment Tool or attachment capability in
the five-tool model-facing roster.

The installed exact graph declares two install hooks:
`@google/genai@1.52.0` has the inert preinstall command
`echo 'preinstall: no-op'`, and `protobufjs@7.6.6` has postinstall
`node scripts/postinstall`. Clean verification uses `npm ci --ignore-scripts`,
so neither hook executes. The deterministic audit fails if either declaration
changes or another hook appears. It found no `.node`, `.dll`, or `.exe`
artifact. Cordis and fast-xml-parser publish JavaScript CLI shims, but the Misen
runtime never invokes them.
