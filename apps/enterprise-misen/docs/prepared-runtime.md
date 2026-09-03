# Self-contained prepared runtime

The package contains private, exact-pinned Windows x64 Node.js and OfficeCLI
runtimes. A target PC performs no `npm install`, runtime install, download,
update, TypeScript build, or PowerShell fallback, and `PATH` is not modified.

## Frozen runtime identities

Node.js is the official v24.20.0 LTS (Krypton) Windows x64 distribution:

- archive `node-v24.20.0-win-x64.zip`, SHA-256 `6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba`
- `node.exe` SHA-256 `5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5`
- `LICENSE` SHA-256 `ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9`

OfficeCLI is the official self-contained iOfficeAI/OfficeCLI v1.0.147 release at
commit `b94f3906fd52d450c64f8e40370e376b9e15079e`:

- artifact `officecli-win-x64.exe`, SHA-256 `724056e5ff079c3585df79c8afc386f08ef7d5f956cf4e2723534e129aab6e80`
- Apache-2.0 `LICENSE`, SHA-256 `0ef10002c77f6f3672795877e8a276f5a2840105474c87aa6c0bcd8904b12fc7`
- `NOTICE`, SHA-256 `762d2098c370da58737a2f235ddf962f041762b803e5bf6f10cd921894836586`
- no .NET, Python, Node.js, Microsoft Office, or network prerequisite

Floating version identities are never accepted.

## Acquisition and assembly

Acquire and verify both inputs on the packaging host:

```powershell
npm run acquire:node-runtime -- --output C:\staging\misen-node-v24.20.0
npm run acquire:officecli-runtime -- --output C:\staging\misen-officecli-v1.0.147
```

The OfficeCLI step downloads only the exact executable, `LICENSE`, and `NOTICE`,
then verifies all hashes and `--version` before promoting its staging directory.
For offline packaging, supply already downloaded files with `--executable`,
`--license`, and `--notice`; the same checks still apply.

Build the application with both verified inputs:

```powershell
npm run prepare-runtime -- --output C:\staging\misen-enterprise-self-contained `
  --node-runtime C:\staging\misen-node-v24.20.0 `
  --officecli-runtime C:\staging\misen-officecli-v1.0.147
```

The output must be absent or empty. Any error removes the incomplete output.
Manifest schema v5 records the application version, informational build Git
SHA, dependency lock, complete inventory, and both runtime identities. Git
ancestry does not grant packaging authority.

The only distributed executable/script paths are:

```text
run.cmd
runtime/node/node.exe
runtime/officecli/officecli.exe
```

Unexpected `.exe`, `.dll`, `.node`, `.cmd`, `.bat`, `.com`, or `.ps1` files are
rejected. npm/npx/corepack, TypeScript, esbuild, Node headers, installers, tests,
and observer/study code are absent. `runtime/node/LICENSE` and
`runtime/officecli/{LICENSE,NOTICE}` are the only other runtime files.

## Target startup

```text
run.cmd
  -> runtime/node/node.exe
     -> app/dist/src/web/server.js
        -> runtime/officecli/officecli.exe
```

The launcher requires both bundled executables and fails closed if either is
missing. It sets `MISEN_OFFICECLI_PATH`, `OFFICECLI_SKIP_UPDATE=1`, and
`OFFICECLI_NO_AUTO_RESIDENT=1`; there is no global or `PATH` fallback. An
absolute workspace may be passed as the first argument.

Conversation history remains host/UI infrastructure under
`%LOCALAPPDATA%\Misen\data\sessions\`. It contains only the bounded UI-safe
projection and is outside both package and business workspace.

## Verification

```powershell
npm run verify:prepared-runtime -- --runtime C:\staging\misen-enterprise-self-contained
```

The verifier checks `SHA256SUMS.txt`, manifest/inventory, dependency count,
runtime versions and hashes, exact launcher text, and executable allowlist. It
starts the package with no Node on `PATH` and with a fake `node.cmd`, observes
the expected bundled Node and loopback-only listener, and runs separate
missing-Node and missing-OfficeCLI negative controls. Point-in-time TCP sampling
is evidence, not packet capture.

The model-visible synthetic workspace still contains `workspace/AGENTS.md` and
`workspace/.agents/skills/monthly-report/SKILL.md`. These guide the Agent but do
not become execution authority.

Corporate-device/EDR/application-control certification remains the separate
#74 human step. Historical packages and transport identities remain immutable.

## Distribution through the read-only share

The prepared runtime is not handed to users directly. `scripts/prepare-misen.cmd`
at the repository root runs `prepare-runtime` and `verify:prepared-runtime`, then
`scripts/New-Misen.ps1` publishes `app/`, `runtime/`, `workspace/` and the launcher into
`_misen/versions/<version>/` on the share, re-verifies the copied hashes, appends the result
to `_misen/publish-log.txt`, and only then switches `current` in the distribution
`_misen/manifest.json` (publish id, SHA-256 of every file). The share root shows only
`Misen起動.cmd`; `_misen` is hidden and keeps one previous version. Users double-click `Misen起動.cmd`; `launcher/launch.ps1` copies and verifies
the files into `%LOCALAPPDATA%\Misen\versions\<version>` before starting the bundled
Node.js. See `DEPLOY.md` for the operator and user flows and
`launcher/test/launch.test.mjs` for the automated first-run / second-run / update /
tamper checks.
