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
| `@deepseek-ai/dsh-llm` | 0.1.2-alpha.2 | MIT | 321,053 B / 37 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-session` | 0.1.2-alpha.2 | MIT | 274,466 B / 27 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-session-projection` | 0.1.2-alpha.2 | MIT | 82,718 B / 13 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-system-prompt` | 0.1.2-alpha.2 | MIT | 56,671 B / 9 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-tools` | 0.1.2-alpha.2 | MIT | 490,379 B / 27 | https://github.com/deepseek-ai/deepseek-harness |
| `@deepseek-ai/dsh-util-values` | 0.1.2-alpha.2 | MIT | 22,110 B / 9 | https://github.com/deepseek-ai/deepseek-harness |
| `@office-kit/xlsx` | 0.9.0 | MIT | 2,913,466 B / 220 | https://github.com/office-kit/xlsx |

DSH provenance for the pinned alpha release: tag `dsh-v0.1.2-alpha.2`, commit
`0a53fb55bea101816fa226bb964ae2bed71c343b`.

## Resolved production transitive packages

DSH/Cordis resolves `@deepseek-ai/cosmokit@1.8.3`, the DSH `brand`,
`code-runtime` contract, `invariants`, `scope`, `session-persistence` contract,
`settings`, `timeout`, `typert-protocol`, `user-approval`, `util-crypto`,
`schemastery@3.18.2`, `@standard-schema/spec@1.1.0`, and `zod@4.5.4`.
These packages are MIT. The code-runtime/persistence/settings contracts are
dependency types only and are not mounted as model-facing runtime services.

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

Development-only dependencies are `@deepseek-ai/dsh-attachment@0.1.2-alpha.2`
(MIT, 54,261 B / 21 files), TypeScript 6.0.3 (Apache-2.0),
`@types/node@24.13.3` (MIT), and `undici-types@7.18.2` (MIT). The attachment
package satisfies the published `dsh-llm` declaration imports during strict
TypeScript compilation; it is absent from production source and the production
SBOM.

No dependency in the installed exact graph declares preinstall/install/
postinstall, and the deterministic audit found no `.node`, `.dll`, or `.exe`
artifact. Cordis and fast-xml-parser publish JavaScript CLI shims, but the Misen
runtime never invokes them.
