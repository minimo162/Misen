# Self-contained prepared runtime

The prepared runtime is assembled on a development or packaging host. A target
user does not install Node.js: the package contains a private, pinned Node.js
runtime used only by Misen. Startup does not modify `PATH`, install system-wide
software, download or update a runtime, build TypeScript, or invoke a PowerShell
fallback.

## Frozen product and runtime inputs

The current free-form bounded Agent source and production-behavior baseline are:

`4eef951bb4f37735dcac2800ccf38a6add5d08e1`

The earlier Thin Misen behavior lineage remains recorded as:

`f3b772f7765206f75f7296e436d89c6a771b690a`

The package bundles exactly the official Node.js v24.20.0 LTS (Krypton) Windows
x64 runtime input:

- archive: `node-v24.20.0-win-x64.zip`
- release: `https://nodejs.org/dist/v24.20.0/`
- archive SHA-256: `6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba`
- `node.exe` SHA-256: `5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5`
- `LICENSE` SHA-256: `ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9`

These values are exact pins from the official release SHASUMS. Floating `lts`,
`24`, `current`, or `latest` identities are not accepted.

## Build-time acquisition boundary

Acquire and verify the Node input separately from package assembly:

```powershell
npm run acquire:node-runtime -- --output C:\staging\misen-node-v24.20.0
```

This step is the only Node-distribution network boundary. It downloads from the
two exact `nodejs.org` v24.20.0 URLs, requires the pinned archive line in the
official `SHASUMS256.txt`, verifies the downloaded ZIP, extracts it with the
existing Windows PowerShell `Expand-Archive`, verifies `node.exe`, and stages
only:

```text
node.exe
LICENSE
node-runtime-provenance.json
```

No execution-policy change, module install, or target-PC download is involved.
An already downloaded official archive and SHASUMS file can instead be supplied
with `--archive` and `--shasums`; the same exact hashes are still required.

## Package assembly

Build from a clean packaging commit whose protected production paths remain
byte-identical to the frozen free-form source:

```powershell
npm run prepare-runtime -- --output C:\staging\misen-enterprise-self-contained `
  --source-sha 4eef951bb4f37735dcac2800ccf38a6add5d08e1 `
  --packaging-sha <40-character-packaging-commit> `
  --node-runtime C:\staging\misen-node-v24.20.0
```

The output directory must be absent or empty. Packaging fails closed and removes
an incomplete output. Manifest schema v3 records the product source, behavior
baseline, packaging commit, Node release/archive/executable/license provenance,
and `resolution: bundled-only` / `externalRuntimeRequired: false`.

The package contains only `runtime/node/node.exe` and
`runtime/node/LICENSE` from the official Node ZIP. It does not distribute npm,
npx, corepack, TypeScript, esbuild, Node headers, an installer, or package-manager
command shims. The executable/script allowlist is exact:

```text
run.cmd
runtime/node/node.exe
```

All other `.exe`, `.dll`, `.node`, `.cmd`, `.bat`, `.com`, and `.ps1` files are
rejected. The reliability observer under `dist/study` is also rejected.

The synthetic workspace still requires:

- `workspace/AGENTS.md`
- `workspace/.agents/skills/monthly-report/SKILL.md`

These are model-visible guidance, not Security Authority.

## Target startup contract

The only supported target startup is:

```text
run.cmd
  -> runtime/node/node.exe
     -> app/dist/src/web/server.js
```

Run `run.cmd` directly. An absolute workspace may be supplied as the first
argument. If the bundled executable is absent, startup fails; there is no global
or `PATH` Node fallback. The target needs no Node installation, `PATH` change,
registry change, administrator privilege, npm command, build, or runtime download.

Before transfer, verify the package on Windows x64:

```powershell
npm run verify:prepared-runtime -- --runtime C:\staging\misen-enterprise-self-contained
```

The verifier checks the complete `SHA256SUMS.txt`, manifest/inventory, exact
Node version and hashes, exact launcher text, and forbidden executable surface.
It starts the package once with no Node on `PATH` and once with a fake `node.cmd`
first on `PATH`; both must reach HTTP 200 and `/state=idle` using the bundled
executable. A missing-bundled-Node negative control must fail without invoking
the fake PATH Node.

PowerShell is used only by the development-host verifier for external process
and TCP observation. It is not distributed, is not a launcher fallback, and is
not an Agent capability. Network evidence is point-in-time sampling, not packet
capture or proof against every arbitrarily short transient connection.

For a later Windows PowerShell 5.1 human verification of `SHA256SUMS.txt`, always
read the UTF-8 file explicitly:

```powershell
Get-Content -LiteralPath $sumPath -Encoding UTF8
```

Corporate-device / EDR / application-control validation remains a separate #74
human-run step after this implementation is reviewed, merged, and assigned a new
transport identity. The historical `eb99e428...` package and prerelease remain
immutable.
