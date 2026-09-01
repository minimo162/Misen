# Prepared runtime (Phase A)

The prepared runtime is built on a development or packaging host. The target
machine never installs dependencies, builds TypeScript, downloads a runtime, or
uses a PowerShell fallback.

The current prepared-runtime distribution source is:

`df2859c471fac035be062703f59f69e07d55b208`

This source includes the merged #75 observer/test/evidence infrastructure, but
the packaged production runtime paths remain byte-identical to the Thin Misen
production-behavior baseline:

`f3b772f7765206f75f7296e436d89c6a771b690a`

The prepared package deliberately excludes `dist/study`; the #75 reliability
observer is not part of the corporate runtime distribution.

```powershell
npm run prepare-runtime -- --output C:\staging\misen-enterprise `
  --source-sha df2859c471fac035be062703f59f69e07d55b208 `
  --packaging-sha <40-character-packaging-commit>
```

The output directory must be absent or empty. Packaging fails closed and removes
the incomplete directory on error. The package contains `run.cmd`, a synthetic
workspace, the compiled production runtime, production dependencies, a manifest,
the exact dependency lock used for staging, and `SHA256SUMS.txt`.

The packaging SHA must equal the current clean Git `HEAD`. Provenance checks
require both:

- the protected production runtime tree to remain byte-identical to the
  distribution source; and
- those same protected runtime paths in the distribution source to remain
  byte-identical to the Thin Misen production-behavior baseline above.

The synthetic Workspace explicitly includes the model-visible Thin Misen
configuration used by the demo:

- `workspace/AGENTS.md`
- `workspace/.agents/skills/monthly-report/SKILL.md`

These files are required package paths, not Security Authority. The exact file
set and hashes remain authoritative for detecting removal or injection.

The generator normalizes only ZIP container timestamps in generated synthetic
`.xlsx` fixtures. Workbook content is unchanged; this allows reproducibility
checks without changing the business fixture semantics.

On the target machine, place the approved Node.js 22 runtime on `PATH` and run:

```cmd
run.cmd
```

An absolute workspace may be supplied as the first argument. The launcher does
not elevate privileges, install or update software, or fall back to PowerShell
or another executable. Corporate policy and application-control approval remain
external prerequisites.

Before transfer, verify exact file-set hashes and inventory, a Node-only `PATH`,
the recursive target process tree, `/state`, stable-startup TCP observations,
and cleanup:

```powershell
npm run verify:prepared-runtime -- --runtime C:\staging\misen-enterprise
```

The verification host may use PowerShell only as an external observation tool
for process/TCP evidence. PowerShell is not distributed in the package and is
not a fallback or Agent capability.

The network evidence is deliberately narrow: ten stable-startup TCP samples
over one second must show only loopback/wildcard endpoints. It is not claimed as
packet capture or proof that an arbitrarily short transient connection could
never occur.

Corporate-device / EDR / live-provider validation remains a separate #74 step
after deterministic packaging verification succeeds.
